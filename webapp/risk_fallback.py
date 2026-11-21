"""Temporary risk scoring for the report UI: severity x amount.

The real model (``analysis/risk/assess()``, plan section 3) does not exist yet. This stand-in
keeps the Summary tab useful until it does. It is a pure function of the input and the
findings, like the planned ``assess``, and the webapp reaches it only through
``webapp.app.RISK_MODEL``, so swapping in the real model is a one-line change plus an adapter
for the result shape.

Method, deliberately simple:

* Likelihood per position: ``p = 1 - prod(1 - w)`` over the position's findings, ``w`` by
  severity (error 0.50, warning 0.25, info 0.08), capped at 0.95. Dismissed findings are left
  out, so dismissing one lowers the score at once. Accepted findings stay in.
* Exposure: the position's own line amount, else quantity x unit price from the file, else the
  priced amount. In a priced BoQ, positions with no amount use the BoQ's median line amount and
  are marked as estimated. A BoQ with almost no prices is ranked by likelihood only.
* Expected amount ``EV = exposure x p x k`` with ``k`` the largest impact among the findings
  (error 1.0, warning 0.5, info 0.2).
* Overall score 0-100: for priced BoQs the share of the net total at risk (10 % -> 100), for
  unpriced ones the sum of likelihoods against 25 % of the positions.
"""

from __future__ import annotations

from collections import defaultdict
from statistics import median
from typing import Any

from analysis.contracts import AnalysisInput, Finding, Line, Status

MODEL = "fallback-v0 (severity x amount)"
WEIGHT = {"error": 0.50, "warning": 0.25, "info": 0.08}
IMPACT = {"error": 1.0, "warning": 0.5, "info": 0.2}
P_CAP = 0.95
TOP_LINES = 50
PRICED_SHARE = 0.20  # a BoQ counts as priced when this share of positions has an amount
TOP_SECTIONS = 15
SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}

# Findings that point at change-order potential (Nachtrag). The layer 1 risk rules in plan
# section 3 (L1.RISK.*) will appear here automatically once they exist.
CHANGE_ORDER_RULES = {"L1.STRUCT.PROVISIONAL_ITEM", "L1.QTY.PLACEHOLDER"}
CHANGE_ORDER_PREFIXES = ("L1.RISK.",)


def is_change_order_signal(rule_id: str) -> bool:
    return rule_id in CHANGE_ORDER_RULES or rule_id.startswith(CHANGE_ORDER_PREFIXES)


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def line_amount(line: Line) -> float | None:
    """The position's own amount, from the file or from pricing. None when unpriced."""
    sa = line.source_amounts
    if sa is not None:
        if sa.line_amount is not None:
            return abs(float(sa.line_amount))
        if sa.unit_price is not None and line.quantity is not None:
            return abs(float(sa.unit_price) * float(line.quantity))
    if line.price is not None and line.price.line_amount is not None:
        return abs(float(line.price.line_amount))
    return None


def _anchor(finding: Finding) -> str | None:
    """The position a finding is charged to: its own line, else the first related one."""
    if finding.target.line_id:
        return finding.target.line_id
    return finding.related_line_ids[0] if finding.related_line_ids else None


def _top_section(sections: dict, section_id: str | None) -> str | None:
    seen = set()
    while section_id in sections and sections[section_id].parent_id and section_id not in seen:
        seen.add(section_id)
        section_id = sections[section_id].parent_id
    return section_id if section_id in sections else None


def _level(p: float, ev: float | None, net_total: float) -> str:
    if p >= 0.5 or (ev is not None and net_total > 0 and ev >= 0.02 * net_total):
        return "high"
    return "medium" if p >= 0.25 else "low"


def _reason(finding: Finding) -> dict[str, Any]:
    return {"finding_id": finding.id, "rule_id": finding.rule_id, "severity": finding.severity,
            "title": finding.title, "status": finding.status}


