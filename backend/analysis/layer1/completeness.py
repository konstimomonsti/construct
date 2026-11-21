"""Missing or unusable values: quantity, unit, text, OZ code."""

from collections import defaultdict

from .. import units
from ..contracts import Fix, SetField
from ..registry import rule
from .common import BID_PHASE, label, review_fix


def is_markup(line) -> bool:
    """A GAEB surcharge item: a percentage of other items, with no quantity or unit of its own."""
    return line.gaeb_flags.get("MarkupItem") == "Yes"


def bid_file_summary(ctx, missing, field: str, title: str):
    """GAEB 84 bids carry only prices; quantities, units and texts are in the tender (GAEB 83).

    Instead of one error per line, report the gap once so it doesn't bury the real findings.
    """
    return ctx.finding(
        severity="info", title=title,
        message=f"{len(missing)} of {len(ctx.input.lines)} items have no {field}. GAEB 84 bids only carry prices; "
                f"analyze them together with the tender (GAEB 83) to check the {field}s.",
        evidence={f"lines_without_{field}": len(missing)}, related_line_ids=[line.id for line in missing][:50],
        suggested_fix=review_fix(f"Attach the corresponding tender and verify the {field} against its position numbers."),
    )


@rule("L1.QTY.MISSING", layer=1, category="completeness", severity="error", title="Quantity missing",
      description="An item without quantity cannot be priced or totalled. Lump sums are checked separately. "
                  "Bid files (GAEB 84) carry no quantities and are reported once.")
def quantity_missing(ctx):
    missing = [line for line in ctx.input.lines
               if line.quantity is None and line.pricing_basis != "lump_sum" and line.unit != "lump_sum"]
    if missing and ctx.input.project.gaeb_phase == BID_PHASE:
        yield bid_file_summary(ctx, missing, "quantity", "Bid file without quantities")
        return
    for line in missing:
        raw = f" The source contains {line.quantity_raw!r}, which is not a number." if line.quantity_raw else ""
        yield ctx.finding(line=line, field="quantity", message=f"{label(line)} has no quantity.{raw}",
                          evidence={"quantity_raw": line.quantity_raw},
                          suggested_fix=review_fix("Confirm the quantity in the tender or approved takeoff, then enter it "
                                                   "in the stated billing unit and recheck the line amount."))


@rule("L1.QTY.NEGATIVE", layer=1, category="completeness", severity="error", title="Negative quantity",
      description="Quantities in a bill of quantities are never negative.")
def quantity_negative(ctx):
    for line in ctx.input.lines:
        if line.quantity is not None and line.quantity < 0:
            yield ctx.finding(line=line, field="quantity", message=f"{label(line)} has quantity {line.quantity}.",
                              evidence={"quantity": line.quantity},
                              suggested_fix=review_fix("Verify the sign against the takeoff. Enter the approved quantity "
                                                       "or confirm how an intended credit should be recorded."))


@rule("L1.QTY.ZERO", layer=1, category="completeness", severity="warning", title="Quantity is zero",
      description="Quantity 0 on a counted item. With a unit price the line contributes nothing to the total.")
def quantity_zero(ctx):
    for line in ctx.input.lines:
        if line.quantity is None or line.quantity != 0 or line.total_rule == "unit_price_only":
            continue
        unit_price = (line.source_amounts.unit_price if line.source_amounts else None) or \
            (line.price.unit_price if line.price else None)
        if unit_price:
            message = (f"{label(line)} has a unit price of {unit_price} but quantity 0, so it adds nothing to the "
                       f"total. Either the quantity is missing or the item should be unit-price-only.")
            yield ctx.finding(line=line, field="quantity", severity="error", message=message,
                              evidence={"quantity": line.quantity, "unit_price": unit_price},
                              suggested_fix=review_fix("Check whether the tender intends a unit-price-only position. "
                                                       "For a counted position, enter the approved quantity and recalculate."))
        else:
            yield ctx.finding(line=line, field="quantity", message=f"{label(line)} has quantity 0.",
                              evidence={"quantity": line.quantity},
                              suggested_fix=review_fix("Confirm whether the zero quantity is intentional. If work is "
                                                       "included, enter the measured quantity from the takeoff."))


@rule("L1.QTY.FRACTIONAL_COUNT", layer=1, category="completeness", severity="warning",
      title="Fractional quantity in a count unit", description="Items counted in pieces or sets need whole numbers.")
