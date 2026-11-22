"""Prices: those written in a bid/award file and those found by the pricing phase (line.price)."""

from collections import defaultdict
from datetime import date
from decimal import Decimal
import re

from .. import units
from ..registry import rule
from .common import THRESHOLDS, is_counted, label, phase_has_prices


CREDIT_PATTERN = re.compile(
    r"\b(gutschrift|abzug|nachlass|rabatt|skonto|vergütung|ablagern|rückbau\s*erlös)\b",
    re.IGNORECASE,
)


def is_credit(line) -> bool:
    text = (line.short_text or "") + " " + (line.long_text or "")
    return bool(CREDIT_PATTERN.search(text)) or line.gaeb_flags.get("discount") == "Yes"


@rule("L1.PRICE.NEGATIVE", layer=1, category="price", severity="error", title="Negative unit price",
      description="Unit prices in a bill of quantities cannot be negative unless explicitly marked as a credit or deduction.")
def price_negative(ctx):
    for line in ctx.input.lines:
        for origin, unit_price in (("file", line.source_amounts.unit_price if line.source_amounts else None),
                                   ("pricing", line.price.unit_price if line.price else None)):
            if unit_price is not None and unit_price < 0:
                if not is_credit(line):
                    yield ctx.finding(
                        line=line, field="unit_price", discriminator=origin,
                        message=f"{label(line)} has a negative unit price of {unit_price} ({origin}) without being marked as a credit or deduction.",
                        evidence={"unit_price": unit_price, "origin": origin},
                    )


@rule("L1.PRICE.MISSING_IN_FILE", layer=1, category="price", severity="error", title="Bid item without price",
      description="In a bid or award (GAEB 84/86) every counted item needs a unit price. Surcharge items "
                  "(MarkupItem) only carry an amount.")
def missing_in_file(ctx):
    if not phase_has_prices(ctx.input):
        return
    for line in ctx.input.lines:
        amounts = line.source_amounts
        if line.gaeb_flags.get("MarkupItem") == "Yes":
            if amounts is None or amounts.line_amount is None:
                yield ctx.finding(line=line, field="line_amount",
                                  message=f"{label(line)} is a surcharge item with no amount in the file.")
            continue
        if is_counted(line) and (amounts is None or amounts.unit_price is None):
            yield ctx.finding(line=line, field="unit_price", message=f"{label(line)} has no unit price in the file.")


@rule("L1.PRICE.NOT_FOUND", layer=1, category="price", severity="error", title="No price found",
      description="The pricing phase ran but found no price for a counted item.")
def not_found(ctx):
    for line in ctx.input.lines:
        if line.price is not None and line.price.unit_price is None and is_counted(line):
            yield ctx.finding(line=line, field="unit_price",
                              message=f"No price was found for {label(line)} in the catalogue, references or AI search.")


@rule("L1.PRICE.ZERO", layer=1, category="price", severity="warning", title="Unit price is zero",
      description="A counted item priced at 0.")
def price_zero(ctx):
    for line in ctx.input.lines:
        if not is_counted(line):
            continue
        for origin, unit_price in (("file", line.source_amounts.unit_price if line.source_amounts else None),
                                   ("pricing", line.price.unit_price if line.price else None)):
            if unit_price is not None and unit_price == 0:
                yield ctx.finding(line=line, field="unit_price", discriminator=origin,
                                  message=f"{label(line)} has a unit price of 0 ({origin}).",
                                  evidence={"origin": origin})


@rule("L1.PRICE.UNIT_MISMATCH", layer=1, category="price", severity="error", title="Price unit differs from line unit",
      description="The matched price refers to another unit (e.g. per m for an item in m²), so the amount is wrong.")
def unit_mismatch(ctx):
    for line in ctx.input.lines:
        price = line.price
        if not price or price.unit_price is None or not price.price_unit or not line.unit:
            continue
        if price.price_unit == line.unit:
            continue
        same_dimension = units.dimension(price.price_unit) == units.dimension(line.unit)
        yield ctx.finding(
            line=line, field="price.price_unit", severity="warning" if same_dimension else "error",
            message=f"The price for {label(line)} is per {price.price_unit}, the line is measured in {line.unit}."
                    + (" Same kind of unit: a conversion is needed." if same_dimension else ""),
            evidence={"line_unit": line.unit, "price_unit": price.price_unit, "unit_price": price.unit_price,
                      "matched_text": price.matched_text},
        )


@rule("L1.PRICE.CURRENCY_MISMATCH", layer=1, category="price", severity="error", title="Price in another currency",
      description="The matched price is not in the project currency.")
def currency_mismatch(ctx):
    currency = ctx.input.project.currency
    for line in ctx.input.lines:
        price = line.price
        if price and price.unit_price is not None and price.currency and currency and price.currency != currency:
            yield ctx.finding(line=line, field="price.currency",
                              message=f"The price for {label(line)} is in {price.currency}, the project uses {currency}.",
                              evidence={"price_currency": price.currency, "project_currency": currency})


@rule("L1.PRICE.OUTLIER", layer=1, category="price", severity="warning", title="Price far from references",
      description="The unit price is more than 3x above or below the median of the observed reference prices.")
