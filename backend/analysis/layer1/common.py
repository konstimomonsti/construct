"""Thresholds, text patterns and helpers shared by the layer 1 rules."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
import re

from ..adapter import is_unselected_scope
from ..contracts import AnalysisInput, Line, Section


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


def excluded_scope_sections(snapshot: AnalysisInput) -> set[str]:
    children: dict[str | None, list[str]] = {}
    for section in snapshot.sections:
        children.setdefault(section.parent_id, []).append(section.id)
    pending = [section.id for section in snapshot.sections if is_unselected_scope(section.gaeb_flags)]
    excluded = set()
    while pending:
        section_id = pending.pop()
        if section_id not in excluded:
            excluded.add(section_id)
            pending.extend(children.get(section_id, []))
    return excluded


def is_optional(line: Line) -> bool:
    """Bedarfsposition: GAEB XML Provis or GAEB 90 provisional flag E."""
    return bool(line.gaeb_flags.get("Provis")) or line.gaeb_flags.get("provisional_flag") == "E"


def label(line: Line) -> str:
    text = line.short_text or line.long_text or ""
    text = text if len(text) <= 60 else text[:57] + "..."
    return f"{line.code or '(no code)'} {text}".strip()


def text_of(line: Line) -> str:
    return "\n".join(part for part in (line.short_text, line.long_text) if part)


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
