# Analysis pipeline: shared contract (v0.1)

Implemented in `analysis/` on branch `analysis/layer1-contract`.

Context document for everyone building an analysis layer. Paste it into prompts as-is.

## 1. Where the analysis sits

```
upload (GAEB X83/D83/D84/D86, PDF, DOCX)
  -> importer/tender_import        raw evidence in source_extract
  -> draft.py                       normalized BOM: bom_version / bom_section / bom_line
  -> pricing phase                  catalogue + reference prices, AI search for the rest
  -> ADAPTER                        builds one AnalysisInput object        <- this contract
  -> layer 1  deterministic checks  (missing qty, unit mismatch, arithmetic, ...)
  -> layer 2  dependency checks     (room / trade requirements, item A requires item B)
  -> layer 3  LLM checks            (hard cases, cheap/local model)
  -> AnalysisResult (list of Finding) -> web review UI -> human accepts/rejects
  -> accepted fixes are applied as a NEW bom_version (never in place, never automatic)
```

All layers are Python, read the same `AnalysisInput`, and return `Finding` objects with the
same shape. A layer never reads the database and never changes the input.

## 2. Code layout and ownership

```
analysis/
  contracts.py      shared Pydantic models (this document). Changes need both owners' OK.
  units.py          shared canonical unit vocabulary + dimension of each unit.
  registry.py       shared @rule decorator, RuleContext.finding(), run_layer().
  adapter.py        builds AnalysisInput from DB / importer result / JSON fixture.  (layer 1 owner)
  runner.py         runs layers in order, merges findings, computes summary.        (shared, small)
  __main__.py       CLI: python -m analysis input|run|rules
  layer1/           deterministic rules                                             (layer 1 owner)
  layer2/           dependency rules + knowledge base (rooms, trades)               (layer 2 owner)
  layer3/           LLM checks                                                      (later)
  tests/fixtures/   AnalysisInput JSON files, real GAEB files from Data/ plus injected errors
db/migrations/009_analysis.sql   analysis_run, analysis_finding, line_pricing        (layer 1 owner)
```

Each person works on their own branch. Only `contracts.py`, `units.py` and `runner.py` are shared.

### Layer interface

Every layer is a package `analysis.layer<N>` that exposes:

```
run(input: AnalysisInput, prior_findings: list[Finding], errors: list[str]) -> list[Finding]
```

`errors` collects rules that crashed. One broken rule never stops the others. The runner skips a
layer package that doesn't exist yet and notes it in `AnalysisResult.errors`.

Writing a rule (`analysis/registry.py`):

```python
from analysis.registry import rule

@rule("L2.BATH.WASHBASIN_NEEDS_SUPPLY_PIPES", layer=2, category="dependency", severity="warning",
      title="Washbasins without supply pipes", description="A washbasin needs supply piping and angle valves.")
def washbasin_pipes(ctx):              # ctx.input, ctx.prior_findings
    ...
    yield ctx.finding(section=section, message="...", related_line_ids=[...], suggested_fix=Fix(...))
```

`ctx.finding(...)` fills in `id`, `rule_id`, `layer`, `category`, default `severity`, `scope`,
`target` and `source_locator`. The layer's `__init__.py` imports its rule modules and
calls `registry.run_layer(N, input, prior_findings, errors)`. See `analysis/layer1/__init__.py`.

Command line:

```
python -m analysis input "Data/file.X83" --out input.json   # AnalysisInput as JSON
python -m analysis run   "Data/file.X83" --layers 1,2       # AnalysisResult as JSON
python -m analysis run   input.json                          # same, from a fixture
python -m analysis rules                                     # every registered rule
python -m pytest analysis/tests
```

- Layer 1 gets `prior_findings = []`.
- Layer 2 gets layer 1 findings. Convention: skip or downgrade a dependency check on a line
  that already has a layer 1 `error` on `quantity` or `unit`, because the values are not reliable.
- Layer 3 gets layer 1 and layer 2 findings.

