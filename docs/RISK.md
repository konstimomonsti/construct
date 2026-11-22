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
| Scope gap, provisional, hourly work or priced zero quantity | 4 |
| By-client or vague-quantity signal | 2 |

A finding with `evidence.change_order=true` multiplies its base by 1.5. When the
tender has a submitted or current unit price on any position (including a zero
unit price), add `min(10, amount_at_stake / 1000)` per finding or nonwording
signal. Wording signals use the section cap instead. An explicit,
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
IDs from `points` and applying the same formula lowers the score. Text signals
have independent IDs; deciding a finding does not remove a separate wording signal.

`top_risks` contains at most ten lines, ordered by points, then known exposure,
then document order. A finding is charged to its target line, else the first
related line in document order. Section/BOM findings without a line still count
globally. `by_section` uses the direct section and includes an unassigned bucket;
each point is allocated once. `by_category` includes `change_order` for text/quantity
signals and `dependency` for derived missing-dependency signals. `open_counts`
counts findings by severity; section `open` counts findings plus signals.

`money_at_stake` counts each affected line once, taking the greatest supported
expected value for that line, plus explicit expected value on unanchored findings.
For each scored item, expected value is `exposure × likelihood × impact`.
Likelihood is 0.65/0.45/0.15 for error/warning/info findings and 0.35 for
signals; impact is 0.40. If several open items affect a line, the greatest
supported expected value is used once. `top_risks.amount` remains the full
supported line exposure. The expected value is a rough prioritization estimate,
not a forecast of a claim or a guaranteed cost.
It is
`null` for unpriced files. A priced file with no known affected amounts has zero;
unknown line exposure remains `null` in `top_risks`. Neither the monetary total
nor the score is added to the tender total.

## Change-order signal catalogue

Signals live in `risk.change_order_signals`. Missing dependencies and priced zero quantities already
covered by a finding are reviewed on that finding. Optimization suggestions contribute no risk points.

| Family | Detection | Contract `kind` |
|---|---|---|
| Provisional | Bedarfs-/Eventual-/Wahlposition or conditional GAEB flag | `provisional` |
| Daywork | Stundenlohn, Regie or unit `h` | `hourly_work` |
| Cost-plus | nach (tatsächlichem) Aufwand | `scope_gap` |
| By client | bauseits, beigestellt | `by_client` |
| Client decides | nach Angabe/Wahl/Anordnung des AG, Bemusterung | `scope_gap` |
| Conditional | ggf., evtl., soweit erforderlich | `scope_gap` |
| Approximate | ca., etwa | `vague_quantity` |
| Ground | Homogenbereich, Fels, Grundwasser, Kampfmittel, Altlasten, LAGA | `scope_gap` |
| Existing fabric | im Bestand, Rückbau, Abbruch, vorhandene Leitung | `scope_gap` |
| Time-related | vorhalten, Vorhaltung, Stillstand, je Woche/Monat/Tag | `scope_gap` |
| Thin lump sum | Nonempty combined text under 200 characters on a lump sum | `scope_gap` |
| Placeholder quantity | Quantity 1 in m/m²/m³/t/h, excluding lump sums | `vague_quantity` |
| Priced zero quantity | Quantity 0 with a known unit price | `zero_qty_priced` |

The seven kinds are fixed by §5.4. Families sharing a kind on one line are merged
into one signal with all reasons in its message; the base is charged once.
For wording kinds (`scope_gap`, `provisional`, `hourly_work`, `by_client`,
`vague_quantity`), only the highest-exposure signal of each wording family in a
direct section receives points, capped at 2.5 per signal. A signal matching
several families uses its first matching family and is charged once. The others
remain visible with zero points
and can still be reviewed. Missing-dependency and priced-zero-quantity signals
retain their individual points because they are not wording-only signals.
Missing-dependency signals retain their source `finding_ids`. Findings and these
derived signals are separate review items and each has its own points entry.

IDs are `co_<line_code>_<kind>`. Missing codes use the stable line ID; duplicate
codes append a short line-ID hash so invalid source numbering cannot overwrite
another line's signal. Negative tests cover every regex family.
`Bestandsdokumentation` does not match existing fabric. Explicitly negated daywork
(including `Stundenlohnarbeiten sind nicht vorgesehen`) overrides daywork wording
and unit `h`. Signals identify exposure requiring review, not proven tender errors.

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
4. Add high-value signal questions (ground report, scope, quantities, daywork and
   bauseitige responsibilities). A represented missing-dependency finding already
   supplies its question. Signal-only questions have `finding_ids=[]` because no
   finding was created; their `rule_id` is the descriptive `CO.<KIND>` template key.
5. Order by the sum of each group's distinct active item points, then document
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
    "version": "risk/1", "score": 20, "level": "low", "scale": 41,
    "priced": false, "currency": "EUR", "money_at_stake": null,
    "points": {"f_ab12": 8, "co_3.2.70_scope_gap": 2.5},
    "open_counts": {"error": 1, "warning": 0, "info": 0},
    "top_risks": [{"line_id": "lv11-3.2.20", "line_code": "3.2.20", "short_text": "FT-Sockel",
      "points": 8, "amount": null, "reasons": ["Concrete grade below minimum"], "item_ids": ["f_ab12"]},
      {"line_id": "lv11-3.2.70", "line_code": "3.2.70", "short_text": "Gründung",
        "points": 2.5, "amount": null, "reasons": ["Leistungsumfang klären"], "item_ids": ["co_3.2.70_scope_gap"]}],
    "by_section": [{"section_id": "s-3.2", "code": "3.2", "title": "Stahlbetonfertigteile", "points": 10.5, "open": 2}],
    "by_category": {"din": 8, "change_order": 2.5},
    "change_order_signals": [{"id": "co_3.2.70_scope_gap", "kind": "scope_gap", "line_id": "lv11-3.2.70",
      "line_code": "3.2.70", "title": "Leistungsumfang klären", "message": "Baugrundbedingungen prüfen.",
      "points": 2.5, "finding_ids": []}]
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
