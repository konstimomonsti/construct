# Council members

| id | member | lens |
|---|---|---|
| visual | Visual designer | hierarchy, type scale, colour, spacing rhythm, polish |
| ux | UX / interaction designer | information architecture, cognitive load, duplicate actions, flows, affordances |
| estimator | Construction estimator (domain user) | does each screen show what an estimator needs (totals, caps, positions, edits) quickly and without noise |
| a11y | Accessibility & responsive specialist | WCAG contrast, targets, focus, colour-only status, mobile layout |
| fintech | Fintech product lead (Wise benchmark) | compares every screen directly with the Wise web dashboard; calm, premium, trustworthy money UI |
| sol | GPT‑6.2 Sol (Codex), independent reviewer | an outside model's all-round read, with the Theo test front of mind: would a dev-tool-literate, design-opinionated developer love this UI? |

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

- Dark only, in the poster palette. The neutral scale is inverted in `index.css` (`white` is the pit black, `slate-900` is the brightest text) so contrast pairings carry over.
- Signal yellow `#edb03e` is the brand: primary buttons (dark text on yellow), the active nav icon, focus rings, the "on track" status.
- Budget status heats up instead of going green: yellow (on track), amber (near cap), orange (almost at cap), red (over cap). It is always shown with a word and an icon, never colour alone.
- Type is Archivo (variable width). Page titles and hero numbers use the heavy, expanded cut from the poster; body text uses the normal width. JetBrains Mono only for OZ codes where already used.
- Shapes are signage, not pills: small radii on buttons, chips, tags and meters. Only people's avatars and radio dots stay round.
- The hero meter is a crane jib: the jib is the cap, the lit part is the spend, the hook hangs at the current figure, a mast marks the cap.
- Selected chips use a light (inverted) fill; secondary buttons are borderless dark fills.
- Empty states sit at the top of the content column with a large icon.
- Percentages are written with no space before % ("1,1%"). Numbers, money and dates use German format. The desktop GP column shows no € because the header says "GP (€)".
- A project's status rolls up from its lists; "Sub-project" is the user-facing term for a nested folder.