Rules are small pure functions registered with metadata (`rule_id`, `layer`, `category`,
`default_severity`, `description`) so the UI can list and explain every rule.

## 3. The adapter (input side)

One model, three sources:

| Source | Use |
|---|---|
| `from_db(conn, bom_version_id)` | Production. Joins `bom_version`, `bom_section`, `bom_line`, `bom_line_distribution`, `project_area`, `source_document` and the pricing table. |
| `from_import(result)` | Runs straight on a parsed GAEB file with no database. Fast tests and demos. |
| `from_json(path)` | Test fixtures and handing data between people. |

What the adapter does, so rules don't have to:

- Parses numbers to `Decimal` (money and quantities never use float). Unparseable value -> `None`, raw text kept.
- Normalizes units to the canonical vocabulary in `units.py`, keeps the raw unit.
- Resolves the section tree and the OZ code parts.
- Collapses whitespace in texts, keeps the GAEB flags exactly as in the source.
- Attaches pricing info and room distributions per line.
- Passes importer warnings through (`import_warnings`).
- **Never drops a line and never fixes data.** Broken data stays visible so a rule can flag it.

### AnalysisInput

| Field | Type | Notes |
|---|---|---|
| `schema_version` | str | `"0.1"` |
| `input_hash` | str | sha256 of the canonical JSON. Results are tied to the input they came from. |
| `project` | Project | `id`, `name`, `currency` (ISO 4217), `gaeb_phase` (`"83"` tender, `"84"` bid, `"86"` award, or null), `source_document` (`id`, `filename`, `format`) |
| `bom` | Bom | `bom_version_id`, `package_code`, `title`, `trade` (optional, e.g. `"sanitary"`, from the LV title or user input), `stated_net_total` (total written in the file, if any) |
| `areas` | list[Area] | `id`, `parent_id`, `name`, `kind` (`bathroom`, `kitchen`, `office`, `corridor`, `facade`, `roof`, ... or `unknown`). Often empty for GAEB, which is organized by trade. |
| `sections` | list[Section] | `id`, `parent_id`, `code` (e.g. `"01.02"`), `code_parts`, `title`, `sort_order`, `stated_total` (subtotal written in the file, GAEB 90 bids/awards) |
| `lines` | list[Line] | see below |
| `import_warnings` | list[dict] | `code`, `message`, `locator` from the importer |

### Line

| Field | Type | Notes |
|---|---|---|
| `id` | str (uuid) | `bom_line.id`, or a stable synthetic id when built from an import |
| `code` | str \| null | OZ, e.g. `"01.02.0030"` |
| `code_parts` | list[str] | `["01","02","0030"]` |
| `section_id` | str \| null | |
| `sort_order` | int | document order |
| `short_text` | str \| null | GAEB short text (Kurztext) |
| `long_text` | str \| null | GAEB long text (Langtext) |
| `quantity` | Decimal \| null | |
| `quantity_raw` | str \| null | as in the source |
| `unit` | str \| null | canonical unit, see section 5 |
| `unit_raw` | str \| null | as in the source, e.g. `"Stk"` |
| `pricing_basis` | `unit_rate` \| `lump_sum` | |
| `total_rule` | `include` \| `conditional` \| `unit_price_only` | `conditional` = optional/alternative item (Bedarfs-/Wahlposition), `unit_price_only` = "Nur Einh.-Pr." |
| `alternative_for` | str \| null | line id of the base item |
| `gaeb_flags` | dict[str, str] | raw flags: `Provis`, `AltItem`, `LumpSumItem`, `position_type`, ... |
| `source_amounts` | object \| null | prices written in the uploaded file itself (D84/D86 bids): `unit_price`, `line_amount` |
| `price` | PriceInfo \| null | result of the pricing phase |
| `distributions` | list | `{area_id, quantity}`: how the line splits across rooms |
| `tags` | list[str] | optional classification (material/activity/trade keywords), empty until classified |
| `source_locator` | dict | points into the original file (xml_path, page, record), so the UI can show the source |

