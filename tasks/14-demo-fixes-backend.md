# Task 14 (PRIORITY): Backend fixes from the walkthrough

**Branch:** `feat/task-14` · **Recommended model:** Sonnet (Claude Sonnet 5.5). Task 02's author knows layer 3 best.

## Why

Task 07's VPS walkthrough ([docs/ui-review/WALKTHROUGH.md](../docs/ui-review/WALKTHROUGH.md)) found demo-visible backend
bugs. The lead reproduced the question prefix and the unit wording. Fix these before the demo.

## Fixes (P0 first)

| P | Bug | Fix | Where |
|---|---|---|---|
| **P0** | On `data/demo/building_hall_planted.X83`, **layer 3 stops halfway**: the 12-call budget runs out, and 15 `L3.QTY.IMPLAUSIBLE` batches plus 2 others are skipped. | (a) Batch smarter: pack several small sections into one `QTY.IMPLAUSIBLE` / `UNDERSPECIFIED` request up to the existing char/line limits, instead of one call per section. (b) Raise the prod default `ANALYSIS_L3_MAX_CALLS` to a value that covers a 200-line LV. (Cost is about $0.004 per call; 30 calls ≈ $0.12.) Keep `ANALYSIS_L3_DEADLINE` and concurrency so it still finishes in about 75 s. (c) **Always report coverage** in one machine-readable line in `AnalysisResult.errors` (format below). | `backend/analysis/layer3/common.py`, `checks/quantities.py`, `checks/underspecified.py`, `backend/deploy/compose.prod.yaml` (L3 lines), `backend/deploy/.env.example` |
| P1 | Bidder questions repeat the prefix: "Zu Pos. 02.02.0010, 02.02.0020: Zu Pos. 02.02.0010, 02.02.0020 ist keine Position für Randdämmstreifen …" | When grouping, don't add `Zu Pos. …:` if the text already starts with "Zu Pos.". Strip the rule's own prefix and rebuild it once with the merged position list. Cover both cases in tests. | `backend/analysis/questions.py` |
| P1 | The edge-insulation fix rationale says "enter it before accepting", but accepting works without a quantity. | Say what is true: "The quantity cannot be derived: enter it before applying the fix." Update the test assertion. | `backend/analysis/layer2/engine.py` (line ~180, **only this string**), `backend/analysis/tests/test_layer2.py` (only that assertion) |
| P2 | The unit finding shows internal tokens: "m is unusual for **opening_surcharge**; expected **ea**", and the German question says "(üblich: **ea**)". | Readable item names (opening surcharge → "Zulage für Aussparungen/Öffnungen", rebar → "Betonstahl", and so on) and units in tender notation (ea → St, lump_sum → psch, m² → m2 or m², following the line's `unit_raw` style). Same in `bieterfrage_de`. | `backend/analysis/layer1/precast.py` |

**Coverage line format** (the UI parses it, task 15; keep it exact):
```
layer 3 coverage: <run>/<planned> batches; skipped: <RULE_ID>×<n>[, <RULE_ID>×<n>…]
```
Example: `layer 3 coverage: 14/31 batches; skipped: L3.QTY.IMPLAUSIBLE×15, L3.TEXT.UNDERSPECIFIED×2`. When nothing was
skipped: `layer 3 coverage: 31/31 batches`. Emit it whenever layer 3 ran. Keep the existing per-batch error lines.

## Files you MAY create or modify (strict allowlist)

- `backend/analysis/layer3/common.py`, `backend/analysis/layer3/checks/quantities.py`, `backend/analysis/layer3/checks/underspecified.py`, `backend/analysis/layer3/__init__.py` (coverage line only)
- `backend/analysis/questions.py`
- `backend/analysis/layer1/precast.py`
- `backend/analysis/layer2/engine.py` (the one rationale string) and `backend/analysis/tests/test_layer2.py` (that assertion)
- `backend/deploy/compose.prod.yaml` (`ANALYSIS_L3_*` lines) and `backend/deploy/.env.example` (layer 3 block)
- tests: `backend/analysis/tests/test_layer3*.py`, `test_questions.py`, `test_layer1_precast.py`
- this task file (notes) and your row in `STATUS.md`

**Not yours:** `backend/workspace_analysis.py` (task 09 sends the section codes, which fixes the `null` label),
`analysis/risk/*` (task 08), `layer1/quantities.py` / `layer2/schema.py` / `rules.json` (task 11), anything in `frontend/`.

## Read-only references

- `CLAUDE.md` §5.7 (layer 3 settings), `docs/ui-review/WALKTHROUGH.md`
- `tasks/02-layer3-claude-checks.md` (notes: budget, deadline, concurrency, measured cost)
- `backend/analysis/units.py` (canonical units)

## Acceptance criteria

1. With `FakeProvider`, a synthetic LV with 20 small sections runs `QTY.IMPLAUSIBLE` in a handful of calls (not 20), and
   the coverage line says `n/n batches`. A test with a tiny budget asserts the exact `skipped:` format.
2. Live, if you have the key: layer 3 on `building_hall_planted.X83` finishes all batches. Write the duration, calls and
   cost in the notes. Without a key, write that it's unverified.
3. No question in the hall or precast demo reports contains "Zu Pos." twice. The precast unit question reads "… (üblich: St)".
4. `PYTHONPATH=backend:backend/importer python -m pytest -q backend/analysis/tests` is green, and `python -m analysis.eval fp` exits 0.

## Notes / blockers (fill in)

-
