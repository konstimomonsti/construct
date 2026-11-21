# Task 15 (PRIORITY, Marcos): UI fixes from the walkthrough

**Branch:** `feat/task-15` · **Owner:** Marcos (general UI) · **Recommended model:** Sonnet (Claude Sonnet 5.5)

## Why

Task 07's VPS walkthrough ([docs/ui-review/WALKTHROUGH.md](../docs/ui-review/WALKTHROUGH.md)) found these UI problems in
the demo path. Screenshots are in `docs/ui-review/walkthrough/`. Task 14 fixes the backend side; task 09 makes uploads
send section codes.

## Fixes (P1 first)

| P | Bug | Fix |
|---|---|---|
| P1 | The score and money at stake look final even when layer 3 was incomplete. | Parse the coverage line in `report.errors` (exact format from task 14: `layer 3 coverage: <run>/<planned> batches; skipped: …`). When `run < planned`, mark the score and amount as **"based on partial analysis"**, with a plain-language line ("17 AI checks were skipped") and the technical details expandable. Hide the hint when coverage is complete or layer 3 didn't run. |
| P1 | Section risk points don't change after accepting or dismissing a finding (the overall score does). | Recompute section totals client-side from **open** items: map each finding or signal to its section through `target.section_id`, its line, the position's `path`, or `line_id` for signals, then sum `risk.points` of undecided items. Accepting and then reopening must restore the value. |
| P1 | Section labels show a literal `null` prefix. | Render the code only when it's present; never print `null`/`undefined`. (Task 09 also starts sending codes.) |
| P1 | Exported PDFs render German characters, but copy, search and text extraction show replacement characters (Helvetica standard font without Unicode mapping). | Embed a Unicode TTF font (for example DejaVu Sans or Noto Sans, regular + bold, licence noted) with `@pdf-lib/fontkit` and use it for all text. This adds one dependency; note it in the PR. Check `Länge`, `Höhe`, `Währung` and `einschließlich` with copy/paste and `pdftotext`. |
| P1 | After importing a single file you stay on the project page and have to hunt for the list. | After a one-file import, open the new list (or show a prominent "Open list" button in the success toast). Multi-file imports stay on the project page. |
| P2 | Risk categories mix raw ids (`change_order`, `din`, `dependency`) with labels. | A display map (`change_order` → "Change-order risk", `din` → "DIN 1045-2", `dependency` → "Missing work", `arithmetic` → "Sums", `text` → "Text", `unit` → "Units", …) with a readable fallback for unknown ids. Use it everywhere categories show (summary, print, Excel export). |
| P2 | The export-format choice looks like checkboxes but acts as a single selection. | Use radio buttons with the legend "Choose one format". |
| P2 | The home page doesn't say what the product is or what to do first. | A short first-visit explanation ("Upload a tender (GAEB, PDF, Excel). BillBuild checks it for errors, missing work and change-order risk before you price it.") and a clear "Import a tender" action. Hide it once the workspace has lists, or make it dismissible. |

## Files you MAY create or modify (strict allowlist)

- `frontend/src/lib/risk-labels.ts` (new: category names, coverage parser), `frontend/tests/risk-labels.test.ts` (new)
- `frontend/src/components/risk/RiskSummary.tsx`, `frontend/src/components/risk/RiskPrint.tsx` (task 12 adds one mount line to RiskSummary later; keep your changes away from the end of the panel)
- `frontend/src/components/LedgerTable.tsx` (section risk display)
- `frontend/src/lib/risk-export.ts` (category names in the Excel)
- `frontend/src/lib/export/pdf.ts`, `frontend/public/fonts/**` (new), `frontend/package.json` / `package-lock.json` (only `@pdf-lib/fontkit`)
- `frontend/src/components/ExportDialog.tsx`
- `frontend/src/components/DropImport.tsx`, `frontend/src/lib/import.ts`, `frontend/src/pages/FolderPage.tsx` (import handoff)
- `frontend/src/pages/AllProjects.tsx` (home intro)
- this task file (notes) and your row in `STATUS.md`

**Not yours:** `ListPage.tsx`, `DetailDrawer.tsx`, `RiskAssessment.tsx` (task 10: it also fixes the "accept vs apply" flow),
`ExportMenu.tsx`, `store.ts` (task 13), `lib/parse-list-file.ts`, anything under `backend/`.

## Read-only references

- `docs/ui-review/WALKTHROUGH.md` and its screenshots, `CLAUDE.md` §4 and §5.4
- `tasks/14-demo-fixes-backend.md` (coverage line format)
- `frontend/src/lib/risk-assessment.ts` (`rescore()`, the `Risk` types)

## Acceptance criteria

1. Each fix is checked on the VPS or the local stack with the two demo files in `data/demo/`. Add before/after
   screenshots to the PR.
2. Unit tests cover the coverage-line parser, the category map fallback and the client-side section recompute (accept →
   lower, reopen → restored).
3. `pdftotext` on an exported precast PDF prints `Länge`, `Höhe` and `einschließlich` correctly.
4. `npm run lint`, `npm run build` and `npm test` pass.

## Notes / blockers (fill in)

- Local frontend checks: `npm run lint`, `npm run build`, and `npm test` passed (153 tests). Both demo X83 files imported (60 hall positions, 12 precast positions); a single-file import offered **Open list** and opened it, while a two-file import stayed on the project page.
- With a mocked analysis response, accepting the precast shop-drawing finding changed section points 51 → 45 and reopening restored 51. A mocked `layer 3 coverage: 17/20 batches; skipped: …` line showed the partial-analysis label and three skipped checks.
- Both demo X83 files exported locally to PDF. Poppler `pdftotext` on the precast PDF found `Länge` (6), `Höhe` (4), `einschließlich` (5), and `Währung` (3). The added `@pdf-lib/fontkit` dependency embeds Noto Sans and Noto Sans Mono regular/bold TTF fonts under the SIL Open Font License (`frontend/public/fonts/OFL.txt`).
- Full-stack/VPS verification is unverified: Docker is not installed here, no local backend is running, and VPS access is unavailable in this workspace. The UI checks above used the frontend preview and a mocked analysis response.