def assess(analysis_input: AnalysisInput, findings: list[Finding]) -> dict[str, Any]:
    lines = analysis_input.lines
    sections = analysis_input.section_by_id()
    line_by_id = analysis_input.line_by_id()

    own = {line.id: line_amount(line) for line in lines}
    priced_amounts = [a for a in own.values() if a]
    priced = bool(lines) and len(priced_amounts) >= PRICED_SHARE * len(lines) and sum(priced_amounts) > 0
    fill = median(priced_amounts) if priced else None
    net_total = sum(own[line.id] or (fill or 0.0) for line in lines) if priced else 0.0

    live = [f for f in findings if f.status != Status.REJECTED.value]
    by_line: dict[str, list[Finding]] = defaultdict(list)
    loose: list[Finding] = []
    for finding in live:
        anchor = _anchor(finding)
        (by_line[anchor] if anchor in line_by_id else loose).append(finding)

    positions = []
    for line_id, items in by_line.items():
        strongest: dict[str, str] = {}  # rule -> worst severity: one signal per rule
        for f in items:
            if f.rule_id not in strongest or SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[strongest[f.rule_id]]:
                strongest[f.rule_id] = f.severity
        survive = 1.0
        for severity in strongest.values():
            survive *= 1 - WEIGHT[severity]
        p = min(P_CAP, 1 - survive)
        k = max(IMPACT[s] for s in strongest.values())
        amount, estimated = own[line_id], False
        if amount is None and priced:
            amount, estimated = fill, True
        ev = amount * p * k if amount is not None else None
        line = line_by_id[line_id]
        positions.append({
            "line_id": line_id, "code": line.code, "short_text": line.short_text,
            "section_id": line.section_id, "amount": amount, "amount_estimated": estimated,
            "p": round(p, 3), "ev": round(ev, 2) if ev is not None else None,
            "level": _level(p, ev, net_total),
            "reasons": sorted((_reason(f) for f in items),
                              key=lambda r: (SEVERITY_ORDER[r["severity"]], r["rule_id"])),
        })
    # Rank by money at stake when priced, else by likelihood; ties by the number of findings.
    positions.sort(key=lambda r: ((-(r["ev"] or 0), -r["p"]) if priced else (-r["p"],)) + (-len(r["reasons"]),
                                                                                       r["code"] or ""))

    ev_total = sum(r["ev"] for r in positions if r["ev"] is not None)
    if priced:
        share = ev_total / net_total if net_total else 0.0
        score = min(100, round(100 * share / 0.10))
    else:
        share = None
        score = min(100, round(100 * sum(r["p"] for r in positions) / max(1.0, 0.25 * len(lines))))
    level = "high" if score >= 60 else "medium" if score >= 30 else "low"

    # Roll-ups by top-level section and by category.
    section_rows: dict[str | None, dict[str, Any]] = {}

    def section_row(section_id: str | None) -> dict[str, Any]:
        top = _top_section(sections, section_id)
        if top not in section_rows:
            sec = sections.get(top)
            section_rows[top] = {"section_id": top, "code": sec.code if sec else None,
                                 "title": sec.title if sec else "(outside any section)",
                                 "findings": 0, "errors": 0, "warnings": 0, "ev": 0.0 if priced else None,
                                 "p_max": 0.0}
        return section_rows[top]

    for row in positions:
        sr = section_row(row["section_id"])
        sr["p_max"] = max(sr["p_max"], row["p"])
        if priced and row["ev"] is not None:
            sr["ev"] += row["ev"]
    for f in live:
        anchor = _anchor(f)
        section_id = line_by_id[anchor].section_id if anchor in line_by_id else f.target.section_id
        sr = section_row(section_id)
        sr["findings"] += 1
        sr["errors"] += f.severity == "error"
        sr["warnings"] += f.severity == "warning"
    for sr in section_rows.values():
        sr["ev"] = round(sr["ev"], 2) if sr["ev"] is not None else None
        sr["p_max"] = round(sr["p_max"], 3)
    by_section = sorted(section_rows.values(),
                        key=lambda r: ((-(r["ev"] or 0), -r["errors"], -r["findings"]) if priced
                                       else (-r["errors"], -r["warnings"], -r["findings"])))

    categories: dict[str, dict[str, Any]] = {}
    for f in live:
        c = categories.setdefault(f.category, {"category": f.category, "findings": 0, "errors": 0,
                                               "warnings": 0, "info": 0})
        c["findings"] += 1
        c[{"error": "errors", "warning": "warnings", "info": "info"}[f.severity]] += 1
    by_category = sorted(categories.values(), key=lambda r: (-r["errors"], -r["warnings"], -r["findings"]))

    signals = []
    for f in live:
        if not is_change_order_signal(f.rule_id):
            continue
        anchor = _anchor(f)
        line = line_by_id.get(anchor)
        signals.append({"finding_id": f.id, "rule_id": f.rule_id, "title": f.title, "severity": f.severity,
                        "status": f.status, "line_id": anchor if line else None,
                        "code": line.code if line else None,
                        "short_text": line.short_text if line else None,
                        "amount": own.get(anchor) if line else None})
    signals.sort(key=lambda s: (-(s["amount"] or 0), s["code"] or ""))

    open_counts = {s: sum(1 for f in findings if f.status == Status.OPEN.value and f.severity == s)
                   for s in WEIGHT}
    accepted = sum(1 for f in findings if f.status == Status.ACCEPTED.value)
    dismissed = sum(1 for f in findings if f.status == Status.REJECTED.value)
    return {
        "model": MODEL,
        "priced": priced,
        "score": score, "level": level,
        "net_total": round(net_total, 2) if priced else None,
        "money_at_stake": round(ev_total, 2) if priced else None,
        "share_at_stake": round(share, 4) if share is not None else None,
        "positions_at_risk": len(positions),
        "positions_estimated": sum(1 for r in positions if r["amount_estimated"]),
        "counts": {"findings": len(findings), "accepted": accepted, "dismissed": dismissed,
                   "reviewed": accepted + dismissed, "open": open_counts,
                   "change_order_signals": len(signals)},
        "lines": positions[:TOP_LINES],  # only the top positions go to the browser
        "by_section": by_section[:TOP_SECTIONS],
        "by_category": by_category,
        "signals": signals[:100],
    }
