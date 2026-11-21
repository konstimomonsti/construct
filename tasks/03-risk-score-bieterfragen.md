# Task 03: Risk score, change-order signals and Bieterfragen (contract v0.2)

**Branch:** `feat/task-03` · **Recommended model:** Sonnet (Claude Sonnet 5.5). Switch to Opus if the scoring design gets stuck.

## Objective

After the three layers run, compute a **risk report** and the **German client questions (Bieterfragen)** and
attach both to every `AnalysisResult`, exactly in the shape of **CLAUDE.md §5.4**. Task 04 builds the UI against
that shape in parallel, so the field names are fixed. The frontend already receives the full `AnalysisResult` from
the upload worker, so no new HTTP endpoint is needed.

## What to build

1. **Contract v0.2** in `backend/analysis/contracts.py`: Pydantic models `RiskReport`, `TopRisk`, `SectionRisk`,
   `ChangeOrderSignal` and `BidderQuestion`, plus `AnalysisResult.risk: RiskReport | None = None` and
   `AnalysisResult.questions: list[BidderQuestion] = []`. Bump `SCHEMA_VERSION` to `"0.2"`. Keep 0.1 JSON
   loadable (both new fields are optional).
2. **`backend/analysis/risk/`** (new package), pure functions, no I/O:
   - `signals.py`: change-order (Nachtrag) signals by regex over each line, with **negative tests for every
     regex**. Use the catalogue in [archived plan §3](../docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md):
     provisional/Bedarfsposition, daywork (Stundenlohn, Regie, unit `h`), cost-plus ("nach Aufwand"), by-client
     (bauseits, beigestellt), client-decides (nach Angabe/Wahl des AG, Bemusterung), conditional (ggf., evtl.,
     soweit erforderlich), approximate (ca.), ground (Homogenbereich, Fels, Grundwasser, Kampfmittel, LAGA),
     existing fabric (im Bestand, Rückbau; "Bestandsdokumentation" must not match), time-related (vorhalten,
     je Woche), thin lump sum (lump sum with under 200 characters of text), placeholder quantity (quantity 1 in
     m/m²/m³/t/h on an item that isn't a lump sum), zero quantity on a priced line, and missing-dependency
     findings from layer 2 (`L2.*_NEEDS_*`). Signal ids are stable: `co_<line_code>_<kind>`.
   - `score.py`: `assess(input, findings) -> RiskReport`. Points per finding and signal, the score formula,
     levels, `top_risks` (max 10, grouped by line), `by_section`, `by_category`, `money_at_stake` (only when the
     tender is priced: line amount, else qty × unit price). Exclude sections titled "Nachtrag" from the score.
     Follow §5.4 exactly. Weights may follow the plan's risk-v1 (w, k), but map them to `points`.
3. **`backend/analysis/questions.py`** (new): Bieterfragen. Use `evidence.bieterfrage_de` first, otherwise German
   templates per rule ID. **Port and adapt from the archived branch `origin/archive/risk-report-ui`, file
   `analysis/questions.py` and `analysis/tests/test_questions.py`** (`git show origin/archive/risk-report-ui:analysis/questions.py`).
   Add templates for the high-value change-order signals. Group identical questions across positions (`Zu Pos. 3.2.20 – 3.2.60: …`).
   No questions for price, arithmetic or bidder-input rules. Return at most 25, ordered by points.
4. **Hook** in `backend/analysis/runner.py`: after sorting, call `assess` and `build_questions`. A crash appends to
   `errors` and leaves `risk=None`. **Layers must never fail because of risk.** Add a CLI flag `--no-risk` to
   `python -m analysis run` in `backend/analysis/__main__.py`.
5. **`backend/analysis_api.py`**: make `GET /api/mvp/analysis` include `risk` and `questions`, recomputed from the
   stored run's findings while leaving out rejected ones. (Optional. Skip it if it gets heavy and note that.)
6. **Docs:** `docs/RISK.md` covers the model, weights, signal catalogue, the §5.4 JSON example and the question rules.

## Files you MAY create or modify (strict allowlist)

- `backend/analysis/contracts.py`, `backend/analysis/runner.py`, `backend/analysis/__main__.py`
- `backend/analysis/risk/__init__.py`, `risk/signals.py`, `risk/score.py` (new)
- `backend/analysis/questions.py` (new)
- `backend/analysis_api.py`
- `backend/analysis/tests/test_risk.py`, `test_questions.py`, `test_contract_v02.py` (new)
- `docs/RISK.md` (new)
- this task file (notes) and your row in `STATUS.md`

## Read-only references

- `CLAUDE.md` §5.1–5.5 (**§5.4 is your spec**)
- `backend/analysis/contracts.py`, `runner.py`, `adapter.py`, `backend/workspace_analysis.py` (how the report is stored)
- `docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md` §3 (risk) and §4 (bidder-question templates)
- `origin/archive/risk-report-ui`: `analysis/questions.py`, `webapp/risk_fallback.py`, `analysis/tests/test_questions.py`
  (old layout: `analysis/` is now `backend/analysis/`)
- `backend/analysis/tests/fixtures/lv11_precast.json`, `data/tenders/StBALV23040.D86`, `data/tenders/[ORT_024] LV24069.D86`

## Acceptance criteria

1. `python -m analysis run data/tenders/StBALV23040.D86 --layers 1,2` prints a result with `risk` and `questions`
   that validate against §5.4. Its top risks include the trench excavation / ground items (see the plan's worked
   example), and `money_at_stake` is set (the file is priced).
2. On the unpriced LV_11 fixture, `priced=false`, `money_at_stake=null`, and the score still ranks lines.
3. The score shrinks when items are removed: a test removes the `points` of some items and recomputes with the §5.4 formula.
4. Regex negative tests: "Bestandsdokumentation" is not existing fabric, and "Stundenlohnarbeiten sind nicht
   vorgesehen" is not daywork (or document why it still is).
5. A crash inside `assess` (monkeypatched) still returns all findings, with the error in `errors`.
6. `python -m pytest -q backend/analysis/tests` is green, and old 0.1 result JSON still parses.

## Notes / blockers (fill in)

- Implemented the exact §5.4 key set, seven signal kinds, scale 40 and score formula.
  Regex families sharing a contract kind are combined per line; all reasons remain
  in the signal message. Findings and change-order signals remain separate review items.
- Ported German templates, dependency names and tests from
  `origin/archive/risk-report-ui:analysis/questions.py` and its test file. Adapted
  them to Pydantic v0.2 fields, explicit `bieterfrage_de`, points ordering, a cap
  of 25 and open-item decisions. Client-scope questions also apply to phases 84/86;
  the price/arithmetic/bidder-input exclusions remain unconditional.
- Included optional stored-run recomputation in `backend/analysis_api.py`; it uses
  saved finding review states and the current input, retaining the existing
  `outdated` flag. No endpoint or migration was added.
- Merged current main including task 01. Added its four new German precast dependency
  names to the ported dictionary; no other task's implementation was modified.
- CLI acceptance after merging task 01: StBALV23040.D86 is priced, has money_at_stake 369665.03 EUR,
  and ranks trench 03.02.0003 in its top ten. Unpriced LV_11 has
  priced=false, money_at_stake=null, and ranked positions. Both return schema
  0.2 with risk/questions and no errors. ORT_024 also runs without errors.
- No implementation blockers. Team-chat tooling is not connected in this session;
  any blocker will be reported in the user chat immediately and recorded here.
- Final required suite after merging current main: 315 passed, 3 skipped,
  66 subtests passed. Changes remain inside the task allowlist and only row 03
  of STATUS.md is edited.
