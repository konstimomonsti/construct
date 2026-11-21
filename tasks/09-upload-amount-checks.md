# Task 09: Check line amounts and totals on uploaded GAEB files

**Branch:** `feat/task-09` · **Recommended model:** Sonnet (Claude Sonnet 5.5)

## Problem

On the command line, `python -m analysis run data/demo/building_hall_planted.X83` reports the planted wrong line amount
on `01.02.0010` (`L1.ARITH.LINE_AMOUNT`) and its section and net consequences (`L1.ARITH.SECTION_TOTAL`,
`L1.ARITH.NET_TOTAL`). **The same file uploaded in the BillBuild UI shows none of them.** The demo script in
`data/demo/README.md` has to work around this.

Root cause, in `backend/workspace_analysis.py`:
- `_uploaded_input()` puts a tender's (phase 83) unit price into `line.price`, not `line.source_amounts`.
- `_attach_source()` copies the file's `line_amount` only when `line.source_amounts` already exists, so for X83 it never
  does. The second branch only handles xls/pdf.
- Section subtotals (`Section.stated_total`) and the net total (`Bom.stated_net_total`) from the original file are never
  attached for any format, so the section and net checks can't run on uploads.

## What to build

1. In `_attach_source()`, for GAEB sources (`gaeb_xml`, `gaeb_1990`): when a list line still has the source's quantity,
   unit and unit price (from `line.price` or `line.source_amounts`), set `line.source_amounts` to the source's
   `unit_price` and `line_amount`, so `L1.ARITH.LINE_AMOUNT` can compare them. Keep the existing rule: **once the user
   changes quantity, unit or price, the file's amount no longer applies** (no false "wrong amount" after an edit).
2. Attach the source's section `stated_total` (match sections by normalised OZ code with the existing `_code()`) and
   `bom.stated_net_total`, **only while every line in that section (or, for the net total, in the list) is unchanged**
   compared with the source and no line was added, removed or moved there. Otherwise leave them `None`.
3. Keep phase semantics: in a tender (83) the prices are the client's; in a bid or award (84/86) they're the bidder's.
   Don't change which analysis rules see them as `price` or `source_amounts`, beyond what step 1 needs.
4. **Also (from the task 07 walkthrough):** `_uploaded_input()` builds sections without a `code`, so risk-by-section
   shows a literal `null` label in the UI. Set each section's `code` (the OZ it was built from, e.g. `02.02`), so
   `risk.by_section[].code` is filled on uploads.
5. Tests in a new `backend/tests/test_workspace_analysis.py`. Call `_uploaded_input`, `_attach_source` and `run`
   directly with an in-memory source (no DB): build the list snapshot the way the frontend sends it (see
   `_uploaded_input`'s input shape) from `data/demo/building_hall_planted.X83` parsed with the importer.

## Files you MAY create or modify (strict allowlist)

- `backend/workspace_analysis.py`
- `backend/tests/test_workspace_analysis.py` (new)
- `data/demo/README.md`: remove the "the current X83 upload check omits the source amount" caveat once it works
- this task file (notes) and your row in `STATUS.md`

## Read-only references

- `CLAUDE.md` §2 (upload flow), §5.1
- `backend/analysis/layer1/arithmetic.py` (what `LINE_AMOUNT`, `SECTION_TOTAL` and `NET_TOTAL` read)
- `backend/analysis/adapter.py` (`from_import`, how CLI runs fill `source_amounts`, `stated_total`, `stated_net_total`)
- `frontend/src/lib/risk-assessment.ts` (the frontend only reads the report; no frontend change is needed)

## Acceptance criteria

1. A test proves that the uploaded-list path on `building_hall_planted.X83` yields `L1.ARITH.LINE_AMOUNT` on 01.02.0010
   plus the section and net total findings, the same as `python -m analysis run` on that file.
2. A test proves that after the user edits the quantity or price of 01.02.0010 (snapshot differs from source), **no**
   arithmetic finding about the file's amount appears for that line or its section.
3. A clean priced GAEB file (for example `data/tenders/StBALV23040.D86`) produces no new arithmetic findings on the
   upload path that the CLI doesn't also produce.
4. `PYTHONPATH=backend:backend/importer python -m pytest -q backend/tests backend/analysis/tests` is green (on
   Windows, the 3 known font/MIME failures in `backend/tests` are acceptable; CI on Linux must be green).
5. A test proves that uploaded-list sections carry their OZ `code`, and `risk.by_section[].code` is never null for them.
6. If you can run the local stack: upload the file in the UI and add a screenshot of the wrong-amount finding to the PR.

## Notes / blockers (fill in)

-
