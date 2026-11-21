# Task 12: Reference prices from past offers and a what-if view

**Branch:** `feat/task-12` · **Recommended model:** Opus (Claude Opus 5.5). This task has matching logic, an honest evaluation and a backend-plus-UI slice.

## Objective

Give the estimator a sense of price. For each position, show what comparable past offers charged (median [min–max], n), flag
file prices far from that, and let them ask "what if steel +15 % / quantities +10 %?" and see the totals and the risk
change. The design is in [archived plan §7](../docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md). Read its "What the
data supports" section first: across projects only 0–2 % of lines match, and within the same project 90–95 % do.
**Present coverage honestly. Never invent prices or index values.**

## What to build (P0 → P2)

**P0, references and matching** (new package `backend/analysis/pricing/`, no DB, **no new dependency**):
- `refset.py`: build references from the priced files in `data/tenders/`. That means `Angebot AN24-0305.D84` (texts from
  its PDF), `StBALV23040.D86` (plus `Abgabe LV.pdf`, deduped) and `[ORT_024] LV24069.D86`. Each reference has: project
  family, document hash, OZ, normalised short text, canonical unit, unit price, date and tags. Write it to a committed
  `backend/analysis/pricing/refset.json` with a regenerate command (the tender files are already in the repo).
- `match.py`: character 3-gram cosine similarity in **pure Python** (about 600 references, so no scikit-learn). Hard
  filters: same unit or a convertible one (`units.convert`), lump sums only with lump sums, and no conflicting DN, PN, SDR,
  concrete class or material. The top 5 at similarity ≥ 0.70 give a `ReferenceRange` (min/median/max/n). A single
  reference caps confidence at 0.6. A **leakage guard** drops references from the same document or family, with an
  explicit `include_same_project` option for the re-tender demo.
- `suggest.py`: fills `Line.price` (`source="reference"`, `reference_range`, `match_confidence`, `citations` = OZ and file
  of each reference) for lines that have no price, and fills `reference_range` for lines that have one. Hook it into
  `analysis.runner.analyze()` behind `ANALYSIS_REFERENCE_PRICES` (default on). A failure goes to `errors`, never a crash.
- A leave-one-project-out evaluation (`python -m analysis.pricing.eval`): coverage and median absolute % error per
  project. Paste the numbers in the notes and in `docs/PRICING.md`.

**P0, layer 1 price tweaks** (`layer1/pricing.py`):
- `L1.PRICE.FILE_OUTLIER` (warning): the file's unit price is more than 3× from the reference median (n ≥ 2).
- `L1.PRICE.COVERAGE` (info, one per BoQ): how many lines have references.
- Stop `L1.PRICE.NOT_FOUND` from producing one error per line when there is simply no reference. Make it one info
  summary, or skip it when the line has no price and no reference.

**P1, what-if engine** (`backend/analysis/pricing/whatif.py`) and API:
- A scenario is a list of adjustments: price % by tag (steel, concrete, …; reuse the category regexes in
  `backend/importer/tender_import/challenge_catalogue.py` by moving them into a psycopg-free module under
  `analysis/pricing/`), price % for a line, quantity % (all or by section), include optional items. The result: totals
  before and after per section, the top 10 line deltas, and risk before and after (call `analysis.risk.assess`, read-only).
- `POST /api/workspace/whatif` with `{ "id": <list_id>, "scenario": [...] }` → that result. Add only the route in
  `backend/server.py`, with the logic in a new `backend/workspace_whatif.py`. Document it in `docs/API.md`.

**P1, UI:** a "What-if" panel (new `frontend/src/components/risk/WhatIf.tsx` and `frontend/src/lib/whatif.ts`) with
adjustment rows, before/after total cards, a section delta table and the top line deltas. Mount it with one line in
`components/risk/RiskSummary.tsx`. In the existing drawer, task 10 owns the layout, so show the reference range only
through `evidence` on the price findings, not as a new column.

**P2:** escalation by the Destatis construction price index (`data/baupreisindex.csv`, values transcribed by hand from
GENESIS 61261 with the source cited, never invented) and configurable markups (BGK/AGK/W+G).

## Files you MAY create or modify (strict allowlist)

- `backend/analysis/pricing/**` (new), `backend/analysis/tests/test_pricing*.py` (new)
- `backend/analysis/layer1/pricing.py`, `backend/analysis/runner.py` (only the reference-price hook)
- `backend/workspace_whatif.py` (new), `backend/server.py` (route only), `backend/tests/test_workspace_whatif.py` (new)
- `frontend/src/components/risk/WhatIf.tsx`, `frontend/src/lib/whatif.ts`, `frontend/tests/whatif.test.ts` (new); `frontend/src/components/risk/RiskSummary.tsx` (one mount line plus a heading)
- `docs/PRICING.md` (new), `docs/API.md` (the what-if endpoint)
- `data/baupreisindex.csv` (P2 only)
- this task file (notes) and your row in `STATUS.md`

**Not yours:** `layer1/__init__.py` and other layer 1 modules (task 11), `analysis/risk/*` (task 08, read-only for you),
`ListPage.tsx` / `DetailDrawer.tsx` / `store.ts` (task 10), `backend/workspace_analysis.py` (task 09).

## Read-only references

- `CLAUDE.md` §5.1–5.4, `backend/analysis/contracts.py` (`PriceInfo`, `ReferenceRange`, `PriceSource.REFERENCE`)
- `backend/analysis/layer1/pricing.py` (`L1.PRICE.OUTLIER` already reads `reference_range`), `backend/analysis/units.py`
- `docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md` §7, `backend/importer/tender_import/challenge_catalogue.py`
- `frontend/src/lib/price-suggestions.ts` (catalogue price suggestions from PR #7; don't duplicate them, reference prices are a separate source)

## Acceptance criteria

1. `python -m analysis run data/tenders/8209.003_Leistungsverzeichnis_leer.X83 --layers 1,2` shows reference ranges where
   matches exist. With `include_same_project` on, a blank tender matched against its own priced file reaches about 90 %
   coverage (plan: 90–95 %). Without it, coverage is honest and low, and it says so.
2. The leave-one-project-out numbers are in `docs/PRICING.md`.
3. The what-if API and panel: "+10 % quantities in section X" changes that section's total by 10 % and shows the risk
   before and after. Unit tests cover the engine.
4. `pytest` (backend, analysis), `npm run lint`, `npm run build` and `npm test` pass, and `python -m analysis.eval fp` still exits 0.

## Notes / blockers (fill in)

-
