# Status

Each worker edits **only their own row** (Status: `todo` → `in progress` → `PR open` → `merged`, or `blocked`).
The lead merges PRs and resolves conflicts in this file. Contracts are in [CLAUDE.md](CLAUDE.md) §5.

## Tasks (wave 1 started 2026-11-21)

| ID | Task | Branch | Status | Notes |
|---|---|---|---|---|
| 01 | [Deterministic DIN 1045-2, precast and text-defect rules](tasks/01-deterministic-din-precast-rules.md) | `feat/task-01` | merged | [PR #8](https://github.com/konstimomonsti/construct/pull/8) merged. LV_11: 13 findings. Lead follow-up: full DIN EN 206 grade table, armour-stone numbers ignored, case-sensitive exposure codes. Open: `SPEC_PLACEHOLDER` is noisy on anonymized manufacturer names (wave 2) |
| 02 | [Layer 3 on Claude: precast extraction, scope audit, live demo](tasks/02-layer3-claude-checks.md) | `feat/task-02` | merged | [PR #13](https://github.com/konstimomonsti/construct/pull/13). Live LV_11 layer 3: 24.5 s, $0.02, precision 1.0 on its eval set. Not measured yet: 200-line LV under 90 s. |
| 03 | [Risk score, change-order signals, Bieterfragen (contract v0.2)](tasks/03-risk-score-bieterfragen.md) | `feat/task-03` | merged | [PR #12](https://github.com/konstimomonsti/construct/pull/12). Contract v0.2 live. Score saturates (clean seed 67, real tenders 84-94): see task 08. |
| 04 | [Risk report UI, reviewer decisions, exports](tasks/04-risk-report-ui.md) | `feat/task-04` | merged | [PR #16](https://github.com/konstimomonsti/construct/pull/16). Built on a fixture (`?risk=fixture`). Re-check against real reports in task 07. |
| 05 | [Planted-error evaluation and demo files](tasks/05-planted-error-evaluation.md) | `feat/task-05` | PR open | Initial evaluation [PR #9](https://github.com/konstimomonsti/construct/pull/9) merged. Follow-up adds source-linked risk checks and upload replays. Scans caught all seven planted labels with guidance and all three scan controls passed. Across ten repository scan pages, all 60 positions link and 59 match native quantities and units. The dependency scope replay caught all 20 labels and cleared eight controls across four formats. Layer 3 scope reviews now preserve suggested bid quantities until reviewer acceptance. Eight adversarial tests cover quoted scope and quantity. The separate offered-SKU replay caught 24 product conflicts and eight missing-offer cases across eight formats. Requirements can now distinguish repeated codes by worksheet or original source locator. A cross-document replay caught 12 incompatible requirements across drainage, insulation, and doors. Written drainage stiffness now reconciles with attached limits across four formats. The source-first audit scores 14 reviewed cases from six repository bills and now catches all five confirmed defects with the optional dictionary. Repeated Word outline codes now cite their explicit alternative and ask for scope confirmation. Written quantity and hire formulas now reconcile with the billed quantities and guard bid-scenario changes. Quantity conflicts now produce source-linked bidder questions in German. Explicitly unresolved fire ratings now produce linked bidder questions across four upload formats. Layer 3 checks whether a stated value belongs to the quoted component before dropping a missing-specification finding. Silent class omissions on explicitly rated doors now produce source-linked bidder questions. All 16 planted cases and 32 controls passed across eight formats. Fire-door product reviews now compare the tender class with the exact offered SKU, flag lower comparable classes, and distinguish missing or incompatible declarations. Fire-door product reviews now select the declaration for the written wall construction and check its stated minimum thickness. The replay caught 40 labelled cases and cleared 16 controls. Named cable designations now flag conflicting core counts, cross-sections and written variants. All 32 planted cases and 24 controls passed across eight formats. See [evaluation](docs/EVALUATION.md). |
| 06 | [Upload real tender PDFs and .xls (queued)](tasks/06-real-pdf-excel-upload.md) | `feat/task-06` | merged | [PR #17](https://github.com/konstimomonsti/construct/pull/17). Real LV_11 PDF imports all nine positions and runs through the analysis. |
| 07 | [Usability walkthrough and improvement proposals (queued)](tasks/07-usability-walkthrough.md) | `feat/task-07` | merged | Desktop bug report and prioritized fix plan in PR #22; hall L3 coverage and end-to-end desktop verification remain. |
| 08 | [Calibrate the risk score and money at stake](tasks/08-risk-calibration.md) | `feat/task-08` | merged | [PR #23](https://github.com/konstimomonsti/construct/pull/23) merged, lead-reviewed. Clean seed 20 low, planted demo 57 high, real tenders 52-79; StBALV23040 money at stake 48 k EUR (plan ~53 k). |
| 09 | [Check line amounts and totals on uploaded GAEB files](tasks/09-upload-amount-checks.md) | `feat/task-09` | merged | Done inside [PR #37](https://github.com/konstimomonsti/construct/pull/37) (Marcos): source line amounts, section and net totals restored on uploads while inputs match; section codes sent. Lead-verified: 8 tests pass. |
| 14 | **PRIORITY:** [Backend fixes from the walkthrough (layer 3 coverage, question prefix, wording)](tasks/14-demo-fixes-backend.md) | `feat/task-14` | merged | [PR #31](https://github.com/konstimomonsti/construct/pull/31) merged and deployed. Live on the VPS (Anthropic): hall demo 16/16 batches in 31 s, 4 layer 3 findings, 12 questions, none with a doubled "Zu Pos.". |
| 15 | **PRIORITY (Marcos):** [UI fixes from the walkthrough](tasks/15-demo-fixes-ui.md) | `feat/task-15` | partly done | #37 added the partial-analysis label and opens a single imported list. **Still open:** Unicode font in the PDF export (still Helvetica), home-page intro, export-format control, and a re-check of section points and category names after #25 moved the risk review into the list. |
| 10 | [Apply accepted fixes (reviewed, undoable, original kept)](tasks/10-apply-accepted-fixes.md) | `feat/task-10` | queued | |
| 13 | **PRIORITY:** [Subcontractor requests: pick positions + subcontractors, budget, export + email draft](tasks/13-subcontractor-requests.md) | `feat/task-13` | merged | [PR #29](https://github.com/konstimomonsti/construct/pull/29) merged, lead-reviewed. 20 tests pass incl. budget-leak checks; .eml drafts verified (encoded subject, base64 attachment, X-Unsent). |
| 11 | [Unusual-quantity rules and layer 2 ratio checks](tasks/11-quantity-rules-and-ratios.md) | `feat/task-11` | queued | |
| 12 | [Reference prices from past offers and a what-if view](tasks/12-reference-prices-what-if.md) | `feat/task-12` | queued | Opus; P0 = references + price rules |
| 16 | [Supplier requests, communication log, AI categorization](tasks/16-supplier-crm.md) | `feat/supplier-crm` | merged | [PR #40](https://github.com/konstimomonsti/construct/pull/40): `/requests` page, grouped supplier quote emails, AI categories with keyword fallback, communication log (migration 020). |

Suggested merge order: 01 → 03 → 02 → 05 → 04 → 06. Each PR must pass CI (Python tests, frontend lint/build).

Priority for free workers: **15 (rest)** → 10 → 11 → 12. Before the hand-in: demo rehearsal on the VPS (see the walkthrough's step 4) and the pitch numbers below.

## Other merged work (outside the task files)

| PR | What | Author |
|---|---|---|
| #25 | Risk review moved into the position list | Marcos |
| #26, #32 | Product matching and catalogue recall from uploaded tender evidence | Marcos |
| #27 | Sidebar reorganised, incomplete catalogue entries flagged | Marcos |
| #33, #38, #39 | Group positions by OZ prefix, section-wide selection, exports scoped to selected subsections | Marcos |
| #36 | Bid simulator for GAEB X83 lists (standard vs price-only vs quantity-aware bids) | Marcos |
| #37 | Hand-in readiness: source amounts on uploads (task 09), partial-analysis label, import opens the list | Marcos |

## Open PRs to review before merging

| PR | What | Note |
|---|---|---|
| #35 | Extend BOM risk evaluation, OCR for raster PDFs, evidence across uploads (branch `feat/task-05`) | 96 files across contracts, adapter, eval and bid pricing. Needs a careful review, a check that `python -m analysis.eval fp` still exits 0, and no regressions in the measured results below |
| #41 | Project page as an X83 → Subcontractors → X84 → X86 workflow | Redesigns `ListPage.tsx`, which task 10 also needs. Merge it before task 10 starts, or have task 10 build on its branch |

## Lead checklist

- [x] VPS `.env.prod`: `ANALYSIS_L3_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, plus the defaults from task 02 (checked 2026-11-21 17:10)
- [ ] After each merge: re-run `python -m analysis.eval report` and the LV_11 fixture, and update the numbers below (last: main at PR #31)
- [ ] After each merge: deploy manually (CI deploy is off, `VPS_HOST` unset). Last deploy: main 916ec70 on 2026-11-21 17:10, backup `manual-20261121T160925Z.dump`
- [x] Update README "Analysis" and "Risk" sections after wave 1

## Wave 2 backlog (nothing is cut, only sequenced)

| Item | Depends on | Notes |
|---|---|---|
| Apply accepted fixes to a **new list version** | 03, 04 | Now task 10 |
| Unusual-quantity rules and layer 2 `Ratio` checks | 01 | Now task 11 |
| Historical reference prices and what-if | 03 | Now task 12 (the bid simulator in #36 covers part of the what-if idea; task 12 should reuse it, not duplicate it) |
| `AnalysisInput.notes` (preamble / Vorbemerkungen) for layer 3 and risk | 02, 03 | Contract change |
| Layer 3 calibration on real labels, precision table in `docs/EVALUATION.md` | 02, 05 | |
| Demo rehearsal on the VPS and pitch numbers | all | Next up for the lead |
| Import subcontractor offers (D84/Excel) back into a package and compare with the budget (Preisspiegel) | 13, 16 | Listed in task 13 as "later"; #41 adds the X84 phase tab |
| Real email sending through SMTP on the VPS | 13, 16 | Needs explicit configuration; drafts (`.eml`) work today |

## Measured results (lead updates after merges)

| Metric | Value |
|---|---|
| Analysis tests | 391 passed, 3 skipped; `backend/tests/test_workspace_analysis.py` 8 passed; `eval fp` exits 0 (main after PR #40, lead check) |
| Planted-error eval (layers 1–2) | 244 files; 100% recall on every non-gap mutation; 100% precision on every rule; 46 controls, 0 false alarms. Gaps: reworded duplicate, typo, 'nach Aufwand' |
| Hall demo, live layers 1–3 on the VPS | 11 findings (6 L1, 1 L2, 4 L3), risk 64 high, 31 s, 16/16 layer 3 batches |
| LV_11 fixture findings (layers 1–2) | 13 (10 `L1.DIN.NOTE`, 2 `L1.TEXT.SPEC_PLACEHOLDER`, 1 `L1.UNIT.TRADE_MISMATCH`); risk 38 medium; 7 Bieterfragen |
