"""Simulate unit-rate bids against explicit award and quantity scenarios."""

from dataclasses import dataclass, replace
from decimal import ROUND_CEILING, Decimal
from fractions import Fraction
from heapq import heappop, heappush
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .adapter import to_decimal
from .contracts import AddLine, AnalysisInput, AnalysisResult, Line
from .layer1.common import money
from .units import Dimension, convert, dimension

CENT = Decimal("0.01")
ZERO = Decimal(0)
DEFAULT_SEARCH_NODES = 512
Rate = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)]
Probability = Annotated[Decimal, Field(ge=0, le=1, max_digits=18, decimal_places=12)]


class Assumption(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PriceBand(Assumption):
    unit_cost: Rate
    standard_rate: Rate
    min_rate: Rate | None = None
    max_rate: Rate | None = None

    @property
    def floor(self):
        return self.standard_rate if self.min_rate is None else self.min_rate

    @property
    def ceiling(self):
        return self.standard_rate if self.max_rate is None else self.max_rate

    @model_validator(mode="after")
    def validate_band(self):
        if not self.unit_cost <= self.floor <= self.standard_rate <= self.ceiling:
            raise ValueError("Expected unit cost <= minimum <= standard <= maximum rate")
        return self


class QuantityChange(Assumption):
    extra_quantity: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    finding_rule: str | None = Field(default=None, min_length=1)
    quoted_rate_share: Probability
    other_unit_rate: Rate | None = None

    @model_validator(mode="after")
    def validate_quantity_source(self):
        if (self.extra_quantity is None) == (self.finding_rule is None):
            raise ValueError("Specify either an extra quantity or a shortfall rule")
        if self.quoted_rate_share < 1 and self.other_unit_rate is None:
            raise ValueError("Specify the settlement rate for units paid outside the bid rate")
        return self


class MarketScenario(Assumption):
    name: str = Field(min_length=1)
    probability: Probability = Field(gt=0)
    winning_bid_ceiling: Rate
    changes: dict[str, QuantityChange] = Field(default_factory=dict)


class PricingAssumptions(Assumption):
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    prices: dict[str, PriceBand] = Field(min_length=1)
    scenarios: list[MarketScenario] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_scenarios(self):
        if sum(s.probability for s in self.scenarios) != 1:
            raise ValueError("Scenario probabilities must sum to 1")
        if len({s.name for s in self.scenarios}) != len(self.scenarios):
            raise ValueError("Scenario names must be unique")
        return self


@dataclass(frozen=True)
class Position:
    quantity: Decimal
    band: PriceBand


@dataclass(frozen=True)
class Change:
    quantity: Decimal
    quoted_share: Decimal
    other_rate: Decimal
    finding_id: str | None = None
    ai_review_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class Scenario:
    name: str
    probability: Decimal
    ceiling: Decimal
    changes: dict[str, Change]


def _finding_change(line: Line, rule_id: str, result: AnalysisResult) -> tuple[Decimal, str, tuple[str, ...]]:
    matches = [f for f in result.findings if f.rule_id == rule_id and f.layer == 2
               and f.severity == "warning" and f.status not in {"rejected", "stale", "applied"}
               and f.evidence.get("reason") == "quantity_shortfall"
               and f.evidence.get("dependency_line_ids") == [line.id]]
    if len(matches) != 1:
        raise ValueError(f"{line.code or line.id}: {rule_id} must identify one shortfall on this single position")
    return _resolve_finding(line, matches[0], result)


def _resolve_finding(line, finding, result):
    evidence = finding.evidence
    unit = evidence.get("quantity_unit")
    scoped_quantity = convert(line.quantity, line.unit, unit)
    proposals = [op.line for op in finding.suggested_fix.operations
                 if isinstance(op, AddLine)] if finding.suggested_fix else []
    if (scoped_quantity is None or scoped_quantity != to_decimal(evidence.get("dependency_quantity"))
            or len(proposals) != 1 or proposals[0].quantity is None):
        raise ValueError(f"{line.code or line.id}: enter a reviewed quantity for this partial or ambiguous shortfall")
    quantity = convert(proposals[0].quantity, proposals[0].unit, line.unit)
    if quantity is None or quantity <= 0:
        raise ValueError(f"{line.code or line.id}: shortfall cannot be converted to the position unit")
    reviews = [f for f in result.findings if f.rule_id == "L3.REVIEW.L2_CONFIRM"
               and f.status not in {"rejected", "stale"}
               and f.evidence.get("reviews_finding_id") == finding.id]
    if any(f.status == "accepted" and f.evidence.get("verdict") in {"included", "excluded"} for f in reviews):
        raise ValueError(f"{line.code or line.id}: an accepted review identifies alternative coverage or a scope exclusion")
    return quantity, finding.id, tuple(f.id for f in reviews)


def included_positions(snapshot: AnalysisInput) -> dict[str, tuple[Line, Decimal]]:
    if any(section.stated_total_after_discount is not None or section.stated_lump_sum_total is not None
           for section in snapshot.sections):
        raise ValueError("The simulator requires an undiscounted BoQ with position-level pricing")
    positions = {}
    for line in snapshot.lines:
        if line.total_rule != "include":
            continue
        key = line.code or line.id
        if key in positions:
            raise ValueError(f"Duplicate position key: {key}")
        quantity = line.quantity
        if line.pricing_basis == "lump_sum":
            kind = dimension(line.unit)
            if (kind not in {Dimension.LUMP, Dimension.UNKNOWN, Dimension.COUNT}
                    or (kind == Dimension.COUNT and quantity not in (None, Decimal(1)))):
                raise ValueError(f"{key}: unit and quantity conflict with lump-sum pricing")
            quantity = Decimal(1)
        if quantity is None or not quantity.is_finite() or quantity <= 0:
            raise ValueError(f"{key}: expected a positive tender quantity")
        positions[key] = (line, quantity)
    if not positions:
        raise ValueError("The tender has no positions in the bid total")
    return positions


def quantity_opportunities(snapshot: AnalysisInput, result: AnalysisResult) -> list[dict]:
    lines = snapshot.line_by_id()
    opportunities = []
    for finding in result.findings:
        ids = finding.evidence.get("dependency_line_ids")
        if (finding.layer != 2 or finding.evidence.get("reason") != "quantity_shortfall"
                or not isinstance(ids, list) or len(ids) != 1):
            continue
        line = lines.get(ids[0])
        if line is None or line.total_rule != "include" or line.pricing_basis != "unit_rate":
            continue
        try:
            quantity, finding_id, reviews = _finding_change(line, finding.rule_id, result)
        except ValueError:
            continue
        opportunities.append({"position": line.code or line.id, "quantity": quantity,
                              "title": finding.title, "rule_id": finding.rule_id,
                              "finding_id": finding_id, "ai_reviewed": bool(reviews)})
    return opportunities


def prepare(snapshot: AnalysisInput, result: AnalysisResult,
            assumptions: PricingAssumptions) -> tuple[dict[str, Position], list[Scenario]]:
    """Join explicit costs and scenarios to positions in the assessed snapshot."""
    if result.input_hash != snapshot.compute_hash():
        raise ValueError("Analysis result belongs to a different BoQ snapshot")
    if snapshot.project.currency and snapshot.project.currency != assumptions.currency:
        raise ValueError("Pricing assumptions and BoQ must use the same currency")

    included = included_positions(snapshot)
    if missing := included.keys() - assumptions.prices.keys():
        raise ValueError(f"Missing pricing assumptions for position {next(iter(sorted(missing)))}")
    if unknown := assumptions.prices.keys() - included.keys():
        raise ValueError(f"Pricing assumptions refer to positions outside the bid total: {', '.join(sorted(unknown))}")
    positions = {key: Position(quantity, assumptions.prices[key]) for key, (_, quantity) in included.items()}
    lines = {key: line for key, (line, _) in included.items()}

    resolved = {}
    scenarios = []
    for scenario in assumptions.scenarios:
        changes = {}
        for key, change in scenario.changes.items():
            line = lines.get(key)
            if line is None or line.pricing_basis != "unit_rate" or not line.unit:
                raise ValueError(f"{key}: quantity changes require an included position with a unit rate and unit")
            quantity, finding_id, review_ids = change.extra_quantity, None, ()
            if change.finding_rule:
                cache_key = (key, change.finding_rule)
                if cache_key not in resolved:
                    resolved[cache_key] = _finding_change(line, change.finding_rule, result)
                quantity, finding_id, review_ids = resolved[cache_key]
            changes[key] = Change(quantity, change.quoted_rate_share, change.other_unit_rate or ZERO,
                                  finding_id, review_ids)
        scenarios.append(Scenario(scenario.name, scenario.probability, scenario.winning_bid_ceiling, changes))
    return positions, scenarios


@dataclass(frozen=True)
class Bid:
    rates: dict[str, Decimal]
    bid_total: Decimal | None
    base_profit: Decimal
    win_probability: Decimal
    expected_profit: Decimal
    worst_awarded_profit: Decimal | None
    optimality_gap_bound: Decimal | None = None

    def summary(self):
        return {
            "bid_total": self.bid_total, "base_profit": money(self.base_profit),
            "win_probability": self.win_probability, "expected_profit": money(self.expected_profit),
            "worst_awarded_profit": (None if self.worst_awarded_profit is None else money(self.worst_awarded_profit)),
            "rates": self.rates,
            "optimality_gap_bound": self.optimality_gap_bound,
        }


def evaluate(positions: dict[str, Position], scenarios: list[Scenario], rates: dict[str, Decimal]) -> Bid:
    if not rates:
        return Bid({}, None, ZERO, ZERO, ZERO, None)
    bid_total = sum(money(p.quantity * rates[key]) for key, p in positions.items())
    base_profit = bid_total - sum(p.quantity * p.band.unit_cost for p in positions.values())
    expected = win_probability = ZERO
    awarded = []
    for scenario in scenarios:
        if bid_total > scenario.ceiling:
            continue
        changes_profit = sum(change.quantity * (
            change.quoted_share * rates[key] + (1 - change.quoted_share) * change.other_rate
            - positions[key].band.unit_cost
        ) for key, change in scenario.changes.items())
        profit = base_profit + changes_profit
        expected += scenario.probability * profit
        win_probability += scenario.probability
        awarded.append(profit)
    return Bid(rates, bid_total, base_profit, win_probability, expected, min(awarded, default=None))


def _rate_within_budget(quantity: Decimal, floor: Decimal, ceiling: Decimal, budget: Decimal) -> Decimal:
    # The line is rounded half up. Binary search whole cents for the highest feasible rate.
    low = int(floor / CENT)
    high = int(ceiling / CENT)
    while low < high:
        middle = (low + high + 1) // 2
        if money(quantity * middle * CENT) <= budget:
            low = middle
        else:
            high = middle - 1
    return low * CENT


def _greedy_optimize(positions: dict[str, Position], scenarios: list[Scenario],
                     reference_rates: dict[str, Decimal] | None = None) -> Bid:
    """Try each award ceiling and spend rate headroom in order of expected payoff per bid euro."""
    standard = {key: p.band.standard_rate for key, p in positions.items()}
    best = evaluate(positions, scenarios, {})
    for rates in (standard, reference_rates or {}):
        option = evaluate(positions, scenarios, rates)
        if option.expected_profit > best.expected_profit:
            best = option
    floors = {key: p.band.floor for key, p in positions.items()}
    floor_amounts = {key: money(p.quantity * floors[key]) for key, p in positions.items()}
    floor_total = sum(floor_amounts.values())
    raw_floor_total = sum(p.quantity * p.band.floor for p in positions.values())
    maximum_total = sum(money(p.quantity * p.band.ceiling) for p in positions.values())
    base_cost = sum(p.quantity * p.band.unit_cost for p in positions.values())
    rounding_allowance = CENT / 2 * sum(p.quantity % 1 != 0 for p in positions.values())
    segments = [(key, stage, limit) for key, p in positions.items()
                for stage, limit in enumerate((p.band.standard_rate, p.band.ceiling))]
    upper_bound = ZERO
    for ceiling in sorted({s.ceiling for s in scenarios if s.ceiling >= floor_total}):
        extra = dict.fromkeys(positions, ZERO)
        winners = [s for s in scenarios if s.ceiling >= ceiling]
        relaxed_profit = sum(s.probability for s in winners) * (min(ceiling, maximum_total) - base_cost)
        for scenario in winners:
            for key, change in scenario.changes.items():
                weighted_quantity = scenario.probability * change.quantity
                extra[key] += weighted_quantity * change.quoted_share
                relaxed_profit += weighted_quantity * (
                    change.quoted_share * floors[key] + (1 - change.quoted_share) * change.other_rate
                    - positions[key].band.unit_cost
                )
        headroom = ceiling - floor_total
        # Relax whole-cent rate increments to bound the value of any missed allocation.
        relaxed_headroom = ceiling + rounding_allowance - raw_floor_total
        rates = floors.copy()
        priority = {key: -extra[key] / p.quantity for key, p in positions.items()}
        for key in sorted(positions, key=lambda k: (priority[k], k)):
            position = positions[key]
            raw_capacity = position.quantity * (position.band.ceiling - position.band.floor)
            spend = min(relaxed_headroom, raw_capacity)
            relaxed_headroom -= spend
            relaxed_profit += spend * extra[key] / position.quantity
        # At equal marginal payoff, restore standard rates before raising any rate above standard.
        for key, _, limit in sorted(segments, key=lambda item: (priority[item[0]], item[1], item[0])):
            quantity = positions[key].quantity
            current_amount = money(quantity * rates[key])
            rates[key] = _rate_within_budget(quantity, rates[key], limit, headroom + current_amount)
            headroom -= money(quantity * rates[key]) - current_amount
        upper_bound = max(upper_bound, relaxed_profit)
        option = evaluate(positions, scenarios, rates)
        if option.expected_profit > best.expected_profit:
            best = option
    gap = max(ZERO, upper_bound - best.expected_profit)
    return replace(best, optimality_gap_bound=gap.quantize(CENT, rounding=ROUND_CEILING))


@dataclass(frozen=True)
class _RateBox:
    low: tuple[int, ...]
    high: tuple[int, ...]

    def split(self, index: int, cents: int) -> tuple["_RateBox", "_RateBox"]:
        left = self.high[:index] + (cents,) + self.high[index + 1:]
        right = self.low[:index] + (cents + 1,) + self.low[index + 1:]
        return _RateBox(self.low, left), _RateBox(right, self.high)


@dataclass(frozen=True)
class _AwardInterval:
    minimum: Decimal
    maximum: Decimal
    probability: Fraction
    fixed_profit: Fraction
    rate_coefficients: tuple[Fraction, ...]
    priority: tuple[int, ...]


def _award_intervals(positions: dict[str, Position], scenarios: list[Scenario]):
    base_cost = sum(p.quantity * p.band.unit_cost for p in positions.values())
    minimum = ZERO
    for ceiling in sorted({s.ceiling for s in scenarios}):
        winners = [s for s in scenarios if s.ceiling >= ceiling]
        probability = sum(Fraction(s.probability) for s in winners)
        fixed_profit = -probability * Fraction(base_cost)
        coefficients = dict.fromkeys(positions, Fraction(0))
        for scenario in winners:
            for key, change in scenario.changes.items():
                weighted_quantity = Fraction(scenario.probability) * Fraction(change.quantity)
                quoted_share = Fraction(change.quoted_share)
                coefficients[key] += weighted_quantity * quoted_share
                fixed_profit += weighted_quantity * (
                    (1 - quoted_share) * Fraction(change.other_rate) - Fraction(positions[key].band.unit_cost)
                )
        density = [coefficients[key] / Fraction(p.quantity) for key, p in positions.items()]
        yield _AwardInterval(minimum, ceiling, probability, fixed_profit, tuple(coefficients.values()),
                             tuple(sorted(range(len(density)), key=lambda index: -density[index])))
        minimum = ceiling + CENT


def _box_bound(box: _RateBox, interval: _AwardInterval, quantities: tuple[Decimal, ...]):
    minimum = sum(money(q * rate * CENT) for q, rate in zip(quantities, box.low))
    if minimum > interval.maximum:
        return None
    maximum = sum(money(q * rate * CENT) for q, rate in zip(quantities, box.high))
    if maximum < interval.minimum:
        return None
    if maximum <= interval.maximum:
        return interval.fixed_profit + interval.probability * Fraction(maximum) + sum(
            coefficient * rate / 100 for coefficient, rate in zip(interval.rate_coefficients, box.high)
        ), box.high, None

    # Bound extra revenue by allowing fractional-cent rates. Each adjustable fractional quantity
    # can contribute up to half a cent of rounding slack. Fixed lines consume their exact amounts.
    raw_minimum = sum(Fraction(q) * lo / 100 if lo != hi else Fraction(money(q * lo * CENT))
                      for q, lo, hi in zip(quantities, box.low, box.high))
    allowance = Fraction(sum(lo != hi and q % 1 != 0
                             for q, lo, hi in zip(quantities, box.low, box.high)), 200)
    headroom = Fraction(interval.maximum) + allowance - raw_minimum
    bound = interval.fixed_profit + interval.probability * Fraction(interval.maximum)
    candidate = list(box.low)
    pivot = None
    for index in interval.priority:
        low, high = box.low[index], box.high[index]
        step = Fraction(quantities[index]) / 100
        added = min(high - low, headroom / step)
        bound += interval.rate_coefficients[index] * (low + added) / 100
        headroom -= added * step
        candidate[index] = low + int(added)
        if added.denominator != 1:
            pivot = (index, candidate[index])
    if pivot is None:
        index = max(range(len(quantities)), key=lambda i: box.high[i] - box.low[i])
        pivot = (index, (box.low[index] + box.high[index]) // 2)
    return bound, tuple(candidate), pivot


def optimize(positions: dict[str, Position], scenarios: list[Scenario],
             reference_rates: dict[str, Decimal] | None = None, *,
             search_nodes: int = DEFAULT_SEARCH_NODES) -> Bid:
    """Refine the greedy bid with a bounded best-first search over whole-cent rates."""
    if search_nodes < 0:
        raise ValueError("Search nodes must be nonnegative")
    best = _greedy_optimize(positions, scenarios, reference_rates)
    if not search_nodes or best.optimality_gap_bound == 0:
        return best

    quantities = tuple(p.quantity for p in positions.values())
    root = _RateBox(tuple(int(p.band.floor / CENT) for p in positions.values()),
                    tuple(int(p.band.ceiling / CENT) for p in positions.values()))
    queue = []
    next_id = 0

    def consider(box, interval):
        nonlocal best, next_id
        enclosed = _box_bound(box, interval, quantities)
        if enclosed is None:
            return
        bound, candidate, pivot = enclosed
        if bound <= best.expected_profit:
            return
        option = evaluate(positions, scenarios, dict(zip(positions, (rate * CENT for rate in candidate))))
        if option.expected_profit > best.expected_profit:
            best = option
        if pivot is not None and bound > best.expected_profit:
            heappush(queue, (-bound, next_id, interval, box, pivot))
            next_id += 1

    for interval in _award_intervals(positions, scenarios):
        consider(root, interval)
    for _ in range(search_nodes):
        if not queue or -queue[0][0] <= best.expected_profit:
            break
        _, _, interval, box, pivot = heappop(queue)
        for child in box.split(*pivot):
            consider(child, interval)

    gap = max(Fraction(0), -queue[0][0] - Fraction(best.expected_profit)) if queue else Fraction(0)
    gap_cents = -(-gap.numerator * 100 // gap.denominator)
    gap_bound = gap_cents * CENT
    if best.optimality_gap_bound is not None:
        gap_bound = min(best.optimality_gap_bound, gap_bound)
    return replace(best, optimality_gap_bound=gap_bound)


def compare(positions: dict[str, Position], scenarios: list[Scenario], *,
            search_nodes: int = DEFAULT_SEARCH_NODES) -> dict[str, Bid]:
    baseline = evaluate(positions, scenarios, {key: p.band.standard_rate for key, p in positions.items()})
    blind = optimize(positions, [replace(s, changes={}) for s in scenarios], search_nodes=search_nodes)
    return {
        "standard": baseline,
        "price_only": evaluate(positions, scenarios, blind.rates),
        "quantity_aware": optimize(positions, scenarios, reference_rates=blind.rates, search_nodes=search_nodes),
    }


def report(snapshot: AnalysisInput, result: AnalysisResult, assumptions: PricingAssumptions, *,
           search_nodes: int = DEFAULT_SEARCH_NODES) -> dict:
    positions, scenarios = prepare(snapshot, result, assumptions)
    return {
        "input_hash": result.input_hash,
        "layers_run": result.layers_run,
        "analysis_errors": result.errors,
        "currency": assumptions.currency,
        "search_node_budget": search_nodes,
        "strategies": {name: bid.summary() for name, bid in
                       compare(positions, scenarios, search_nodes=search_nodes).items()},
        "scenarios": {s.name: {
            "probability": s.probability, "winning_bid_ceiling": s.ceiling,
            "changes": {key: {
                "extra_quantity": change.quantity, "quoted_rate_share": change.quoted_share,
                "other_unit_rate": change.other_rate, "finding_id": change.finding_id,
                "ai_review_ids": change.ai_review_ids,
            } for key, change in s.changes.items()},
        } for s in scenarios},
    }
