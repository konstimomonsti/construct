# Analysis phase: the error-detection layers

What the analysis phase does, what each of the three layers covers, and what is still open.
Start here when you work on any layer. The exact data model is in
[ANALYSIS_CONTRACT.md](ANALYSIS_CONTRACT.md), and layer 2's knowledge base is described in
[DEPENDENCY_VALIDATOR.md](DEPENDENCY_VALIDATOR.md).

## 1. Purpose

A construction company receives bills of quantities (Leistungsverzeichnis, LV) from clients as GAEB
files (X83/D83 tenders, D84 bids, D86 awards), plus PDF and Word. Before pricing and submitting an
offer, the platform has to find the errors in them: missing quantities, wrong units, wrong sums,
missing work, contradictions. Each error is shown to a person with an optional proposed fix.
**Nothing is ever changed without human approval.**

```
upload (GAEB / PDF / DOCX)
  -> importer/tender_import        raw evidence (source_extract)
  -> draft.py                      normalized BOM: bom_version / bom_section / bom_line
  -> pricing phase                 catalogue + reference prices, AI search for the rest   (not built yet)
  -> analysis/adapter.py           one AnalysisInput object
  -> layer 1  deterministic checks                 analysis/layer1   DONE
  -> layer 2  dependency / completeness checks     analysis/layer2   DONE (first version)
  -> layer 3  LLM checks for the hard cases        analysis/layer3   FIRST VERSION (2 checks, unmeasured)
  -> AnalysisResult: list of Finding -> review UI -> accept / reject
  -> accepted fixes are applied to a NEW bom_version                                       (not built yet)
```

The layers run in order. Each one receives the findings of the previous layers.

| Layer | Question it answers | Technique | Cost | Output confidence |
|---|---|---|---|---|
| 1 | Is each line complete and internally consistent? Do the sums add up? | Plain code | ~0 | High, mostly certain |
| 2 | Is work missing that other lines require? (screed needs edge insulation, concrete needs formwork) | Rule base of regex triggers and dependencies, quantity comparison | ~0 | Medium, heuristic |
| 3 | Everything that needs understanding the text: semantic contradictions, implausible quantities, wrong trade, confirming or dismissing layer 1/2 findings | Small local or cheap LLM | Tokens | Low to medium, always reviewed |

## 2. What every layer shares

All of it lives in `analysis/` and is the same for the three layers.

- **Input:** `AnalysisInput` (`analysis/contracts.py`): project (currency, GAEB phase), sections tree,
  lines (OZ code, short/long text, quantity + raw, canonical unit + raw, pricing basis, total rule,
  GAEB flags, prices from the file, prices from the pricing phase, room distributions, tags,
  source locator), import warnings. Money and quantities are `Decimal`.
- **Units:** `analysis/units.py`: canonical codes (`ea`, `m`, `m²`, `m³`, `kg`, `t`, `h`, `lump_sum`, ...),
  their dimension, and exact conversions (`convert`).
- **Layer interface:** a package `analysis/layer<N>/` exposing
  `run(input, prior_findings, errors) -> list[Finding]`. The runner (`analysis/runner.py`) imports it,
  passes the findings of the earlier layers, merges, de-duplicates, sorts and summarizes.
  A layer that doesn't exist is skipped and reported in `AnalysisResult.errors`.
- **Rules:** registered with `@rule(...)` from `analysis/registry.py`. A rule yields findings built
  with `ctx.finding(...)`, which fills in the stable id, rule id, layer, category, scope, target and
  source locator. A crashing rule goes into `errors` and never stops the others.
- **Output:** `Finding`: `id` (stable: the same problem gets the same id on every run, so human
  decisions survive re-analysis), `layer`, `rule_id` (`L<layer>.<CATEGORY>.<NAME>`), `category`,
  `severity` (`error` / `warning` / `info`), `scope` (line / section / area / bom), `target`,
  `related_line_ids`, `title`, `message`, `evidence`, `suggested_fix`, `origin` (`rule` / `llm`),
  `model`, `status` (always `open` when produced).
- **Fixes:** `Fix` = list of operations + `confidence` + `rationale`. Operations: `set_field`,
  `add_line`, `remove_line`, `merge_lines`, `link_alternative`. Proposals only; never applied by a layer.
- **Storage:** migration `db/migrations/009_analysis.sql`: `line_pricing` (pricing hand-off),
  `analysis_run`, `analysis_finding`.

Commands:

