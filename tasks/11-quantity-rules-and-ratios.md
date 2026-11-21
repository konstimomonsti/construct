# Task 11: Unusual-quantity rules and layer 2 ratio checks

**Branch:** `feat/task-11` · **Recommended model:** Sonnet-class (Claude Sonnet 5.5, or the strongest ChatGPT/Codex coding model)

## Objective

Catch the quantity problems that lead to change orders under VOB/B §2(3) (quantities that differ by more than 10 %),
deterministically and with negative tests. The design is in [archived plan §3](../docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md)
("Unusual quantities").

## Rules to add (P0 first)

| P | Rule ID | Severity | What it detects |
|---|---|---|---|
| P0 | `L1.QTY.PLACEHOLDER` | warning | Quantity exactly 1 in a measured unit (m, m², m³, t, h) on an item that is **not** a lump sum. Typical "insert quantity later" placeholder. Skip `Zulage`, unit-price-only items and alternatives. |
| P0 | `L1.QTY.ROUND_SHARE` | info | Section with ≥ 5 measured lines where > 60 % of quantities are round (multiples of 10/50/100 for m/m², whole numbers for m³ ≥ 50). Quantities look estimated. Use one finding per section. |
| P0 | `L1.UNIT.CROSS_SECTION_MISMATCH` | warning | The same work (same normalised short text) is measured in different units in different sections (e.g. "Warnleuchte vorhalten" in StWo in one and in Std in another). |
| P1 | `L1.QTY.IMPLIED_DURATION` | warning | Rental/standby lines (vorhalten, Vorhaltung, je Woche/Tag/Monat) whose quantity divided by the matching set-up line's quantity gives durations that disagree by > 25 % across the LV (plan: 28 weeks vs 20 weeks vs 50 days in StBALV23040). Report the computed durations in `evidence`. |
| P1 | `L1.QTY.SURCHARGE_EXCEEDS_BASE` | warning | A Zulage that names its base OZ explicitly ("Zulage zu Pos. 02.01.0010") has a larger quantity than that base (same dimension). |
| P1 | `L1.QTY.UNIT_OUTLIER` | info | Robust z-score (median/MAD) of log quantity within the same unit and item family in one LV, \|z\| > 3.5, families with ≥ 5 lines. |
| P0 | Layer 2 check type `Ratio` | warning | New `CheckType: "Ratio"` in `layer2/schema.py` and `engine.py`: the dependency quantity must stay within `[MinRatio, MaxRatio]` × the trigger quantity, after unit conversion. Add rules to `rules.json`: backfill ≤ 1.0 × excavation (m³); screed edge strip ≥ 0.3 m per m² of screed area (rough perimeter); floor finish ≤ 1.05 × screed area; pipe bedding ≈ pipe length (0.9–1.1, m). Rule IDs follow the existing pattern `L2.<GROUP>_NEEDS_<DEP>` / new `L2.<GROUP>.RATIO_<DEP>`. |

Every finding that a client should clarify sets `evidence.bieterfrage_de` (formal German, `Zu Pos. {oz}: …`).
Quantity findings set `evidence.change_order = true` (CLAUDE.md §5.2), so the risk score weights them.

## Files you MAY create or modify (strict allowlist)

- `backend/analysis/layer1/__init__.py`: only the import line for the new module
- `backend/analysis/layer1/quantities.py` (new)
- `backend/analysis/layer2/schema.py`, `backend/analysis/layer2/engine.py`, `backend/analysis/layer2/rules.json`
- `backend/analysis/tests/test_layer1_quantities.py`, `backend/analysis/tests/test_layer2_ratio.py` (new); `backend/analysis/tests/test_layer2.py` only for hard-coded rule counts
- `docs/ANALYSIS_CONTRACT.md` (§7 rule catalogue), `docs/DEPENDENCY_VALIDATOR.md` (the `Ratio` type)
- this task file (notes) and your row in `STATUS.md`

**Not yours:** `layer1/pricing.py` (task 12), `analysis/risk/*` (task 08), `analysis/eval/*`.

## Read-only references

- `CLAUDE.md` §5.1–5.3, `backend/analysis/units.py` (`convert`, dimensions)
- `backend/analysis/layer1/consistency.py`, `din.py` (style, phase-dependent severity), `backend/analysis/layer2/engine.py` (`QuantityMatch` as the model for `Ratio`)
- `docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md` §3 (counts measured on `data/tenders/`)

## Acceptance criteria

1. Each rule has a positive and a negative test. The `Ratio` engine has tests for in-range, out-of-range, unit conversion and "not assessable".
2. Run on `data/tenders/StBALV23040.D86`, `[ORT_024] LV24069.D86`, `501-24-01_GAEB-XML_sas.x83` and
   `8209.003_Leistungsverzeichnis_leer.X83`, and paste counts per new rule in the notes. Tighten any rule with more than ~20
   findings on one file. `IMPLIED_DURATION` should reproduce the plan's StBALV23040 example.
3. `python -m analysis.eval fp` still exits 0 (no new false alarms on the clean seeds and controls). If a clean seed now fires
   a correct finding, say so in the notes. Don't edit the seeds (ask the lead).
4. `PYTHONPATH=backend:backend/importer python -m pytest -q backend/analysis/tests` is green.

## Notes / blockers (fill in)

-
