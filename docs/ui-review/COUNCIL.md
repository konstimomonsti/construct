# Council members

| id | member | lens |
|---|---|---|
| visual | Visual designer (Claude) | hierarchy, type scale, colour, spacing rhythm, polish; also scores every rubric category, including accessibility and mobile |
| sol | GPT‑6.2 Sol (Codex), independent reviewer | an outside model's all-round read, with the Theo test front of mind: would a dev-tool-literate, design-opinionated developer love this UI? |

From round 7 the council is these two members. The ux, estimator, a11y and fintech reviewers sat through round 6; their scores stay in `scores/round-0` … `round-6` for the record.

## Screens

| id | screen | screenshots |
|---|---|---|
| S1 | All Projects (home) | 01-all-projects.png, 11-mobile-home.png |
| S2 | Folder | 02-folder.png |
| S3 | List (ledger; sections start collapsed, 04 is after "Expand all") | 03-list.png, 04-list-full.png, 12-mobile-list.png |
| S4 | Position detail drawer | 05-list-detail-drawer.png |
| S5 | Active Budgets | 06-active-budgets.png |
| S6 | Archived | 07-archived.png |
| S7 | ~~Trash~~ (removed; deleting is permanent behind a confirm) | — |
| S8 | Search palette | 09-command-palette.png |
| S9 | Empty folder | 10-empty-folder.png |
| S10 | Catalogue: Products | 13-catalogue-products.png |
| S11 | Catalogue: Suppliers | 14-catalogue-suppliers.png |
| S12 | Catalogue: Subcontractors | 15-catalogue-subcontractors.png |
| S13 | Catalogue editor dialog | 16-catalogue-editor.png |
| S14 | Upload-check findings (list rows + drawer) | 17-list-findings.png, 18-drawer-findings.png |

## Design decisions (settled; score how well they are executed, not whether to make them)

- Light is the default; dark is a toggle in the header (sun/moon), remembered per browser. Both use the poster palette. Dark mode re-points the same tokens under `:root[data-theme='dark']` in `index.css` (`white` becomes the pit black, `slate-900` the brightest text), so every contrast pairing holds in both themes.
- Signal yellow `#edb03e` is the brand: primary buttons (dark text on yellow), the active nav icon, the "on track" status. In light mode, text accents and focus rings use bronze (`brand-700`) because yellow on white is too faint for text.
- Budget status heats up instead of going green: yellow (on track), amber (near cap), orange (almost at cap), red (over cap). It is always shown with a word and an icon, never colour alone.
- Type is Archivo (variable width). Page titles and hero numbers use the heavy, expanded cut from the poster; body text uses the normal width. JetBrains Mono only for OZ codes where already used.
- Shapes are signage, not pills: small radii on buttons, chips, tags and meters. Only people's avatars and radio dots stay round.
- The hero meter is a crane jib: the jib is the cap, the lit part is the spend, the hook hangs at the current figure, a mast marks the cap.
- Selected chips use an inverted fill (ink on light, cream on dark); secondary buttons are borderless tinted fills. Icon tiles share one tint; colour is reserved for status.
- Money heroes span the full width: the total on the left, Used/Left on the right, the crane-jib meter underneath.
- Toasts always use the dark ink surface, in both themes.
- Empty states sit at the top of the content column with a large icon.
- Percentages are written with no space before % ("1,1%"). Numbers, money and dates use German format. The desktop GP column shows no € because the header says "GP (€)".
- A project's status rolls up from its lists; "Sub-project" is the user-facing term for a nested folder.