### PriceInfo: what we ask from the pricing phase

| Field | Type | Notes |
|---|---|---|
| `unit_price` | Decimal \| null | |
| `currency` | str | |
| `price_unit` | str | canonical unit the price refers to. Can differ from `line.unit`, and that is exactly what layer 1 checks. |
| `line_amount` | Decimal \| null | if the pricing phase computed it |
| `source` | `catalogue` \| `reference` \| `ai` \| `client` \| `none` | |
| `source_ref` | str \| null | `product.id`, `reference_price.id`, or URL |
| `matched_text` | str \| null | description of the matched product/position |
| `match_confidence` | float 0–1 | 1.0 for an exact catalogue match |
| `price_date` | date \| null | |
| `reference_range` | `{min, median, max, n}` \| null | other observed prices for the same item, used for outlier checks |
| `citations` | list[str] | for `ai`, where the price came from |

The pricing phase stores this in a `line_pricing` table (one current row per `bom_line_id`),
created in migration 009.

## 4. The output

### AnalysisResult

| Field | Type | Notes |
|---|---|---|
| `run_id` | str | uuid |
| `schema_version` | str | |
| `bom_version_id` | str | |
| `input_hash` | str | same as the input |
| `created_at` | datetime | |
| `layers_run` | list[int] | e.g. `[1, 2]` |
| `findings` | list[Finding] | |
| `summary` | object | counts by layer, severity, category, rule |
| `errors` | list[str] | rules that crashed, layers not implemented yet |

### Finding

| Field | Type | Notes |
|---|---|---|
| `id` | str | **stable**: hash of `rule_id` + target + field. The same problem gets the same id on every run, so a human decision survives re-analysis. |
| `layer` | 1 \| 2 \| 3 | |
| `rule_id` | str | `L<layer>.<CATEGORY>.<NAME>`, e.g. `L1.QTY.MISSING`, `L2.BATH.WASHBASIN_NEEDS_SUPPLY_PIPES` |
| `category` | str | `completeness`, `unit`, `arithmetic`, `price`, `structure`, `text`, `dependency`, `requirement`, ... |
| `severity` | `error` \| `warning` \| `info` | `error`: the line can't be priced or totalled correctly. `warning`: probably wrong, a human must look. `info`: observation. |
| `scope` | `line` \| `section` \| `area` \| `bom` | |
| `target` | object | `line_id`, `line_code`, `section_id`, `area_id`, `field`: whichever apply |
| `related_line_ids` | list[str] | other lines involved (the washbasin that triggered "missing pipes", the duplicate twin, ...) |
| `title` | str | short, English, e.g. `"Quantity missing"` |
| `message` | str | one or two sentences explaining what's wrong and why |
| `evidence` | dict | the observed values that triggered the rule |
| `suggested_fix` | Fix \| null | null = needs a human decision with no automatic proposal |
| `origin` | `rule` \| `llm` | plus `model` when `llm` |
| `status` | `open` \| `accepted` \| `rejected` \| `applied` \| `stale` | always `open` when produced. Only the UI changes it. `stale` = the finding didn't come back on a re-run. |
| `source_locator` | dict \| null | copied from the line |

### Fix

| Field | Type | Notes |
|---|---|---|
| `operations` | list[Operation] | applied together or not at all |
| `confidence` | float 0–1 | 1.0 only when derivable (e.g. recomputed `qty × unit_price`) |
| `rationale` | str | why this fix |

Operations:

| `op` | Payload | Typical producer |
|---|---|---|
| `set_field` | `line_id`, `field`, `old_value`, `new_value` | L1 (unit, quantity, total_rule, amount) |
| `add_line` | `section_id`, `after_line_id`, `line` (`short_text`, `long_text`, `quantity`, `unit`, `pricing_basis`), `distributions` | L2 (missing required material) |
| `remove_line` | `line_id` | L1/L2 (duplicate) |
| `merge_lines` | `keep_line_id`, `remove_line_ids`, `new_quantity` | L1 (duplicates) |
| `link_alternative` | `line_id`, `alternative_for` | L1 (orphan alternative) |

