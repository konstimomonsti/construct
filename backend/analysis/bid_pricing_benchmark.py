"""Replay synthetic X83 bids and stress-test selected rates without refitting."""

import argparse
from dataclasses import replace
from decimal import Decimal
import json
from pathlib import Path

from . import adapter
from .bid_pricing import DEFAULT_SEARCH_NODES, PricingAssumptions, compare, evaluate, prepare
from .layer1.common import money
from .runner import analyze


def benchmark(directory: Path, *, search_nodes: int = DEFAULT_SEARCH_NODES) -> dict:
    cases = {}
    for tender in sorted(directory.glob("*.X83")):
        assumptions = PricingAssumptions.model_validate_json(tender.with_suffix(".json").read_text(encoding="utf-8"))
        snapshot = adapter.from_file(tender)
        assessment = analyze(snapshot)
        if assessment.errors:
            raise ValueError(f"{tender.name}: {assessment.errors}")
        positions, forecast = prepare(snapshot, assessment, assumptions)
        bids = compare(positions, forecast, search_nodes=search_nodes)
        greedy = compare(positions, forecast, search_nodes=0)["quantity_aware"]
        settlement_sweep = []
        for percent in (0, 25, 50, 75, 100):
            realized = [replace(s, changes={
                key: replace(c, quoted_share=Decimal(percent) / 100, other_rate=positions[key].band.unit_cost)
                for key, c in s.changes.items()
            }) for s in forecast]
            settlement_sweep.append({
                "share_at_quoted_rate_percent": percent,
                "expected_profit": {name: money(evaluate(positions, realized, bid.rates).expected_profit)
                                    for name, bid in bids.items()},
            })
        stresses = {
            "no_extra_work": [replace(s, changes={}) for s in forecast],
            "extra_work_at_zero_payment": [
                replace(s, changes={key: replace(c, quoted_share=Decimal(0), other_rate=Decimal(0))
                                    for key, c in s.changes.items()}) for s in forecast
            ],
        }
        cases[tender.stem] = {
            "currency": assumptions.currency,
            "positions": len(positions),
            "quantity_changes": {key: {"quantity": c.quantity, "finding_id": c.finding_id}
                                 for s in forecast for key, c in s.changes.items()},
            "forecast": {name: bid.summary() for name, bid in bids.items()},
            "greedy_quantity_aware": greedy.summary(),
            "settlement_sweep": settlement_sweep,
            "stress": {stress: {name: evaluate(positions, scenarios, bid.rates).summary()
                                for name, bid in bids.items()} for stress, scenarios in stresses.items()},
        }
    if not cases:
        raise ValueError("No benchmark .X83 files found")
    return {"cases": cases}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Directory with paired .X83 tenders and .json assumptions")
    parser.add_argument("--search-nodes", type=int, default=DEFAULT_SEARCH_NODES)
    args = parser.parse_args()
    try:
        result = benchmark(args.directory, search_nodes=args.search_nodes)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
