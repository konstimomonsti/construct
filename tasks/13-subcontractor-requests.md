# Task 13 (PRIORITY, before 11 and 12): Subcontractor requests (Nachunternehmer-Anfrage)

**Branch:** `feat/task-13` · **Recommended model:** Sonnet (Claude Sonnet 5.5); Opus if the flow gets stuck

## Why

After we receive a tender, we price part of the work ourselves and **give packages of positions to subcontractors**
(Nachunternehmer), for example screed, drywall or electrical. Today that means copying positions into a new file and
writing emails by hand. BillBuild should do it in one flow:

1. **Pick what** the subcontractor should do: positions or whole sections of the list.
2. **Pick who:** one or more subcontractors from the existing subcontractor catalogue.
3. **Set the expected cost** (our internal budget for the package). **It is never exported to the subcontractor.**
4. **One click:** export the file they must fill in (positions with empty price fields) and open a **ready email draft**
   with the file attached, one per subcontractor.

## What to build

1. **Package model** in a new `frontend/src/lib/subcontract.ts` (pure functions, unit-tested), stored on the list and
   synced through the workspace:
   ```ts
   type SubcontractPackage = {
     id: string; name: string                    // e.g. "Estricharbeiten"
     positionIds: string[]                       // positions of this list
     subcontractorIds: string[]                  // catalogue ids (subcontractors)
     budget: { perPosition: Record<string, number>; total: number }  // internal expected cost, EUR, never exported
     dueDate?: string                            // offer deadline (ISO date)
     format: 'x83' | 'xlsx' | 'pdf'
     status: 'draft' | 'sent' | 'offer_received'
     sentAt?: string; notes?: string
   }
   ```
   Store it as `listPatch[listId].subcontractPackages: SubcontractPackage[]`. A position may be in only one package
   (warn and offer to move it).
2. **Flow** in a new overlay `frontend/src/components/subcontract/SubcontractOverlay.tsx`, opened from a new
   **"Send to subcontractor…"** item in `components/ExportMenu.tsx`. ExportMenu already receives the selected positions.
   - **What:** starts with the current selection. You can add or remove positions or whole sections with the existing
     `components/split/CategoryTree.tsx` checkbox tree. Show count and quantity summary.
   - **Who:** a multi-select from the subcontractor catalogue (`lib/catalogues.ts`, kind `subcontractors`: `name`,
     `trade`, `contact_name`, `email`). Filter by trade, and suggest subcontractors whose trade matches the package name
     or the sections. Warn when someone has no email.
   - **Expected cost:** per position (prefilled from the list's own unit price × quantity when there is one, otherwise
     empty), with an editable package total. Clearly marked "internal, not sent".
   - **Send:** due date, format (default **GAEB X83 without prices**, the standard request format; Excel with empty price
     columns; PDF printout), and a German email text built from a template that you can edit before sending.
3. **One click "Export & draft email"** (`frontend/src/lib/subcontract-send.ts`, new):
   - Build the request file per package with the existing exporter (`lib/export/*`, scope = the package positions,
     `prices: false`). The Excel variant must give the subcontractor **empty unit-price cells with line totals as
     formulas**. If the existing table export can't do that, write the small variant in your own file (don't change
     `lib/export/*`).
   - For **each subcontractor**, generate an **`.eml` draft** (MIME multipart, file attached as base64, header
     `X-Unsent: 1`, `To:` = catalogue email, subject `Anfrage Nachunternehmerleistung: <package> – <project/list>`) and
     download it. Outlook, Apple Mail and Thunderbird open it as a ready-to-send draft with the attachment. With several
     subcontractors, download one `.zip` (fflate is already a dependency).
   - Also offer **"Copy email text"** and a **`mailto:` link** (no attachment possible there; say so).
   - **We don't send real email from the server in this task.** (A later task can add SMTP behind env settings. Sending
     on the user's behalf needs explicit configuration.)
   - Set the package to `sent` with `sentAt`.
4. **Email template (German, formal):** salutation with `contact_name` if known ("Sehr geehrte/r …", otherwise
   "Sehr geehrte Damen und Herren,"), the project and package name, the number of positions, the offer deadline, a request
   to fill in unit prices in the attached file and return it, and the sender block (our company name; leave a placeholder
   field the user can edit once and that is remembered in local settings). No budget figures in the email.
5. **Overview:** a "Subcontract packages" section in the same overlay listing this list's packages with status, recipients,
   budget total, "Re-export / new draft", "Mark offer received" and delete.

## Files you MAY create or modify (strict allowlist)

- `frontend/src/lib/subcontract.ts`, `frontend/src/lib/subcontract-send.ts` (new)
- `frontend/src/components/subcontract/**` (new)
- `frontend/src/components/ExportMenu.tsx`: add the menu item and mount the overlay
- `frontend/src/lib/store.ts`: **only** add `subcontractPackages?: SubcontractPackage[]` at the end of the `ListPatch`
  interface (task 10 also adds a field there; keep your change to that one line plus the import)
- `frontend/tests/subcontract.test.ts` (new)
- this task file (notes) and your row in `STATUS.md`

**Not yours:** `ListPage.tsx`, `DetailDrawer.tsx`, `RiskAssessment.tsx` (task 10), `components/risk/*` (tasks 04/12),
`lib/export/*` (read-only, reuse it), anything under `backend/`.

## Read-only references

- `CLAUDE.md` §4 (frontend conventions, German formats via `lib/format.ts`)
- `frontend/src/lib/catalogues.ts`, `frontend/src/components/WorkspaceCatalogue.tsx` (how catalogue rows are loaded)
- `frontend/src/components/ExportDialog.tsx`, `frontend/src/lib/export/index.ts` (scope `selection`, `prices: false`)
- `frontend/src/components/split/SplitOverlay.tsx`, `CategoryTree.tsx` (an existing overlay with a section checkbox tree)

## Acceptance criteria

1. On a list (for example the uploaded `data/demo/building_hall_planted.X83`), select the screed section, choose two
   subcontractors, enter an expected cost, click **Export & draft email**: you get a `.zip` with one X83 (no prices) and
   two `.eml` drafts. Each `.eml` opens in a mail client as a draft with the right recipient, German text and the X83
   attached. Add screenshots of the overlay and an opened draft to the PR.
2. The exported X83 re-imports into BillBuild with exactly the package positions and no prices. The Excel variant has
   empty unit-price cells and formula totals.
3. The budget appears nowhere in the exported file or the email (test this).
4. The package is saved, syncs to a second browser, and shows as `sent`.
5. Unit tests cover the package model (one package per position), the template and the MIME builder.
   `npm run lint`, `npm run build` and `npm test` pass.

## Later (not in this task, listed so the design leaves room)

- Import the subcontractor's filled-in offer (D84 / Excel) back into the package and compare it with the budget and other
  subcontractors (price comparison, Preisspiegel).
- Real email sending through SMTP on the VPS, behind explicit env configuration.

## Notes / blockers (fill in)

-
