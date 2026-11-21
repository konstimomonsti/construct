# Usability walkthrough — VPS, incomplete

Run 21 November 2026 on the deployed VPS, using the two synthetic demo files in a new project named **Task 07 usability walkthrough**. This was an operator walkthrough using browser automation, not a study with an independent estimator or judge. The deployed commit was not exposed in the UI; local main was `37966c5` when the branch was last merged. The production project and two imported lists remain on the VPS. The hall's “Missing edge insulation” finding was accepted for S4; the score changed from 75 to 73. No other people's projects were edited.

**Still incomplete:** the requested 15 evidenced findings, a timed end-to-end demo-script rehearsal, a full keyboard-only journey, and a full 375 px repeat of S2–S4 were not completed. The instruction to read only `CLAUDE.md` and task 07 excluded the demo README. The figures below are recorded interaction durations, not estimates of an unaided person's task time. The browser console captured no errors. The hall report itself reported incomplete layer 3 checks.

## Five highest-impact changes

1. Make the hall's skipped layer 3 batches complete and make partial coverage actionable (UX-01).
2. Explain the scope and uncertainty of the risk score when checks fail (UX-02).
3. Make section risk totals reflect reviewer decisions and remove `null` labels (UX-03, UX-04).
4. Remove duplicated position prefixes from generated bidder questions (UX-05).
5. Preserve searchable/copyable German text in PDF exports (UX-06).

## Scenarios

| Scenario | Time | Clicks | Result | Worst friction |
| --- | --- | --- | --- | --- |
| S1 First visit | Not measured | 0 | Partial | Populated home gives project and budget data but no product explanation or first-step guidance. |
| S2 Hall project and upload | 73.5 s from opening project dialog to observed upload state, including browser/file-chooser overhead; analysis was not yet ready | 3 clicks plus file selection; a fourth opened the list | Partial | The app remained on the project page; checks later completed only partially. File chooser used, not drag-and-drop. |
| S3 Find top three | Not measured | 0 after the risk panel appeared | Partial | Ranking visible without reading rows, but first three included generic change-order wording and the report showed incomplete checks. |
| S4 Understand, review, filter | Not measured | 4 clicks for top risk, accept, filter menu and Errors; Escape closed drawer | Partial | The finding was accepted and Errors showed one row; advice said quantity must be entered before accepting, yet Accept succeeded. No reason was collected on acceptance. |
| S5 Precast findings | 4.1 s for chooser/upload, excluding time for analysis and review | 2 clicks plus file selection to import and open; 3 more to inspect the named findings | Partial | DIN, 32 vs 30 cm layer sum and placeholder were visible; wording mixes languages and internal vocabulary. |
| S6 Exports | Not measured | Not recorded | Partial | Excel, PDF and X83 downloaded. Spot checks below; PDF extracted text has replacement characters. No exhaustive row/column reconciliation. |
| S7 375 px and dark mode | Not measured | Not recorded | Partial | Precast risk summary and DIN drawer inspected; full S2–S4 repeat was not performed. Title truncates. |
| S8 Keyboard | 7 s for the recorded Enter → Tab → Escape segment, including tool latency | 0 during segment | Partial | Enter opened a focused top-risk item, Tab reached Accept, Escape closed and restored focus. Full traversal and trap test not completed. |

**Demo script:** not rehearsed end to end; timing unavailable because the explicit read restriction excluded `data/demo/README.md`. The VPS hall report also indicated skipped checks. Rehearse after the lead resolves that limitation.

**Export spot checks:** Excel `LV` sheet had 12 position rows, OZ, Kurztext, Langtext, Menge, ME, EP, GP and Kategorie columns, with German text intact; the exported GAEB XML parsed and contained 12 `Item` elements. PDF page 1 rendered with readable umlauts and columns, but `pypdf` extraction produced replacement characters for e.g. “Länge”, “Höhe” and “Währung”; copy/search/accessibility fidelity needs verification in the intended reader. The file was unpriced, so priced export reconciliation remains untested.

## Ranked findings

### UX-01 — P0 — Hall checks are incomplete (S2–S4)

[Warning](walkthrough/vps-errors.png) · **Owner:** backend · **Effort:** M

The report lists 15 quantity batches and two other batches not checked because a 12-call budget was reached. The estimator expects the demo's checks to cover the list. Complete or explicitly schedule the skipped batches, expose coverage, and provide a retry/resume path. This is a coverage failure on this run, not proof that every analysis run fails.

### UX-02 — P1 — Partial analysis still presents a definitive score (S3)

[Warning and score](walkthrough/vps-errors.png) · **Owner:** task 04 · **Effort:** S

A 73 High score and €94,992 money-at-stake figure are prominent alongside a technical error banner. A judge needs to know the score is based on incomplete checks. Label the score “Partial analysis” and explain that missed checks can change it; translate the call-budget detail into a plain-language expandable explanation.

### UX-03 — P1 — Section breakdown does not react to the decision (S4)

[Section breakdown](walkthrough/vps-section.png) · **Owner:** task 04 · **Effort:** M

