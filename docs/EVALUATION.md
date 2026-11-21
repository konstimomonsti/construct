# Evaluation: proof on bills of quantities with known errors

How we show that the error detection works: take a clean synthetic bill of quantities, plant one known
error per file, run the analysis, and count what it caught, missed and falsely raised. The plan is
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) section 5; the code is in `analysis/eval/`.

This is measured on a synthetic seed, not on real tenders. Read the numbers as "the rules do what they
claim on errors they are meant to find" and "nothing else fires on harmless edits". They are not an accuracy
estimate for real files; for that see [Next steps](#next-steps).

## 1. Run it

```powershell
python -m analysis.eval mutate          # plant errors in the seed: eval_out/mutated/*.X83 and *.json, plus labels
python -m analysis.eval run             # analyse every file (layers 1,2), store the findings in eval_out/results/
python -m analysis.eval report          # recall per mutation type, controls, precision per rule, gaps
python -m analysis.eval fp              # only the controls and the clean seed; exit code 1 on any false alarm
python -m analysis.eval label-template Data/some_file.X83     # CSV skeleton to label real findings by hand
```

`mutate` takes `--seed N` (which lines get picked; default 1), `--per-type N` (instances of each
line-level type, default 3), `--backend x83|json|both`, `--only QTY,L2-REMOVE` and `--no-demo`. The same
seed gives byte-identical files. `run --layers 1,2,3` adds layer 3, which needs a model; if it cannot run,
labels that only layer 3 can catch are reported as "not run", not as missed. `report --backend x83` shows one
format only. `eval_out/` is git-ignored.

The whole run takes about 15 seconds. Tests: `python -m pytest analysis/tests/test_eval.py`.

## 2. What is in the package

| Part | What it does |
|---|---|
| `seeds/building_hall.json` | The clean seed: 60 hand-written German lines for a training hall with an office wing (earthworks, concrete, screed, drywall, painting, flat roof), priced, with subtotals. `seeds/make_building_hall.py` regenerates it, so the amounts cannot drift. |
| `gaeb_writer.py` | Exports a seed document as GAEB DA XML 3.3, phase 83 (X83). The importer reads it back to the same document (tested). Not validated against the GAEB XSD, which is not in the repo. |
| `mutate.py`, `catalogue.py`, `ops.py` | The mutator. A mutation is a list of backend-independent operations. The **JSON backend** edits the document, the **X83 backend** edits the XML tree with lxml. |
| `labels.py` | Label schema `construct-eval-labels/1`, matching, the template for real-file labels. |
| `harness.py`, `report.py`, `cli.py` | `run`, `fp`, `report`. |

The clean seed gives **0 findings** from layers 1 and 2. Every layer 2 dependency of the five trades (16 of
them) is named by exactly one line, so removing that line must make the check fire. No short text names a
trigger of another trade and no long text names a dependency, so a planted change has no side effects.

### The read-back check

Every file is parsed again after it is written, with the real importer (X83) or the adapter (JSON), and
compared with the seed. The whole `mutate` run fails unless

1. the result equals the seed with exactly the planned operations applied;
2. the planted change is visible in the parsed document;
3. everything else that differs is plain arithmetic that follows from the change: the line amount after a
   quantity change, and the subtotals and net total above it. A quantity change in a priced file also updates
   the amounts, as an estimator's software would, so only the planted error is present.

Whitespace controls must not change the parsed document at all. A dependency is removed only if no remaining
text still names it, and a quantity is cut only if the result falls below the 90% tolerance. Layer 1 mutations
avoid lines that layer 2 reads, so a quantity change cannot trigger a dependency finding as a side effect.

### Labels

Every mutated file `X.X83` has `X.X83.labels.json`:

```json
{"schema": "construct-eval-labels/1", "file": "QTY-ZERO-01.X83", "baseline": "building_hall_clean.X83",
 "labels": [{"id": "QTY-ZERO-01/1", "mutation_type": "QTY-ZERO",
             "target": {"line_codes": ["05.02.0040"]}, "expect": ["L1.QTY.ZERO"], "match": "line",
             "also_acceptable": [], "gap": false, "control": false, "layers": [1], "note": ""}]}
```

Labels key on the OZ (`line_code`), the section code, or the trigger codes of a layer 2 check, **never on
finding ids**, because those are hashes of the file content and change with every mutation.

- `expect`: rule ids, fnmatch patterns allowed. `match`: `line`, `section`, `dependency` (a layer 2 finding
  whose trigger items share an OZ with the target) or `bom`.
- `also_acceptable`: rules that may appear as a consequence of the change. A line amount broken on its own
  also makes the subtotals disagree; that is correct and counts as neither a catch nor a false alarm.
- `gap`: nothing detects this yet (see below). `control`: nothing may be reported.
- `layers`: derived from `expect`. A label whose layers did not run is **not run**, never missed.

### How a file is scored

1. The baseline (the clean seed in the same format) is analysed and its findings are subtracted.
2. A new finding that a label expects on its target is a **catch**.
3. A new finding listed in `also_acceptable` is a consequence. Any other new finding is a **false alarm**; on a
   control file that is every new finding.
4. Recall per mutation type is caught / (labels - not run). Precision per rule is correct / (correct + false alarms).

## 3. Current results

Seed `building_hall.json`, mutator seed 1, 3 instances per line-level type, X83 files, layers 1 and 2. The JSON
backend gives the same outcome for every mutation (`report --backend json`). Layer 3 was not run.

| Mutation | Expected | n | Caught | Missed | Gap | Not run | Recall |
|:---|:---|---:|---:|---:|---:|---:|---:|
| Quantity 0 on a priced line | `L1.QTY.ZERO` | 3 | 3 | 0 | 0 | 0 | 100% |
| Quantity missing | `L1.QTY.MISSING` | 3 | 3 | 0 | 0 | 0 | 100% |
| Negative quantity | `L1.QTY.NEGATIVE` | 3 | 3 | 0 | 0 | 0 | 100% |
| Fractional piece count | `L1.QTY.FRACTIONAL_COUNT` | 3 | 3 | 0 | 0 | 0 | 100% |
| Lump sum with quantity 3 | `L1.LUMP.INCONSISTENT` | 3 | 3 | 0 | 0 | 0 | 100% |
| Unit missing | `L1.UNIT.MISSING` | 3 | 3 | 0 | 0 | 0 | 100% |
| Unknown unit | `L1.UNIT.UNKNOWN` | 3 | 3 | 0 | 0 | 0 | 100% |
| Wrong dimension against 'Abrechnung nach' | `L1.UNIT.TEXT_MISMATCH` | 3 | 3 | 0 | 0 | 0 | 100% |
| Exact duplicate, new OZ | `L1.DUP.SUSPECTED` | 3 | 3 | 0 | 0 | 0 | 100% |
| Exact duplicate, same OZ | `L1.CODE.DUPLICATE` | 3 | 3 | 0 | 0 | 0 | 100% |
| Reworded duplicate (gap) | `gap: no similarity rule` | 3 | 0 | 0 | 3 | 0 | 0% |
| Typo in the short text (gap) | `gap: L1.TEXT.TYPO planned` | 3 | 0 | 0 | 3 | 0 | 0% |
| Vague item 'nach Aufwand' (gap) | `gap: L1.TEXT.SPEC_PLACEHOLDER planned` | 3 | 0 | 0 | 3 | 0 | 0% |
| Concrete class differs in the long text (gap) | `gap: L1.TEXT.VALUE_CONFLICT planned / L3` | 3 | 0 | 0 | 3 | 0 | 0% |
| DN differs in the long text (gap) | `gap: L1.TEXT.VALUE_CONFLICT planned / L3` | 1 | 0 | 0 | 1 | 0 | 0% |
| Dependency removed | `L2.<GROUP>_NEEDS_<DEP>` | 16 | 16 | 0 | 0 | 0 | 100% |
| Dependency quantity cut by 50% | `L2.<GROUP>_NEEDS_<DEP>` | 7 | 7 | 0 | 0 | 0 | 100% |
| Dependency declared 'bauseits' | `L2.<GROUP>_NEEDS_<DEP>` | 16 | 16 | 0 | 0 | 0 | 100% |
| Line amount broken | `L1.ARITH.LINE_AMOUNT` | 3 | 3 | 0 | 0 | 0 | 100% |
| Section subtotal broken | `L1.ARITH.SECTION_TOTAL` | 3 | 3 | 0 | 0 | 0 | 100% |
| Net total broken | `L1.ARITH.NET_TOTAL` | 1 | 1 | 0 | 0 | 0 | 100% |
| **All planted errors** |  | 89 | 76 | 0 | 13 | 0 | 85% |
| **Excluding the known gaps** |  | 76 | 76 | 0 | 0 | 0 | 100% |

Controls: the changes that must produce nothing.

| Control | Files | Clean | False alarms |
|:---|---:|---:|---:|
| Control: the clean seed | 1 | 1 | 0 |
| Control: dependency moved inline | 9 | 9 | 0 |
| Control: items reordered | 3 | 3 | 0 |
| Control: whitespace changed | 3 | 3 | 0 |
| Control: +5% on an unrelated line | 3 | 3 | 0 |

Precision per rule, on the findings that the planted changes caused. The clean seed and all controls give zero
false alarms, so no rule has any:

| Rule | Correct | False alarm | Consequence | Precision |
|:---|---:|---:|---:|---:|
| `L1.ARITH.LINE_AMOUNT` | 3 | 0 | 0 | 100% |
| `L1.ARITH.NET_TOTAL` | 1 | 0 | 3 | 100% |
| `L1.ARITH.SECTION_TOTAL` | 3 | 0 | 6 | 100% |
| `L1.CODE.DUPLICATE` | 3 | 0 | 0 | 100% |
| `L1.DUP.SUSPECTED` | 3 | 0 | 3 | 100% |
| `L1.LUMP.INCONSISTENT` | 3 | 0 | 0 | 100% |
| `L1.QTY.FRACTIONAL_COUNT` | 3 | 0 | 0 | 100% |
| `L1.QTY.MISSING` | 3 | 0 | 0 | 100% |
| `L1.QTY.NEGATIVE` | 3 | 0 | 0 | 100% |
| `L1.QTY.ZERO` | 3 | 0 | 0 | 100% |
| `L1.UNIT.MISSING` | 3 | 0 | 0 | 100% |
| `L1.UNIT.TEXT_MISMATCH` | 3 | 0 | 3 | 100% |
| `L1.UNIT.UNKNOWN` | 3 | 0 | 0 | 100% |
| `L2.CONCRETE.STRUCTURE_NEEDS_CLEAN_LAYER` | 2 | 0 | 0 | 100% |
| `L2.CONCRETE.STRUCTURE_NEEDS_FORMWORK` | 2 | 0 | 0 | 100% |
| `L2.CONCRETE.STRUCTURE_NEEDS_REINFORCEMENT_STEEL` | 2 | 0 | 0 | 100% |
| `L2.DRYWALL.PARTITION_NEEDS_EDGE_PROTECTION` | 2 | 0 | 0 | 100% |
| `L2.DRYWALL.PARTITION_NEEDS_INSULATION_AND_ACOUSTICS` | 3 | 0 | 0 | 100% |
| `L2.DRYWALL.PARTITION_NEEDS_JOINT_FILLING` | 3 | 0 | 0 | 100% |
| `L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION` | 2 | 0 | 0 | 100% |
| `L2.FLOOR.SCREED_NEEDS_FLOOR_COVERING` | 3 | 0 | 0 | 100% |
| `L2.FLOOR.SCREED_NEEDS_PRIMER_AND_LEVELING` | 3 | 0 | 0 | 100% |
| `L2.FLOOR.SCREED_NEEDS_SKIRTING` | 2 | 0 | 0 | 100% |
| `L2.FLOOR.SCREED_NEEDS_UNDERLAYS_AND_INSULATION` | 2 | 0 | 0 | 100% |
| `L2.PAINT.COATING_NEEDS_MASKING_AND_PROTECTION` | 2 | 0 | 0 | 100% |
| `L2.PAINT.COATING_NEEDS_SURFACE_PREPARATION_AND_PRIMER` | 3 | 0 | 0 | 100% |
| `L2.ROOF.WATERPROOFING_NEEDS_ROOF_DRAINAGE` | 2 | 0 | 0 | 100% |
| `L2.ROOF.WATERPROOFING_NEEDS_THERMAL_INSULATION` | 3 | 0 | 0 | 100% |
| `L2.ROOF.WATERPROOFING_NEEDS_VAPOR_BARRIER` | 3 | 0 | 0 | 100% |

*Consequence*: findings the label lists as an acceptable result of the change, for example a subtotal that no
longer matches a changed line amount.

### Honest reading

- **100% excluding gaps is by construction.** Each mutation is designed to be applicable to the rule it targets
  (that is what the applicability checks do), and the seed is written to satisfy the layer 2 regexes. The table
  proves that the rules fire on what they claim, that the importer and writer keep the planted change intact, and
  that nothing fires on harmless edits. It does not show how the rules do on the variety of real tenders.
- **85% overall is the honest headline**, because the five gap types are errors a cost estimator would want
  flagged and the tool does not find today.

### Known gaps

These are planted and labelled with the rule that should catch them once it exists, so they turn from "gap"
to "caught" when someone builds the rule. They are not left out of the table.

| Gap | Planted as | Rule that should catch it |
|---|---|---|
| Reworded duplicate | the same line under a new OZ with synonyms in both texts | none yet (`L1.DUP.*`) |
| Typo | two letters swapped in a long word of the short text | `L1.TEXT.TYPO` (plan §2.3) |
| Vague item | a new lump-sum line "Zusätzliche Leistungen nach Aufwand" | `L1.TEXT.SPEC_PLACEHOLDER`, kind `open_quantity_basis` (plan §2.2) |
| Concrete class differs | the class in the long text changed (C30/37 in the short text, C20/25 in the long text) | `L1.TEXT.VALUE_CONFLICT` (plan §2.1), or `L3.TEXT.SHORT_LONG_CONTRADICTION` with a model |
| DN differs | "DN 100" in the short text, "DN 70" in the long text | same |

For the last two, the label lists both rules and layers 1 and 3, so a layer 1 run reports a gap (the layer 1
rule does not exist yet) and not "not run".

## 4. The three-minute demo

1. **A subtotal off by exactly 982.20 EUR.** `python -m analysis run Data/StBALV23040.D86` (a confidential file,
   show it locally only). The finding points at the damaged OZ.
2. **38 priced change-order items with quantity 0.** `python -m analysis run "Data/[ORT_024] LV24069.D86"`.
3. **A building with planted errors.** `python -m analysis.eval mutate`, then
   `python -m analysis run eval_out/demo/building_hall_planted.X83`: missing edge insulation
   (`L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION`), a duplicate (`L1.DUP.SUSPECTED`) and a quantity 0
   (`L1.QTY.ZERO`). The same building with nothing planted, `eval_out/mutated/building_hall_clean.X83`, gives no findings.
4. **The evaluation table.** `python -m analysis.eval run`, then `report`: recall per mutation type, no false
   alarms on the controls, and the five gaps in the open.
5. **Nothing is changed automatically.** Every finding is a proposal; the person accepts or rejects it.

Only the synthetic seed may ever be sent to an API model. Files in `Data/` are confidential: never copy a
mutated `Data/` file into the repository (`eval_out/` is ignored for that reason).

## 5. Adding a mutation

Add a `MutationType` to `TYPES` in `catalogue.py` with a planner that yields `Plan`s: operations (see `ops.py`)
plus `label(...)`. Use `derive(...)` to recompute amounts and totals after a planted change. If no rule catches
it yet, set `gap=True`; if nothing may be reported, set `control=True`. `mutate` refuses to write a file whose
read-back does not match.

## Next steps

Out of scope for this first version:

- **Labels for real files** (`analysis/eval/labels/real_findings.csv`). `python -m analysis.eval label-template
  Data/<file>` prints a CSV skeleton with one row per (file, rule) group. A person fills in `verdict` as
  `true_error | false_alarm | importer_artefact | unsure`; `finding_id` `*` labels the whole group, so about 15
  rows cover today's 140 errors and warnings. The `.gitignore` already allows `analysis/eval/labels/*.csv`.
  Precision per rule on real files needs this, and `report` does not read it yet.
- **Layer 3 cases**: export the mutated lines as layer 3 test cases (`analysis/layer3/eval_cases.json`) and run
  `run --layers 1,2,3` with a model. Only the synthetic seed may go to an API model.
- A priced X83 from a real source (Dangl "Neubau Sportheim", the BVBS test files, already in `test-data/`) as a
  second seed, to check the mutator on a file whose structure it did not write.
- Validate the `gaeb_writer.py` output against the GAEB XSD.
