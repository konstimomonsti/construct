"""Thresholds, text patterns and helpers shared by the layer 1 rules."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
import re

from ..contracts import AnalysisInput, Fix, Line, Section


def review_fix(rationale: str) -> Fix:
    """Suggest a source check or manual correction when the source cannot justify an edit."""
    return Fix(operations=[], confidence=0.7, rationale=rationale)


@dataclass(frozen=True)
class Thresholds:
    line_amount_tolerance: Decimal = Decimal("0.01")   # qty x unit price vs stated line amount
    total_tolerance: Decimal = Decimal("0.05")         # sum of lines vs stated subtotal / total
    distribution_tolerance: Decimal = Decimal("0.001")
    outlier_factor: Decimal = Decimal("3")             # price > 3x median or < median/3
    outlier_min_references: int = 3
    low_confidence: float = 0.6
    ai_low_confidence: float = 0.8
    source_deviation: Decimal = Decimal("0.5")         # bid price vs our price, relative
    stale_price_years: int = 3


THRESHOLDS = Thresholds()

# Phases in which the file itself must carry prices (bid, award).
PRICED_PHASES = {"84", "86"}
BID_PHASE = "84"


def phase_has_prices(analysis_input: AnalysisInput) -> bool:
    return analysis_input.project.gaeb_phase in PRICED_PHASES


def money(value: Decimal) -> Decimal:
    """Commercial rounding to cents, as GAEB computes line amounts."""
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def is_counted(line: Line) -> bool:
    """Line amount goes into the totals (not optional, not alternative, not unit-price-only)."""
    return line.total_rule == "include"


def label(line: Line) -> str:
    text = line.short_text or line.long_text or ""
    text = text if len(text) <= 60 else text[:57] + "..."
    return f"{line.code or '(no code)'} {text}".strip()


def text_of(line: Line) -> str:
    return "\n".join(part for part in (line.short_text, line.long_text) if part)


def source_detail(line: Line, source_format: str | None) -> str | None:
    """Exclude the heading copied into the detail by the printed PDF layout extractor."""
    if source_format != "pdf" or not line.source_locator.get("page") or not line.short_text or not line.long_text:
        return line.long_text
    header, _, detail = line.long_text.partition("\n")
    if " ".join(header.casefold().split()) == " ".join(line.short_text.casefold().split()):
        return detail or None
    return line.long_text


def outline_alternative_repeats(snapshot: AnalysisInput):
    """Locate identical unmeasured Word lines repeated across explicit outline alternatives."""
    if snapshot.project.source_document.format != "docx":
        return {}
    groups = defaultdict(list)
    for line in snapshot.lines:
        if line.code:
            groups[line.code].append(line)

    repeats = {}
    for group in groups.values():
        if len(group) < 2:
            continue
        first, *rest = sorted(group, key=lambda line: line.sort_order)
        outline = first.source_locator
        heading = outline.get("outline_heading_paragraph")
        previous = outline.get("paragraph")
        if not heading or not isinstance(previous, int) or outline.get("outline_connector") or not first.short_text:
            continue
        linked = {}
        for line in [first, *rest]:
            if (line.source_locator.get("outline_heading_paragraph") != heading or line.quantity is not None
                    or line.price is not None or line.source_amounts is not None
                    or ((line.short_text or "").casefold(), line.long_text, line.unit)
                    != (first.short_text.casefold(), first.long_text, first.unit)):
                break
            if line is first:
                continue
            paragraph = line.source_locator.get("paragraph")
            connector = line.source_locator.get("outline_connector")
            boundary = connector.get("paragraph") if isinstance(connector, dict) else None
            if (not isinstance(paragraph, int) or not isinstance(boundary, int)
                    or not previous < boundary < paragraph or str(connector.get("text")).casefold() != "oder"):
                break
            linked[line.id] = (first, connector)
            previous = paragraph
        else:
            repeats.update(linked)
    return repeats


def section_subtrees(analysis_input: AnalysisInput) -> dict[str, set[str]]:
    """Section id -> ids of the section and all its descendants."""
    children: dict[str | None, list[str]] = {}
    for section in analysis_input.sections:
        children.setdefault(section.parent_id, []).append(section.id)
    result: dict[str, set[str]] = {}

    def collect(section_id: str) -> set[str]:
        if section_id not in result:
            ids = {section_id}
            for child in children.get(section_id, []):
                ids |= collect(child)
            result[section_id] = ids
        return result[section_id]

    for section in analysis_input.sections:
        collect(section.id)
    return result


def section_label(section: Section) -> str:
    return f"{section.code or ''} {section.title or ''}".strip() or section.id


# Blanks the bidder has to fill in: "........", "_____", "'....'", "vom Bieter einzutragen".
BIDDER_INPUT = re.compile(
    r"(\.{5,}|_{4,}|…{3,}|\bvom\s+Bieter\s+(?:einzutragen|anzugeben)|\bBieterangabe)", re.IGNORECASE,
)
# A reference product "or equivalent": the bidder must name the offered product.
OR_EQUIVALENT = re.compile(r"\b(?:oder|od\.)\s+(?:ein\s+Produkt\s+)?gleichwertig", re.IGNORECASE)
# Explicit measurement unit stated in the text: "Abrechnung nach m2", "Abrechnungseinheit: Stück".
# A following "x" / "*" / "×" means a composite unit ("Stück x Stunden"), which is skipped.
BILLING_UNIT = re.compile(
    r"Abrechnung(?:seinheit)?\s*(?:nach|in|:|=)?\s*"
    r"(m2|m3|m²|m³|qm|cbm|lfm|lfdm|m|Stück|Stk|St|kg|t|h|Std|psch|pauschal)(?!\w)(?!\s*[x×*])",
    re.IGNORECASE,
)


def excerpt(text: str, match: re.Match, width: int = 40) -> str:
    start, end = max(0, match.start() - width), min(len(text), match.end() + width)
    snippet = " ".join(text[start:end].split())
    return ("..." if start else "") + snippet + ("..." if end < len(text) else "")
