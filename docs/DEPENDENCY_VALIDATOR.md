# GAEB dependency validator

Python implementation of **layer 2** from `ANALYSIS_CONTRACT.md`: the five trade rule groups from `gaeb_dependency_validator_spec.md` plus the ten groups from `IMPLEMENTATION_PLAN.md` §2.4 (15 groups, 46 checks).

The checker consumes **already parsed JSON**. It returns contract-shaped `Finding` objects and optional `add_line` proposals for human review. It never edits the BoQ or accesses a database. Raw GAEB/PDF extraction, pricing, layer 1, layer 3, and applying accepted fixes belong to the surrounding pipeline. Layer 2 registers all 46 checks with the existing shared registry without replacing shared models, units, adapters, or the runner.

## Run on Windows / PowerShell

Python 3.10 or newer is required. Set up a virtual environment from the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Run the included multi-trade example:

```powershell
.\.venv\Scripts\python.exe -m analysis.layer2 examples/items.json --scope trade --format table
```

This fixture deliberately produces **8 findings** (6 warnings, 2 info), covering the five original trade groups. Write the complete contract JSON report for your own file with:

```powershell
.\.venv\Scripts\python.exe -m analysis.layer2 "C:\path\to\parsed-boq.json" --scope trade --output report.json
```

Other useful commands:

```powershell
# Room distributions: one shortage in Office B.
.\.venv\Scripts\python.exe -m analysis.layer2 examples/analysis_input.json --format table

# Set a 5% allowable shortage; 0.05 is a fraction, not the number 5.
.\.venv\Scripts\python.exe -m analysis.layer2 examples/items.json --scope trade --tolerance 0.05

# Metadata for all 46 registered dependency checks.
.\.venv\Scripts\python.exe -m analysis.layer2 --list-rules

# Exit 1 on warnings/errors, useful in a validation job.
.\.venv\Scripts\python.exe -m analysis.layer2 examples/items.json --scope trade --fail-on warning

# Run all analysis tests (layers 1 and 2), configured in pyproject.toml.
.\.venv\Scripts\python.exe -m pytest
```

Exit codes: `0` = successful run; `1` = the selected finding threshold was met; `2` = invalid input/configuration or an I/O error. Without `--fail-on`, findings do not change exit code 0. JSON is the default output; `--format table` is a compact console view. The output file must differ from all input/configuration files.

Optionally install the package with `python -m pip install .` to use the `gaeb-check` command instead of `python -m analysis.layer2`.

## Input formats

1. A complete shared `AnalysisInput` object with `project`, `bom`, `areas`, `sections`, and `lines`. See [examples/analysis_input.json](../examples/analysis_input.json).
2. A JSON array of the specification's `Item` objects, or `{"items": [...]}`. See [examples/items.json](../examples/items.json).

```json
[
  {
    "oz": "14.1.20",
    "short_text": "Vinylbodenbelag 2mm",
    "long_text": "Bodenbelag aus PVC Vinyl, homogen",
    "quantity": "140.0",
    "unit": "m2",
    "trade_group": "Bodenbelagsarbeiten"
  }
]
```

The adapter maps `oz` to `code`, creates a section for each `trade_group`, and generates repeatable IDs for a stable item order. Supply persistent `id` values when the upstream system can reorder or insert items: generated IDs include the item index and are not stable across such edits. Existing IDs and source locators are preserved.

Internal line, area, and section IDs must be unique within their respective collections; ambiguous IDs are rejected. Repeated OZ codes are retained for layer 1 to check.

Numbers are parsed as `Decimal`, including German decimal commas and grouped forms such as `1.234,50`. A dot without a comma is interpreted as a decimal point. Invalid numbers become `null`; original quantity text and an import warning remain available. No lines are dropped. Units such as `m2`, `m3`, and `Stk` are normalized; unknown units retain their text. Source GAEB flags are retained exactly; the upstream parser must already resolve them into `total_rule`, `pricing_basis`, and `alternative_for`.

`input_hash` is recomputed from the canonical normalized model, excluding the hash itself. Findings use a stable hash of the rule ID and target, including the target field. The backend must carry human decisions within the same BOM as described in the contract. New findings always have status `open`.

## Checks and scoping

*(info)* marks a dependency with `"Severity": "info"`: it is usually tendered in another package, so a gap is a question for the client, not a warning.

