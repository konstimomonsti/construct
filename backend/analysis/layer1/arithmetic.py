"""Amounts written in the file: line amounts, section subtotals, net total.

When quantity x unit price and the stated amount disagree, VOB/A §16c makes the unit price prevail,
so the corrected amount is quantity x unit price.
"""

from decimal import Decimal

from .. import units
from ..graph import validate_graph
from ..registry import rule
from .common import THRESHOLDS, is_counted, label, money, section_label


@rule("L1.ARITH.LINE_AMOUNT", layer=1, category="arithmetic", severity="error", title="Line amount is wrong",
      description="Quantity x unit price differs from the stated line amount. The unit price prevails (VOB/A §16c).")
def line_amount(ctx):
    invalid_lines = validate_graph(ctx.input).invalid_line_ids
    for line in ctx.input.lines:
        if line.id in invalid_lines:
            continue
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


def working_line_amount(line, currency=None) -> Decimal | None:
    price = line.price
    quantity = line.quantity
    if price and price.unit_price is not None:
        if currency and price.currency and price.currency != currency:
            return None
        if price.price_unit and price.price_unit != line.unit:
            quantity = units.convert(quantity, line.unit, price.price_unit) if quantity is not None else None
            if quantity is None:
                return None
        rate = price.unit_price
    elif line.source_amounts:
        rate = line.source_amounts.unit_price
        if rate is None and line.gaeb_flags.get("MarkupItem") == "Yes":
            return line.source_amounts.line_amount
    else:
        return None
    if rate is None:
        return None
    if quantity is not None:
        return money(quantity * rate)
    return money(rate) if line.pricing_basis == "lump_sum" else None


def working_totals(analysis_input, graph) -> dict:
    total = Decimal(0)
    missing = 0
    counted = 0
    for line in analysis_input.lines:
        if not is_counted(line):
            continue
        counted += 1
        amount = None if line.id in graph.invalid_line_ids else working_line_amount(line, analysis_input.project.currency)
        if amount is None:
            missing += 1
        else:
            total += amount
    source_net = analysis_input.bom.stated_net_total
    return {
        "currency": analysis_input.project.currency,
        "working_net": str(money(total)) if missing < counted else None,
        "complete": bool(counted) and not missing and graph.is_valid,
        "counted_positions": counted,
        "missing_amounts": missing,
        "source_net": str(source_net) if source_net is not None else None,
    }


def line_effective_amount(line) -> Decimal | None:
    if line.source_amounts and line.source_amounts.line_amount is not None:
        return line.source_amounts.line_amount
    return working_line_amount(line)


def _counted_amount(lines) -> Decimal | None:
    total = Decimal(0)
    for line in lines:
        if is_counted(line):
            amount = line_effective_amount(line)
            if amount is None:
                return None
            total += amount
    return total


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

    def __init__(self, analysis_input, graph=None):
        if graph is None:
            graph = validate_graph(analysis_input)
        self.graph = graph
        self.invalid_section_ids = graph.invalid_section_ids
        sections_by_id = {s.id: s for s in analysis_input.sections}

        self.lines: dict[str | None, list] = {}
        self.incomplete: set[str | None] = {None} if self.invalid_section_ids else set()
        for line in analysis_input.lines:
            if line.id in graph.invalid_line_ids:
                if is_counted(line):
                    self.incomplete.add(None)
                    section_id = line.section_id
                    while section_id in sections_by_id and section_id not in self.incomplete:
                        self.incomplete.add(section_id)
                        section_id = sections_by_id[section_id].parent_id
                continue
            self.lines.setdefault(line.section_id, []).append(line)

        self.children: dict[str | None, list] = {}
        for parent_id, child_ids in graph.safe_section_children.items():
            self.children[parent_id] = [sections_by_id[cid] for cid in child_ids if cid in sections_by_id]

        self._computed: dict[str | None, Decimal | None] = {}

    def computed(self, section_id: str | None) -> Decimal | None:
        """Amount of a section (None: the whole BoQ) from its items and its child sections.

        Returns None if section is invalid or BoQ has invalid branches.
        """
        pending = [(section_id, False)]
        while pending:
            current, visited = pending.pop()
            if current in self._computed:
                continue
            if current in self.invalid_section_ids or current in self.incomplete:
                self._computed[current] = None
                continue
            children = self.children.get(current, [])
            if visited:
                total = _counted_amount(self.lines.get(current, []))
                for child in children:
                    carried = self.carried(child)
                    amount = carried if carried is not None else self._computed[child.id]
                    if total is None or amount is None:
                        total = None
                        break
                    total += amount
                self._computed[current] = total
            else:
                pending.append((current, True))
                pending.extend((child.id, False) for child in children if self.carried(child) is None)
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
        if section.stated_total is None or section.id in sums.invalid_section_ids:
            continue
        computed = sums.computed(section.id)
        if computed is None:
            continue
        if section.stated_total == 0:
            yield ctx.finding(section=section, severity="info", title="Section subtotal not filled in",
                              message=f"Section {section_label(section)} states 0.00 but its items add up to {computed}.",
                              evidence={"stated": section.stated_total, "computed": computed})
            continue
        difference = section.stated_total - computed
        if abs(difference) <= THRESHOLDS.total_tolerance:
            continue
        explained = _unplaced_match(ctx, difference)
        hint = " An item outside every section has exactly the missing amount." if explained else ""
        discounted = sums.discounted_children(section.id)
        basis = f" (using the discounted or lump-sum totals of {', '.join(discounted)})" if discounted else ""
        yield ctx.finding(section=section, related_line_ids=explained,
                          message=f"Section {section_label(section)} states {section.stated_total}, its items add up "
                                  f"to {computed}{basis} (difference {difference}).{hint}",
                          evidence={"stated": section.stated_total, "computed": computed, "difference": difference,
                                    "discounted_subsections": discounted})


@rule("L1.ARITH.NET_TOTAL", layer=1, category="arithmetic", severity="error", title="Net total is wrong",
      description="The net total written in the file differs from the sum of all counted items.")
def net_total(ctx):
    stated = ctx.input.bom.stated_net_total
    if stated is None:
        return
    sums = _SectionSums(ctx.input)
    if sums.invalid_section_ids:
        return
    computed = sums.computed(None)
    if computed is None:
        return
    if stated == 0:
        yield ctx.finding(severity="info", title="Net total not filled in",
                          message=f"The file states a net total of 0.00 but its items add up to {computed}.",
                          evidence={"stated": stated, "computed": computed})
        return
    difference = stated - computed
    if abs(difference) <= THRESHOLDS.total_tolerance:
        return
    yield ctx.finding(message=f"The file states a net total of {stated}, its items add up to {computed} "
                              f"(difference {difference}).",
                      related_line_ids=_unplaced_match(ctx, difference),
                      evidence={"stated": stated, "computed": computed, "difference": difference})
