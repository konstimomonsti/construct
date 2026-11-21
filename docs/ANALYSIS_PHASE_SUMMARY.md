# Analysis phase: what was built (summary for the team)

Date: 21 November 2026. Branch: `main` (everything below is pushed). Detail lives in
[ANALYSIS_LAYERS.md](ANALYSIS_LAYERS.md) (overview of the layers), [ANALYSIS_CONTRACT.md](ANALYSIS_CONTRACT.md)
(data model and layer 1 rules) and [DEPENDENCY_VALIDATOR.md](DEPENDENCY_VALIDATOR.md) (layer 2).

## In one paragraph

The platform receives a client's bill of quantities (GAEB X83/D83/D84/D86, PDF, Word), organizes it, and
prices it. The **analysis phase** then finds the errors and shows them to a person, with an optional
proposed fix. **Nothing is ever changed automatically.** It works in three layers that run in order: layer 1
is plain code (missing quantities, wrong units, wrong sums), layer 2 is a rule base of construction
dependencies (screed needs edge insulation, concrete needs formwork), and layer 3 uses a small LLM for what
needs understanding the text. A minimal web page lets you upload a file and see the report.

```
upload -> importer -> normalized BOM -> (pricing, not built) -> adapter -> layer 1 -> layer 2 -> layer 3
       -> findings -> web report -> human accepts/rejects -> (apply to a new BOM version, not built)
```

## What was done, step by step

### 1. Shared contract (so two people could work in parallel)

- Agreed on **one input object** (`AnalysisInput`) and **one output object** (`Finding`) for every layer,
  documented in `docs/ANALYSIS_CONTRACT.md`.
- `analysis/contracts.py`: Pydantic models. Money and quantities use `Decimal`, and every finding has a
  **stable id** (same problem → same id on every run, so a human decision survives re-analysis).
- `analysis/units.py`: one canonical unit vocabulary (`St`/`Stk` → `ea`, `m2` → `m²`, `psch` → `lump_sum`, …),
  each unit's dimension, and exact conversions.
- `analysis/adapter.py`: builds the input from a **GAEB file directly** (no database needed), from the
  **database**, or from **JSON**. It never drops a line and never repairs data, so the rules can see
  the problems.
- `analysis/registry.py` + `analysis/runner.py`: a `@rule` decorator, layers run in order, a crashing rule
  never stops the others, and findings are merged, de-duplicated and summarized.
- `db/migrations/009_analysis.sql`: tables for the pricing hand-off (`line_pricing`) and for stored results
  (`analysis_run`, `analysis_finding`).
- CLI: `python -m analysis run "Data/file.X83" --layers 1,2,3`.

### 2. Research on typical errors

Before writing layer 1 we looked up common BoQ errors and German award rules. In short: quantity, unit and
description errors are the most frequent; unit price beats line total when they disagree (**VOB/A §16c**);
Wahlpositionen need a Grundposition; Bedarfspositionen are generally not allowed in public tenders; bidder
fields ("Fabrikat: ……", "oder gleichwertig") must be filled in a bid. Sources are listed in the contract doc.
We also mined the real files in `Data/` to see which errors actually occur.

### 3. Layer 1: deterministic checks (34 rules)

`analysis/layer1/`, in four modules:

- **Completeness:** missing, negative or zero quantity, fractional piece counts, missing or unknown unit,
  missing text, missing or duplicate OZ.
- **Consistency:** a unit contradicting "Abrechnung nach …", inconsistent lump sums, empty bidder fields,
  "oder gleichwertig" products, structure problems, suspected duplicates.
- **Arithmetic:** qty × unit price vs line amount, section subtotals, net total.
- **Prices:** missing, zero, unit or currency mismatch, outliers, low confidence, bid price vs ours, stale
  prices.

Severity depends on the document phase: an empty bidder field is *info* in a tender and a *warning* in a bid.

**What it found in the real files:**

| File | Finding |
|---|---|
| `[ORT_024] LV24069.D86` | 38 change-order items priced at 3,279.20 € but with **quantity 0 and no unit**; net total left at 0.00 |
| `StBALV23040.D86` | A damaged OZ puts one item outside every section, so **section 08's subtotal is off by exactly its 982.20 €**. The rule points at that item |
| `Angebot AN24-0305.D84` | 20 bidder fields left empty in the bid |
| `501-24-01_GAEB-XML_sas.x83` | A duplicated item (02.03.0005 / 02.03.0007) |
| Clean tenders | Only informational notes |

