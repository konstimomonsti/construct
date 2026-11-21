# Task 01: Deterministic DIN 1045-2, precast and text-defect rules (layers 1 and 2)

**Branch:** `feat/task-01` · **Recommended model:** Sonnet-class (Claude Sonnet 5.5, or the strongest ChatGPT/Codex coding model)

## Objective

Make the analysis catch, **without an LLM**, the errors described in Biel's spec
([docs/lv_hybrid_validation_implementation_guide.md](../docs/lv_hybrid_validation_implementation_guide.md), Step 3)
and in the archived plan §2.1–2.2, as layer 1 rules and a layer 2 rule group inside `backend/analysis`.
Today the LV_11 fixture yields 0 findings. When you're done it must light up.

## Rules to add (priority order: do P0 first, then P1)

| P | Rule ID | Severity | What it detects |
|---|---|---|---|
| P0 | `L1.DIN.EXPOSURE_STRENGTH` | error | Concrete grade below the DIN 1045-2 minimum for a stated exposure class (for example `C20/25` with `XF2`). Use the matrix in the spec §3A (`strength_rank`, `exposure_min_strength`). Parse `C 35/45`, `C35/45`, `LC…`, and exposure codes `XC1-4, XD1-3, XS1-3, XF1-4, XA1-3, XM1-3, WO/WF/WA/WS`. |
| P0 | `L1.DIN.UNKNOWN_GRADE` | warning | A concrete grade is stated but isn't in the rank table. |
| P0 | `L1.DIN.NOTE` | info | Special notes per exposure: XF2/XF4 (air-entrained concrete, LP-Beton), WA (alkali guideline). Use one finding per line, with the discriminator set to the exposure code. |
| P0 | `L1.PRECAST.LAYER_SUM` | error | Sandwich element: facing shell + insulation + structural shell ≠ total thickness (tolerance 0.1 cm). Parse `Dicke Vorsatzschale: 7 cm`, `Dicke Tragschale: 15 cm`, `Dämmschicht: … d= 8 cm`, `d=30cm gesamt`. |
| P0 | `L1.UNIT.TRADE_MISMATCH` | warning | Unit not plausible for the item type (spec `vob_units.json`). Classify the item type by regex: sandwich/FT-Sockel → `ea, m², m`; Betonstahl → `t, kg`; Zulage Aussparung/Öffnung → `ea`; Halfen/Ankerschiene/Einbauteil → `ea, m`; Werkstatt-/Montagepläne → `lump_sum, h`. On LV_11 it must fire on 3.2.80 (`m`). |
| P0 | `L1.TEXT.SPEC_PLACEHOLDER` | warning | A product or value left open: anonymization tokens like `[FIRMA_095]` or `[KENNZEICHEN_005]` **inside a line's short or long text**, values left as dashes or dots (`Widerstandsklasse: ---`, `Fabrikat: ……`), `XXX`. Use `evidence.kind = placeholder`. Skip empty bidder fields, which `L1.TEXT.BIDDER_INPUT` already reports (`consistency.py`). |
| P0 | `L1.TEXT.UNCLEAR_DIMENSION` | warning | Question marks or conflicting numbers inside a dimension (`d=? 30cm`, `l=?`). |
| P0 | `L1.TEXT.VALUE_CONFLICT` | warning/info | Short text and long text state values of the same family and share none. Families: DN, concrete class, fire rating, IP rating, board type, length `l=`, thickness `d=`. The full design is in [archived plan §2.1](../docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md). Use warning for concrete, fire rating and board, info for DN. |
| P1 | `L1.TEXT.REFERENCE_UNRESOLVED` | warning | "siehe Pos. 6.1.80" when that OZ doesn't exist, or a "wie vor" with nothing before it (archived plan §2.2). |
| P1 | `L1.TEXT.SPEC_ATTRIBUTE_MISSING` | info | A table of item type → required attributes (pipe needs DN or a size, cable needs a cross-section, in-situ concrete needs a class, screed needs a thickness, insulation needs a thickness, door needs a size), §2.2. |
| P1 | `L2.PRECAST.*` group in `layer2/rules.json` | warning/info | Precast elements (Fertigteil, Sandwich, FT-) need: shop drawings (Werkstatt-/Montagepläne), transport and assembly (unless the text says `einschl. Transport und Montage`), joint sealing (Fugen), anchors / embedded parts. Follow the existing JSON format. |

