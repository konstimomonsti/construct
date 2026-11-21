# Status

Each worker edits **only their own row** (Status: `todo` → `in progress` → `PR open` → `merged`, or `blocked`).
The lead merges PRs and resolves conflicts in this file. Contracts are in [CLAUDE.md](CLAUDE.md) §5.

## Wave 1 (started 2026-11-21, about 18 h left)

| ID | Task | Branch | Status | Notes |
|---|---|---|---|---|
| 01 | [Deterministic DIN 1045-2, precast and text-defect rules](tasks/01-deterministic-din-precast-rules.md) | `feat/task-01` | merged | [PR #8](https://github.com/konstimomonsti/construct/pull/8) merged. LV_11: 13 findings. Lead follow-up: full DIN EN 206 grade table, armour-stone numbers ignored, case-sensitive exposure codes. Open: `SPEC_PLACEHOLDER` is noisy on anonymized manufacturer names (wave 2) |
| 02 | [Layer 3 on Claude: precast extraction, scope audit, live demo](tasks/02-layer3-claude-checks.md) | `feat/task-02` | merged | [PR #13](https://github.com/konstimomonsti/construct/pull/13). Live LV_11 layer 3: 24.5 s, $0.02, precision 1.0 on its eval set. Not measured yet: 200-line LV under 90 s. |
| 03 | [Risk score, change-order signals, Bieterfragen (contract v0.2)](tasks/03-risk-score-bieterfragen.md) | `feat/task-03` | merged | [PR #12](https://github.com/konstimomonsti/construct/pull/12). Contract v0.2 live. Score saturates (clean seed 67, real tenders 84-94): see task 08. |
| 04 | [Risk report UI, reviewer decisions, exports](tasks/04-risk-report-ui.md) | `feat/task-04` | merged | [PR #16](https://github.com/konstimomonsti/construct/pull/16). Built on a fixture (`?risk=fixture`). Re-check against real reports in task 07. |
| 05 | [Planted-error evaluation and demo files](tasks/05-planted-error-evaluation.md) | `feat/task-05` | PR open | Initial evaluation [PR #9](https://github.com/konstimomonsti/construct/pull/9) merged. Follow-up adds source-linked risk checks and upload replays. Scans caught all seven planted labels with guidance and all three scan controls passed. Across ten repository scan pages, all 60 positions link and 59 match native quantities and units. See [evaluation](docs/EVALUATION.md). |
| 06 | [Upload real tender PDFs and .xls (queued)](tasks/06-real-pdf-excel-upload.md) | `feat/task-06` | merged | [PR #17](https://github.com/konstimomonsti/construct/pull/17). Real LV_11 PDF imports all nine positions and runs through the analysis. |
| 07 | [Usability walkthrough and improvement proposals (queued)](tasks/07-usability-walkthrough.md) | `feat/task-07` | merged | Desktop bug report and prioritized fix plan in PR #22; hall L3 coverage and end-to-end desktop verification remain. |
| 08 | [Calibrate the risk score and money at stake](tasks/08-risk-calibration.md) | `feat/task-08` | merged | [PR #23](https://github.com/konstimomonsti/construct/pull/23) merged, lead-reviewed. Clean seed 20 low, planted demo 57 high, real tenders 52-79; StBALV23040 money at stake 48 k EUR (plan ~53 k). |
| 09 | [Check line amounts and totals on uploaded GAEB files](tasks/09-upload-amount-checks.md) | `feat/task-09` | queued | Demo gap: the planted wrong amount only shows in the CLI |
| 14 | **PRIORITY:** [Backend fixes from the walkthrough (layer 3 coverage, question prefix, wording)](tasks/14-demo-fixes-backend.md) | `feat/task-14` | merged | [PR #31](https://github.com/konstimomonsti/construct/pull/31) merged and deployed. Live on the VPS (Anthropic): hall demo 16/16 batches in 31 s, 4 layer 3 findings, 12 questions, none with a doubled "Zu Pos.". |
| 15 | **PRIORITY (Marcos):** [UI fixes from the walkthrough](tasks/15-demo-fixes-ui.md) | `feat/task-15` | queued | From task 07 |
| 10 | [Apply accepted fixes (reviewed, undoable, original kept)](tasks/10-apply-accepted-fixes.md) | `feat/task-10` | queued | |
| 13 | **PRIORITY:** [Subcontractor requests: pick positions + subcontractors, budget, export + email draft](tasks/13-subcontractor-requests.md) | `feat/task-13` | merged | [PR #29](https://github.com/konstimomonsti/construct/pull/29) merged, lead-reviewed. 20 tests pass incl. budget-leak checks; .eml drafts verified (encoded subject, base64 attachment, X-Unsent). |
| 11 | [Unusual-quantity rules and layer 2 ratio checks](tasks/11-quantity-rules-and-ratios.md) | `feat/task-11` | queued | |
| 12 | [Reference prices from past offers and a what-if view](tasks/12-reference-prices-what-if.md) | `feat/task-12` | queued | Opus; P0 = references + price rules |

Suggested merge order: 01 → 03 → 02 → 05 → 04 → 06. Each PR must pass CI (Python tests, frontend lint/build).

Priority for free workers: 09 → 15 (Marcos) → 10 → 11 → 12. (08, 13, 14 merged.)

## Lead checklist

- [x] VPS `.env.prod`: `ANALYSIS_L3_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, plus the defaults from task 02 (checked 2026-11-21 17:10)
- [ ] After each merge: re-run `python -m analysis.eval report` and the LV_11 fixture, and update the numbers below (last: main at PR #31)
- [ ] After each merge: deploy manually (CI deploy is off, `VPS_HOST` unset). Last deploy: main 916ec70 on 2026-11-21 17:10, backup `manual-20261121T160925Z.dump`
- [x] Update README "Analysis" and "Risk" sections after wave 1

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
| Analysis tests | 386 passed, 4 skipped; importer tests 173 passed (main at PR #31) |
| Planted-error eval (layers 1–2) | 244 files; 100% recall on every non-gap mutation; 100% precision on every rule; 46 controls, 0 false alarms. Gaps: reworded duplicate, typo, 'nach Aufwand' |
| Hall demo, live layers 1–3 on the VPS | 11 findings (6 L1, 1 L2, 4 L3), risk 64 high, 31 s, 16/16 layer 3 batches |
| LV_11 fixture findings (layers 1–2) | 13 (10 `L1.DIN.NOTE`, 2 `L1.TEXT.SPEC_PLACEHOLDER`, 1 `L1.UNIT.TRADE_MISMATCH`); risk 38 medium; 7 Bieterfragen |
