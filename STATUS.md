# Status

Each worker edits **only their own row** (Status: `todo` → `in progress` → `PR open` → `merged`, or `blocked`).
The lead merges PRs and resolves conflicts in this file. Contracts are in [CLAUDE.md](CLAUDE.md) §5.

## Wave 1 (started 2026-11-21, about 18 h left)

| ID | Task | Branch | Status | Notes |
|---|---|---|---|---|
| 01 | [Deterministic DIN 1045-2, precast and text-defect rules](tasks/01-deterministic-din-precast-rules.md) | `feat/task-01` | merged | [PR #8](https://github.com/konstimomonsti/construct/pull/8) merged. LV_11: 13 findings. Lead follow-up: full DIN EN 206 grade table, armour-stone numbers ignored, case-sensitive exposure codes. Open: `SPEC_PLACEHOLDER` is noisy on anonymized manufacturer names (wave 2) |
| 02 | [Layer 3 on Claude: precast extraction, scope audit, live demo](tasks/02-layer3-claude-checks.md) | `feat/task-02` | PR open | Live LV_11 layer 3 run: 24.5 s, $0.020, 5 calls (Haiku 5.5 + Sonnet 5.5 audit); MISSING_SPEC on 3.2.20-60, REBAR_AMBIGUOUS on 3.2.70; repeat run 0 calls. Eval: task 02 checks precision 1.0 / recall 1.0 (4 cases), contradiction 1.0 / 1.0, L2 review 0.75. Prod defaults: 12 calls, 30 s timeout, 75 s deadline. Request: register the `integration` pytest marker. |
| 03 | [Risk score, change-order signals, Bieterfragen (contract v0.2)](tasks/03-risk-score-bieterfragen.md) | `feat/task-03` | PR open | [PR #12](https://github.com/konstimomonsti/construct/pull/12); 315 passed, 3 skipped; CLI acceptance verified. |
| 04 | [Risk report UI, reviewer decisions, exports](tasks/04-risk-report-ui.md) | `feat/task-04` | PR open | [PR #16](https://github.com/konstimomonsti/construct/pull/16); built against `tests/fixtures/risk-report.ts` (`?risk=fixture` on any list page); switches to the real `report.risk`/`report.questions` automatically once task 03 ships, since both are read straight off the report. `npm run lint && npm run build && npm test` green (128 tests). Checked the fixture's field names against task 03's `feat/task-03` branch |
| 05 | [Planted-error evaluation and demo files](tasks/05-planted-error-evaluation.md) | `feat/task-05` | PR open | Task 01 replay: building hall 80/80 and precast 6/6 supported cases per format. All 46 controls clean. Nine known gaps and two Layer 3 cases per format remain. |
| 06 | [Upload real tender PDFs and .xls (queued)](tasks/06-real-pdf-excel-upload.md) | `feat/task-06` | in progress | Real PDF and legacy Excel preview, source-backed assessment, and parser regression coverage. |

Suggested merge order: 01 → 03 → 02 → 05 → 04 → 06. Each PR must pass CI (Python tests, frontend lint/build).

## Lead checklist

- [ ] VPS `.env.prod`: `ANALYSIS_L3_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, plus the defaults from task 02
- [ ] After each merge: re-run `python -m analysis.eval report` and the LV_11 fixture, and update the numbers below
- [ ] Update README "Analysis" and "Risk" sections after wave 1

## Wave 2 backlog (nothing is cut, only sequenced)

| Item | Depends on | Notes |
|---|---|---|
| Apply accepted fixes to a **new list version** (`Fix` operations → new `bom_version` / workspace list copy) | 03, 04 | Contracts already define `SetField`, `AddLine`, `RemoveLine`, `MergeLines`, `LinkAlternative` |
| Unusual-quantity rules `L1.QTY.ROUND_SHARE`, `IMPLIED_DURATION`, `UNIT_OUTLIER`, `L1.UNIT.CROSS_SECTION_MISMATCH` and layer 2 `Ratio` checks | 01 | Archived plan §3 |
| Historical reference prices and what-if (price shock → risk delta) | 03 | Archived plan §7 |
| `AnalysisInput.notes` (preamble / Vorbemerkungen) for layer 3 and risk | 02, 03 | Contract change |
| Layer 3 calibration on real labels, precision table in `docs/EVALUATION.md` | 02, 05 | |
| Demo rehearsal on the VPS and pitch numbers | all | |

## Measured results (lead updates after merges)

| Metric | Value |
|---|---|
| Analysis tests | 266 passed, 2 skipped (after task 01 + DIN follow-up) |
| LV_11 fixture findings (layers 1–2) | 13 (10 `L1.DIN.NOTE`, 2 `L1.TEXT.SPEC_PLACEHOLDER`, 1 `L1.UNIT.TRADE_MISMATCH`) |
