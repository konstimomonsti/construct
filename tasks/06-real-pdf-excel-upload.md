# Task 06 (queued: the first worker who finishes takes it): Upload real tender PDFs and .xls files

**Branch:** `feat/task-06` · **Recommended model:** Sonnet (Claude Sonnet 5.5)

## Objective

Today the BillBuild UI can only import PDFs that BillBuild itself exported (with an embedded payload). A **real tender
PDF** such as `data/tenders/LV_11_Stahlbetonfertigeile_Sandwichsockel.pdf` is rejected, and
`python -m analysis run <file>.pdf` fails with "from_file supports GAEB XML and GAEB 90". The backend importer already
parses tender PDFs well (98.8 % of positions with Poppler). Connect it to the UI and the analysis, and land the PDF
fixes and the `.xls` import that are sitting on unmerged branches.

## What to build

1. **Port the PDF fixes** from `origin/archive/pdf-extraction-fixes`: the diff to `importer/tender_import/pdf.py`
   plus `importer/tests/test_pdf_layout.py` and `conftest.py`. In the current layout they live at
   `backend/importer/...`. These fixes are F0–F4 and F6 in the archived plan §1. F0 is the Poppler check: refuse
   or warn on xpdf, and honour an optional `POPPLER_BIN`.
2. **F5:** `backend/analysis/adapter.py::derive_pricing` maps the PDF boolean flags (`unit_price_only`,
   `provisional_included`, `alternative_item`, `base_item`) the way `draft.py` does, and stops turning `False` into
   `"False"`. Also let `adapter.from_file` accept PDFs, so `python -m analysis run file.pdf` works.
3. **Endpoint** `POST /api/workspace/parse?filename=<name>` (CLAUDE.md §5.6). It takes the raw bytes and returns the
   list JSON that `parseListJson` reads, with `path` built from the section hierarchy, `qty`/`up` as numbers and
   `warnings`. Put the logic in a new `backend/workspace_parse.py`. In `backend/server.py`, only add the route,
   using the same size limit, host and origin checks as `/api/workspace/file`.
4. **Frontend:** in `frontend/src/lib/parse-list-file.ts`, when a PDF has no BillBuild payload, POST it to
   `/api/workspace/parse` and use the result (source kind `pdf`). Do the same for `.xls`. Add `.xls` to `ACCEPT` in
   `frontend/src/lib/import.ts`. Show the server's message on failure.
5. **.xls / messy Excel:** port `importer/tender_import/spreadsheet.py` and its tests from `origin/archive/excel-import`
   (commit `a8bbcb7`) into `backend/importer/`. Don't port the `webapp/` parts. Use it in `/api/workspace/parse` for
   `.xls` (the frontend keeps parsing `.xlsx`/`.csv` itself). Add `xlrd`/`openpyxl` to
   `backend/importer/requirements.txt` and `backend/requirements.txt`, and to the backend `Dockerfile` if it doesn't
   install from those files.
6. **Docs:** `docs/API.md` (the new endpoint) and the README's Poppler note if F0 changes behaviour.

## Files you MAY create or modify (strict allowlist)

- `backend/importer/tender_import/pdf.py`, `spreadsheet.py` (new), `common.py`, `ingest.py`
- `backend/importer/tests/**`, `backend/importer/requirements.txt`, `backend/requirements.txt`, `backend/Dockerfile`
- `backend/analysis/adapter.py`, `backend/analysis/tests/test_adapter_pdf.py` (new)
- `backend/workspace_parse.py` (new), `backend/server.py` (route only), `backend/tests/test_workspace_parse.py` (new)
- `frontend/src/lib/parse-list-file.ts`, `frontend/src/lib/import.ts`
- `docs/API.md`
- this task file (notes) and your row in `STATUS.md`

## Read-only references

- `CLAUDE.md` §3 (Poppler warning), §5.6
- `docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md` §0, §1 (PDF) and §6 (Excel)
- `backend/importer/tender_import/draft.py` (flag mapping), `structured.py`, `backend/workspace_analysis.py::_uploaded_input`
- `origin/archive/pdf-extraction-fixes`, `origin/archive/excel-import`

## Acceptance criteria

1. Dragging `LV_11_Stahlbetonfertigeile_Sandwichsockel.pdf` into a BillBuild folder creates a list with 9 positions
   (3.2.10–3.2.90) with correct quantities and units, and the upload assessment shows findings.
2. `python -m analysis run data/tenders/HEM2301-2_Gesamt-LV.pdf --layers 1,2` works, with no QTY/UNIT.MISSING
   storm (archived plan §1: 73 → 0/1).
3. The golden pair test (PDF vs GAEB by OZ) passes when Poppler is present and is skipped otherwise.
4. All backend and importer tests are green, and `npm run lint` and `npm run build` pass.

## Notes / blockers (fill in)

-

- The preview uses the existing importer and the same content-derived line IDs as the upload assessment. It retains page/row locations, pricing flags and missing source quantities.
- Real LV_11 extracts all nine positions. A two-sheet BIFF .xls with repeated position numbers imports both sheets and produces distinct position IDs.
- The archived PDF changes preserve the existing BillBuild embedded attachment path. The golden test also covers wrapped headers whose first line already contains “Menge”.
