# Task 02: Layer 3 on Claude: precast extraction, cross-item scope audit, live-demo readiness

**Branch:** `feat/task-02` · **Recommended model:** Opus (Claude Opus 5.5). This task covers LLM prompt design, schemas, cost and caching.

## Objective

Layer 3 must **work live in the VPS demo** through the Anthropic API and add the LLM checks from Biel's spec
([docs/lv_hybrid_validation_implementation_guide.md](../docs/lv_hybrid_validation_implementation_guide.md), Steps 2 and 4),
implemented with our existing `analysis/layer3` framework (provider, cache, session budget, `FakeProvider`),
**not** with Gemini or a separate project.

## Checks to add (all `origin="llm"`, severity `warning` or `info`, never `error`)

| P | Rule ID | What it does |
|---|---|---|
| P0 | `L3.PRECAST.MISSING_SPEC` | Extraction (spec Step 2) of `PrecastElementItem` fields for candidate lines (precast / Fertigteil / Sandwich / Betonstahl / Halfen / Werkstattpläne). Then apply the spec's `DEP_001` (sandwich needs `height_m`, `length_m`, `concrete_grade`, `total_thickness_cm`) and `DEP_002` (through-coloured concrete needs a RAL colour or pigment) **deterministically in Python on the extracted fields**. Store the extracted fields in `evidence.extracted` and the question in `evidence.bieterfrage_de`. One finding per line, `discriminator` = the missing-field set. |
| P0 | `L3.SCOPE.REBAR_AMBIGUOUS` | Spec `LLM_SCOPE_01`: rebar tendered separately from precast elements without saying whether it is factory reinforcement or site connection steel. |
| P0 | `L3.SCOPE.SHOP_DRAWINGS_OVERLAP` | Spec `LLM_SCOPE_02`: a shop-drawing item overlaps the anchor design already included in the precast items. |
| P0 | `L3.SCOPE.EMBEDDED_UNALLOCATED` | Spec `LLM_SCOPE_03`: embedded parts (Halfen etc.) not assigned to specific elements. |
| P1 | `L3.OPT.BUNDLED_FORMWORK` | Spec `LLM_OPT_01` (info): identical cross-sections, with the bundled length in `evidence`. |
| P1 | `L3.TEXT.UNDERSPECIFIED` | Archived plan §2.2. Runs only on candidates (long text under 60 chars or a prior layer 1 text signal). It returns `missing_property` from a fixed list, a verbatim quote and a draft question. Confidence ≤ 0.6. |
| P1 | `L3.QTY.IMPLAUSIBLE` | The quantity is implausible for the described work, compared with sibling lines in the section. Batch per section. |

The cross-item audits (`L3.SCOPE.*`, `L3.OPT.*`) send **one call per BOM section group**, using the JSON of the
extracted items (not the raw text), with the audit model (`ANALYSIS_L3_AUDIT_MODEL`, default `claude-sonnet-5-5`).
Per-line extraction uses `ANALYSIS_L3_MODEL` (default `claude-haiku-5-5`), batched. Use Anthropic structured
output through the existing `AnthropicProvider.complete_json` (JSON schema), temperature 0, and the disk cache.
Use prompt caching for the shared system prompt.

## Demo readiness (P0)

- Default budget: a 200-line LV must finish layer 3 in **under 90 s** with no more than **`ANALYSIS_L3_MAX_CALLS`**
  calls (choose a sane prod default, for example 12, and document it). When the budget runs out, report the skipped
  batches in `errors` and never crash.
- `layer3` must not repeat work: skip `L3.TEXT.SHORT_LONG_CONTRADICTION` on lines that already have
  `L1.TEXT.VALUE_CONFLICT` (task 01 adds that rule ID; filter on the ID string).
- The upload-assessment worker (`backend/workspace_analysis.py`) must run layers 1, 2 and 3 when the provider is
  `anthropic` and must still store the layer 1–2 findings if layer 3 fails.
- Update `backend/deploy/compose.prod.yaml` and `backend/deploy/.env.example` with `ANALYSIS_L3_AUDIT_MODEL`
  and the new defaults. Don't touch other services.

## Files you MAY create or modify (strict allowlist)

- `backend/analysis/layer3/**` (all files, including `checks/__init__.py`, new `checks/precast.py`, `checks/scope.py`, `checks/underspecified.py`, `checks/quantities.py`, `prompts.py`, `schema.py`, `common.py`, `provider.py`, `eval.py`, `eval_cases.json`)
- `backend/analysis/tests/test_layer3.py` and new `backend/analysis/tests/test_layer3_*.py`
- `backend/workspace_analysis.py`
- `backend/deploy/compose.prod.yaml`: backend `ANALYSIS_L3_*` environment lines only. `backend/deploy/.env.example`: the layer 3 block only.
- `docs/ANALYSIS_LAYERS.md`: §5 (layer 3) only
- this task file (notes) and your row in `STATUS.md`

## Read-only references

