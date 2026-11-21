"""Reconcile explicitly written position quantities with the measured quantity column."""

from decimal import Decimal
import re

from .. import units
from ..adapter import parse_number
from ..registry import rule
from .common import review_fix, source_detail

NUMBER = r"(?:\d{1,3}(?:\.\d{3})+,\d+|\d+(?:[,.]\d+)?)"
RAW_UNIT = r"(?:Stück|Stk\.?|St\.?|kg|t|mm|cm\^?2|cm²|cm|m\^?[23]|m[²³]|m|Tage?|Wochen?|Std\.?|h)"
DIRECT = re.compile(
    rf"\b(?:Positionsmenge|Abrechnungsmenge|Gesamtmenge)\s*[:=]\s*(?P<number>{NUMBER})\s*"
    rf"(?P<unit>{RAW_UNIT})(?![\w²³])(?=\s*(?:[.;]|$))", re.I | re.M,
)
TIME = {"tag": "day", "tage": "day", "woche": "week", "wochen": "week"}
QUALIFIER = re.compile(r"\b(?:je|jeweils|pro|für|nur|optional|falls|sofern|wenn|wahlweise|alternativ|oder|bis)\b", re.I)
CLAUSE_START = re.compile(r"[.;!?]|\n")
DOTTED_THOUSANDS = re.compile(r"[1-9]\d{0,2}\.\d{3}")


def _product_pattern(gap):
    return re.compile(
        rf"\bPositionsmenge\s*[:=]\s*Produkt\s+aus{gap}(?P<amount>{NUMBER})\s*"
        rf"(?P<unit>{RAW_UNIT})(?![\w²³]){gap}(?:\(Vorhaltemenge\){gap})?"
        rf"(?:\bmal\b|[x×]){gap}(?P<duration>{NUMBER})\s*(?P<time>Wochen?|Tage?)\b"
        rf"{gap}(?:\(Vorhaltedauer\){gap})?(?=[.;]|$)", re.I | re.M,
    )


PRODUCT = _product_pattern(r"\s*")
LEGACY_PRODUCT = _product_pattern(r"(?:\s|\[TA\d{2}(?=\s)|[\[\]])*")


def _number(text):
    return None if DOTTED_THOUSANDS.fullmatch(text) else parse_number(text)


def _source_unit(text):
    return TIME.get(text.casefold()) or units.normalize(text)


def _qualified(text, match):
    lead = CLAUSE_START.split(text[:match.start()])[-1].strip().rstrip(",").rsplit(",", 1)[-1]
    tail = text[match.end():].lstrip()
    return bool(QUALIFIER.search(lead) or QUALIFIER.match(tail))


def _written_values(text, line_unit, legacy):
    for match in DIRECT.finditer(text):
        number = _number(match["number"])
        if number is not None and units.is_known(line_unit) and not _qualified(text, match):
            value = units.convert(number, _source_unit(match["unit"]), line_unit)
            if value is not None:
                yield match[0], value, None

    if units.dimension(line_unit) != units.Dimension.COMPOSITE:
        return
    base, duration_unit = line_unit.split("·")
    pattern = LEGACY_PRODUCT if legacy else PRODUCT
    for match in pattern.finditer(text):
        amount, duration = _number(match["amount"]), _number(match["duration"])
        if (amount is None or duration is None or TIME[match["time"].casefold()] != duration_unit
                or _qualified(text, match)):
            continue
        amount_unit = _source_unit(match["unit"])
        converted = units.convert(amount, amount_unit, base)
        if converted is not None:
            yield match[0].strip(), converted * duration, {
                "amount": amount, "unit": amount_unit, "duration": duration, "duration_unit": duration_unit,
            }


def _display(value: Decimal):
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


@rule("L1.QTY.WRITTEN_CONFLICT", layer=1, category="arithmetic", severity="error",
      title="Written quantity disagrees with the position",
      description="Compare an explicit position quantity or a priced hire quantity formula to the written measurement.")
def check_written_quantity(ctx):
    source_format = ctx.input.project.source_document.format
    for line in ctx.input.lines:
        if line.pricing_basis != "unit_rate" or line.quantity is None or line.quantity <= 0 or not line.unit:
            continue
        written = {}
        fields = (("short_text", line.short_text), ("long_text", source_detail(line, source_format)))
        for field, text in fields:
            for quote, expected, factors in _written_values(text or "", line.unit, source_format == "gaeb_1990"):
                if expected != line.quantity:
                    written.setdefault(" ".join(quote.split()), (field, quote, expected, factors))
        if not written:
            continue
        evidence = [{"field": field, "quote": quote, "quantity": expected, "factors": factors}
                    for field, quote, expected, factors in written.values()]
        _, quote, expected, _ = next(iter(written.values()))
        yield ctx.finding(
            line=line, field="quantity",
            message=f"The quantity column shows {_display(line.quantity)} {line.unit_raw or line.unit}. "
                    f"“{' '.join(quote.split())}” gives {_display(expected)} {line.unit_raw or line.unit}.",
            evidence={"quantity": line.quantity, "quantity_raw": line.quantity_raw, "unit": line.unit,
                      "unit_raw": line.unit_raw, "written_quantities": evidence},
            suggested_fix=review_fix("Confirm the intended quantity against the takeoff or hire schedule. "
                                     "Align the description and quantity column, then recalculate the amount."),
        )