Every finding sets `evidence.bieterfrage_de` (formal German, starting `Zu Pos. {oz}: …`) when a client question makes
sense. Templates are in the spec §3A. DIN findings also set `evidence.din`. See CLAUDE.md §5.2.

Severity depends on the document phase (`project.gaeb_phase`) the way the existing rules do it. Look at
`consistency.py`.

## Files you MAY create or modify (strict allowlist)

- `backend/analysis/layer1/__init__.py`: **only** the import line that registers your new modules
- `backend/analysis/layer1/din.py` (new): DIN rules and tables as Python constants. **No new JSON or
  package data**, because `pyproject.toml` isn't yours.
- `backend/analysis/layer1/precast.py` (new): `LAYER_SUM`, `TRADE_MISMATCH`, item-type classifier
- `backend/analysis/layer1/text_defects.py` (new): `SPEC_PLACEHOLDER`, `UNCLEAR_DIMENSION`, `VALUE_CONFLICT`, `REFERENCE_UNRESOLVED`, `SPEC_ATTRIBUTE_MISSING`
- `backend/analysis/layer1/textvalues.py` (new): shared value extractors (DN, concrete class, thickness …)
- `backend/analysis/layer2/rules.json`: add groups only. Also add `messung|\w*feuchte|belegreife` to the screed `ExcludeRegex`.
- `backend/analysis/tests/test_layer1_din.py`, `test_layer1_precast.py`, `test_layer1_text_defects.py`, `test_layer2_precast.py` (new)
- `docs/ANALYSIS_CONTRACT.md`: §7 rule catalogue only (add your rules)
- `docs/DEPENDENCY_VALIDATOR.md`: document the new layer 2 group
- `tasks/01-deterministic-din-precast-rules.md` (this file, notes section) and your row in `STATUS.md`

## Read-only references

- `CLAUDE.md` (contracts §5.1–5.3), `backend/analysis/contracts.py`, `registry.py`, `units.py`
- `backend/analysis/layer1/consistency.py`, `text_quality.py`, `common.py` (style, severity by phase)
- `backend/analysis/layer2/engine.py`, `rules.json`, `backend/analysis/tests/test_layer1.py`, `test_layer2.py`
- `backend/analysis/tests/fixtures/lv11_precast.json` (the LV_11 golden input, 9 lines)
- `docs/lv_hybrid_validation_implementation_guide.md` §3, §6.1 (expected results table)
- `docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md` §2.1, §2.2

## Acceptance criteria

1. On `lv11_precast.json` (`python -m analysis run backend/analysis/tests/fixtures/lv11_precast.json --layers 1,2`):
   - `L1.DIN.NOTE` for XF2 and WA on 3.2.20–3.2.60, and **no** `L1.DIN.EXPOSURE_STRENGTH` (C35/45 satisfies XC2/XF2);
   - **no** `L1.PRECAST.LAYER_SUM` (7 + 8 + 15 = 30);
   - `L1.UNIT.TRADE_MISMATCH` on 3.2.80;
   - `L1.TEXT.SPEC_PLACEHOLDER` on 3.2.80 and 3.2.90.
2. Negative tests on synthetic copies: `C20/25` + `XF2` gives `EXPOSURE_STRENGTH`, insulation 10 cm gives `LAYER_SUM`,
   "C20/25" in the short text with "C25/30" in the long text gives `VALUE_CONFLICT`.