```
python -m analysis input  "Data/file.X83" --out input.json   # AnalysisInput as JSON
python -m analysis run    "Data/file.X83" --layers 1,2,3     # AnalysisResult as JSON
python -m analysis rules                                      # every registered rule
python -m pytest analysis/tests                               # all analysis tests
```

## 3. Layer 1: deterministic checks (done)

`analysis/layer1/`: 34 rules in four modules, with thresholds in `common.py`. Full catalogue in
ANALYSIS_CONTRACT.md §7.

- **Completeness** (`completeness.py`): missing, negative or zero quantity (an error when the line has
  a price, since it then adds nothing to the total), fractional count, missing or unknown unit,
  missing text, missing or duplicate OZ.
- **Consistency** (`consistency.py`): unit contradicting an explicit "Abrechnung nach …" in the text,
  inconsistent lump sums, empty bidder fields (info in a tender, warning in a bid or award),
  "oder gleichwertig" products, OZ outside its section, items outside any section, empty sections,
  alternatives without a base item, optional items (Bedarfspositionen), unit-price-only items with
  an amount, suspected duplicates, room split ≠ quantity.
- **Arithmetic** (`arithmetic.py`): qty × unit price vs line amount (the unit price prevails,
  VOB/A §16c), section subtotals, net total. A gap explained by an item outside every section is
  pointed at.
- **Prices** (`pricing.py`): missing in a bid, not found by the pricing phase, zero, unit or currency
  mismatch, outliers against reference prices, low-confidence or AI matches, file price vs our price,
  stale prices. Import warnings are surfaced too.

What it found in `Data/`: 38 change-order items priced but with quantity 0 and no unit, a
subtotal off by exactly the amount of an item with a damaged OZ, a duplicate item, empty bidder
fields in a bid, net totals left at 0.00.

Known limits: a unit is only checked against the text when the text states it explicitly; GAEB XML
subtotals are not extracted by the importer, so they're not checked; the price rules have only been
tested on synthetic data, because the pricing phase doesn't exist yet.

## 4. Layer 2: dependency checks (first version done)