### 4. Layer 2: review and fixes (built by a teammate)

The teammate built the dependency checker (5 trade groups, 16 checks, with scoping by trade, section or room).
The review found that **on the real files every layer 2 warning was a false positive**: "EPDM" pipe seals
triggered flat-roof checks, and "Beton" in demolition, precast, temporary and core-drilling items triggered
concrete checks. Fixes made:

- Triggers now match the **short text** (long texts mention materials in passing), and each rule can
  **exclude** lines (demolition, precast, pipes, temporary items, work on existing concrete). Reinforcement is
  only required for reinforced elements.
- Real files now give 0 false warnings, and real cases (a reinforced concrete wall, an EPDM roof membrane) still
  trigger.
- Clean-up: one shared unit table and one JSON loader instead of duplicates; the layer 2 CLI moved into
  `analysis/layer2/`; proposals now carry a unit; all tests live in `analysis/tests/`; `pyproject.toml` and
  `.gitignore` were fixed.

### 5. Layer 3: LLM checks (first version, built in a separate session)

`analysis/layer3/`, with two checks:

- **`L3.TEXT.SHORT_LONG_CONTRADICTION`:** short and long text state different values (DN 100 vs DN 150).
- **`L3.REVIEW.L2_CONFIRM`:** re-reads each layer 2 "missing" finding and says whether the dependency is in fact
  included elsewhere, excluded ("bauseits"), or really missing.

Safety by design: the provider is pluggable (**local Ollama by default**, the Anthropic API opt-in, a fake
for tests). Answers must be structured JSON, the quoted text is checked word for word against the line,
confidence is capped at 0.7, answers are cached, there's a call budget per run, and a model failure never
stops layers 1 and 2. **Precision has not been measured yet**: run `python -m analysis.layer3.eval` with the
chosen model first.

### 6. Minimal web app (built in a separate session)

`webapp/`: a FastAPI app (`python -m webapp`). Upload a GAEB, PDF or Word file, or pick a sample from `Data/`.
It runs the layers and shows a one-page report: counts by severity, filters, each finding with its evidence,
proposed fix and source text, a table of positions, and a JSON download. It also fixed the adapter so PDF items
land in their sections.

### 7. Documentation

- `docs/ANALYSIS_LAYERS.md`: start here; what each layer does, the status, and the design rules for layer 3.
- `docs/ANALYSIS_CONTRACT.md`: data model, layer 1 rule catalogue, sources.
- `docs/DEPENDENCY_VALIDATOR.md`: layer 2 rules and how to extend them.
- `docs/PUBLIC_DATA_SOURCES.md`: public GAEB test files, tender portals and price data we could use.

## Current state

| Part | State |
|---|---|
| Contract, adapter, runner, CLI | Done |
| Layer 1 (34 rules) | Done, tested on the real files |
| Layer 2 (46 checks) | 15 trade groups. The 10 new groups were tested on the `LV_xx` building PDFs in `Data/` (the earlier "no building projects" note was wrong) |
| Layer 3 (2 checks) | First version; precision not measured yet |
| Web report | Minimal version works |
| Tests | 142 passing (`python -m pytest`) |
| `from_db` + migration 009 | Written, **never run against PostgreSQL** |
| Pricing phase | Not built; price rules tested only on synthetic data |
| Accept/reject in the UI, apply fixes to a new BOM version | Not built |

## Suggested next steps

1. Measure layer 3 precision with the chosen model (`python -m analysis.layer3.eval`).
2. Get building-project GAEB files (see `PUBLIC_DATA_SOURCES.md`: BVBS test files, Dangl samples, public tenders) to
   test layer 2 on real buildings and add more trades (sanitary, electrical, tiling, windows).
3. Run migration 009 and `from_db` against the database.
4. Add accept/reject to the web report and apply accepted fixes to a new BOM version.
5. Connect the pricing phase through `line_pricing` so the price rules get real data.

## How to try it

```
pip install -r webapp/requirements.txt     # includes the analysis requirements
python -m analysis run "Data/StBALV23040.D86" --layers 1,2
python -m webapp                           # then open http://127.0.0.1:8000
python -m pytest                           # all analysis tests
```

Working agreements: `contracts.py`, `units.py`, `registry.py` and `runner.py` are shared, so agree before
changing them; the next migration number is `010`; tests go in `analysis/tests/`.
