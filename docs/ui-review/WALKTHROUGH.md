# Usability walkthrough — preliminary, blocked

Run on 21 November 2026 against local Vite at commit `455e7c9`, without the backend. Docker, npm and Python were not available on PATH; no backend was listening on port 8080. The existing Vite installation was started directly with Node. No VPS login or team-chat destination was available. This is an operator walkthrough, not a timed study with a new human participant. The browser started at a narrow viewport; the mobile check explicitly used 375 × 812. The console log captured no errors, although the UI reported unavailable services.

**Incomplete:** findings, review decisions, exports, and the demo rehearsal require a working backend. The requested minimum of 15 evidenced findings was not reached. The instruction to read only `CLAUDE.md` and the task file prevented reading the demo script; it was not rehearsed. Do not treat this report as acceptance of the demo.

## Highest-impact observations

1. Restore analysis access for the walkthrough and give a clear recovery action when checks are unavailable (UX-01).
2. Open the imported list or offer a prominent next step after import (UX-02).
3. Explain the product and first action on the populated home page (UX-03).
4. Preserve the list title on narrow screens (UX-04).
5. Clarify that only one export format can be selected at a time (UX-05).

## Scenarios

Times and clicks below cover only recorded portions; no estimates are substituted for missing measurements. Upload duration includes browser automation and file chooser overhead, so it is not a reliable product performance measurement.

| Scenario | Time | Clicks | Result | Worst friction |
| --- | --- | --- | --- | --- |
| S1 First visit | Not measured | 0 | Partial | Home shows projects and totals but no explanation of the risk-checking workflow. |
| S2 Create and import hall | About 77 s for file chooser/upload interaction, not end-to-end | 4 clicks including opening the list; excludes file selection | Partial | Imported 60 positions, stayed on project page, and the upload check was unavailable. Drag-and-drop was not exercised. |
| S3 Top three problems | Not measurable | Not recorded | Couldn't run | No analysis report available. |
| S4 Review and filter | Not measurable | Not recorded | Couldn't run | No finding available to open or review. |
| S5 Precast findings | About 5 s for chooser/upload interaction, not end-to-end | 2 clicks after returning to project; excludes file selection | Partial | Imported 12 positions; DIN, layer-sum and placeholder findings unavailable. |
| S6 Excel, PDF, GAEB exports | Not measured | Not recorded | Partial | Export options were inspected; generated files and their contents were not verified. |
| S7 Mobile and dark mode | Not measured | Not recorded | Partial | 375 px dark list and position detail viewed; S2–S4 could not be repeated end-to-end without analysis. |
| S8 Keyboard only | Not measured | Not recorded | Partial | Escape closed a position detail and focus returned to its row. Finding drawer and full Tab journey could not be tested. |

Demo script: **not rehearsed**; time unavailable. A working backend and permission to read the specified demo README are needed to complete it.

## Findings ranked by impact

### UX-01 — P0 — Analysis unavailable in fallback (S2–S5, S7–S8)

[Hall list screenshot](walkthrough/list.png) · **Owner:** task 04 · **Effort:** S

The list says “Upload check unavailable”; no findings or recovery action are visible. This is expected to be possible when the backend is absent and is not evidence that the VPS is broken. A user needs to know that analysis did not run, why, and what to do next. Show a prominent analysis-unavailable state with a retry action and a short explanation; coordinate backend diagnosis separately.

### UX-02 — P1 — Import ends at the project list (S2, S5)

[Hall list screenshot](walkthrough/list.png) · **Owner:** task 06 · **Effort:** S

After import the project showed a success toast and a list card, but the list did not open automatically. The scenario expects the list and its findings to appear. Open the imported list after a single-file upload, or provide an “Open list” action in the success message.

### UX-03 — P1 — First-visit purpose is unclear (S1)

[Hall list screenshot](walkthrough/list.png) · **Owner:** Marcos · **Effort:** S

The initial populated home page showed “All Projects” and financial totals without explaining that BillBuild checks tender risks or which action starts that process. The linked screenshot shows the subsequent list rather than the home page; capture a home screenshot on the next run. Add a short introductory sentence and a visible “Import a tender” action for first visits.

### UX-04 — P1 — Mobile title truncated (S7)

[Mobile dark list](walkthrough/mobile-dark.png) · **Owner:** Marcos · **Effort:** S

At 375 px the title was clipped to “LV 11 – Stahlbetonf...”, obscuring the tender identity. Allow the title to wrap fully or expose the full title with an accessible expansion control.

### UX-05 — P2 — Export format selection is ambiguous (S6)

[Export format dialog](walkthrough/formats.png) · **Owner:** Marcos · **Effort:** S

The format options appear as checkboxes, but selecting PDF and then GAEB left only GAEB selected. A user can reasonably expect checkboxes to allow multiple formats. Use radio buttons and label the group “Choose one format”, or implement multiple simultaneous exports.

## Copy fixes

| Current | Proposed | Context |
| --- | --- | --- |
| Upload check unavailable | Analysis unavailable — retry | Include a reason and retry action; verify wording with backend state. |
| More formats… | All export formats… | Makes the route to GAEB clearer. |
| Choose files / Import files | Import a tender | Suggested first-visit action, where appropriate. |

## What already works well

Both GAEB demo files imported into the local frontend and appeared with 60 and 12 positions respectively. German tender text and umlauts were visible in the position detail. The mobile position detail closed with Escape and returned focus to its invoking row. The export dialog offered Excel, PDF and several GAEB variants, although their output was not validated.
