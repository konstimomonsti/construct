# Task 08 (queued; task 03's author is best placed): Calibrate the risk score and money at stake

**Branch:** `feat/task-08` · **Recommended model:** Sonnet (Claude Sonnet 5.5)

## Problem (measured by the lead on `main` after wave 1, layers 1–2)

The score saturates, so it can't tell files apart, and every real tender looks "critical" in the demo:

| File | Findings | Signals | S (points) | Score | Level | Money at stake |
|---|---:|---:|---:|---:|---|---:|
| `backend/analysis/eval/seeds/building_hall.json` (**clean** seed) | 0 | 9 | 80 | 67 | high | 85,920 € |
| `data/demo/building_hall_planted.X83` (4 planted errors) | 7 | 11 | 163 | 80 | critical | 107,785 € |
| `backend/analysis/tests/fixtures/lv11_precast.json` | 13 | 7 | 38 | 49 | medium | – |
| `data/tenders/8209.003_Leistungsverzeichnis_leer.X83` | 83 | 32 | 210 | 84 | critical | – |
| `data/tenders/StBALV23040.D86` (net ≈ 897 k€) | 45 | 83 | — | 94 | critical | 446,582 € |
| `data/tenders/[ORT_024] LV24069.D86` | 154 | 31 | 673 | 94 | critical | 250,683 € |

Causes:
1. `SCALE = 40` is fixed (`backend/analysis/risk/score.py`), but S grows with tender size: 600+ points on a big LV.
2. Change-order signals dominate (443 of S on StBALV23040), and a clean file collects 80 points from wording alone.
3. `money_at_stake` adds the **full** line amount of every line with any open item. Half the tender is "at stake",
   while the archived plan's worked example estimates about 53 k€ (6 %) for StBALV23040.

## Objective

Make the score and the money figure mean something in the demo, **without changing the contract** (CLAUDE.md §5.4).
`scale` is already a field the UI reads, so it may vary per report, and `points` keep their meaning.

1. **Size-aware scale:** for example `scale = 40 + k × measured_lines`, or score by density. Pick it so that:
   the clean building hall is **low** (< 25), the planted building hall is **at least medium and ≥ 15 points above the
   clean one**, LV_11 is medium, and real tenders spread across medium/high/critical instead of all scoring 94.
2. **Signal weights:** cap the points per signal family per section (as archived plan §3 suggests: strongest signal per
   family), so wording alone can't make a file "high".
3. **Expected money at stake:** amount × likelihood × impact (plan §3, `EV = E·p·k`), not the full amount. Keep
   `amount` on `top_risks` as the full exposure if you want, but `money_at_stake` becomes the expected value. Say so in
   `docs/RISK.md` and in the UI tooltip text (ask the lead to forward the wording to the frontend owner).
4. Add a golden test with the table above as assertions (ranges, not exact numbers), so the calibration can't drift.

## Files you MAY create or modify (strict allowlist)

- `backend/analysis/risk/score.py`, `backend/analysis/risk/signals.py`
- `backend/analysis/tests/test_risk.py`, new `backend/analysis/tests/test_risk_calibration.py`
- `docs/RISK.md`
- this task file (notes) and your row in `STATUS.md`

## Read-only references

- `CLAUDE.md` §5.4, `docs/archive/NEXT_FEATURES_IMPLEMENTATION_PLAN.md` §3 (risk-v1 model, worked example, calibration notes)
- `frontend/src/lib/risk-assessment.ts` (`rescore()`: it must keep matching the backend formula)

## Acceptance criteria

1. The table above, re-run, meets the targets in step 1. Paste the new table into the notes.
2. `rescore()` in the frontend still reproduces `risk.score` when no decisions exist (same formula, scale from the report).
3. `python -m pytest -q backend/analysis/tests` is green.

## Notes / blockers (fill in)

-