def fractional_count(ctx):
    for line in ctx.input.lines:
        if line.quantity is None or units.dimension(line.unit) is not units.Dimension.COUNT:
            continue
        if line.quantity != line.quantity.to_integral_value():
            yield ctx.finding(line=line, field="quantity",
                              message=f"{label(line)} is counted in {line.unit_raw or line.unit} but has quantity "
                                      f"{line.quantity}.",
                              evidence={"quantity": line.quantity, "unit": line.unit},
                              suggested_fix=review_fix("Confirm the whole count in the takeoff or correct the billing unit "
                                                       "if the work is measured. Recheck the amount after the correction."))


@rule("L1.UNIT.MISSING", layer=1, category="completeness", severity="error", title="Unit missing",
      description="Without a unit the quantity has no meaning and no price can be matched. Surcharge items have no "
                  "unit, and bid files (GAEB 84) carry no units and are reported once.")
def unit_missing(ctx):
    missing = [line for line in ctx.input.lines if line.unit is None and not is_markup(line)]
    if missing and ctx.input.project.gaeb_phase == BID_PHASE:
        yield bid_file_summary(ctx, missing, "unit", "Bid file without units")
        return
    for line in missing:
        if line.pricing_basis == "lump_sum":
            fix = Fix(operations=[SetField(line_id=line.id, field="unit", old_value=None, new_value="lump_sum")],
                      confidence=0.9, rationale="The item is flagged as a lump sum.")
        else:
            fix = review_fix("Copy the confirmed billing unit from the tender or measurement specification. "
                             "Verify that the quantity and rate use that same unit.")
        yield ctx.finding(line=line, field="unit", message=f"{label(line)} has no unit.", suggested_fix=fix,
                          evidence={"quantity": line.quantity, "pricing_basis": line.pricing_basis})


@rule("L1.UNIT.UNKNOWN", layer=1, category="unit", severity="warning", title="Unknown unit",
      description="The unit is not in the shared vocabulary, so it cannot be compared or converted.")
def unit_unknown(ctx):
    for line in ctx.input.lines:
        if line.unit is not None and not units.is_known(line.unit):
            source_unit = line.unit_raw or line.unit
            yield ctx.finding(line=line, field="unit", message=f"{label(line)} uses the unknown unit {source_unit!r}.",
                              evidence={"unit_raw": source_unit},
                              suggested_fix=review_fix("Confirm what the stated unit measures. Use its recognized "
                                                       "equivalent and check that any conversion also updates the quantity and rate."))


@rule("L1.TEXT.MISSING", layer=1, category="completeness", severity="error", title="Description missing",
      description="Item without short and long text. Bid files (GAEB 84) carry no texts and are reported once.")
def text_missing(ctx):
    missing = [line for line in ctx.input.lines if not line.short_text and not line.long_text]
    if not missing:
        return
    if ctx.input.project.gaeb_phase == BID_PHASE:
        yield bid_file_summary(ctx, missing, "text", "Bid file without descriptions")
        return
    for line in missing:
        yield ctx.finding(line=line, field="short_text", message=f"{label(line)} has no description.",
                          suggested_fix=review_fix("Restore the description from the corresponding tender position "
                                                   "or obtain a specification from the issuer."))


@rule("L1.CODE.MISSING", layer=1, category="structure", severity="error", title="OZ code missing or damaged",
      description="Every item needs an ordinal number (OZ) to be referenced in bids, awards and invoices.")
def code_missing(ctx):
    for line in ctx.input.lines:
        if not line.code:
            raw = "".join(line.code_parts) or None
            yield ctx.finding(line=line, field="code",
                              message=f"Item '{label(line)}' has no valid OZ code"
                                      + (f" (source: {raw!r})." if raw else "."),
                              evidence={"code_parts": line.code_parts},
                              suggested_fix=review_fix("Check the source record against the tender position and section. "
                                                       "Confirm the intended number before repairing the position and its references."))


@rule("L1.CODE.DUPLICATE", layer=1, category="structure", severity="error", title="Duplicate OZ code",
      description="Two items share the same ordinal number.")
def code_duplicate(ctx):
    by_code = defaultdict(list)
    for line in ctx.input.lines:
        if line.code:
            sheet = line.source_locator.get("sheet")
            by_code[(sheet if isinstance(sheet, str) else None, line.code)].append(line)
    for (sheet, code), lines in by_code.items():
        first, *repeats = lines
        for line in repeats:
            yield ctx.finding(line=line, field="code", related_line_ids=[first.id],
                              message=f"OZ {code} is used {len(lines)} times" + (f" on sheet {sheet}." if sheet else "."),
                              evidence={"code": code, "occurrences": len(lines), **({"sheet": sheet} if sheet else {})},
                              suggested_fix=review_fix("Compare the linked positions with the tender. Remove a confirmed "
                                                       "duplicate or give distinct work unique numbers and update references."))
