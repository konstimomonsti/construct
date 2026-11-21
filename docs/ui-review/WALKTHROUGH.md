# Desktop demo: bugs and fix plan

VPS walkthrough on 21 November 2026 using the synthetic hall and precast tenders. This is a report and implementation plan; it makes no application changes. The deployed commit was not exposed in the UI. The test project **Task 07 usability walkthrough** remains on the VPS, with two imported lists and one accepted hall finding.

## Priority order

| Priority | Bug | Owner | Proposed fix | Verification |
| --- | --- | --- | --- | --- |
| P0 | Hall analysis skips checks when the layer 3 call budget is exhausted. | backend | Resume or schedule skipped batches within the demo's latency/cost limits. Return explicit coverage and an actionable retry when a complete run cannot be delivered. | Upload `building_hall_planted.X83` on the VPS. Confirm all intended batches finish, or that the UI identifies exactly what was skipped and retry completes it. Record duration and provider errors. |
| P1 | Partial analysis is presented beside a definitive score and money-at-stake value. | task 04 | Mark the score and amount as based on partial analysis when coverage is incomplete; show plain-language impact and a retry action. Keep technical details expandable. | Force a skipped batch and verify the score is visibly qualified; repeat with complete analysis and verify the qualification disappears. |
| P1 | Risk-by-section points appeared stale after accepting a finding. | task 04 | Recalculate section totals from open findings and signals after reviewer decisions, or explicitly label them as upload-time values if that is the intended contract. Confirm attribution before changing the calculation. | Reproduce on the hall list: accept the edge-insulation finding, compare its section's before/after points with the remaining open items, then reopen it and verify restoration. |
| P1 | Risk-by-section labels show a literal `null` prefix. | task 04 | Omit missing codes and render the title; include a code only when present. | Check hall and precast reports with missing section codes and a report with a valid code. Neither should show `null` or lose the title. |
| P1 | A generated bidder question duplicates its `Zu Pos.` prefix. | backend | Normalize question composition so a position prefix is added once, including when the rule already supplies one. | Generate the hall edge-insulation question and check it contains one prefix and retains both position numbers. Check questions that do not already contain a prefix. |
| P1 | PDF text extraction replaces German characters although the page renders correctly. | Marcos | Use a Unicode font and valid text mapping for exported PDFs. | Export the precast list, visually inspect it, then copy/search and extract `Länge`, `Höhe`, `Währung` and `einschließlich` without replacement characters. |
| P1 | The edge-insulation finding says quantity is required before accepting, but Accept succeeds without it. | task 04 | Distinguish accepting the finding from applying a proposed fix; require a quantity only for the operation that needs it and state that clearly. | Accept the finding, confirm the wording matches the resulting state, and verify any later fix application cannot proceed without its required quantity. |
| P1 | Single-file import leaves the user on the project page. | task 06 | Open the imported list or provide a prominent “Open list” action in the success message. | Import each demo file into a new project and reach its list and analysis state without hunting for the card or reloading. |
| P2 | The opening-surcharge finding exposes `opening_surcharge` and `ea`. | backend | Render trade-readable language and the tender's unit convention, e.g. “confirm whether the unit should be St instead of m.” | Inspect precast position 3.2.80 and its generated question; confirm the mismatch is accurate and no internal token is visible. |
| P2 | Risk categories mix raw lowercase identifiers and display labels. | task 04 | Map all categories to consistent, readable display names. | Review hall and precast category charts, including an unknown category fallback. |
| P2 | Export-format controls appear as checkboxes but behave as a single selection. | Marcos | Use radio buttons and “Choose one format,” or implement actual multiple selection. | Select PDF then GAEB and verify the control semantics and resulting download match. |
| P2 | The populated home page does not explain the product or next action. | Marcos | Add a brief first-visit explanation of tender-risk review and a clear “Import a tender” action. | Ask a new user to identify the purpose and first action within 30 seconds without instructions. |

## Evidence and observations

- [Hall analysis warning and score](walkthrough/vps-errors.png): the report listed 15 quantity batches and two other batches not checked after the 12-call budget was reached. This is evidence for this run, not a claim that every run fails.
- [Hall finding drawer](walkthrough/vps-drawer.png): accepting the edge-insulation finding changed the overall score from 75 to 73. Its top-risk points dropped from 23.12 to 11.56; the Estrich section remained at 23.12 in the observed state. The [section screenshot](walkthrough/vps-section.png) illustrates the same component on the precast list; capture the hall breakdown during reproduction before fixing.
- [Section label](walkthrough/vps-section.png), [duplicated question](walkthrough/vps-question.png), [unit wording](walkthrough/vps-unit.png), [category labels](walkthrough/vps-categories.png), [import result](walkthrough/vps-import.png), [export dialog](walkthrough/formats.png), and [home page](walkthrough/vps-home.png).
- [Rendered PDF page](walkthrough/vps-pdf.png) shows readable characters. `pypdf` extraction of the downloaded PDF replaced accented characters; copy/search behavior in the intended reader remains to be checked.
- The precast DIN, layer-sum and placeholder findings were present and understandable in their drawers: [DIN](walkthrough/vps-din.png), [layer sum](walkthrough/vps-layers.png), [placeholder](walkthrough/vps-placeholder.png).
- Excel's checked sheet contained 12 position rows and the expected OZ, text, quantity, unit, price, total and category columns; checked German text was intact. The GAEB XML parsed and contained 12 `Item` elements. These were spot checks on an unpriced list, not a full export reconciliation.

## Suggested execution

1. Backend resolves coverage first; task 04 adds an honest partial-coverage state in parallel using the existing contract. Re-run the hall demo before treating its risk score as complete.
2. Task 04 reproduces and fixes the section total and missing-code display. Backend fixes bidder-question composition; Marcos fixes PDF text mapping. Each owner verifies the concrete examples above.
3. Resolve the accept/fix wording and import handoff, then address the smaller language and export-control issues. Keep each change in its owner's branch and add targeted regression coverage where behavior changes.
4. Re-run the desktop path end to end on the VPS: create project, import hall, wait for checks, inspect top risks, review and filter a finding, inspect the precast findings, and compare Excel, PDF and GAEB exports. Record elapsed times, clicks, console errors and the deployed version.

## Limits

This was an operator walkthrough, not a study with an independent estimator. The hall analysis was incomplete. The demo script was not rehearsed because the original instruction limited repository reading to `CLAUDE.md` and task 07. Timings and click counts were not consistently recorded, and exports were only spot-checked. Desktop review should be repeated after the fixes.