Allowed `set_field` fields: `quantity`, `unit`, `short_text`, `long_text`, `pricing_basis`,
`total_rule`, `alternative_for`, `unit_price`.

Applying accepted fixes is the web/backend's job: copy the BOM into a new draft `bom_version`,
apply the operations in order, and record which findings they came from.

### Persistence (migration 009)

- `analysis_run(id, bom_version_id, input_hash, layers_run, created_at, summary jsonb)`
- `analysis_finding(id, run_id, finding_key, layer, rule_id, severity, status, payload jsonb, decided_by, decided_at)`
- When a run produces a `finding_key` that already has a human decision for the same BOM, the decision is carried over.

## 5. Shared unit vocabulary (`units.py`)

Canonical codes (taken from `draft.py`), each with a dimension, so both layers can reason about
"does this unit make sense for this item":

| Dimension | Units |
|---|---|
| count | `ea`, `set` |
| length | `m`, `km` |
| area | `m²`, `cm²`, `km²` |
| volume | `m³`, `l` |
| mass | `kg`, `t` |
| time | `h`, `day`, `week`, `month`, `year` |
| lump | `lump_sum` |
| composite | `m·week`, `ea·week`, `m²·day`, `m²·week`, `m·day` |

An unknown unit keeps its raw text and gets dimension `unknown`. That's a layer 1 finding.

## 6. Examples

### One input line

```json
{
  "id": "7c1e...", "code": "02.01.0040", "code_parts": ["02","01","0040"],
  "section_id": "a91f...", "sort_order": 112,
  "short_text": "Waschtisch Keramik 60 cm", "long_text": "Waschtisch aus Sanitärporzellan ...",
  "quantity": "4", "quantity_raw": "4,000", "unit": "ea", "unit_raw": "Stk",
  "pricing_basis": "unit_rate", "total_rule": "include", "alternative_for": null,
  "gaeb_flags": {}, "source_amounts": null,
  "price": {"unit_price": "185.00", "currency": "EUR", "price_unit": "ea", "source": "catalogue",
            "source_ref": "prod_123", "matched_text": "Waschtisch 60x48 weiß", "match_confidence": 0.86,
            "price_date": "2024-11-25", "reference_range": {"min": "140", "median": "190", "max": "260", "n": 5},
            "citations": []},
  "distributions": [{"area_id": "bath_eg", "quantity": "2"}, {"area_id": "bath_og", "quantity": "2"}],
  "tags": ["sanitary", "washbasin"],
  "source_locator": {"xml_path": "Award/BoQ/BoQBody/BoQCtgy[2]/...", "import_id": "..."}
}
```

### Layer 1 finding

```json
{
  "id": "f_3b9a...", "layer": 1, "rule_id": "L1.PRICE.UNIT_MISMATCH", "category": "price",
  "severity": "error", "scope": "line",
  "target": {"line_id": "9d2e...", "line_code": "03.02.0010", "field": "price.price_unit"},
  "related_line_ids": [],
  "title": "Price unit differs from line unit",
  "message": "The matched price is per m but the line is measured in m². The amount would be wrong.",
  "evidence": {"line_unit": "m²", "price_unit": "m", "unit_price": "12.40"},
  "suggested_fix": null, "origin": "rule", "status": "open",
  "source_locator": {"xml_path": "..."}
}
```

### Layer 2 finding (missing dependency)

