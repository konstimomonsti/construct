"""Contract risk/1: additive open-item points and a bounded, reproducible score."""

from __future__ import annotations

from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Iterable

from ..contracts import AnalysisInput, Finding, Line, RiskReport, SectionRisk, TopRisk
from .signals import anchor, collect, excluded_sections

SCALE = 40
SEVERITY_POINTS = {"error": Decimal(8), "warning": Decimal(4), "info": Decimal(1)}


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


def score_for_points(points: Iterable[float | Decimal]) -> int:
    total = sum((Decimal(str(point)) for point in points), Decimal(0))
    return int((100 * total / (total + SCALE)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def assess(analysis_input: AnalysisInput, findings: list[Finding]) -> RiskReport:
    lines, sections = analysis_input.line_by_id(), analysis_input.section_by_id()
    excluded = excluded_sections(analysis_input)
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
    at_stake: dict[str, Decimal] = {}

    def add(id: str, base: Decimal, line_id: str | None, section_id: str | None,
            category: str, title: str, amount: Decimal | None) -> None:
        uplift = min(Decimal(10), amount / 1000) if priced and amount is not None else Decimal(0)
        value = base + uplift
        points[id] = float(value)
        category_points[category] += value
        section_points[section_id] += value
        section_open[section_id] += 1
        if line_id:
            line_points[line_id] += value
            line_items[line_id].append(id)
            if title not in line_reasons[line_id]:
                line_reasons[line_id].append(title)
            if priced and amount is not None:
                at_stake[line_id] = max(at_stake.get(line_id, Decimal(0)), amount)
        elif priced and amount is not None:
            at_stake[id] = amount

    live = []
    for finding in sorted(findings, key=lambda item: item.id):
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
        add(finding.id, base, line_id, section_id, finding.category, finding.title, amount)
        counts[finding.severity] += 1
    signals = collect(analysis_input, live)
    for signal in signals:
        line = lines[signal.line_id]
        add(signal.id, Decimal(str(signal.points)), line.id, line.section_id,
            "dependency" if signal.kind == "missing_dependency" else "change_order", signal.title, amounts[line.id])
        signal.points = points[signal.id]
    ordered = sorted(line_points, key=lambda id: (-line_points[id], -(amounts[id] or Decimal(0)),
                                                  lines[id].sort_order, id))
    top = [TopRisk(line_id=id, line_code=lines[id].code, short_text=lines[id].short_text,
                   points=float(line_points[id]), amount=at_stake.get(id) if priced else None,
                   reasons=line_reasons[id], item_ids=line_items[id]) for id in ordered[:10]]
    by_section = [SectionRisk(section_id=id, code=sections[id].code if id in sections else None,
                              title=sections[id].title if id in sections else None,
                              points=float(section_points[id]), open=section_open[id])
                  for id in sorted(section_points, key=lambda id: (-section_points[id],
                                  sections[id].sort_order if id in sections else -1, id or ""))]
    score = score_for_points(points.values())
    level = "critical" if score >= 75 else "high" if score >= 50 else "medium" if score >= 25 else "low"
    return RiskReport(score=score, level=level, priced=priced, currency=analysis_input.project.currency,
                      money_at_stake=sum(at_stake.values(), Decimal(0)) if priced else None,
                      points=points, open_counts=dict(counts), top_risks=top, by_section=by_section,
                      by_category={key: float(value) for key, value in sorted(category_points.items())},
                      change_order_signals=signals)