| Rule group | Trigger (short text) | Required complements |
| --- | --- | --- |
| `L2.FLOOR.SCREED` | Estrich, Hohl-/Doppelboden, EN 13813 code + thickness ("CT, 65mm") | Edge insulation; underlays/insulation; primer/leveling area (not for floating screed); floor covering area *(info)*; skirting *(info)* |
| `L2.CONCRETE.STRUCTURE` | Beton, Ortbeton, Stahlbeton, Bodenplatte, foundations | Formwork; reinforcing steel (reinforced elements only); clean layer **only when a floor slab is present** |
| `L2.DRYWALL.PARTITION` | Metallständerwand, GKB/GKF, Trockenbauwand, Vorsatzschale | Insulation area; joint filling area; edge protection |
| `L2.PAINT.COATING` | Dispersionsfarbe, Anstrich, Lackierung, Silikatfarbe | Masking/protection; primer area |
| `L2.ROOF.WATERPROOFING` | Dachabdichtung, Dachbahn, Flachdach, FPO/EPDM/PVC membranes | Vapor barrier area; thermal insulation area; drainage |
| `L2.ELEC.INSTALLATION` | sockets, switches, push buttons, motion/presence detectors | Installation cable (NYM…); device boxes; RCD protection *(info)*; initial verification DIN VDE 0100-600; as-built documents |
| `L2.ELEC.LIGHTING` | luminaires, light bands, floodlights | Emergency lighting *(info, indoor luminaires only)*; switches/presence detectors/lighting control |
| `L2.ELEC.CABLING` | power cables (NYM, NYY, NYCWY, N2XH, Energiekabel) | Cable trays/conduits (not for cables pulled into ducts or buried); cable termination *(info)* |
| `L2.ELEC.LIGHTNING_PROTECTION` | air-termination system (Fangstange, Fangleitung, Blitzschutz-Stahlband…) | Earthing; equipotential bonding; acceptance inspection DIN EN 62305-3 |
| `L2.SANITARY.WC` | wall/floor WC (Tiefspül-WC, Wand-WC…) | WC seat, flush plate, mounting frame (wall WCs): **counts in `ea`, 0% tolerance** |
| `L2.SANITARY.POTABLE_WATER` | drinking-water pipes (TW-Rohr, Trinkwasserleitung…) | Pipe insulation (**length in `m`**); pressure test; flushing/disinfection; water sampling *(info)* |
| `L2.TILE.COVERING` | tiles, porcelain stoneware, mosaic, natural stone | Primer area; waterproofing (**wet rooms only**: shower, Nassraum, Bad); elastic joints; skirting/edge profiles |
| `L2.DOOR.STEEL` | steel, fire and smoke doors ("tür" required) | Door closer (T30/T90/RS doors only); lock cylinder *(info; "PZ-vorgerichtet" is not a cylinder)*; door hardware |
| `L2.DOOR.INDUSTRIAL` | sectional, roller, high-speed doors | Safety edge or light barrier (powered doors); drive power supply *(info)* |
| `L2.WINDOW` | windows, window doors | Window sills *(info)*; installation joint sealing (RAL) |

The ten new groups were written against the real `LV_xx` PDFs in `Data/` (one building split by trade). On them layer 2 now reports:

- **LV_13 ELT**: no RCD protection and no emergency lighting *(info)*;
- **LV_19 doors**: steel doors "PZ-Vorgerichtet" with no lock cylinder, and a powered sectional door with no power supply *(info)*;
- **LV_17 drywall**: 100 m² of W628 shaft wall with no insulation mentioned (warning);
- **LV_18 screed**: skirting is in another package *(info)*.

LV_14 (12 WCs against 12 seats, frames and flush releases; 288 m of pipe against 288 m of insulation) and LV_08 (tiles) correctly give nothing. The GAEB files in `Data/` give no warnings. The PDFs must be read with Poppler's `pdftotext` (see IMPLEMENTATION_PLAN.md §0.1).

**Triggers** are searched in each line's short text and tags (the long text only when there is no short text), and lines matching the rule's `ExcludeRegex` are never triggers. Long texts mention materials in passing ("Dichtmanschette aus EPDM", "Stützen aus Beton werden bauseits erstellt"), and on the real files in `Data/` that made pipe couplings look like roofs and pipe removals look like concrete jobs. The bundled rules exclude demolition and removal (abbrechen, Rückbau, Demontage, ausbauen, entsorgen), and for concrete also precast parts, pipes, manholes, kerbs, lean or blinding concrete, temporary or rental items and work on existing concrete (Kernbohrung, sägen, Sanierung). Reinforcement is only required for reinforced elements (Stahlbeton, StB, Ortbeton, Bodenplatte), not for `unbewehrt`. Each new group excludes what the real files showed: measurements and recesses ("Messung Estrichfeuchte", "Aussparung … Estrich"), surcharges ("Zul.", "Zulage"), painting on concrete or doors, paving and civil-engineering stone, "Thermische Steckdose" (concrete core activation), reinforcement for luminaires, temporary site power, and WC frames, seats and flush plates as WC triggers. Set `"TriggerIn": "all"` on a rule to search long texts again.

