# Task 04: Risk report UI, reviewer decisions and exports (frontend)

**Branch:** `feat/task-04` · **Recommended model:** Sonnet (Claude Sonnet 5.5)

## Objective

On a list's page, turn today's findings-on-rows into a full **risk review** that the demo can walk through:
a risk summary, findings with accept/dismiss and a reason, change-order signals, Bieterfragen and exports. Build it
against the contract in **CLAUDE.md §5.4–5.5**. Task 03 implements that contract in parallel, so use a
TypeScript fixture until it lands, and handle reports **without** `risk`/`questions` (older runs) gracefully.

## What to build

1. **Types and data** (`src/lib/risk-assessment.ts`): extend `Finding` (`evidence`, `origin`, `model`, `category`,
   `scope`, `target.line_code`) and `Report` (`risk?`, `questions?`, `layers_run`, `summary`). Add a pure function
   `rescore(risk, decisions)` that implements the §5.4 formula.
2. **Decisions** (§5.5): `listPatch[listId].findingDecisions` with status, reason and note. Keep `reviewedFindings` in
   sync. The existing "Mark reviewed" becomes Accept / Dismiss (with a reason picker) / Reopen. Add bulk dismiss by rule.
3. **Risk summary panel** (new `src/components/risk/RiskSummary.tsx`): tiles for score and level (live re-score),
   money at stake or "not priced", open errors/warnings, change-order signals and reviewed n of m. Then top-10 risks
   (click to jump to the row and open the drawer), risk by section and category (simple bars) and a change-order
   signals list with dismiss. Add a banner when layer 3 didn't run or reported errors (`report.errors`).
4. **Finding detail** in the existing drawer: show `origin=llm` with a model badge ("AI check"), `evidence.din`,
   `evidence.extracted` as a small key/value table and the suggested fix rationale.
5. **Bieterfragen panel** (new `src/components/risk/BidderQuestions.tsx`): a numbered list of `questions` whose
   source findings aren't dismissed, editable text, "Copy all", "Download .md" (German email starting
   *Sehr geehrte Damen und Herren,*).
6. **Exports** (new `src/lib/risk-export.ts`): an **Excel risk matrix** with `exceljs` (already a dependency),
   following Biel's spec §5A. Sheets: `Summary`, `Findings_Log` (OZ, rule, layer/source, severity, category,
   message, recommended action, Bieterfrage, decision, reason, with severity colours #FFC7CE / #FFEB9C / #DDEBF7,
   a frozen header and wrapped text) and `Change_Orders`. Add a **Print / Save as PDF** view through `@media print`
   CSS: summary, top risks, findings by section and questions, with controls hidden.
7. Keep it fast: a 1,000-line list with 500 findings must stay responsive (virtualize or paginate the findings list,
   and update only the changed row on a decision).

## Files you MAY create or modify (strict allowlist)

- `frontend/src/lib/risk-assessment.ts`, `frontend/src/components/RiskAssessment.tsx`
- `frontend/src/components/risk/**` (new)
- `frontend/src/lib/risk-export.ts` (new)
- `frontend/src/pages/ListPage.tsx`, `frontend/src/components/LedgerTable.tsx`, `frontend/src/components/DetailDrawer.tsx`
- `frontend/src/lib/types.ts` and `frontend/src/lib/store.ts`: **only** to add `findingDecisions` to the list patch type and its setter
- `frontend/src/index.css`: print styles only
- `frontend/tests/risk-assessment.test.ts`, `frontend/tests/fixtures/risk-report.ts` (new; use `.ts`, because `*.json` is git-ignored)
- this task file (notes) and your row in `STATUS.md`

**Not yours:** `parse-list-file.ts`, `import.ts`, anything under `backend/`.

## Read-only references

- `CLAUDE.md` §5.4, §5.5 (your contract) and §4 (frontend conventions)
- `frontend/src/lib/format.ts` (German formats), `frontend/src/components/ui.tsx`, `frontend/src/lib/export/table.ts` (exceljs usage)
- `docs/API.md` (`/api/workspace/analysis`), `docs/lv_hybrid_validation_implementation_guide.md` §5 (report layout)
- `docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md` §4 (screen layout ideas)
- `origin/archive/risk-report-ui:webapp/static/index.html` (an earlier risk UI in the old demo, for ideas only)

## Acceptance criteria

1. `npm run lint`, `npm run build` and `npm test` pass. A unit test covers `rescore()` and the decision reducer.
2. With the fixture (and later a real backend), a reviewer can: see the score, dismiss a finding with a reason
   (the score drops immediately and the change syncs to a second browser), accept, reopen, bulk-dismiss a rule,
   edit and copy Bieterfragen, download the `.xlsx` (3 sheets, colours) and `.md`, and print.
3. A report without `risk`/`questions` shows the findings as today, with no crash and the summary hidden.
4. Desktop and 375 px mobile layouts work. Add a screenshot of each to the PR.

## Notes / blockers (fill in)

-