`analysis/layer2/`. The knowledge base is `rules.json`: groups of a **trigger** (what the line is)
and **required dependencies**. A dependency is either `Boolean` (something must exist) or
`QuantityMatch` (it must cover the trigger's area, within 10%).

- 15 groups and 46 checks: screed and floor finishes, in-situ concrete, drywall, painting, flat roofs,
  and (from NEXT_FEATURES_IMPLEMENTATION_PLAN.md §2.4) electrical installation, lighting, cabling, lightning
  protection, WCs, drinking water, tiling, steel doors, industrial doors and windows. Tested on the
  `LV_xx` building PDFs in `Data/`; see DEPENDENCY_VALIDATOR.md for what they find.
- A dependency can be `"Severity": "info"` for items usually in another package (RCD protection,
  emergency lighting, floor covering under a screed package).
- Triggers are matched on the short text (the long text mentions materials in passing), and
  `ExcludeRegex` drops demolition, precast, pipe, temporary and existing-concrete items.
- Scope can be the whole BoQ, each trade (top-level section), each section, or each room when
  `distributions` exist.
- Lines with a layer 1 error on quantity or unit can't be compared, so the finding is downgraded to
  info.
- Proposals are `add_line` with confidence 0.4–0.55.

Known limits: regex heuristics, with no understanding of negations ("ohne Dämmung"), "included in
another trade" or engineering exceptions. The files in `Data/` are pipeline, plant and civil works with
no buildings, so they correctly raise nothing; that it detects real problems is only tested on
synthetic examples. More trades (sanitary, electrical, windows, tiling, ...) are still to add.

## 5. Layer 3: LLM checks (first version)

### Goal

Catch what layers 1 and 2 can't express as code or regex, and make their output better.
It uses a **small local model or a cheap API model**. Every result is a proposal for a person to
review, never an automatic change.

### What layer 3 should check (candidates, pick by value)

| rule_id (suggested) | What | Why code can't do it |
|---|---|---|
| `L3.TEXT.SHORT_LONG_CONTRADICTION` | Short text and long text disagree (DN 100 vs DN 150, C25/30 vs C30/37, 12.5 mm vs 15 mm board) | Free text |
| `L3.UNIT.SEMANTIC_MISMATCH` | Unit doesn't fit what the item is ("Bodenfliesen verlegen" in `St`, "Rohrleitung" in `m²`) when the text states no unit | Needs to understand the item |
| `L3.QTY.IMPLAUSIBLE` | Quantity implausible for the item (50 × "Baustelleneinrichtung", 0.5 m² of facade, 10 000 h) | Needs domain sense |
| `L3.TEXT.UNDERSPECIFIED` | Item can't be priced from its text: no dimensions, material, class or thickness where they're needed | Judgement |
| `L3.DUP.SEMANTIC` | Same work with different wording, or overlapping scope (an item "inkl. Schalung" plus a separate formwork item) | Paraphrase |
| `L3.STRUCT.WRONG_TRADE` | Item placed in an unrelated section or trade | Semantics |
| `L3.TEXT.REFERENCE_UNRESOLVED` | "Leistung wie Position …", "wie vor", "gemäß Pos. …" pointing at a missing or different item | Reference resolution |
| `L3.REVIEW.L2_CONFIRM` | Re-check each layer 2 finding against the full texts: is the dependency included in another line ("inkl. Randdämmstreifen"), excluded ("bauseits"), or really missing? Downgrade or confirm with a reason | Reduces layer 2 false positives |
| `L3.FIX.SUGGEST` | Propose fixes for layer 1 findings that have none (fractional count, unknown unit → closest canonical unit, price unit conversion m ↔ m² using thickness or width from the text) | Needs reading the text |

Start with `L3.REVIEW.L2_CONFIRM` and `L3.TEXT.SHORT_LONG_CONTRADICTION`: they have the clearest value
and are easy to evaluate.

### Design rules

1. **Same interface as the other layers.** Package `analysis/layer3/` with
   `run(input, prior_findings, errors)`, and rules registered with `@rule(..., layer=3, ...)`.
   Findings are built with `ctx.finding(..., origin="llm", model="<model id>")`.
2. **The provider is pluggable.** One small interface (`complete_json(prompt, schema) -> dict`) with
   implementations for a local model (e.g. Ollama or llama.cpp) and for a cheap API model
   (e.g. `claude-haiku-5-5`), chosen with environment variables. Tender documents can be confidential:
   default to local, make the API opt-in.
3. **Structured output only.** Ask for JSON that matches a Pydantic model (`line_id`, `rule_id` from a
   fixed list, `severity`, `title`, `message`, `quote`, optional fix operations, `confidence`).
   Validate it and discard anything invalid.
4. **Anti-hallucination checks in code:** `line_id` must exist; `quote` must appear verbatim in that
   line's text; fix operations must pass the contract models; `set_field` only on allowed fields;
   confidence capped (e.g. ≤ 0.7). Drop anything that fails.
5. **Pre-filter before calling the model.** Send only candidate lines (lines with long texts for
   contradictions, lines with layer 2 findings for confirmation), batch by section, and cap tokens per
   run. Skip lines that already have a layer 1 error on the same field.
6. **Deterministic and cheap to re-run.** Temperature 0, and cache answers by
   `(model, prompt version, hash of the lines sent)` so a re-analysis with the same input costs nothing.
   Put the prompt version in `evidence`.
7. **Failures don't break the run.** A timeout, bad JSON or a missing model goes to `errors`; layers 1
   and 2 still return their findings.
8. **Severity:** layer 3 findings are `warning` or `info`, never `error` (they're never certain).
   `L3.REVIEW.L2_CONFIRM` doesn't edit layer 2 findings. It emits its own finding with
   `related_line_ids` and `evidence.reviews_finding_id`, and the UI shows them together.
9. **Tests run with no network:** a fake provider returns canned JSON. Add golden tests on real LV
   excerpts and a small labelled set to measure precision before enabling a rule.

### Suggested layout

```
analysis/layer3/
  __init__.py        run(); imports the check modules
  provider.py        LLMProvider protocol, LocalProvider, ApiProvider, FakeProvider, cache
  prompts.py         versioned prompt templates
  schema.py          Pydantic models for the model's answer + validation (quote check, ids)
  checks/
    contradictions.py
    l2_confirm.py
    ...
analysis/tests/test_layer3.py
```

## 5a. Layer 3: what is built

`analysis/layer3/`, following the design rules above. Two checks so far, the ones recommended to start with:

- **`L3.TEXT.SHORT_LONG_CONTRADICTION`** (`checks/contradictions.py`). Sends lines that have both texts,
  differing texts, and a value in the short text (a number or a material word); skips lines with a
  layer 1 error on a text field. Batches by section (≤ 12 lines, ≤ 12 000 characters). The model must quote
  the conflicting words from *each* text; both quotes are checked verbatim in code (whitespace, case and
  line-break hyphens aside) and must differ. When the long text also contains the short-text value
  (a DN 150 pipe with a DN 100 branch) the finding is downgraded to info. No fix is proposed: a person
  decides which text is right.
- **`L3.REVIEW.L2_CONFIRM`** (`checks/l2_confirm.py`). For each layer 2 finding with reason `missing` or
  `quantity_shortfall`, sends the trigger items, the matched dependency items and up to 25 items of the
  same section. Verdicts: `included` / `excluded` → info "probably a false positive", with the quote
  verified in the cited item; `missing` → warning "confirmed"; `unclear` → no finding. The layer 2
  finding is never edited; the new one carries `evidence.reviews_finding_id` and the same target.

Infrastructure:

| File | What |
|---|---|
| `provider.py` | `complete_json(LLMRequest) -> dict`. `OllamaProvider` (local, default; JSON-schema `format`, temperature 0), `AnthropicProvider` (official SDK, `output_config.format` structured output, effort `low`; opt-in), `FakeProvider` (tests), `ResponseCache` |
| `schema.py` | JSON schemas sent to the model, Pydantic models that validate each answer item on its own, quote check, confidence clamp (≤ 0.7) |
| `prompts.py` | System prompts and their versions (`l3-contradiction-v1`, `l3-l2confirm-v1`); the version is in the cache key and in every finding's evidence |
| `common.py` | Per-run session: cache first, then call budget, then the provider; a failed request goes to `errors`; an unavailable provider (or 3 failures in a row) stops further calls; skipped batches are reported |
| `eval.py`, `eval_cases.json` | `python -m analysis.layer3.eval`: precision/recall on 10 labelled contradiction cases (two are real excerpts) and accuracy on 4 layer 2 review cases, against the configured real model |

Configuration (environment variables):

| Variable | Default | |
|---|---|---|
| `ANALYSIS_L3_PROVIDER` | `ollama` | `ollama`, `anthropic` or `none` |
| `ANALYSIS_L3_MODEL` | `qwen2.5:7b-instruct` / `claude-haiku-5-5` | per provider |
| `OLLAMA_HOST` | `http://localhost:11434` | |
| `ANALYSIS_L3_TIMEOUT` | `120` | seconds per request |
| `ANALYSIS_L3_MAX_CALLS` | `40` | model calls per run (cache hits are free) |
| `ANALYSIS_L3_MAX_BATCH_LINES` / `_CHARS` | `12` / `12000` | contradiction batch size |
| `ANALYSIS_L3_CACHE` | `.cache/layer3` | directory, or `off` |

The API provider needs `pip install -e ".[llm-api]"` and credentials the SDK can resolve
(`ANTHROPIC_API_KEY`). Layer 3 is not in the runner's default layers: ask for it with `--layers 1,2,3`.

On the files in `Data/`, the contradiction check needs 4–32 calls per file (≈ 11 000–137 000 prompt
characters); the layer 2 review sends nothing there, because layer 2 raises nothing on those files.

Known limits: **precision has not been measured yet**, since no model was available while building it.
Run the eval with the chosen model before trusting either check. The cache holds tender text: it is
git-ignored, and `ANALYSIS_L3_CACHE=off` disables it. The other candidate checks in the table above are
still to build; fix validation (`set_field` on allowed fields only) comes with `L3.FIX.SUGGEST`.

## 6. After the layers: review and apply (not built yet)

- **Web review UI:** list findings grouped by severity, line and layer; show the source text through
  `source_locator`; accept or reject with a reason; edit a proposed fix before accepting.
- **Persist:** `analysis_run` + `analysis_finding` (migration 009). A decision is keyed by the
  finding's stable id, so it is carried over when the BOM is re-analysed.
- **Apply:** copy the BOM to a new draft `bom_version`, apply the accepted operations in order, record
  which findings they came from, and re-run the analysis on the new version.

## 7. Status and open points

| Item | State |
|---|---|
| Contract, adapter (GAEB files, JSON, DB), runner, CLI | Done |
| Layer 1 | Done, tested on real files |
| Layer 2 | First version, false positives on real files fixed; true positives only tested synthetically |
| Layer 3 | First version: contradiction check and layer 2 review (§5a); precision not measured yet |
| `from_db` + migration 009 | Written, **never run against PostgreSQL** |
| Pricing phase (`line_pricing`) | Not built; price rules tested only on synthetic data |
| Review UI, apply to new BOM version | Not built |

Working agreements: one branch per person; `contracts.py`, `units.py`, `registry.py` and `runner.py`
are shared, so agree before changing them; the next migration number is `010`; tests go in
`analysis/tests/`.