3. Each new rule has at least one positive and one negative test. `python -m pytest -q backend/analysis/tests` is green
   (197+ passing today).
4. Run `python -m analysis run` on 3 real GAEB files (for example `data/tenders/StBALV23040.D86`,
   `data/tenders/501-24-01_GAEB-XML_sas.x83`, `data/tenders/8209.003_Leistungsverzeichnis_leer.X83`) and write the
   count of new findings per rule in the notes below. Spot-check for false alarms and tighten the regexes when one
   rule produces more than ~20 findings on a single file.
5. `python -m analysis rules` lists every new rule with a title and description.

## Notes / blockers (fill in)

- Implemented all ten layer-1 rules and four `L2.PRECAST.ELEMENTS_NEEDS_*` checks, without dependencies or automatic edits. P0 was implemented before the P1 dependency group.
- Scope exception approved explicitly by the user in chat: update only the hard-coded group/check counts in `backend/analysis/tests/test_layer2.py` (16 / 50), and add precast German question evidence in `backend/analysis/layer2/engine.py`. No other out-of-allowlist edits.
- LV_11: 13 findings (10 DIN notes: XF2 and WA on 3.2.20–60; one trade-unit warning on 3.2.80; two placeholders on 3.2.80/90). No strength, layer-sum or dependency errors. Synthetic C20/25 + XF2, 10 cm insulation and conflicting concrete classes are tested.
- Real-file CLI validation (`--layers 1,2`): counts below are new rules only; every omitted rule is zero. No analysis execution errors.

  | Rule | StBALV23040.D86 | 501-24-01_GAEB-XML_sas.x83 | 8209.003_Leistungsverzeichnis_leer.X83 |
  |---|---:|---:|---:|
  | L1.DIN.UNKNOWN_GRADE | 1 | 1 | 0 |
  | L1.DIN.NOTE | 3 | 0 | 0 |
  | L1.TEXT.SPEC_PLACEHOLDER | 0 | 16 | 11 |
  | L1.TEXT.VALUE_CONFLICT | 4 | 1 | 2 |
  | L1.TEXT.SPEC_ATTRIBUTE_MISSING | 2 | 0 | 0 |

- False-positive review: broad redactions initially produced 54/147/72 placeholder findings. Restricted the pattern to product/value identifiers rather than PERSON/ORT/contact redactions; excluded identified bidder blanks, including “oder gleichwertig” fields. Checked remaining product examples. Tightened item classification to avoid trench, marking and ancillary work; recognized pipe outside diameters. Two remaining attribute infos concern temporary power cables without a cross-section. Prevented DIN notes from matching embedded image data without a concrete grade, and “wie vor” warnings from component lists within an item. Standard drainage precast structures are excluded from the structural dependency group, preserving existing real-file regression tests.
- Limits: only the supplied DIN rank/minimum tables are used; XA/XM have no invented minima, LC grades are unknown, and multi-grade items are not assigned ambiguous exposure-strength pairs. Attribute checks are conservative and inherit previous base items and section titles; the input contract has no section-note text. Named prose references are not resolved semantically. Dependency presence uses the existing engine scope, not per-element allocation. These limitations do not change the shared contracts.
- Blockers / requests: the two code-scope blockers were resolved by user approval. Team-chat destination was requested but has not been supplied; blockers were reported immediately in the working chat. Validation and PR status are recorded below.
- Validation: `PYTHONPATH=backend;backend/importer python -m pytest -q backend/analysis/tests` (PowerShell equivalent): **259 passed, 3 skipped, 66 subtests passed**. Used the pre-existing Python virtual environment from the sibling checkout, with imports pointing at this repository; installed no dependencies. `python -m analysis rules` lists all 14 new rules with nonempty titles/descriptions. `git diff --check` passed. Fetched and merged `origin/main` before final verification (already up to date).
- Published branch `feat/task-01`; [PR #8](https://github.com/konstimomonsti/construct/pull/8) is open against `main`. No push to `main`.
