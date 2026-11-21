# VaultBudget — handoff / resume notes (2026-11-21)

## What this is
Recreation of the 4 design screens in `../design` (light "VaultBudget" variant) as a Vite + React 19 + TS + Tailwind v4 + zustand + motion app, filled with the real GAEB construction data from `../data`.

Run: `cd app && npm run dev` (http://localhost:5173). Rebuild data: `npm run data` (needs poppler `pdftotext`/`pdfinfo`).

## Done
- Data pipeline: `scripts/build-data.ts` + `src/lib/gaeb.ts` (GAEB DA XML 3.2/2004, GAEB 90 D83/D84/D86, "Anfrage" PDFs via `pdftotext -raw`, docx). All 44 data files used; 6 folders, 37 lists. Invariant: positions per LV_*.pdf == quantity lines; GAEB90 category sums == "32" records; Angebot total == 988,913.89.
- UI: All Projects grid, folder page, list detail (ledger, budget alert), empty folder, Active/Archived/Shared/Trash, Cmd+K palette, import (GAEB/CSV/JSON/PDF), mobile drawer. Lazy routes, persisted store (version 2 + migrate).
- Hill-climbing: `tests/compare.mjs` renders ours vs `design/*/code.html` at 1280x1024 → `tests/compare/`. Blurred similarity: projects 99.2 %, list 97.1 %, empty 99.3 %.
- Council review round 2: visual 8.3, function/content 8.7, code 7.0 → weighted 8.3/10.
- Feature (done, verified): category tree + split overlay + re-categorisation (`src/components/split/*`, `src/lib/resolve.ts`, `src/lib/cat.ts`). User decisions: moved positions are RENUMBERED (next free OZ in target category); split UI = large in-app overlay. Test: `node tests/split.mjs` (13 checks pass).

## Exporters (done 2026-11-21, verified)
- `src/lib/export/**`, `ExportMenu`/`ExportDialog` wired into ListPage. 10 formats. Tests: `npx tsx tests/export-roundtrip.ts` (byte-identical 9/9, cross-format 45/45, patch, PDF OZ/qty order), `node tests/export-ui.mjs` (all formats download via UI, UI byte-identity for X83/D86/PDF).
- Known gaps: PDF pagination differs from originals; Angebot (C) Zusammenstellung blocks + multi-line short texts fixed (61 texts recovered, totals match original); exceljs lazy chunk 929 kB triggers Vite warning (lazy only).

## (historic) In progress when saved
- Exporters (Sonnet subagent B, background): `src/lib/export/**`, `src/components/ExportMenu.tsx`, `src/components/ExportDialog.tsx`, `scripts/pdf-layout.py`, `public/data/layout/**`, `tests/export-roundtrip.ts`.
  Formats: CSV, XLSX (exceljs), PDF (pdf-lib, in the original layout family `source.pdfTemplate` A_anfrage | B_kurz_langtext | C_angebot | D_lv_ausdruck | E_courier — measurements in `docs/pdf-templates/*.txt`), GAEB X83 (3.2), x83 (2004), D83, D84, D86, DOCX, JSON.
  Fidelity rules: unedited + same format → original bytes; edited + same format → patch original; else generate in the source's notation.
  If the files above are incomplete, check what exists and finish/redo that part.

## Next steps
1. Wire `<ExportMenu listId doc selectedIds>` into `src/pages/ListPage.tsx` (replace the old Export menu) — main session does this.
2. Verify: `npx tsx tests/export-roundtrip.ts`, `npm run build`, compare exported PDFs to originals (PyMuPDF renders into `tests/export-shots/`).
3. Re-run all tests: `node tests/interact.mjs`, `node tests/extra.mjs`, `node tests/split.mjs`, `node tests/responsive.mjs`, `node tests/compare.mjs` (dev server must be running).
4. Open council items: alert "-/3" stepper + green CTA when within budget; sidebar 240 vs 256 px; duplicate checkbox in FolderCard select mode; 375px ledger table; 81 Angebot positions without short text; stats persisted; `trashedAt: 'purged'` sentinel.

## Conventions
- Pure coding → Sonnet subagents; review/visual verification in main session.
- Real data only; placeholders like `[FIRMA_102]` are the (anonymised) source content — keep verbatim.
- English UI chrome, German content, € formatting via `src/lib/format.ts`.
