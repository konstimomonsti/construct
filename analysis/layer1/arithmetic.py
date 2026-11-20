"""Amounts written in the file: line amounts, section subtotals, net total.

When quantity x unit price and the stated amount disagree, VOB/A §16c makes the unit price prevail,
so the corrected amount is quantity x unit price.
"""

from decimal import Decimal

from ..registry import rule
from .common import THRESHOLDS, is_counted, label, money, section_label, section_subtrees


@rule("L1.ARITH.LINE_AMOUNT", layer=1, category="arithmetic", severity="error", title="Line amount is wrong",
      description="Quantity x unit price differs from the stated line amount. The unit price prevails (VOB/A §16c).")
def line_amount(ctx):
    for line in ctx.input.lines:
        amounts = line.source_amounts
        if not amounts or amounts.unit_price is None or amounts.line_amount is None or line.quantity is None:
            continue
        if line.total_rule == "unit_price_only":
            continue  # reported by L1.STRUCT.UNIT_PRICE_ONLY_IN_TOTAL
        expected = money(line.quantity * amounts.unit_price)
        difference = amounts.line_amount - expected
        if abs(difference) > THRESHOLDS.line_amount_tolerance:
            yield ctx.finding(
                line=line, field="line_amount",
                message=f"{label(line)}: {line.quantity} x {amounts.unit_price} = {expected}, but the file states "
                        f"{amounts.line_amount}. The unit price prevails, so the amount should be {expected}.",
                evidence={"quantity": line.quantity, "unit_price": amounts.unit_price,
                          "stated_amount": amounts.line_amount, "expected_amount": expected, "difference": difference},
            )


def _counted_amount(lines) -> Decimal:
    return sum((line.source_amounts.line_amount for line in lines
                if is_counted(line) and line.source_amounts and line.source_amounts.line_amount is not None),
               Decimal(0))


def _unplaced_match(ctx, difference: Decimal) -> list[str]:
    """Lines outside every section whose amount explains the difference."""
    return [line.id for line in ctx.input.lines
            if line.section_id is None and line.source_amounts and line.source_amounts.line_amount is not None
            and abs(abs(difference) - line.source_amounts.line_amount) <= THRESHOLDS.total_tolerance]


@rule("L1.ARITH.SECTION_TOTAL", layer=1, category="arithmetic", severity="error", title="Section subtotal is wrong",
      description="The subtotal written in the file differs from the sum of the counted items of the section.")
def section_total(ctx):
    subtrees = section_subtrees(ctx.input)
    for section in ctx.input.sections:
        if section.stated_total is None:
            continue
        lines = [line for line in ctx.input.lines if line.section_id in subtrees[section.id]]
        computed = _counted_amount(lines)
        difference = section.stated_total - computed
        if abs(difference) <= THRESHOLDS.total_tolerance:
            continue
        if section.stated_total == 0:
            yield ctx.finding(section=section, severity="info", title="Section subtotal not filled in",
                              message=f"Section {section_label(section)} states 0.00 but its items add up to {computed}.",
                              evidence={"stated": section.stated_total, "computed": computed})
            continue
        explained = _unplaced_match(ctx, difference)
        hint = " An item outside every section has exactly the missing amount." if explained else ""
        yield ctx.finding(section=section, related_line_ids=explained,
                          message=f"Section {section_label(section)} states {section.stated_total}, its items add up "
                                  f"to {computed} (difference {difference}).{hint}",
                          evidence={"stated": section.stated_total, "computed": computed, "difference": difference})


@rule("L1.ARITH.NET_TOTAL", layer=1, category="arithmetic", severity="error", title="Net total is wrong",
      description="The net total written in the file differs from the sum of all counted items.")
def net_total(ctx):
    stated = ctx.input.bom.stated_net_total
    if stated is None:
        return
    computed = _counted_amount(ctx.input.lines)
    difference = stated - computed
    if abs(difference) <= THRESHOLDS.total_tolerance:
        return
    if stated == 0:
        yield ctx.finding(severity="info", title="Net total not filled in",
                          message=f"The file states a net total of 0.00 but its items add up to {computed}.",
                          evidence={"stated": stated, "computed": computed})
        return
    yield ctx.finding(message=f"The file states a net total of {stated}, its items add up to {computed} "
                              f"(difference {difference}).",
                      related_line_ids=_unplaced_match(ctx, difference),
                      evidence={"stated": stated, "computed": computed, "difference": difference})
