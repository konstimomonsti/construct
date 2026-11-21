# Status

Each worker edits **only their own row** (Status: `todo` → `in progress` → `PR open` → `merged`, or `blocked`).
The lead merges PRs and resolves conflicts in this file. Contracts are in [CLAUDE.md](CLAUDE.md) §5.

## Wave 1 (started 2026-11-21, about 18 h left)

| ID | Task | Branch | Status | Notes |
|---|---|---|---|---|
| 01 | [Deterministic DIN 1045-2, precast and text-defect rules](tasks/01-deterministic-din-precast-rules.md) | `feat/task-01` | PR open | [PR #8](https://github.com/konstimomonsti/construct/pull/8); 259 tests passed, 3 skipped; LV_11: 13 findings. User approved minimal engine evidence/count-test exceptions. |
| 02 | [Layer 3 on Claude: precast extraction, scope audit, live demo](tasks/02-layer3-claude-checks.md) | `feat/task-02` | todo | |
| 03 | [Risk score, change-order signals, Bieterfragen (contract v0.2)](tasks/03-risk-score-bieterfragen.md) | `feat/task-03` | todo | |
| 04 | [Risk report UI, reviewer decisions, exports](tasks/04-risk-report-ui.md) | `feat/task-04` | todo | Uses a fixture until 03 lands |
| 05 | [Planted-error evaluation and demo files](tasks/05-planted-error-evaluation.md) | `feat/task-05` | todo | Precast labels show "missed" until 01/02 merge |
| 06 | [Upload real tender PDFs and .xls (queued)](tasks/06-real-pdf-excel-upload.md) | `feat/task-06` | queued | First worker to finish takes it |

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
| Analysis tests | 197 passed, 2 skipped (main @ 4c65528) |
| LV_11 fixture findings (layers 1–2) | 0 |
