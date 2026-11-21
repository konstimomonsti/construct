# Task 07 (queued: the next free worker takes it): Usability walkthrough and improvement proposals

**Branch:** `feat/task-07` · **Recommended model:** Sonnet (Claude Sonnet 5.5) with browser control (Playwright or the
Claude browser pane). A human teammate can do the clicking and let the agent write the report.

## Objective

Use BillBuild the way a real user and a demo judge would, write down where it feels slow, confusing or broken, and
propose concrete improvements ranked by demo impact. **This task produces a report and screenshots, not code.**
Most frontend files currently belong to task 04 (risk UI), and Marcos owns the general UI (his council work, PR #7, is
merged). Changing them here would cause merge conflicts, so each proposal names the owner who should implement it.

## Personas and scenarios

Run each scenario as one persona, time it and count the clicks. Note every hesitation ("where do I click?"), every
surprise, any wrong or missing number, and every console error.

| # | Persona | Scenario | Success means |
|---|---|---|---|
| S1 | Judge, first visit, no instructions | Open the home page. What is this product, and what should I do first? | They can explain it within 30 s |
| S2 | Estimator (Kalkulator) at a mid-size contractor | Create a project and drag `data/demo/building_hall_planted.X83` into it | The list opens and the findings appear without a reload |
| S3 | Estimator | Find the three most serious problems in that list | Done in under 2 minutes, without reading every row |
| S4 | Estimator | Open a finding, understand why it fired and what to do, then mark it reviewed. Filter to open errors only | Each finding is understandable without knowing the rule IDs |
| S5 | Estimator | Upload `data/demo/precast_lv11_planted.X83` and check the DIN, layer-sum and placeholder findings | The German or English wording makes sense to a construction professional |
| S6 | Project manager | Export the list (Excel, PDF, GAEB) and check that the export matches the screen | No missing columns or broken German characters |
| S7 | Any | Repeat S2–S4 at 375 px width (mobile) and in dark mode | Usable, no horizontal scroll, readable contrast |
| S8 | Any | Keyboard only: Tab through the list page, open a finding, close the drawer | Focus is visible and nothing traps the keyboard |

Run against the **VPS** if you have the site login (ask the lead). Otherwise use the local stack (`CLAUDE.md` §3:
`./db/ops.sh up`, backend `--profile app`, then `cd frontend; npm run dev`). If neither is available, use
`npm run dev` without the backend and record which scenarios couldn't run.

## Deliverable: `docs/ui-review/WALKTHROUGH.md`

1. **Summary:** the 5 changes with the most demo impact, one line each.
2. **Scenario table:** scenario, time, clicks, pass / partial / fail, and the worst friction point.
3. **Findings**, one per entry: ID (`UX-01`…), severity (`P0` blocks the demo, `P1` hurts the impression, `P2` polish),
   scenario, screenshot, what happened, what the user expected, **proposed change** (concrete: wording, layout, default),
   **owner** (`task 04` for risk UI / findings / drawer, `task 06` for import, `Marcos` for general UI and
   pricing, `backend` for wrong numbers), and effort (S/M/L).
4. **Copy fixes:** a table of current text → proposed text (English UI labels, German tender wording).
5. **What already works well:** keep it short, but it matters for the pitch.

## Files you MAY create or modify (strict allowlist)

- `docs/ui-review/WALKTHROUGH.md` (new)
- `docs/ui-review/walkthrough/*.png` (new screenshots, at most ~25, compressed)
- `frontend/tests/walkthrough.mjs` (new, optional: a Playwright script that replays S2–S4 and takes the screenshots, modelled on `frontend/tests/shots.mjs`)
- this task file (notes) and your row in `STATUS.md`

**Not yours:** every file under `frontend/src/` and `backend/`. Propose changes; don't make them.

## Read-only references

- `CLAUDE.md` §1 (what we're demoing), §5.4–5.5 (the risk UI that task 04 is building)
- `docs/ui-review/COUNCIL.md` and the description of the merged PR #7 (UI decisions already made; don't re-propose them)
- `data/demo/README.md` (what is planted where, and the 3-minute demo script)
- `frontend/tests/shots.mjs`, `frontend/tests/interact.mjs` (Playwright patterns)

## Acceptance criteria

1. All 8 scenarios have been run, or are marked "couldn't run" with the reason.
2. At least 15 findings, each with a screenshot, a concrete proposal and an owner. P0s come first.
3. The demo script in `data/demo/README.md` has been rehearsed once, end to end, and its timing noted.
4. Open a PR. The lead turns the P0/P1 items into follow-up tasks for their owners.

## Notes / blockers (fill in)

-