**Dependencies** are searched in each line's short text, long text and tags, case insensitively. A line matching several synonyms in the same dependency is counted once. A bundled description can satisfy a dependency on the same line. Multiple matching lines, including different floor covering types, are summed. Conditional positions, alternatives, unit-price-only positions, and explicitly nonpositive quantities neither trigger nor satisfy these checks. The same applies to PDF items flagged `unit_price_only`, `provisional_included` or `alternative_item` ("*** Bedarfsposition ohne/mit GB", "*** Wahlposition"): the shared adapter does not yet turn those flags into `total_rule` (IMPLEMENTATION_PLAN.md §0.2), so layer 2 reads them itself.

Scope options:

| Option | Search boundary |
| --- | --- |
| `auto` (default) | Uses room allocations if any active line has distributions; otherwise the entire BoQ |
| `document` | Entire BoQ, as in the specification's document-wide mode |
| `trade` | Each top-level section tree; for flat input, each `trade_group` |
| `section` | Each exact section, independently |
| `area` | Each room allocation; falls back to the entire BoQ if there are no distributions |

The default stays `document` for files without room allocations. IMPLEMENTATION_PLAN.md §2.4 suggested `trade`, but on LV_14 the drinking-water pipes (section 2) and their insulation (section 10) are both top-level sections, so `trade` reports a false "no pipe insulation" that `document` does not; whether to change the default is an open team decision (§8). Use `--scope trade` for a combined multi-trade item list so an unrelated trade's primer cannot satisfy another trade's requirement. When rooms exist, quantities come from distributions. Positive residual quantities are checked in an unassigned group. Incomplete or excessive allocations produce informational findings when they prevent a check. An unassigned dependency never silently satisfies every room; a matching unassigned candidate downgrades a room shortage to `info` so its allocation can be reviewed. Areas are independent; parent/child area allocations are not inferred.

For `QuantityMatch`, the default test is:

```text
dependency_quantity < trigger_quantity × (1 − 0.10)
```

Equality at the boundary passes; excess dependency quantities pass. Of the twelve bundled quantity checks, eight compare **areas in m²**, three (WC seat, flush plate, frame) compare **counts in `ea`** with 0% tolerance and one (pipe insulation) compares **lengths in `m`**; compatible units are converted exactly. Quantities with incompatible units are never added together: a line measured in another measurable dimension (insulation shells in pieces next to insulation in metres) is **skipped** and listed in `skipped_trigger_lines` / `skipped_dependency_lines`; if every match was skipped the dependency counts as missing. Lump sums, composite and unknown units may still cover the whole quantity, so they, like missing/unreliable values, produce `info` with reasons and known subtotals, rather than a claimed numerical shortage. `variance` is dependency quantity minus trigger quantity; `shortfall_to_minimum` is the amount below the tolerated boundary. Both are serialized as decimal strings. When quantity problems exist, these are partial observations, not a confirmed shortage.

Dependency absences and reliable shortages are `warning`, because a reviewer must confirm the work belongs in this package. A dependency with `"Severity": "info"` reports the same gap as `info` and asks whether it is included elsewhere or provided by others; it keeps its proposal. For quantity shortages, a proposed line covers the difference to full trigger coverage. For Boolean dependencies the proposed quantity is `null`, because it can't be inferred from mere presence. The unit comes from the dependency's `SuggestedUnit` (e.g. `m` for skirting, `t` for reinforcement), and the rationale tells the reviewer to enter the quantity before accepting. A line added without one would be flagged by `L1.QTY.MISSING`. Proposal confidence is deliberately below 1.0. Proposals are never executed.

These are text heuristics. The supplied regexes have limited compound-word coverage and do not understand negations, exclusions, repeated coats/layers, construction sequencing, or engineering exceptions. A result reports what was found in the reviewed scope. It does not establish that the complete project contains or lacks that work.

## Integrate with the analysis pipeline

