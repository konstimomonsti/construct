"""Contract risk/1: additive open-item points and a bounded, reproducible score."""

from __future__ import annotations

from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Iterable

from ..contracts import AnalysisInput, Finding, Line, RiskReport, SectionRisk, TopRisk
from .signals import WORDING_KINDS, anchor, collect, excluded_sections, wording_families

SCALE = 40
SCALE_PER_LINE = Decimal("0.65")
SEVERITY_POINTS = {"error": Decimal(8), "warning": Decimal(4), "info": Decimal(1)}
WORDING_SECTION_CAP = Decimal("2.5")
# Likelihood and affected share of exposure, respectively. These are estimates,
# not probabilities that a finding is correct.
LIKELIHOOD = {"error": Decimal("0.65"), "warning": Decimal("0.45"), "info": Decimal("0.15"),
              "signal": Decimal("0.35")}
IMPACT = Decimal("0.4")


def number(value: object) -> Decimal | None:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() else None


def line_amount(line: Line) -> Decimal | None:
    # Current pricing takes precedence over submitted rates when both are supplied.
    for price in (line.price, line.source_amounts):
        if price is None:
            continue
        amount = number(price.line_amount)
        if amount is not None:
            return abs(amount)
        unit_price, quantity = number(price.unit_price), number(line.quantity)
        if unit_price is not None and quantity is not None:
            return abs(unit_price * quantity)
    return None


