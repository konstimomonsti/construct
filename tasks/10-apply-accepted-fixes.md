# Task 10: Apply accepted fixes (reviewed, undoable, original kept)

**Branch:** `feat/task-10` · **Recommended model:** Sonnet (Claude Sonnet 5.5)

## Objective

Close the loop "error found → reviewer approves → list corrected". Many findings carry a `suggested_fix`: a list of
operations (CLAUDE.md §5.1, `backend/analysis/contracts.py`: `set_field`, `add_line`, `remove_line`, `merge_lines`,
`link_alternative`). Today the UI only shows the fix's rationale. Let the reviewer **apply** it with one click, as
tracked edits that can be undone, and optionally save the corrected result as a **new list version** next to the
original. **Nothing is ever applied without a click.** The uploaded original file always stays unchanged.

## What to build

1. **`frontend/src/lib/apply-fix.ts`** (new), pure and unit-tested:
   - `planFix(finding, list) → { steps: Step[]; skipped: { op; reason }[] }` maps operations onto the existing edit
     model (`ListEdits` in `lib/store.ts`):
     - `set_field quantity` → `setQty`; `unit_price` → `setUp`; `unit` / `short_text` / `long_text` → `patchPosition`
       (`unit` / `short` / `long`);
     - `add_line` → `addPosition` (new id, placed in `section_id` / after `after_line_id`);
     - `remove_line` → `removePositions`; `merge_lines` → `removePositions(remove_line_ids)` plus `setQty(keep, new_quantity)`;
     - `link_alternative`, `pricing_basis`, `total_rule`, `alternative_for` → skipped with a reason (the list model has no
       field for them yet).
   - **Units:** fixes use canonical units (`ea`, `m`, `m²`, `m³`, `t`, `kg`, `h`, `lump_sum`; see `backend/analysis/units.py`).
     Map them back to the list's notation (St, m, m2, m3, t, kg, h, psch), matching what the list already uses.
   - Refuse (skip with a reason) when the position no longer matches the fix's `old_value`, which means the user changed it since.
2. **Drawer UI:** on a finding with a non-empty, applicable fix, show **"Apply fix"** with a one-line preview of each step
   ("Unit m → St", "Add position: Randdämmstreifen, 120 m") and the skipped ones. Applying it:
   - takes an undo snapshot (`setEdits` pattern already used by the list page), then runs the steps;
   - records the decision as accepted with `applied: <ISO time>` (an **optional** new field on `Decision`, §5.5; keep
     everything else in the decision shape unchanged);
   - shows "Applied · Undo". Undo restores the snapshot and clears `applied` (the decision stays accepted).
3. **"Save corrected version":** in the list's actions, creates a new list (`addList`) in the same folder named
   "<title> (korrigiert)", containing the resolved positions with all applied fixes, linked to the source list (store the
   source list id in the new list's patch). The original list and its file stay untouched.
4. After applying, the list is re-assessed, or the findings show as changed/outdated the way edits already do
   (`changedFindings` in `ListPage.tsx`). Check which happens and make sure the UI doesn't show a fixed finding as still open.

## Files you MAY create or modify (strict allowlist)

- `frontend/src/lib/apply-fix.ts` (new), `frontend/tests/apply-fix.test.ts` (new)
- `frontend/src/pages/ListPage.tsx`, `frontend/src/components/DetailDrawer.tsx`, `frontend/src/components/RiskAssessment.tsx`
- `frontend/src/lib/store.ts` and `frontend/src/lib/risk-assessment.ts`: only the `Decision.applied` field, the corrected-version link, and the types of `suggested_fix` operations
- this task file (notes) and your row in `STATUS.md`

**Not yours:** `components/risk/RiskSummary.tsx` (task 12 adds the what-if panel there), anything under `backend/`.

## Read-only references

- `CLAUDE.md` §5.1 (Fix operations), §5.5 (decisions)
- `backend/analysis/contracts.py` (`Fix`, `SetField`, `AddLine`, `RemoveLine`, `MergeLines`, `LinkAlternative`)
- Fix producers, to see real examples: `backend/analysis/layer1/completeness.py`, `consistency.py`, `text_quality.py`, `backend/analysis/layer2/engine.py`
- `frontend/src/lib/resolve.ts` (how edits resolve into the displayed list), `frontend/tests/risk-assessment.test.ts`

## Acceptance criteria

1. Unit tests for `planFix` cover every operation type, unit mapping, a stale `old_value`, and the skipped types.
2. On `data/demo/building_hall_planted.X83`: applying the edge-insulation fix (`L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION`
   → `add_line`) adds the position, Undo removes it, and "Save corrected version" creates a second list with it while the
   first stays as uploaded. Add screenshots to the PR.
3. A decision with `applied` syncs to a second browser (workspace sync), and older decisions without the field still load.
4. `npm run lint`, `npm run build` and `npm test` pass.

## Notes / blockers (fill in)

-
