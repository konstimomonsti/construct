"""Values that are present but contradict each other: unit vs text, lump sums, structure, duplicates, texts."""

from collections import defaultdict
from decimal import Decimal

from .. import units
from ..contracts import Fix, SetField
from ..registry import rule
from .common import (
    BILLING_UNIT, BIDDER_INPUT, OR_EQUIVALENT, THRESHOLDS, excerpt, is_optional, label, phase_has_prices, section_label,
    text_of,
)


@rule("L1.UNIT.TEXT_MISMATCH", layer=1, category="unit", severity="warning", title="Unit contradicts the text",
      description="The description states how the item is measured ('Abrechnung nach m2') and it differs from the unit.")
def unit_text_mismatch(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        match = BILLING_UNIT.search(text)
        if not match or line.unit is None:
            continue
        stated = units.normalize(match.group(1))
        if stated == "lump_sum" and line.pricing_basis == "lump_sum":
            continue
        if stated == line.unit or units.dimension(stated) is units.Dimension.UNKNOWN:
            continue
        fix = Fix(operations=[SetField(line_id=line.id, field="unit", old_value=line.unit, new_value=stated)],
                  confidence=0.6, rationale=f"The text says {match.group(0)!r}.")
        yield ctx.finding(line=line, field="unit", suggested_fix=fix,
                          message=f"{label(line)} is measured in {line.unit_raw or line.unit}, but the text says "
                                  f"{match.group(0)!r}.",
                          evidence={"unit": line.unit, "stated_unit": stated, "excerpt": excerpt(text, match)})


@rule("L1.LUMP.INCONSISTENT", layer=1, category="unit", severity="warning", title="Inconsistent lump sum",
      description="A lump sum (psch) should have quantity 1, and a lump-sum flag should not carry a measured unit.")
def lump_inconsistent(ctx):
    for line in ctx.input.lines:
        if line.unit == "lump_sum" and line.quantity is not None and line.quantity != 1:
            yield ctx.finding(line=line, field="quantity", discriminator="quantity",
                              message=f"{label(line)} is a lump sum (psch) with quantity {line.quantity}.",
                              evidence={"quantity": line.quantity, "unit": line.unit})
        elif line.unit == "lump_sum" and line.quantity is None:
            fix = Fix(operations=[SetField(line_id=line.id, field="quantity", old_value=None, new_value=Decimal(1))],
                      confidence=0.8, rationale="Lump sums are quantity 1.")
            yield ctx.finding(line=line, field="quantity", discriminator="quantity", severity="info",
                              suggested_fix=fix, message=f"{label(line)} is a lump sum without quantity.")
        elif line.pricing_basis == "lump_sum" and units.dimension(line.unit) not in (
                units.Dimension.LUMP, units.Dimension.UNKNOWN, units.Dimension.COUNT):
            yield ctx.finding(line=line, field="unit", discriminator="unit",
                              message=f"{label(line)} is flagged as a lump sum but measured in "
                                      f"{line.unit_raw or line.unit} (quantity {line.quantity}).",
                              evidence={"unit": line.unit, "quantity": line.quantity})


@rule("L1.TEXT.BIDDER_INPUT", layer=1, category="text", severity="warning", title="Bidder field not filled in",
      description="Blanks the bidder must fill (product, type, values). Expected in a tender, an error in a bid or award.")
def bidder_input(ctx):
    priced = phase_has_prices(ctx.input)
    for line in ctx.input.lines:
        text = text_of(line)
        matches = list(BIDDER_INPUT.finditer(text))
        if not matches:
            continue
        if priced:
            message = (f"{label(line)} still has {len(matches)} empty bidder field(s), e.g. "
                       f"'{excerpt(text, matches[0])}'. The offered product or value is not specified.")
            severity = "warning"
        else:
            message = (f"{label(line)} asks the bidder to fill in {len(matches)} field(s), e.g. "
                       f"'{excerpt(text, matches[0])}'. These must be completed in the bid.")
            severity = "info"
        yield ctx.finding(line=line, field="long_text", severity=severity, message=message,
                          evidence={"blanks": len(matches), "excerpts": [excerpt(text, m) for m in matches[:3]]})


@rule("L1.TEXT.OR_EQUIVALENT", layer=1, category="text", severity="info", title="Reference product 'or equivalent'",
      description="A named product 'oder gleichwertig': the price should be checked against the reference product.")
def or_equivalent(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        match = OR_EQUIVALENT.search(text)
        if match:
            yield ctx.finding(line=line, field="long_text",
                              message=f"{label(line)} names a reference product 'or equivalent': "
                                      f"'{excerpt(text, match)}'. Confirm which technical criteria the offered product must meet.",
                              evidence={"excerpt": excerpt(text, match)})


@rule("L1.CODE.OUTSIDE_SECTION", layer=1, category="structure", severity="warning",
      title="OZ code does not match its section", description="The OZ prefix should be the code of the parent section.")
def code_outside_section(ctx):
    sections = ctx.input.section_by_id()
    section_codes = {tuple(section.code_parts) for section in sections.values() if section.code_parts}
    for line in ctx.input.lines:
        section = sections.get(line.section_id)
        if not section or not section.code_parts or not line.code:
            continue
        if line.code_parts[:len(section.code_parts)] != section.code_parts:
            expected = next((tuple(line.code_parts[:depth]) for depth in range(len(line.code_parts) - 1, 0, -1)
                             if tuple(line.code_parts[:depth]) in section_codes), None)
            consequence = (" Check which section should include its amount and export this position."
                           if expected else " Check whether the position number should use this section’s prefix.")
            yield ctx.finding(line=line, field="code", severity="warning" if expected else "info",
                              message=f"OZ {line.code} sits in section {section_label(section)}." + consequence,
                              evidence={"code": line.code, "section_code": section.code,
                                        "matching_section_code": ".".join(expected) if expected else None})


@rule("L1.STRUCT.ORPHAN_LINE", layer=1, category="structure", severity="warning", title="Item outside any section",
      description="The document has sections but this item could not be placed in one.")
def orphan_line(ctx):
    if not ctx.input.sections:
        return
    for line in ctx.input.lines:
        if line.section_id is None:
            yield ctx.finding(line=line, field="section",
                              message=f"{label(line)} is not inside any section, so it is missing from section subtotals.")


@rule("L1.STRUCT.ORPHAN_ALTERNATIVE", layer=1, category="structure", severity="warning",
      title="Alternative item without base item", description="A Wahlposition must refer to a Grundposition.")
def orphan_alternative(ctx):
    for line in ctx.input.lines:
        is_alternative = line.gaeb_flags.get("position_type") == "A" or line.gaeb_flags.get("AltItem")
        if is_alternative and not line.alternative_for:
            yield ctx.finding(line=line, field="alternative_for",
                              message=f"{label(line)} is an alternative item but no base item precedes it.")


@rule("L1.STRUCT.PROVISIONAL_ITEM", layer=1, category="structure", severity="info", title="Optional item (Bedarfsposition)",
      description="Optional items may be included in the written total depending on their GAEB pricing flag.")
def provisional_item(ctx):
    for line in ctx.input.lines:
        if is_optional(line):
            yield ctx.finding(line=line, field="total_rule",
                              message=f"{label(line)} is an optional item. Confirm the quantity to price and whether it will be evaluated.",
                              evidence={"total_rule": line.total_rule, "flags": line.gaeb_flags})


@rule("L1.STRUCT.UNIT_PRICE_ONLY_IN_TOTAL", layer=1, category="arithmetic", severity="error",
      title="Unit-price-only item has an amount", description="'Nur Einheitspreis' items must not carry a line amount.")
def unit_price_only_in_total(ctx):
    for line in ctx.input.lines:
        amount = line.source_amounts.line_amount if line.source_amounts else None
        # A Bedarfsposition ohne GB may show its amount for information; the section and net-total checks
        # already catch a file that adds it to the total. Only real "Nur Einheitspreis" items are wrong here.
        if line.total_rule == "unit_price_only" and amount and not is_optional(line):
            yield ctx.finding(line=line, field="line_amount",
                              message=f"{label(line)} is unit-price-only but has a line amount of {amount}. "
                                      f"It must not be added to the total.",
                              evidence={"line_amount": amount})


@rule("L1.DUP.SUSPECTED", layer=1, category="duplicate", severity="warning", title="Possible duplicate item",
      description="Same description and unit twice in the same section: possible double counting.")
def suspected_duplicate(ctx):
    groups = defaultdict(list)
    for line in ctx.input.lines:
        if not line.short_text:
            continue
        key = (line.section_id, line.short_text.casefold(), (line.long_text or "").casefold(), line.unit)
        groups[key].append(line)
    for lines in groups.values():
        first, *repeats = lines
        for line in repeats:
            yield ctx.finding(line=line, related_line_ids=[first.id],
                              message=f"{label(line)} and {first.code or first.id} have the same description and unit "
                                      f"in this section (quantities {line.quantity} and {first.quantity}). Compare "
                                      "their locations and scope before adjusting either position.",
                              evidence={"same_as": first.code, "quantities": [first.quantity, line.quantity]})


@rule("L1.DIST.SUM_MISMATCH", layer=1, category="arithmetic", severity="warning",
      title="Room quantities do not add up", description="The per-room split must equal the line quantity.")
def distribution_mismatch(ctx):
    for line in ctx.input.lines:
        if not line.distributions or line.quantity is None:
            continue
        if any(d.quantity is None for d in line.distributions):
            continue
        total = sum(d.quantity for d in line.distributions)
        if abs(total - line.quantity) > THRESHOLDS.distribution_tolerance:
            yield ctx.finding(line=line, field="quantity",
                              message=f"{label(line)}: rooms add up to {total}, the line says {line.quantity}.",
                              evidence={"quantity": line.quantity, "distributed": total})
