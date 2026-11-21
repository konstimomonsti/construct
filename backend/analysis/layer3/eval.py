"""Measure layer 3 against the labelled cases in eval_cases.json, with the configured real model.

    ANALYSIS_L3_PROVIDER=ollama    python -m analysis.layer3.eval
    ANALYSIS_L3_PROVIDER=anthropic python -m analysis.layer3.eval --json

Prints precision and recall for the contradiction check, accuracy for the layer 2 review, and precision
and recall for the task 02 checks (precast spec, scope audit, underspecified text, implausible quantity)
per (rule, OZ), so a rule can be judged before it is relied on. With ANALYSIS_L3_PROVIDER=anthropic the
audit uses ANALYSIS_L3_AUDIT_MODEL (default claude-sonnet-5-5). Uses the same cache as the analysis (ANALYSIS_L3_CACHE).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from ..adapter import from_data
from ..contracts import AnalysisInput, Finding, Line, Target
from ..runner import analyze
from . import run
from .provider import ProviderUnavailable, audit_provider_from_env, provider_from_env

CASES = Path(__file__).with_name("eval_cases.json")
TASK02_RULES = ("L3.PRECAST.MISSING_SPEC", "L3.SCOPE.REBAR_AMBIGUOUS", "L3.SCOPE.SHOP_DRAWINGS_OVERLAP",
                "L3.SCOPE.EMBEDDED_UNALLOCATED", "L3.TEXT.UNDERSPECIFIED", "L3.QTY.IMPLAUSIBLE")


def _contradiction_input(cases: list[dict]) -> AnalysisInput:
    lines = [Line(id=case["id"], code=case["id"], sort_order=index, short_text=case["short_text"],
                  long_text=case["long_text"]) for index, case in enumerate(cases)]
    return AnalysisInput(lines=lines).with_hash()


def _l2_case(case: dict) -> tuple[AnalysisInput, Finding]:
    lines = [Line(id=f"{case['id']}:{item['code']}", code=item["code"], sort_order=index,
                  short_text=item.get("short_text"), long_text=item.get("long_text"),
                  quantity=item.get("quantity"), unit=item.get("unit"))
             for index, item in enumerate(case["lines"])]
    trigger = lines[0]
    finding = Finding(
        id=f"l2_{case['id']}", layer=2, rule_id="L2.EVAL.CASE", category="dependency", severity="warning",
        scope="bom", target=Target(), related_line_ids=[trigger.id], title=f"Missing {case['dependency'].lower()}",
        message=f"No {case['dependency'].lower()} was found for floor screed in Entire BoQ.",
        evidence={"reason": "missing", "dependency": case["dependency"], "check_type": "Boolean",
                  "trade_category": "Floor screed and finishes", "trigger_line_ids": [trigger.id],
                  "dependency_line_ids": []},
    )
    return AnalysisInput(lines=lines).with_hash(), finding


def _task02_input(case: dict) -> AnalysisInput:
    if case.get("fixture"):
        path = Path(__file__).resolve().parents[1] / case["fixture"]
        return AnalysisInput.model_validate_json(path.read_text(encoding="utf-8")).with_hash()
    return from_data({"sections": case["sections"], "lines": case["lines"]})


def evaluate_task02(cases: list[dict], provider, audit_provider, errors: list[str]) -> dict:
    rows, tp, fp, fn = [], 0, 0, 0
    for case in cases:
        analysis_input = _task02_input(case)
        prior = analyze(analysis_input, [1, 2]).findings
        found = {(f.rule_id, f.target.line_code) for f in run(analysis_input, prior, errors, provider=provider,
                                                               audit_provider=audit_provider)
                 if f.rule_id in TASK02_RULES}
        expect = {tuple(pair) for pair in case["expect"]}
        acceptable = {tuple(pair) for pair in case.get("acceptable", [])}
        hits, misses, extra = found & expect, expect - found, found - expect - acceptable
        tp, fn, fp = tp + len(hits), fn + len(misses), fp + len(extra)
        rows.append({"id": case["id"], "hits": sorted(hits), "missed": sorted(misses),
                     "false_positives": sorted(extra), "acceptable": sorted(found & acceptable)})
    per_rule = {}
    for rule_id in TASK02_RULES:
        r_tp = sum(1 for row in rows for pair in row["hits"] if pair[0] == rule_id)
        r_fp = sum(1 for row in rows for pair in row["false_positives"] if pair[0] == rule_id)
        r_fn = sum(1 for row in rows for pair in row["missed"] if pair[0] == rule_id)
        per_rule[rule_id] = {"tp": r_tp, "fp": r_fp, "fn": r_fn,
                             "precision": r_tp / (r_tp + r_fp) if r_tp + r_fp else None}
    return {"precision": tp / (tp + fp) if tp + fp else None, "recall": tp / (tp + fn) if tp + fn else None,
            "per_rule": per_rule, "cases": rows}


def evaluate(provider, audit_provider=None) -> dict:
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    errors: list[str] = []

    contradiction = cases["contradiction"]
    found = {f.target.line_id for f in run(_contradiction_input(contradiction), [], errors, provider=provider)
             if f.rule_id == "L3.TEXT.SHORT_LONG_CONTRADICTION" and f.severity == "warning"}
    rows = [{"id": c["id"], "expect": c["expect"], "got": c["id"] in found} for c in contradiction]
    tp = sum(r["expect"] and r["got"] for r in rows)
    fp = sum(not r["expect"] and r["got"] for r in rows)
    fn = sum(r["expect"] and not r["got"] for r in rows)

    reviews = []
    for case in cases["l2_confirm"]:
        analysis_input, prior = _l2_case(case)
        results = [f for f in run(analysis_input, [prior], errors, provider=provider)
                   if f.rule_id == "L3.REVIEW.L2_CONFIRM"]
        got = results[0].evidence["verdict"] if results else "unclear"
        reviews.append({"id": case["id"], "expect": case["expect"], "got": got})

    return {
        "model": provider.model_id,
        "contradiction": {"precision": tp / (tp + fp) if tp + fp else None,
                          "recall": tp / (tp + fn) if tp + fn else None, "cases": rows},
        "l2_confirm": {"accuracy": sum(r["expect"] == r["got"] for r in reviews) / len(reviews), "cases": reviews},
        "task02": evaluate_task02(cases.get("task02", []), provider, audit_provider, errors),
        "errors": errors,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m analysis.layer3.eval")
    parser.add_argument("--json", action="store_true", help="print the full result as JSON")
    args = parser.parse_args(argv)
    try:
        provider = provider_from_env()
    except ProviderUnavailable as exc:
        print(f"layer 3 provider: {exc}", file=sys.stderr)
        return 2
    if provider is None:
        print("ANALYSIS_L3_PROVIDER=none: nothing to evaluate", file=sys.stderr)
        return 2
    try:
        audit_provider = audit_provider_from_env(provider)
    except ProviderUnavailable as exc:
        print(f"layer 3 audit provider: {exc}", file=sys.stderr)
        return 2
    result = evaluate(provider, audit_provider)
    sys.stdout.reconfigure(encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        c, r = result["contradiction"], result["l2_confirm"]
        print(f"model: {result['model']}  audit model: {audit_provider.model_id}")
        print(f"contradiction  precision={c['precision']}  recall={c['recall']}")
        for row in c["cases"]:
            print(f"  {'ok ' if row['expect'] == row['got'] else 'BAD'} {row['id']:28} expect={row['expect']} got={row['got']}")
        print(f"l2_confirm     accuracy={r['accuracy']:.2f}")
        for row in r["cases"]:
            print(f"  {'ok ' if row['expect'] == row['got'] else 'BAD'} {row['id']:28} expect={row['expect']} got={row['got']}")
        t = result["task02"]
        print(f"task02         precision={t['precision']}  recall={t['recall']}")
        for rule_id, stats in t["per_rule"].items():
            print(f"  {rule_id:32} precision={stats['precision']}  tp={stats['tp']} fp={stats['fp']} fn={stats['fn']}")
        for row in t["cases"]:
            status = "ok " if not row["missed"] and not row["false_positives"] else "BAD"
            print(f"  {status} {row['id']:28} missed={row['missed']} false_positives={row['false_positives']}")
        for error in result["errors"]:
            print(f"error: {error}")
    return 0 if not result["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