def score_for_points(points: Iterable[float | Decimal], scale: int = SCALE) -> int:
    total = sum((Decimal(str(point)) for point in points), Decimal(0))
    return int((100 * total / (total + scale)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def assess(analysis_input: AnalysisInput, findings: list[Finding]) -> RiskReport:
    lines, sections = analysis_input.line_by_id(), analysis_input.section_by_id()
    excluded = excluded_sections(analysis_input)
    measured_lines = sum(line.quantity is not None and line.section_id not in excluded
                         for line in lines.values())
    scale = SCALE + int((SCALE_PER_LINE * measured_lines).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    priced = any(price and price.unit_price is not None for line in lines.values()
                 for price in (line.price, line.source_amounts))
    amounts = {id: line_amount(line) for id, line in lines.items()}
    points: dict[str, float] = {}
    category_points: dict[str, Decimal] = defaultdict(Decimal)
    line_points: dict[str, Decimal] = defaultdict(Decimal)
    line_reasons: dict[str, list[str]] = defaultdict(list)
    line_items: dict[str, list[str]] = defaultdict(list)
    section_points: dict[str | None, Decimal] = defaultdict(Decimal)
    section_open: Counter = Counter()
    counts = Counter({"error": 0, "warning": 0, "info": 0})
    exposure: dict[str, Decimal] = {}
    expected: dict[str, Decimal] = {}
    item_sections: dict[str, str | None] = {}
    item_exposure: dict[str, tuple[str, Decimal]] = {}

    def add(id: str, base: Decimal, line_id: str | None, section_id: str | None,
            category: str, title: str, amount: Decimal | None, likelihood: Decimal,
            *, capped: bool = False) -> None:
        uplift = min(Decimal(10), amount / 1000) if priced and amount is not None and not capped else Decimal(0)
        value = base + uplift
        points[id] = float(value)
        item_sections[id] = section_id
        category_points[category] += value
        section_points[section_id] += value
        section_open[section_id] += 1
        if line_id and value:
            line_points[line_id] += value
            line_items[line_id].append(id)
            if title not in line_reasons[line_id]:
                line_reasons[line_id].append(title)
            if priced and amount is not None:
                exposure[line_id] = max(exposure.get(line_id, Decimal(0)), amount)
                estimate = amount * likelihood * IMPACT
                expected[line_id] = max(expected.get(line_id, Decimal(0)), estimate)
                item_exposure[id] = (line_id, estimate)
        elif not line_id and priced and amount is not None and value:
            expected[id] = amount * likelihood * IMPACT
            item_exposure[id] = (id, expected[id])

    live = []
    scored_finding_ids = set()
    for finding in sorted(findings, key=lambda item: (item.layer, item.id)):
        line_id = anchor(finding, lines)
        section_id = lines[line_id].section_id if line_id else finding.target.section_id
        if finding.status != "open" or section_id in excluded or finding.id in points:
            continue
        live.append(finding)
        amount = number(finding.evidence.get("amount_at_stake"))
        amount = abs(amount) if amount is not None else amounts.get(line_id)
        base = SEVERITY_POINTS[finding.severity]
        if finding.evidence.get("change_order") is True:
            base *= Decimal("1.5")

        # An L3 corroboration finding confirms an existing L2 finding (reviews_finding_id)
        # It does not double charge base points or exposure.
        reviewed_id = finding.evidence.get("reviews_finding_id")
        if reviewed_id and reviewed_id in scored_finding_ids:
            base = Decimal(0)
            amount = None

        add(finding.id, base, line_id, section_id, finding.category, finding.title, amount,
            LIKELIHOOD[finding.severity])
        scored_finding_ids.add(finding.id)
        counts[finding.severity] += 1
    signals = collect(analysis_input, live)
    signals_by_id = {signal.id: signal for signal in signals}
    strongest: dict[tuple[str | None, str], str] = {}
    for signal in signals:
        if signal.kind not in WORDING_KINDS:
            continue
        section_id = lines[signal.line_id].section_id
        families = wording_families(lines[signal.line_id], signal.kind)
        if not families:
            continue
        key = (section_id, families[0])
        current = strongest.get(key)
        current_amount = amounts[signals_by_id[current].line_id] if current else None
        if current is None or (amounts[signal.line_id] or Decimal(0)) > (current_amount or Decimal(0)):
            strongest[key] = signal.id
    winning_signals = set(strongest.values())
    for signal in signals:
        line = lines[signal.line_id]
        wording = signal.kind in WORDING_KINDS
        # If signal is derived from an already scored finding (signal.finding_ids overlap with scored findings),
        # do NOT double-charge base points or exposure:
        is_overlapping_finding = bool(signal.finding_ids and any(fid in scored_finding_ids for fid in signal.finding_ids))
        if is_overlapping_finding:
            base = Decimal(0)
            amount = None
        elif wording:
            base = min(WORDING_SECTION_CAP, Decimal(str(signal.points))) if signal.id in winning_signals else Decimal(0)
            amount = amounts[line.id]
        else:
            base = Decimal(str(signal.points))
            amount = amounts[line.id]
        add(signal.id, base, line.id, line.section_id,
            "dependency" if signal.kind == "missing_dependency" else "change_order", signal.title,
            amount, LIKELIHOOD["signal"], capped=wording or is_overlapping_finding)
        signal.points = points[signal.id]
    ordered = sorted(line_points, key=lambda id: (-line_points[id], -(amounts[id] or Decimal(0)),
                                                  lines[id].sort_order, id))
    top = [TopRisk(line_id=id, line_code=lines[id].code, short_text=lines[id].short_text,
                   points=float(line_points[id]), amount=exposure.get(id) if priced else None,
                   reasons=line_reasons[id], item_ids=line_items[id]) for id in ordered[:10]]
    by_section = [SectionRisk(section_id=id, code=sections[id].code if id in sections else None,
                              title=sections[id].title if id in sections else None,
                              points=float(section_points[id]), open=section_open[id])
                  for id in sorted(section_points, key=lambda id: (-section_points[id],
                                  sections[id].sort_order if id in sections else -1, id or ""))]
    score = score_for_points(points.values(), scale)
    level = "critical" if score >= 75 else "high" if score >= 50 else "medium" if score >= 25 else "low"
    return RiskReport(score=score, level=level, scale=scale, priced=priced, currency=analysis_input.project.currency,
                      money_at_stake=sum(expected.values(), Decimal(0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                      if priced else None,
                      points=points, open_counts=dict(counts), top_risks=top, by_section=by_section,
                      by_category={key: float(value) for key, value in sorted(category_points.items())},
                      change_order_signals=signals, item_sections=item_sections, item_exposure=item_exposure)
