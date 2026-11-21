"""Amounts written in the file: line amounts, section subtotals, net total.

When quantity x unit price and the stated amount disagree, VOB/A §16c makes the unit price prevail,
so the corrected amount is quantity x unit price.
"""

from dataclasses import dataclass, field
from decimal import Decimal

from ..contracts import Fix, Line
from ..registry import rule
from .common import THRESHOLDS, is_counted, label, money, review_fix, section_label


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


_MISSING_POSITION_LIMIT = 20


@dataclass
class _AmountBasis:
    known_amount: Decimal = Decimal(0)
    missing_count: int = 0
    missing_positions: list[Line] = field(default_factory=list)
    reconstructed_count: int = 0

    def add_missing(self, count: int, positions: list[Line]) -> None:
        self.missing_count += count
        remaining = _MISSING_POSITION_LIMIT - len(self.missing_positions)
        self.missing_positions.extend(positions[:remaining])


def _counted_amounts(lines: list[Line]) -> _AmountBasis:
    basis = _AmountBasis()
    for line in lines:
        if not is_counted(line):
            continue
        amounts = line.source_amounts
        if amounts and amounts.line_amount is not None:
            basis.known_amount += amounts.line_amount
        elif amounts and amounts.unit_price is not None and line.quantity is not None:
            basis.known_amount += money(line.quantity * amounts.unit_price)
            basis.reconstructed_count += 1
        else:
            basis.add_missing(1, [line])
    return basis


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
        self._computed: dict[str | None, _AmountBasis] = {}

    def computed(self, section_id: str | None) -> _AmountBasis:
        """Known amounts and unresolved positions within a section or the whole BoQ."""
        if section_id not in self._computed:
            basis = _counted_amounts(self.lines.get(section_id, []))
            for child in self.children.get(section_id, []):
                carried = self.carried(child)
                if carried is not None:
                    basis.known_amount += carried
                    continue
                child_basis = self.computed(child.id)
                basis.known_amount += child_basis.known_amount
                basis.reconstructed_count += child_basis.reconstructed_count
                basis.add_missing(child_basis.missing_count, child_basis.missing_positions)
            self._computed[section_id] = basis
        return self._computed[section_id]

    def discounted_children(self, section_id: str | None) -> list[str]:
        return [section_label(child) for child in self.children.get(section_id, [])
                if self.carried(child) is not None]


def _unplaced_match(ctx, difference: Decimal) -> list[str]:
    """Lines outside every section whose amount explains the difference."""
    return [line.id for line in ctx.input.lines
            if line.section_id is None and line.source_amounts and line.source_amounts.line_amount is not None
            and abs(abs(difference) - line.source_amounts.line_amount) <= THRESHOLDS.total_tolerance]


def _incomplete_total(ctx, basis, stated, *, title, locator, section=None):
    subjects = [line.id for line in basis.missing_positions]
    return ctx.finding(
        section=section, severity="info", title=title, source_locator=locator,
        related_line_ids=subjects,
        message=f"The stated total is {stated}. Known amounts sum to {basis.known_amount}, and "
                f"{basis.missing_count} counted position(s) lack enough source data to verify the total.",
        evidence={
            "reason": "incomplete_source_amounts", "stated": stated, "known_amount": basis.known_amount,
            "missing_count": basis.missing_count, "reconstructed_count": basis.reconstructed_count,
            "missing_positions": [{"line_id": line.id, "code": line.code, "source_locator": line.source_locator}
                                  for line in basis.missing_positions],
        },
        suggested_fix=review_fix("Check the linked positions in the original bill. Obtain each written line "
                                 "amount or its quantity and unit price, then recalculate the total."),
    )


@rule("L1.ARITH.SECTION_TOTAL", layer=1, category="arithmetic", severity="error", title="Section subtotal is wrong",
      description="The subtotal written in the file differs from the sum of the counted items of the section.")
def section_total(ctx):
    sums = _SectionSums(ctx.input)
    for section in ctx.input.sections:
        if section.stated_total is None:
            continue
        amount_basis = sums.computed(section.id)
        locator = section.stated_total_locator or None
        if section.stated_total != 0 and amount_basis.missing_count:
            yield _incomplete_total(ctx, amount_basis, section.stated_total, section=section,
                                    title="Section subtotal could not be verified", locator=locator)
            continue
        computed = amount_basis.known_amount
        difference = section.stated_total - computed
        if abs(difference) <= THRESHOLDS.total_tolerance:
            continue
        if section.stated_total == 0:
            yield ctx.finding(section=section, severity="info", title="Section subtotal not filled in",
                              source_locator=locator,
                              message=f"Section {section_label(section)} states 0.00. The known amounts sum to {computed}.",
                              evidence={"stated": section.stated_total,
                                        "known_amount" if amount_basis.missing_count else "computed": computed})
            continue
        explained = _unplaced_match(ctx, difference)
        hint = " An item outside every section has exactly the missing amount." if explained else ""
        discounted = sums.discounted_children(section.id)
        basis = f" (using the discounted or lump-sum totals of {', '.join(discounted)})" if discounted else ""
        yield ctx.finding(section=section, related_line_ids=explained,
                          source_locator=locator,
                          message=f"Section {section_label(section)} states {section.stated_total}, its items add up "
                                  f"to {computed}{basis} (difference {difference}).{hint}",
                          evidence={"stated": section.stated_total, "computed": computed, "difference": difference,
                                    "discounted_subsections": discounted,
                                    "reconstructed_count": amount_basis.reconstructed_count},
                          suggested_fix=Fix(operations=[], confidence=0.7,
                                            rationale="Confirm which positions belong to this section and resolve any "
                                                      "line amount, discount, or lump-sum discrepancies. Then recalculate the subtotal."))


@rule("L1.ARITH.NET_TOTAL", layer=1, category="arithmetic", severity="error", title="Net total is wrong",
      description="The net total written in the file differs from the sum of all counted items.")
def net_total(ctx):
    stated = ctx.input.bom.stated_net_total
    if stated is None:
        return
    amount_basis = _SectionSums(ctx.input).computed(None)
    locator = ctx.input.bom.stated_net_total_locator or None
    if stated != 0 and amount_basis.missing_count:
        yield _incomplete_total(ctx, amount_basis, stated, title="Net total could not be verified", locator=locator)
        return
    computed = amount_basis.known_amount
    difference = stated - computed
    if abs(difference) <= THRESHOLDS.total_tolerance:
        return
    if stated == 0:
        yield ctx.finding(severity="info", title="Net total not filled in",
                          source_locator=locator,
                          message=f"The file states a net total of 0.00. The known amounts sum to {computed}.",
                          evidence={"stated": stated,
                                    "known_amount" if amount_basis.missing_count else "computed": computed})
        return
    yield ctx.finding(message=f"The file states a net total of {stated}, its items add up to {computed} "
                              f"(difference {difference}).",
                      related_line_ids=_unplaced_match(ctx, difference),
                      source_locator=locator,
                      evidence={"stated": stated, "computed": computed, "difference": difference,
                                "reconstructed_count": amount_basis.reconstructed_count},
                      suggested_fix=Fix(operations=[], confidence=0.7,
                                        rationale="Reconcile the counted positions and corrected section totals, "
                                                  "including discounts and lump sums, then recalculate the net total."))
