# Council members

| id | member | lens |
|---|---|---|
| visual | Visual designer | hierarchy, type scale, colour, spacing rhythm, polish |
| ux | UX / interaction designer | information architecture, cognitive load, duplicate actions, flows, affordances |
| estimator | Construction estimator (domain user) | does each screen show what an estimator needs (totals, caps, positions, edits) quickly and without noise |
| a11y | Accessibility & responsive specialist | WCAG contrast, targets, focus, colour-only status, mobile layout |
| fintech | Fintech product lead (Wise benchmark) | compares every screen directly with the Wise web dashboard; calm, premium, trustworthy money UI |

## Screens

| id | screen | screenshots |
|---|---|---|
| S1 | All Projects (home) | 01-all-projects.png, 11-mobile-home.png |
| S2 | Folder | 02-folder.png |
| S3 | List (ledger) | 03-list.png, 04-list-full.png, 12-mobile-list.png |
| S4 | Position detail drawer | 05-list-detail-drawer.png |
| S5 | Active Budgets | 06-active-budgets.png |
| S6 | Archived | 07-archived.png |
| S7 | Trash | 08-trash.png |
| S8 | Search palette | 09-command-palette.png |
| S9 | Empty folder | 10-empty-folder.png |

## Design decisions (settled; score how well they are executed, not whether to make them)

- Secondary buttons, pills and chips are borderless (`bg-slate-100`, darker on hover). The selected or active state is `bg-slate-900 text-white`.
- Text inputs are white with a `slate-500` border (WCAG 1.4.11 non-text contrast) that darkens on hover.
- Ledger editable cells (Menge, EP) have no border at rest on desktop. The border shows on row hover and on focus. Cards and coarse pointers always show a `bg-slate-50` fill with a `slate-500` bottom border.
- Empty states sit at the top of the content column (not centred vertically) with a large icon.
- Hero status pills are plain status, not buttons. The filter chips under the section title are the filters.
- Percentages are written with no space before % ("1,1%"). Numbers, money and dates use German format.
- The desktop GP column shows no € because the header says "GP (€)". Cards on narrow screens show €.
- A project's status rolls up from its lists: a project row or filter is flagged when any counted list is near its own cap, and the row says which.
- Section colours in "Cost by section" use only brand and slate tones, so they never read as a budget status.
- "Sub-project" is the user-facing term for a nested folder.
