# Risk scoring and German bidder questions

Every new `AnalysisResult` uses schema `0.2` and includes `risk` and `questions`.
The fields follow `CLAUDE.md` §5.4. Old `0.1` JSON remains loadable: absent `risk`
defaults to `null` and absent `questions` to an independent empty list.

`analysis.risk.assess(input, findings)` and `analysis.questions.build_questions(...)`
are pure functions. They do not alter positions, create findings, access files or
call an LLM. The runner calls them after sorting and deduplicating layer findings.
A failure in either appends a `risk report:` error, sets `risk=null` and
`questions=[]`, and retains every layer finding. `--no-risk` skips both functions.

## Points and roll-ups

Only findings with `status="open"` contribute. Accepted, rejected, applied and
stale findings contribute no points or questions. Repeated finding IDs count once.
Sections whose titles contain the standalone word `Nachtrag` or `Nachträge`, and
all their descendants, are excluded. The original findings stay in the result.

| Item | Base points |
|---|---:|
| Error finding | 8 |
| Warning finding | 4 |
| Info finding | 1 |

A finding with `evidence.change_order=true` multiplies its base by 1.5. When the
tender has a submitted or current unit price on any position (including a zero
unit price), add `min(10, amount_at_stake / 1000)` per finding. An explicit,
finite `evidence.amount_at_stake` takes precedence for that finding; otherwise use
the position amount. Negative amounts are treated as absolute exposure.

Amounts use `Decimal`. Current pricing has priority: current line amount, else
quantity × current unit price; then source line amount or quantity × source unit
price. There is no guessed price, median fill, or currency conversion. Monetary
values serialize as decimal **strings**, while points are JSON numbers for the UI.
Unknown currency remains `null`.

For `S = sum(risk.points.values())`:

```text
scale = 40 + round_half_up(0.65 × measured_lines)
score = round_half_up(100 * S / (S + scale))
low: score < 25; medium: 25–49; high: 50–74; critical: 75–100
```

Measured lines have a quantity and are outside Nachtrag sections. The report
stores its size-aware `scale`; the frontend uses the same value when re-scoring
after decisions. `version="risk/1"` is fixed. The score is a prioritization measure,
not a calibrated probability or an expected claim amount. Removing decided item
IDs from `points` and applying the same formula lowers the score.

`top_risks` contains at most ten lines, ordered by points, then known exposure,
then document order. A finding is charged to its target line, else the first
related line in document order. Section/BOM findings without a line still count
globally. `by_section` uses the direct section and includes an unassigned bucket;
each point is allocated once. `by_category` sums the points by finding category.
`open_counts` counts findings by severity. Section `open` counts findings in the section.

`money_at_stake` counts each affected line once, taking the greatest supported
expected value for that line, plus explicit expected value on unanchored findings.
For each scored item, expected value is `exposure × likelihood × impact`.
Likelihood is 0.65/0.45/0.15 for error/warning/info findings. Impact is 0.40. If several open items affect a line, the greatest
supported expected value is used once. `top_risks.amount` remains the full
supported line exposure. The expected value is a rough prioritization estimate,
not a forecast of a claim or a guaranteed cost.
It is
`null` for unpriced files. A priced file with no known affected amounts has zero;
unknown line exposure remains `null` in `top_risks`. Neither the monetary total
nor the score is added to the tender total.

New reports leave `risk.change_order_signals` empty. When opening a saved report, the
app removes legacy signals and their points before displaying or exporting the review.
Optimization suggestions contribute no risk points.

## Bieterfragen

`questions.py` ports the German singular/plural templates and dependency names
from `origin/archive/risk-report-ui:analysis/questions.py`; its tests adapt the
archived `analysis/tests/test_questions.py` to the v0.2 output.

1. Omit decided findings, price/arithmetic categories and rules, and bidder-input
   rules, even when they supply explicit wording.
2. Prefer nonempty `evidence.bieterfrage_de`, then the per-rule German template.
   Unknown rules without explicit wording produce no question. Unassessable
   dependency quantities produce no invented quantity question.
3. Group equivalent template questions within a section, and identical explicit
   question bodies after removing position prefixes. Retain all line codes and
   finding IDs; long visible code lists are shortened after twelve entries.
4. Order by the sum of each group's distinct active finding points, then document
   order and stable ID; return at most 25. Questions are formal German using `Sie`.

Client-scope clarification questions are available on priced phases 84/86 too;
the archive's tender-only phase gate is intentionally removed for v0.2. This does
not create questions about the bidder's prices, arithmetic or input fields.

The stored-BOM `GET /api/mvp/analysis` recomputes risk/questions from saved findings
and their current review states, using the current snapshot and retaining the
existing `outdated` flag. It does not mutate the stored run or require a migration.

## Fixed JSON shape (illustrative values)

```json
{
  "risk": {
    "version": "risk/1", "score": 16, "level": "low", "scale": 41,
    "priced": false, "currency": "EUR", "money_at_stake": null,
    "points": {"f_ab12": 8},
    "open_counts": {"error": 1, "warning": 0, "info": 0},
    "top_risks": [{"line_id": "lv11-3.2.20", "line_code": "3.2.20", "short_text": "FT-Sockel",
      "points": 8, "amount": null, "reasons": ["Concrete grade below minimum"], "item_ids": ["f_ab12"]}],
    "by_section": [{"section_id": "s-3.2", "code": "3.2", "title": "Stahlbetonfertigteile", "points": 8, "open": 1}],
    "by_category": {"din": 8},
    "change_order_signals": []
  },
  "questions": [{"id": "q_1a2b", "topic": "Fehlende Angaben",
    "text_de": "Zu Pos. 3.2.20: Bitte bestätigen Sie die Bauteilhöhe.",
    "line_codes": ["3.2.20"], "finding_ids": ["f_ab12"], "rule_id": "L3.PRECAST.MISSING_SPEC"}]
}
```

## Verification

```powershell
$env:PYTHONPATH="backend;backend/importer"
python -m pytest -q backend/analysis/tests
python -m analysis run data/tenders/StBALV23040.D86 --layers 1,2
python -m analysis run backend/analysis/tests/fixtures/lv11_precast.json --layers 1,2
python -m analysis run data/tenders/StBALV23040.D86 --layers 1,2 --no-risk
```
