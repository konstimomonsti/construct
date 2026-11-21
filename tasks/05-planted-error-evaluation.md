# Task 05: Planted-error evaluation (proof the detection works) and demo files

**Branch:** `feat/task-05` · **Recommended model:** Sonnet-class (Claude Sonnet 5.5, or the strongest ChatGPT/Codex coding model)

## Objective

Show judges, with numbers, that BillBuild catches known errors and doesn't raise false alarms: plant errors in clean
tenders, run the analysis and report recall per error type and precision per rule. Also produce the **demo files**
(GAEB X83 with planted errors) that the presenter uploads in the UI. Most of this already exists on an unmerged
branch from before the repo was reorganised. **Port it first, then extend it.**

## What to build

1. **Port** commit `ad1c245` from `origin/archive/eval-harness` (`git show --stat ad1c245`). The old path
   `analysis/eval/**` moves to `backend/analysis/eval/**`, and `analysis/tests/test_eval.py` to
   `backend/analysis/tests/test_eval.py`. The package name stays `analysis`, so `from analysis…` imports keep
   working. The old `docs/EVALUATION.md` also comes over. Fix paths and imports until the tests pass on the new layout.
   Recipe: `git checkout origin/archive/eval-harness -- analysis/eval analysis/tests/test_eval.py docs/EVALUATION.md`,
   then `git mv` the files into `backend/`.
2. **Precast seed** (new): `backend/analysis/eval/seeds/precast_lv11.json`, built from
   `backend/analysis/tests/fixtures/lv11_precast.json` (read-only; copy it and don't edit the original) and made
   "clean" so it yields **no layer 1–2 warnings or errors**: placeholders replaced, unit of 3.2.80 = St, plus a
   few extra lines. Add mutations that target the new rule namespaces (CLAUDE.md §5.3), which tasks 01 and 02 are
   building in parallel:

   | Mutation | Expected rule pattern |
   |---|---|
   | concrete grade → `C20/25` with `XF4` | `L1.DIN.EXPOSURE_STRENGTH` |
   | insulation thickness 8 → 10 cm (sum ≠ total) | `L1.PRECAST.LAYER_SUM` |
   | Zulage unit St → m | `L1.UNIT.TRADE_MISMATCH` |
   | product name replaced by `[FIRMA_123]` / `---` | `L1.TEXT.SPEC_PLACEHOLDER` |
   | short-text concrete class differs from long text | `L1.TEXT.VALUE_CONFLICT` |
   | shop-drawings line removed | `L2.PRECAST.*` |
   | height/RAL removed from a "durchgefärbt" element | `L3.PRECAST.MISSING_SPEC` (layer 3, "not run" without a model) |
   | rebar line added without a factory/site note | `L3.SCOPE.REBAR_AMBIGUOUS` (layer 3) |
   | controls: whitespace, reorder, +5 % on an unrelated quantity | nothing |

   Until tasks 01 and 02 merge, these labels show as **missed**. That is expected. The report must still run.
3. **Real-file labels:** `backend/analysis/eval/labels/real_findings.csv` (verdict
   `true_error | false_alarm | importer_artefact | unsure`) for today's error and warning findings on the
   `data/tenders/*.X83/D83/D86` files, using group rows (`finding_id="*"`) per (file, rule).
4. **Demo files** in `data/demo/` (new): `building_hall_planted.X83` (missing edge insulation, a duplicate,
   quantity 0, a wrong line amount) and `precast_lv11_planted.X83` (DIN, layer sum, unit, placeholder,
   missing spec). Both are written by `gaeb_writer.py`. Add a short `data/demo/README.md` with a table of what
   is planted where, the presenter's 3-minute script (see the archived plan §5, "Three-minute demo") and the expected findings.
5. **Report:** `python -m analysis.eval report --format md` writes a Markdown table that can go into the pitch.
   Add `--layers 1,2,3` support. Only synthetic seeds may be sent to the API model (`ANTHROPIC_API_KEY`). Never
   send `data/tenders/` files.
6. `.gitignore`: allow `backend/analysis/eval/labels/*.csv`, ignore `eval_out/`. `backend/pyproject.toml`:
   package data for `analysis.eval` seeds.

## Files you MAY create or modify (strict allowlist)

- `backend/analysis/eval/**` (new, ported)
- `backend/analysis/tests/test_eval.py` (new, ported)
- `docs/EVALUATION.md` (new, ported and updated)
- `data/demo/**` (new)
- `.gitignore`, `backend/pyproject.toml` (only the lines described above)
- this task file (notes) and your row in `STATUS.md`

## Read-only references

- `CLAUDE.md` §5.3 (rule namespaces) and §5.8 (label schema)
- `origin/archive/eval-harness` (commit `ad1c245`): the whole harness, the seed and the docs
- `backend/analysis/adapter.py` (`from_file`), `backend/analysis/runner.py`, `backend/importer/tender_import/structured.py`
- `backend/analysis/tests/fixtures/lv11_precast.json`, `docs/lv_hybrid_validation_implementation_guide.md` §6.1
- `docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md` §5

## Acceptance criteria

1. `python -m analysis.eval mutate; python -m analysis.eval run; python -m analysis.eval report` runs from the repo
   root (with `PYTHONPATH=backend;backend/importer`) in under 60 s for layers 1–2.
2. `python -m analysis.eval fp` exits 0: the clean seeds and the controls produce no findings.
3. The building-hall recall numbers match or beat the old branch's `docs/EVALUATION.md` numbers. The precast labels
   are listed (missed or not run until tasks 01/02 merge).
4. Both demo `.X83` files import in the BillBuild UI (drag and drop on a folder) and show findings after the upload
   assessment, on a local stack or the VPS. If you can't run the stack, at least run
   `python -m analysis run data/demo/building_hall_planted.X83 --layers 1,2`.
5. `python -m pytest -q backend/analysis/tests` is green.

## Notes / blockers (fill in)

-