```python
from analysis.layer2.adapter import from_json
from analysis.layer2 import run
from analysis.layer2.report import analyze

input = from_json("parsed-boq.json")
layer1_findings = []  # Replace with existing layer 1 output.

# Shared layer interface: returns only new layer 2 findings.
layer2_findings = run(input, layer1_findings)

# Standalone wrapper: merges the prior findings and returns AnalysisResult.
result = analyze(input, layer1_findings, scope="trade")
print(result.model_dump_json(indent=2))
```

The existing pipeline also runs both layers with `python -m analysis run path/to/file.X83 --layers 1,2` (install `importer/requirements.txt` for raw GAEB), and `python -m analysis rules` lists their metadata. Existing adapters can pass an `AnalysisInput` directly to `run(input, prior_findings)`. Pydantic models are in [analysis/contracts.py](../analysis/contracts.py). The standalone report wrapper records `layers_run: [2]` because it executes layer 2; supplied layer 1 findings remain in `findings` and summary counts. It does not claim to execute layer 1.

A prior layer 1 `error` targeting a line's `quantity` or `unit` prevents a quantitative claim about that line. Related dependency checks are downgraded to informational findings and receive no fix proposal. For the CLI, use `--prior-findings layer1.json` with either a findings array or an `AnalysisResult` object. A supplied result's `input_hash` must match the normalized current input; findings arrays have no hash envelope, so callers must ensure they belong to this input.

## Extend the knowledge base

Rules live in [analysis/layer2/rules.json](../analysis/layer2/rules.json); no code changes are needed to add another category. Use `--rules custom-rules.json` to replace the bundled rules. An empty rules array explicitly disables all layer 2 checks.

```json
[
  {
    "RuleID": "L2.FLOOR.SCREED",
    "Category": "Floor screed and finishes",
    "TriggerRegex": "(?i)\\bestrich\\b",
    "Required_Dependencies": [
      {
        "DependencyName": "Floor covering",
        "Regex": "(?i)\\b(vinyl|pvc|teppich)\\b",
        "CheckType": "QuantityMatch",
        "TolerancePct": "0.10",
        "QuantityUnit": "m²",
        "SuggestedText": "Bodenbelag, Ausführung zu klären"
      }
    ]
  }
]
```

Rule-level `TriggerIn` (`short_text` by default, or `all`) chooses where the trigger is searched, and `ExcludeRegex` drops lines from the triggers. A dependency can also have its own `ExcludeRegex`, which drops triggers for that dependency only, e.g. `unbewehrt` for reinforcement. `TolerancePct` is a fraction in `[0, 1)` and overrides the CLI/global tolerance for that dependency. `QuantityUnit` defaults to `m²` and must be canonical. A dependency-level `TriggerRegex` narrows the parent trigger, used for concrete floor slabs. `SuggestedText` enables a reviewable proposal, and `SuggestedUnit` (canonical) gives its unit when the quantity can't be derived. `Severity` (`warning` by default, or `info`) is for items usually tendered in another package. When adding a group, run it on the real files first and add both a detection test and the real texts that must not trigger it (`NewTradeTests` in the tests). Python regexes and `/pattern/i` notation are supported. Derived finding IDs append `_NEEDS_<DEPENDENCY_NAME>` to the group's `RuleID`; dependency names must yield distinct ASCII keys. Keep names stable when human decisions already reference them.

## Files

- `analysis/contracts.py`: shared Pydantic input, result, finding, and fix models.
- `analysis/units.py`: shared canonical vocabulary, dimensions and exact conversions (`convert`).
- `analysis/layer2/quantities.py`: thin layer 2 wrapper over `analysis/units.py`.
- `analysis/adapter.py`: shared adapter for GAEB files, the database and JSON. `from_json`/`from_data` accept an AnalysisInput object, an Item array or `{"items": [...]}`, with lenient number parsing.
- `analysis/layer2/adapter.py`: re-exports the shared JSON loader.
- `analysis/layer2/schema.py`: validated ruleset and UI rule metadata.
- `analysis/layer2/engine.py`: deterministic checks and scope handling.
- `analysis/runner.py`: shared pipeline runner; discovers registered layer 2 checks.
- `analysis/layer2/report.py`: standalone layer 2 report and result summaries.
- `analysis/layer2/cli.py`: layer 2 command line (`python -m analysis.layer2`, `gaeb-check`). The full pipeline is `python -m analysis`.
- `analysis/tests/test_layer2.py`: regression and end-to-end tests.
