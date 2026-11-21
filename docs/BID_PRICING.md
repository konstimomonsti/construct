# X83 bid pricing simulator

The simulator compares a standard estimate with two optimized bids. It reports the net tender total, probability of award, expected gross profit per tender, worst profit among awarded scenarios, and the proposed rate for each included position. It runs locally and produces JSON for estimator review.

## Run it in BillBuild

Open an imported X83 list and choose **Bid simulator** in the list header. Enter
the direct costs, standard rates, and any rate limits. Add your estimated award
ceilings and their probabilities. Use a detected quantity shortfall or add your
own extra units, then set the correction probability and how extra units would
be paid.

The workspace form uses the same correction probability in every market
scenario. The CLI accepts arbitrary joint scenarios. Both use the original
tender quantities and leave the workspace quote unchanged.

## Run the examples

From the repository root with the backend Python dependencies installed:

```sh
cd backend
python -m analysis bid-plan ../data/examples/bid-pricing/sanitary.X83 ../data/examples/bid-pricing/sanitary.json
python -m analysis.bid_pricing_benchmark ../data/examples/bid-pricing
```

Use `--layers 1,2,3` with a configured AI provider or `--analysis-result result.json` with a saved assessment of the same snapshot. The default is layers 1 and 2. The output includes the layers run, any assessment errors, and the IDs of findings and linked AI reviews used in the simulation.

## Supply assumptions

Copy one of the [example inputs](../data/examples/bid-pricing/). The JSON contains:

- `currency` for all costs, rates, and net totals.
- `prices` keyed by position code, or line ID for positions without codes. Give each included position a direct `unit_cost` and `standard_rate`. Set `min_rate` and `max_rate` for rates the estimator can move. An omitted limit defaults to the standard rate. The minimum must cover the unit cost.
- `scenarios` describing joint market and payment assumptions. Each scenario has a `probability` and a `winning_bid_ceiling`. A bid at or below that ceiling wins the scenario. Include scenarios covering both quantity correction and no correction, and give those scenarios probabilities that sum to one.
- Optional `changes` in each scenario, keyed by existing unit-rate position. Enter `extra_quantity` in the position's unit or give the `finding_rule` for a detected shortfall. Set `quoted_rate_share` to the share of the extra units paid at the bid rate. If any units are settled on another basis, specify their `other_unit_rate`. For example, if 1 of 10 extra units stays at the bid rate and the other 9 are repriced at €20, use a share of 0.1 and a rate of 20.

A finding can supply a quantity when its numerical shortfall applies to one existing dependency position and the priced scope matches. Ambiguous shortfalls require an explicit reviewed quantity assumption. Open AI scope reviews accompany the suggested quantity as advice. Accept a review of inclusion or exclusion after verifying the scope. That decision removes the automatically suggested quantity. Enter a reviewed quantity yourself if there is still work to price. A missing position without an original rate requires a separate estimate or clarification. The current model covers increases on existing rate positions, undiscounted position-level pricing, and the base award total. Conditional positions and positions quoted for unit price only are outside that total.

The simulator displays confirmed conflicts between the quantity column and the original description. It uses the as-issued quantity for base pricing and holds manual or detected quantity changes that depend on the disputed value. Use a reconciled tender to model changes for that position. A review decision in the risk drawer records the review and leaves the original source quantities in place.

## How the comparison works

Awarded profit equals the quoted base total minus the estimated base cost, plus revenue less cost for extra units. Expected profit weights that result by the probability of each awarded scenario. Project overhead, bid preparation costs, and taxes are outside the objective unless accounted for in the supplied costs.

- **Standard** uses the supplied standard rates.
- **Price-only** selects rates using the market ceilings and base costs, then those rates are scored on the same quantity and payment scenarios as the other strategies.
- **Quantity-aware** accounts for extra-unit contribution when selecting rates. It examines each award ceiling and prioritizes rate increases that add the most expected extra-unit contribution per euro of quoted total. It can choose no bid when every evaluated option has nonpositive expected profit.

The search uses whole-cent rates and rounds each base line amount to cents. The greedy pass provides an initial feasible bid. If a better bid is possible, the optimizer searches combinations of rates within each interval of bid totals that awards the same scenarios. It drops combinations whose best possible profit falls below the current best.

A zero `optimality_gap_bound` certifies the best modeled result. If the node budget is exhausted earlier, the gap bounds how much expected profit a longer search could still recover. Use `--search-nodes 0` for the greedy comparison or increase `--search-nodes` above the default 512 to allow more work per strategy. Both the simulator and benchmark take this flag.

## Benchmark results

The bundled X83s, market ceilings, costs, and probabilities are synthetic. The table fixture supplies the expected 27 extra chairs as an assumption. The sanitary fixture obtains seven extra WC seats from an existing dependency rule. The benchmark uses deterministic assessment. A test exercises the saved AI review handoff with a fixture.

| X83 case | Standard → quantity-aware bid | Standard expected profit | Price-only expected profit | Quantity-aware expected profit | Gain vs. price-only |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tables and chairs | €1,290 → €1,120 | €89.20 | €276.00 | €492.00 | €216.00 |
| Sanitary fixtures | €2,996 → €2,756 | €81.09 | €300.60 | €391.60 | €91.00 |

Each optimized quote wins all modeled award scenarios, versus 20% and 15% for the respective standard quotes. The benchmark holds the selected rates fixed and varies settlement. The uplift falls to zero when all extra units are settled at cost. If the chair quantities increase and the extra units go unpaid, the quantity-aware bid falls to an expected loss of €372.

The competing-rates fixture isolates the improvement from the second search pass. At 12,000 metres and 8,000 metres, a one-cent rate change adds either €120 or €80 to the bid. With €160 of room, the greedy pass uses the €120 increment and leaves €40 unused. The refined search uses two €80 increments and increases expected profit from €187.50 to €242.50 at the same modeled award probability. It certifies a zero gap on all three fixtures.

Model settlement from the tender and governing contract. If VOB/B § 2(3) applies, either party can request a new price for quantities beyond 110% of the contracted amount. The quoted-rate case in this benchmark is an economic stress endpoint. [VOB/B text published by the German federal ministry](https://www.bmwsb.bund.de/SharedDocs/downloads/Webs/BMWSB/DE/veroeffentlichungen/bauen/vob-teil-b.pdf?__blob=publicationFile&v=1)