On the hall, accepting the edge-insulation finding changed the score 75→73 and removed its category points, but the Estrich section still showed 23.12 points while its top-risk row fell from 23.12 to 11.56. The screenshot illustrates the same section breakdown component on precast; re-capture the hall before implementation. Recompute section values from open item points or label them as upload-time values.

### UX-04 — P1 — Section labels display `null` (S3, S5)

[Section label](walkthrough/vps-section.png) · **Owner:** task 04 · **Effort:** S

“null Stahlbetonfertigt...” appears in the section chart; the hall sections also had a `null` prefix. Users expect the section code or title. Omit absent codes and show the complete title.

### UX-05 — P1 — Duplicate position prefix in bidder question (S4)

[Question](walkthrough/vps-question.png) · **Owner:** backend · **Effort:** S

The edge-insulation question starts “Zu Pos. 02.02.0010, 02.02.0020: Zu Pos. 02.02.0010, 02.02.0020 …”. A client-ready question should have one prefix. Add the position prefix only if the generated text does not already contain it.

### UX-06 — P1 — PDF text extraction corrupts German characters (S6)

[Rendered page](walkthrough/vps-pdf.png) · **Owner:** Marcos · **Effort:** M

The rendered page looks correct, but extraction returned replacement characters for umlauts and ß. A user expects searchable and copyable text to match the printout. Embed a Unicode font with a valid text mapping and verify copy/search as well as rendering.

### UX-07 — P1 — Suggested-fix prerequisite conflicts with Accept (S4)

[Finding drawer](walkthrough/vps-drawer.png) · **Owner:** task 04 · **Effort:** S

The edge-insulation text says “enter [quantity] before accepting,” but Accept immediately marked it accepted without a quantity. Users need a clear distinction between accepting a finding and applying a fix. Change the text to say quantity is required before applying the suggested fix, or collect it before any action that actually requires it.

### UX-08 — P1 — Imported list does not open (S2, S5)

[Project after import](walkthrough/vps-import.png) · **Owner:** task 06 · **Effort:** S

A successful single-file import leaves the user on the project card; the scenario expects the list and findings. Open the list or add a prominent “Open list” action to the success toast.

### UX-09 — P1 — First-visit purpose is unclear (S1)

[Home](walkthrough/vps-home.png) · **Owner:** Marcos · **Effort:** S

The home page leads with totals and existing projects, without explaining tender-risk review or the first action. Add a concise one-sentence purpose and “Import a tender” first-visit action.

### UX-10 — P1 — Mobile list title is truncated (S7)

[375 px view](walkthrough/vps-mobile.png) · **Owner:** Marcos · **Effort:** S

The title becomes “LV 11 – Stahlbetonf...”, obscuring the tender identity. Wrap the title or offer an accessible expansion.

### UX-11 — P2 — Internal check names dominate the failure message (S2–S3)

[Warning](walkthrough/vps-errors.png) · **Owner:** task 04 · **Effort:** S

Identifiers such as `L3.QTY.IMPLAUSIBLE` and “batch(es)” explain implementation rather than the missing coverage to an estimator. Lead with “Some quantity and consistency checks did not finish,” show affected coverage and an action, and put technical details behind a disclosure.

### UX-12 — P2 — Unit finding exposes internal vocabulary (S5, S8)

[Unit drawer](walkthrough/vps-unit.png) · **Owner:** backend · **Effort:** S

The warning says “opening_surcharge” and “expected ea” while the tender says “Abrechnung nach St.” A construction professional expects trade language and German units. Say “For an opening surcharge, confirm whether the unit should be St instead of m.”

### UX-13 — P2 — Risk categories mix raw and display labels (S3, S5)

[Categories](walkthrough/vps-categories.png) · **Owner:** task 04 · **Effort:** S

Labels include “DIN 1045-2”, “Units”, lowercase “arithmetic”, “completeness” and “optimization”. Use a consistent display-name mapping and capitalization, with clear names for each category.

### UX-14 — P2 — Export format controls imply multiple selection (S6)

[Export dialog](walkthrough/formats.png) · **Owner:** Marcos · **Effort:** S

The controls look like checkboxes, but choosing PDF and then GAEB leaves only GAEB selected. Use radio buttons and “Choose one format,” or support multiple exports.

## Copy fixes

| Current | Proposed |
| --- | --- |
| `null Stahlbetonfertigteile` | `Stahlbetonfertigteile` (or the actual section code and title) |
| `opening_surcharge; expected ea` | `opening surcharge; expected St` |
| `Zu Pos. …: Zu Pos. …` | One `Zu Pos. …:` prefix |
| `Some checks reported errors … batch(es) not checked` | `Some checks did not finish. Results are incomplete. Retry checks.` |
| `More formats…` | `All export formats…` |

## What works well

The precast top-risk list links directly to relevant positions; the DIN drawer states grade, exposure and minimum, the layer-sum warning gives 32 cm versus 30 cm, and the placeholder identifies `[FIRMA_123]`. The error filter narrowed the hall list to its zero-quantity error. Accepting a finding updated the live score; Escape returned focus to the invoking top-risk item. The PDF rendered German characters correctly on the inspected page, and Excel preserved them in the checked rows.