- `CLAUDE.md` §5.1–5.3, §5.7
- `backend/analysis/layer3/__init__.py`, `common.py`, `provider.py`, `checks/contradictions.py`, `checks/l2_confirm.py` (copy their patterns)
- `backend/analysis/tests/fixtures/lv11_precast.json`
- `docs/lv_hybrid_validation_implementation_guide.md` §3 (models), Step 2 and Step 4 (prompts), §6.1 (expected results)
- `backend/server.py` (how `/api/workspace/analysis` calls the worker)

## Acceptance criteria

1. Unit tests with `FakeProvider` (no network): on `lv11_precast.json`, `L3.PRECAST.MISSING_SPEC` fires on
   3.2.20–3.2.60 (height missing, RAL/pigment missing for "durchgefärbt"), and `L3.SCOPE.REBAR_AMBIGUOUS` fires on
   3.2.70. A provider timeout or invalid JSON goes to `errors`, and layers 1–2 still return findings.
2. A live integration test (`@pytest.mark.integration`, skipped without `ANTHROPIC_API_KEY`) runs layers 1–3 on
   the fixture and asserts those same rule IDs. Write the cost and duration of one live run in the notes.
3. `python -m analysis.layer3.eval` (or your extension of it) reports precision on the eval cases. Write the
   numbers in the notes.
4. `python -m pytest -q backend/analysis/tests` is green.
5. A second identical run is served from cache (0 API calls). Show this in a test with `FakeProvider` call counting.

## Notes / blockers (fill in)

**Status: PR open. Live numbers pending: no `ANTHROPIC_API_KEY` was available to this worker.**

- **Built:** `checks/precast.py` (extraction + `L3.PRECAST.MISSING_SPEC` + `L3.OPT.BUNDLED_FORMWORK`),
  `checks/scope.py` (`L3.SCOPE.REBAR_AMBIGUOUS`, `SHOP_DRAWINGS_OVERLAP`, `EMBEDDED_UNALLOCATED`, one audit
  call per precast section with `ANALYSIS_L3_AUDIT_MODEL`), `checks/underspecified.py`, `checks/quantities.py`.
  DEP_001/DEP_002 and the bundled length are computed in Python from the extracted fields. Extracted values
  the text doesn't back (grade, RAL, element mark not written there; height/length without a height/length
  word) count as missing. Scope answers must cite an item of the right type, or they are dropped.
- **Budget / speed:** prod defaults `ANALYSIS_L3_MAX_CALLS=12`, `ANALYSIS_L3_TIMEOUT=30`,
  `ANALYSIS_L3_DEADLINE=75` (new; later batches are reported in `errors`, not sent). Independent batches of a
  check run 4 at a time (`ANALYSIS_L3_CONCURRENCY`). The P0 precast checks run first, so they get the budget.
  LV_11 needs 5 calls (extraction 1, audit 1, contradiction 1, underspecified 1, quantity 1).
- **Temperature:** Claude Haiku 5.5 and Sonnet 5.5 return HTTP 400 for a non-default `temperature`, so none
  is sent. Repeat runs are deterministic through the disk cache (test:
  `test_second_identical_run_is_served_from_cache`, 0 provider calls). The system prompt carries
  `cache_control` for Anthropic prompt caching (extraction and audit prompts are > 512 tokens).
- **Worker:** `workspace_analysis.run` already runs layers 1-3 when `ANALYSIS_L3_PROVIDER` is `anthropic`/`ollama`.
  If layer 3 still crashes, it now re-runs layers 1-2 and stores that report with an error line.
- **Live cost / duration (acceptance 2):** *pending*. Run
  `$env:ANTHROPIC_API_KEY="..."; $env:PYTHONPATH="backend;backend/importer"; python -m pytest -q -s -m integration backend/analysis/tests/test_layer3_live.py`;
  it prints seconds, tokens per model and the USD cost. Expected order of magnitude: about 9 lines -> 4 Haiku calls +
  1 Sonnet call, well under $0.05.
- **Eval precision (acceptance 3):** *pending a key*. `python -m analysis.layer3.eval` now also reports
  precision/recall per (rule, OZ) on 4 task 02 cases (LV_11 + complete precast section + site connection steel
  section + general quantities/texts). Offline with the FakeProvider it reports precision 1.0, which only
  shows that the harness works, not how good the model is.
- **Tests:** `python -m pytest -q backend/analysis/tests` (after merging main with task 01): 291 passed, 3 skipped (the live test skips without a key).
  `backend/tests` has 3 failures on Windows that also happen on `main` (Linux font path, JS MIME type).

### Blockers / requests

- Need `ANTHROPIC_API_KEY` from the lead to fill in the live cost/duration and the eval precision.
- Please register the `integration` pytest marker in `backend/pyproject.toml`
  (`markers = ["integration: needs ANTHROPIC_API_KEY"]`). The file is outside this task's allowlist, so pytest
  currently warns `PytestUnknownMarkWarning`.
- Task 01 is merged: its `L1.TEXT.SPEC_ATTRIBUTE_MISSING` / `UNCLEAR_DIMENSION` / `SPEC_PLACEHOLDER` /
  `REFERENCE_UNRESOLVED` findings make a line an `L3.TEXT.UNDERSPECIFIED` candidate, and `L1.TEXT.VALUE_CONFLICT`
  lines are skipped by the contradiction check (rule IDs matched as strings).