```json
{
  "id": "f_77c0...", "layer": 2, "rule_id": "L2.BATH.WASHBASIN_NEEDS_SUPPLY_PIPES",
  "category": "dependency", "severity": "warning", "scope": "section",
  "target": {"section_id": "a91f...", "area_id": null},
  "related_line_ids": ["7c1e..."],
  "title": "Washbasins without supply pipes",
  "message": "4 washbasins are listed but no water supply piping or angle valves were found in this LV.",
  "evidence": {"trigger": "washbasin", "missing": ["supply_pipe", "angle_valve"], "trigger_quantity": "4"},
  "suggested_fix": {
    "confidence": 0.6,
    "rationale": "Each washbasin needs cold/hot supply connection.",
    "operations": [{"op": "add_line", "section_id": "a91f...", "after_line_id": "7c1e...",
                    "line": {"short_text": "Eckventil 1/2\" für Waschtisch", "quantity": "8",
                             "unit": "ea", "pricing_basis": "unit_rate"}}]
  },
  "origin": "rule", "status": "open", "source_locator": null
}
```

## 7. Layer 1 rule catalogue (planned)

| rule_id | Severity | Check |
|---|---|---|
| `L1.QTY.MISSING` | error | `quantity` is null on an item that is not `lump_sum` |
| `L1.QTY.NON_POSITIVE` | error | `quantity <= 0` |
| `L1.QTY.FRACTIONAL_COUNT` | warning | non-integer quantity in a count unit (`2.5 ea`) |
| `L1.UNIT.MISSING` | error | no unit |
| `L1.UNIT.UNKNOWN` | warning | unit not in the vocabulary |
| `L1.UNIT.TEXT_MISMATCH` | warning | unit dimension contradicts keywords in the text (area words + `ea`, pipe + `m²`, ...) |
| `L1.LUMP.INCONSISTENT` | warning | `lump_sum` with quantity ≠ 1 or unit ≠ `lump_sum`, or the other way round |
| `L1.TEXT.MISSING` | error | no short or long text |
| `L1.TEXT.PLACEHOLDER` | warning | unfilled placeholders (`......`, `XXX`, `Fabrikat: ___`, `nach Wahl`) |
| `L1.CODE.MISSING` / `L1.CODE.DUPLICATE` | error | empty or repeated OZ |
| `L1.CODE.OUTSIDE_SECTION` | warning | OZ prefix doesn't match its section code |
| `L1.STRUCT.EMPTY_SECTION` | info | section without items |
| `L1.STRUCT.ORPHAN_ALTERNATIVE` | warning | alternative item without a base item |
| `L1.STRUCT.UNIT_PRICE_ONLY_IN_TOTAL` | error | "Nur Einh.-Pr." item counted in the total |
| `L1.DUP.SUSPECTED` | warning | same normalized text and unit twice in one section |
| `L1.ARITH.LINE_AMOUNT` | error | `qty × unit_price ≠ line_amount` beyond rounding tolerance (0.01 per line) |
| `L1.ARITH.SECTION_TOTAL` | error | stated subtotal ≠ sum of included lines |
| `L1.PRICE.MISSING` | error | no price after the pricing phase |
| `L1.PRICE.ZERO` | warning | unit price 0 |
| `L1.PRICE.UNIT_MISMATCH` | error | `price.price_unit` ≠ `line.unit` |
| `L1.PRICE.OUTLIER` | warning | price outside the reference range by a set factor |
| `L1.PRICE.LOW_CONFIDENCE` | info | `match_confidence` below a threshold |
| `L1.DIST.SUM_MISMATCH` | warning | room distributions don't add up to the line quantity |

## 8. Notes for layer 2

- Input is the full `AnalysisInput` plus layer 1 findings. Main signals: `short_text`, `long_text`,
  `tags`, `section` titles, `bom.trade`, `areas[].kind` and `distributions`.
- GAEB documents are usually split by trade (one LV per Gewerk), and rooms are often missing.
  Requirements must work at BOM/section level when `areas` is empty, and at room level when it isn't.
- The knowledge base format (room types, trade requirements, item → required item) belongs to
  layer 2. Only the `Finding` output is shared.
- Suggest missing items with `add_line`, and point at the triggering lines with `related_line_ids`.
- Keep `confidence` honest. A heuristic dependency is not 1.0.
