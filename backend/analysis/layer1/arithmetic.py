"""Amounts written in the file: line amounts, section subtotals, net total.

When quantity x unit price and the stated amount disagree, VOB/A §16c makes the unit price prevail,
so the corrected amount is quantity x unit price.
"""

from decimal import Decimal

from ..contracts import Fix
from ..registry import rule
from .common import THRESHOLDS, is_counted, label, money, section_label


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
                suggested_fix=Fix(operations=[], confidence=0.9,
                                  rationale=f"Verify the source quantity and unit price. If both are correct, "
                                            f"recalculate the written line amount to {expected}."),
            )


def _counted_amount(lines) -> Decimal:
    return sum((line.source_amounts.line_amount for line in lines
                if is_counted(line) and line.source_amounts and line.source_amounts.line_amount is not None),
               Decimal(0))


class _SectionSums:
    """What each section and the whole BoQ should add up to.

    A section adds its own counted items plus, for each child section, the amount the file carries up:
    the child's total after discount (GAEB XML TotAfterDisc), else its lump-sum price (TotalLSUM),
    else the child's computed amount. Without either, this is the plain sum of all counted items below.
    """

    @staticmethod
    def carried(section) -> Decimal | None:
        if section.stated_total_after_discount is not None:
            return section.stated_total_after_discount
        return section.stated_lump_sum_total

    def __init__(self, analysis_input):
        known = {section.id for section in analysis_input.sections}
        self.lines: dict[str | None, list] = {}
        for line in analysis_input.lines:
            self.lines.setdefault(line.section_id if line.section_id in known else None, []).append(line)
        self.children: dict[str | None, list] = {}
        for section in analysis_input.sections:
            self.children.setdefault(section.parent_id if section.parent_id in known else None, []).append(section)
        self._computed: dict[str | None, Decimal] = {}

    def computed(self, section_id: str | None) -> Decimal:
        """Amount of a section (None: the whole BoQ) from its items and its child sections."""
        if section_id not in self._computed:
            total = _counted_amount(self.lines.get(section_id, []))
            for child in self.children.get(section_id, []):
                carried = self.carried(child)
                total += carried if carried is not None else self.computed(child.id)
            self._computed[section_id] = total
        return self._computed[section_id]

    def discounted_children(self, section_id: str | None) -> list[str]:
        return [section_label(child) for child in self.children.get(section_id, [])
                if self.carried(child) is not None]


def _unplaced_match(ctx, difference: Decimal) -> list[str]:
    """Lines outside every section whose amount explains the difference."""
    return [line.id for line in ctx.input.lines
            if line.section_id is None and line.source_amounts and line.source_amounts.line_amount is not None
            and abs(abs(difference) - line.source_amounts.line_amount) <= THRESHOLDS.total_tolerance]


@rule("L1.ARITH.SECTION_TOTAL", layer=1, category="arithmetic", severity="error", title="Section subtotal is wrong",
      description="The subtotal written in the file differs from the sum of the counted items of the section.")
def section_total(ctx):
    sums = _SectionSums(ctx.input)
    for section in ctx.input.sections:
        if section.stated_total is None:
            continue
        computed = sums.computed(section.id)
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
        discounted = sums.discounted_children(section.id)
        basis = f" (using the discounted or lump-sum totals of {', '.join(discounted)})" if discounted else ""
        yield ctx.finding(section=section, related_line_ids=explained,
                          message=f"Section {section_label(section)} states {section.stated_total}, its items add up "
                                  f"to {computed}{basis} (difference {difference}).{hint}",
                          evidence={"stated": section.stated_total, "computed": computed, "difference": difference,
                                    "discounted_subsections": discounted},
                          suggested_fix=Fix(operations=[], confidence=0.7,
                                            rationale="Confirm which positions belong to this section and resolve any "
                                                      "line amount, discount, or lump-sum discrepancies. Then recalculate the subtotal."))


@rule("L1.ARITH.NET_TOTAL", layer=1, category="arithmetic", severity="error", title="Net total is wrong",
      description="The net total written in the file differs from the sum of all counted items.")
def net_total(ctx):
    stated = ctx.input.bom.stated_net_total
    if stated is None:
        return
    computed = _SectionSums(ctx.input).computed(None)
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
                      evidence={"stated": stated, "computed": computed, "difference": difference},
                      suggested_fix=Fix(operations=[], confidence=0.7,
                                        rationale="Reconcile the counted positions and corrected section totals, "
                                                  "including discounts and lump sums, then recalculate the net total."))
