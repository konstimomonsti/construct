from decimal import Decimal
from itertools import product
from pathlib import Path

import pytest

from analysis.adapter import from_bytes, from_file
from analysis.bid_pricing import Change, Position, PriceBand, PricingAssumptions, Scenario, evaluate, included_positions, optimize, prepare
from analysis.bid_pricing_benchmark import benchmark
from analysis.contracts import Finding
from analysis.runner import analyze

EXAMPLES = Path(__file__).resolve().parents[3] / "data" / "examples" / "bid-pricing"


def test_x83_benchmark_and_downside():
    cases = benchmark(EXAMPLES)["cases"]
    chairs = cases["tables-and-chairs"]
    assert chairs["forecast"]["quantity_aware"]["rates"] == {"01.0010": Decimal(100), "01.0020": Decimal(40)}
    assert chairs["forecast"]["quantity_aware"]["bid_total"] == chairs["forecast"]["price_only"]["bid_total"] == 1120
    assert chairs["forecast"]["quantity_aware"]["expected_profit"] == 492
    assert chairs["forecast"]["price_only"]["expected_profit"] == 276
    assert chairs["settlement_sweep"][0]["expected_profit"]["quantity_aware"] == 60
    assert chairs["stress"]["extra_work_at_zero_payment"]["quantity_aware"]["expected_profit"] == -372

    sanitary = cases["sanitary"]
    assert sanitary["quantity_changes"]["01.0020"]["finding_id"]
    assert sanitary["quantity_changes"]["01.0020"]["quantity"] == 7
    assert sanitary["forecast"]["quantity_aware"]["expected_profit"] == Decimal("391.60")
    assert sanitary["forecast"]["quantity_aware"]["optimality_gap_bound"] == 0

    competing = cases["competing-rate-increments"]
    greedy = competing["greedy_quantity_aware"]
    refined = competing["forecast"]["quantity_aware"]
    assert greedy["expected_profit"] == Decimal("187.50")
    assert refined["expected_profit"] == Decimal("242.50")
    assert refined["bid_total"] == 40160
    assert greedy["win_probability"] == refined["win_probability"] == 1
    assert refined["optimality_gap_bound"] == 0


def test_saved_ai_assessment_links_confirmation_and_blocks_conflicting_scope():
    snapshot = from_file(EXAMPLES / "sanitary.X83")
    result = analyze(snapshot)
    assumptions = PricingAssumptions.model_validate_json((EXAMPLES / "sanitary.json").read_text())
    finding = next(f for f in result.findings if f.rule_id == "L2.SANITARY.WC_NEEDS_WC_SEAT")
    review = Finding.create(rule_id="L3.REVIEW.L2_CONFIRM", layer=3, scope=finding.scope, target=finding.target,
                            category="dependency", origin="llm", severity="info", title="AI review",
                            message="Review fixture",
                            evidence={"reviews_finding_id": finding.id, "verdict": "missing"})
    result.findings.append(review)
    _, scenarios = prepare(snapshot, type(result).model_validate_json(result.model_dump_json()), assumptions)
    assert scenarios[0].changes["01.0020"].ai_review_ids == (review.id,)

    review.evidence["verdict"] = "excluded"
    with pytest.raises(ValueError, match="scope exclusion"):
        prepare(snapshot, result, assumptions)
    snapshot.lines[0].quantity = Decimal(11)
    with pytest.raises(ValueError, match="different BoQ snapshot"):
        prepare(snapshot, result, assumptions)


def test_limited_search_bounds_and_full_search_matches_exhaustive_rounding():
    first = PriceBand(unit_cost="1", standard_rate="1.01", min_rate="1", max_rate="1.04")
    second = PriceBand(unit_cost="2", standard_rate="2.01", min_rate="2", max_rate="2.04")
    positions = {"a": Position(Decimal("2.5"), first), "b": Position(Decimal("3"), second)}
    scenarios = [
        Scenario("tight", Decimal("0.7"), Decimal("8.57"), {
            "a": Change(Decimal("3"), Decimal(1), Decimal(0)),
            "b": Change(Decimal("3.5"), Decimal(1), Decimal(0)),
        }),
        Scenario("loose", Decimal("0.3"), Decimal("8.66"), {}),
    ]
    candidates = [evaluate(positions, scenarios, {"a": Decimal(100 + a) / 100, "b": Decimal(200 + b) / 100})
                  for a, b in product(range(5), repeat=2)]
    exact = max(candidate.expected_profit for candidate in candidates)
    limited = optimize(positions, scenarios, search_nodes=1)
    assert limited.expected_profit < exact <= limited.expected_profit + limited.optimality_gap_bound
    refined = optimize(positions, scenarios)
    assert refined.expected_profit == exact
    assert refined.optimality_gap_bound == 0


def test_no_bid_when_every_possible_award_loses_money():
    band = PriceBand(unit_cost="1", standard_rate="1.10", min_rate="1", max_rate="1.20")
    positions = {"a": Position(Decimal(2), band)}
    scenarios = [Scenario("uncompensated work", Decimal(1), Decimal(3),
                          {"a": Change(Decimal(1), Decimal(0), Decimal(0))})]
    bid = optimize(positions, scenarios)
    assert bid.bid_total is None
    assert bid.expected_profit == bid.optimality_gap_bound == 0


def test_simulator_excludes_every_position_below_an_unselected_alternative_section():
    snapshot = from_bytes("alternative.X83", b"""<GAEB><Award><DP>83</DP><BoQ><BoQBody>
      <BoQCtgy RNoPart="01"><ALNBGroupNo>1</ALNBGroupNo><ALNBSerNo>0</ALNBSerNo>
        <BoQBody><Itemlist><Item RNoPart="0010"><Qty>1</Qty><QU>m</QU></Item></Itemlist></BoQBody>
      </BoQCtgy>
      <BoQCtgy RNoPart="02"><ALNBGroupNo>1</ALNBGroupNo><ALNBSerNo>1</ALNBSerNo><BoQBody>
        <BoQCtgy RNoPart="10"><BoQBody>
          <Itemlist><Item RNoPart="0010"><Qty>10</Qty><QU>m</QU></Item></Itemlist>
        </BoQBody></BoQCtgy>
      </BoQBody></BoQCtgy>
    </BoQBody></BoQ></Award></GAEB>""")
    assert set(included_positions(snapshot)) == {"01.0010"}