def outlier(ctx):
    factor = THRESHOLDS.outlier_factor
    for line in ctx.input.lines:
        price = line.price
        reference = price.reference_range if price else None
        if not reference or price.unit_price is None or reference.n < THRESHOLDS.outlier_min_references:
            continue
        if (price.unit_price <= 0 or reference.median <= 0
                or not reference.min <= reference.median <= reference.max
                or (price.price_unit and price.price_unit != line.unit)
                or (price.currency and ctx.input.project.currency and price.currency != ctx.input.project.currency)):
            continue
        ratio = price.unit_price / reference.median
        if ratio > factor or ratio < 1 / factor:
            yield ctx.finding(
                line=line, field="unit_price",
                message=f"{label(line)} is priced at {price.unit_price}, {ratio:.1f}x the median of {reference.n} "
                        f"reference prices ({reference.median}; range {reference.min}-{reference.max}). "
                        f"Difference from the median: {price.unit_price - reference.median:+.2f} per {line.unit or 'item'}.",
                evidence={"unit_price": price.unit_price, "median": reference.median, "min": reference.min,
                          "max": reference.max, "n": reference.n, "ratio": round(float(ratio), 2)},
            )


@rule("L1.PRICE.LOW_CONFIDENCE", layer=1, category="price", severity="info", title="Uncertain price match",
      description="The price comes from a weak match or from AI search and should be checked.")
def low_confidence(ctx):
    for line in ctx.input.lines:
        price = line.price
        if not price or price.unit_price is None or price.match_confidence is None:
            continue
        limit = THRESHOLDS.ai_low_confidence if price.source == "ai" else THRESHOLDS.low_confidence
        if price.match_confidence < limit:
            yield ctx.finding(line=line, field="unit_price",
                              message=f"The price for {label(line)} comes from a {price.source} match with confidence "
                                      f"{price.match_confidence:.2f}. Check the item, unit and scope against "
                                      f"'{price.matched_text or '-'}' before using the rate.",
                              evidence={"source": price.source, "confidence": price.match_confidence,
                                        "matched_text": price.matched_text, "citations": price.citations})


@rule("L1.PRICE.SOURCE_DEVIATION", layer=1, category="price", severity="warning",
      title="File price differs from our price", description="The price in the bid/award file deviates more than 50% from ours.")
def source_deviation(ctx):
    for line in ctx.input.lines:
        filed = line.source_amounts.unit_price if line.source_amounts else None
        price = line.price
        if (filed is None or filed <= 0 or not price or price.unit_price is None or price.unit_price <= 0
                or not line.unit
                or (price.currency and ctx.input.project.currency and price.currency != ctx.input.project.currency)):
            continue
        quoted_unit = price.price_unit or line.unit
        quoted_units_per_line_unit = units.convert(Decimal(1), line.unit, quoted_unit)
        if quoted_units_per_line_unit is None:
            continue
        ours = price.unit_price * quoted_units_per_line_unit
        deviation = (filed - ours) / ours
        if abs(deviation) > THRESHOLDS.source_deviation:
            yield ctx.finding(line=line, field="unit_price",
                              message=f"{label(line)}: the file says {filed} per {line.unit}, our price is {ours} "
                                      f"per {line.unit} ({deviation:+.0%}, difference {filed - ours:+.2f}).",
                              evidence={"file_price": filed, "our_price": ours, "unit": line.unit,
                                        "difference": filed - ours, "deviation": round(float(deviation), 3)})


@rule("L1.PRICE.STALE", layer=1, category="price", severity="info", title="Old price",
      description="The matched price is older than 3 years.")
def stale(ctx):
    today = date.today()
    for line in ctx.input.lines:
        price = line.price
        if not price or price.unit_price is None or not price.price_date:
            continue
        age_years = (today - price.price_date).days / 365.25
        if age_years > THRESHOLDS.stale_price_years:
            yield ctx.finding(line=line, field="price.price_date",
                              message=f"The price for {label(line)} dates from {price.price_date} "
                                      f"({age_years:.0f} years old). Verify the rate against a current quote before submitting the bid.",
                              evidence={"price_date": price.price_date.isoformat(), "age_years": round(age_years, 1)})


@rule("L1.IMPORT.WARNING", layer=1, category="import", severity="warning", title="Import problem",
      description="The importer could not read part of the source file.")
def import_warning(ctx):
    groups = defaultdict(list)
    for warning in ctx.input.import_warnings:
        groups[warning.code].append(warning)
    diagnostics = {"unmapped_legacy_record_type", "pdf_structure_review", "pdf_inventory_review"}
    for code, warnings in sorted(groups.items()):
        locations = [warning.locator for warning in warnings]
        details = list(dict.fromkeys(warning.message or code.replace("_", " ") for warning in warnings))
        location_labels = list(dict.fromkeys(
            ", ".join(f"{key} {location[key]}" for key in ("sheet", "page", "row", "record", "code")
                      if location.get(key) is not None) for location in locations
        ))
        where = ", ".join(name for name in location_labels[:5] if name)
        diagnostic = code in diagnostics
        message = f"{len(warnings)} occurrence(s). " if len(warnings) > 1 else ""
        message += " ".join(details[:3])
        if where:
            message += f" Source: {where}."
        if not diagnostic:
            message += " Check these entries against the original file and correct or reimport the affected values."
        yield ctx.finding(discriminator=code, severity="info" if diagnostic else "warning",
                          title=f"{'Import note' if diagnostic else 'Import problem'}: {code.replace('_', ' ')}",
                          message=message, evidence={"code": code, "locator": locations[0],
                                                     "locations": locations[:10], "occurrences": len(warnings)})
