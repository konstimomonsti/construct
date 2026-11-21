import type { Finding } from './risk-assessment'
import type { Position } from './types'
import { globalStep, leafOz, nextPositionOz } from './resolve'

/* ------------------------------------------------------------------ */
/* Fix operations (backend/analysis/contracts.py, CLAUDE.md §5.1)      */
/* ------------------------------------------------------------------ */

export type SetFieldOp = { op: 'set_field'; line_id: string; field: string; old_value?: unknown; new_value?: unknown }
export type AddLineOp = {
  op: 'add_line'; section_id?: string | null; after_line_id?: string | null
  distributions?: { area_id: string; quantity: string | number | null }[]
  line: { short_text: string; long_text?: string | null; quantity?: string | number | null; unit?: string | null; pricing_basis?: 'unit_rate' | 'lump_sum' }
}
export type RemoveLineOp = { op: 'remove_line'; line_id: string }
export type MergeLinesOp = { op: 'merge_lines'; keep_line_id: string; remove_line_ids: string[]; new_quantity?: string | number | null }
export type LinkAlternativeOp = { op: 'link_alternative'; line_id: string; alternative_for: string }
export type FixOperation = SetFieldOp | AddLineOp | RemoveLineOp | MergeLinesOp | LinkAlternativeOp

/** one change to the list, in the terms of the existing edit model (`ListEdits`) */
export type FixStep =
  | { kind: 'qty'; id: string; value: number; label: string }
  | { kind: 'up'; id: string; value: number | null; label: string }
  | { kind: 'patch'; id: string; patch: Partial<Pick<Position, 'unit' | 'short' | 'long'>>; label: string }
  | { kind: 'add'; position: Position; label: string }
  | { kind: 'remove'; ids: string[]; label: string }

export type FixPlan = { steps: FixStep[]; skipped: { op: string; reason: string }[] }
type PlannedFix = { finding: Finding; plan: FixPlan }

export const fixOperations = (finding: Finding): FixOperation[] => finding.suggested_fix?.operations ?? []

/* ------------------------------------------------------------------ */
/* Units: canonical (backend/analysis/units.py) <-> list notation       */
/* ------------------------------------------------------------------ */

const UNIT_FORMS: Record<string, string[]> = {
  ea: ['St', 'Stk', 'Stck', 'Stück'],
  m: ['m', 'lfm'],
  'm²': ['m²', 'm2', 'qm'],
  'm³': ['m³', 'm3', 'cbm'],
  t: ['t'],
  kg: ['kg'],
  h: ['h', 'Std'],
  lump_sum: ['psch', 'Psch', 'pauschal'],
}

export function canonicalUnit(unit: string | null | undefined): string | null {
  const u = (unit ?? '').trim().replace(/\.$/, '').toLowerCase()
  if (!u) return null
  for (const [canonical, forms] of Object.entries(UNIT_FORMS)) {
    if (canonical.toLowerCase() === u || forms.some((form) => form.toLowerCase() === u)) return canonical
  }
  return u
}

/** the canonical unit written the way this list already writes it (m2 stays m2, St stays St) */
export function listUnit(canonical: string, positions: Pick<Position, 'unit'>[]): string {
  const forms = UNIT_FORMS[canonical]
  if (!forms) return canonical
  const used = new Map<string, number>()
  for (const position of positions) {
    const form = forms.find((f) => f.toLowerCase() === position.unit?.trim().toLowerCase())
    if (form) used.set(position.unit.trim(), (used.get(position.unit.trim()) ?? 0) + 1)
  }
  return [...used].sort((a, b) => b[1] - a[1])[0]?.[0] ?? forms[0]
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

const toNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const fmt = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 3 })
const short = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Maps a finding's suggested fix onto list edits. Pure: nothing is changed here.
 * An operation is skipped (with a reason) when the list model can't express it, its position is gone, or the user
 * changed the value since the upload check (`old_value` no longer matches).
 */
export function planFix(finding: Finding, positions: Position[], newId: () => string = () => `u-${crypto.randomUUID()}`): FixPlan {
  const steps: FixStep[] = []
  const skipped: FixPlan['skipped'] = []
  const operations = fixOperations(finding)
  if (!operations.length) return { steps, skipped }
  const byId = new Map(positions.map((position) => [position.id, position]))
  const taken = new Set(positions.map((position) => position.oz))
  for (const op of operations) {
    if (op.op === 'set_field') {
      const position = byId.get(op.line_id)
      if (!position) { skipped.push({ op: op.op, reason: 'The position is no longer in the list.' }); continue }
      const where = `Pos. ${position.oz}`
      if (op.field === 'quantity' || op.field === 'unit_price') {
        const value = toNumber(op.new_value)
        const current = op.field === 'quantity' ? position.qty : position.up
        const old = toNumber(op.old_value)
        if (value === null && (op.field === 'quantity' || op.new_value !== null)) { skipped.push({ op: op.op, reason: 'The new value is missing or invalid.' }); continue }
        const expected = op.field === 'quantity' && op.old_value === null ? 0 : old
        if ('old_value' in op && current !== expected) { skipped.push({ op: op.op, reason: `${where} was changed since the check.` }); continue }
        steps.push(op.field === 'quantity'
          ? { kind: 'qty', id: position.id, value: value!, label: `${where}: quantity ${fmt(position.qty)} → ${fmt(value!)}` }
          : { kind: 'up', id: position.id, value, label: `${where}: unit price → ${value === null ? 'empty' : fmt(value)}` })
      } else if (op.field === 'unit') {
        const target = typeof op.new_value === 'string' ? op.new_value : null
        if (!target) { skipped.push({ op: op.op, reason: 'No new unit given.' }); continue }
        if ('old_value' in op && canonicalUnit(position.unit) !== canonicalUnit(op.old_value == null ? null : String(op.old_value))) {
          skipped.push({ op: op.op, reason: `${where} was changed since the check.` }); continue
        }
        const unit = listUnit(target, positions)
        steps.push({ kind: 'patch', id: position.id, patch: { unit }, label: `${where}: unit ${position.unit || '—'} → ${unit}` })
      } else if (op.field === 'short_text' || op.field === 'long_text') {
        const key = op.field === 'short_text' ? 'short' : 'long'
        const current = position[key] ?? ''
        if (typeof op.new_value !== 'string') { skipped.push({ op: op.op, reason: 'No new text given.' }); continue }
        if ('old_value' in op && String(op.old_value ?? '') !== current) { skipped.push({ op: op.op, reason: `${where} was changed since the check.` }); continue }
        steps.push({ kind: 'patch', id: position.id, patch: { [key]: op.new_value }, label: `${where}: ${key === 'short' ? 'short text' : 'long text'} corrected` })
      } else {
        skipped.push({ op: op.op, reason: `The list has no field for ${op.field.replaceAll('_', ' ')}.` })
      }
    } else if (op.op === 'add_line') {
      const after = op.after_line_id ? byId.get(op.after_line_id) : undefined
      if (op.after_line_id && !after) {
        skipped.push({ op: op.op, reason: 'The source position is no longer in the list.' })
        continue
      }
      if (op.distributions?.length) {
        skipped.push({ op: op.op, reason: 'Confirm and enter the room allocations with the new position.' })
        continue
      }
      const quantity = toNumber(op.line.quantity)
      const lump = op.line.pricing_basis === 'lump_sum'
      const canonical = canonicalUnit(op.line.unit) ?? (lump ? 'lump_sum' : null)
      if (quantity === null || quantity <= 0 || !canonical || !Object.hasOwn(UNIT_FORMS, canonical)) {
        skipped.push({ op: op.op, reason: 'Confirm the quantity and unit before adding this position.' })
        continue
      }
      const sibling = after ?? positions.find((position) => op.section_id && position.path?.at(-1)?.oz === op.section_id)
      if (!sibling && op.section_id) {
        skipped.push({ op: op.op, reason: 'The source section is no longer in the list.' })
        continue
      }
      const path = sibling?.path
      const cat = sibling ? leafOz(sibling) : ''
      const oz = nextPositionOz(cat, positions.filter((position) => leafOz(position) === cat).map((position) => position.oz), taken, globalStep(positions))
      taken.add(oz)
      const unit = listUnit(canonical, positions)
      const position: Position = {
        id: newId(), oz, short: op.line.short_text, long: op.line.long_text ?? undefined, qty: quantity, unit, up: null,
        category: path?.at(-1)?.label ?? sibling?.category ?? 'Eigene Positionen', path, lumpSum: lump || undefined,
      }
      steps.push({ kind: 'add', position, label: `Add Pos. ${oz}: ${short(op.line.short_text)}, ${fmt(quantity)} ${unit}` })
    } else if (op.op === 'remove_line') {
      const position = byId.get(op.line_id)
      if (!position) { skipped.push({ op: op.op, reason: 'The position is already gone.' }); continue }
      steps.push({ kind: 'remove', ids: [position.id], label: `Remove Pos. ${position.oz}` })
    } else if (op.op === 'merge_lines') {
      const keep = byId.get(op.keep_line_id)
      const remove = op.remove_line_ids.map((id) => byId.get(id))
      if (!keep || !remove.length || remove.some((position) => !position || position.id === keep.id)
          || new Set(op.remove_line_ids).size !== remove.length) {
        skipped.push({ op: op.op, reason: 'The complete set of positions to merge must still exist.' })
        continue
      }
      const quantity = toNumber(op.new_quantity)
      if (op.new_quantity != null && quantity === null) {
        skipped.push({ op: op.op, reason: 'The combined quantity is invalid.' })
        continue
      }
      if (quantity !== null) steps.push({ kind: 'qty', id: keep.id, value: quantity, label: `Pos. ${keep.oz}: quantity ${fmt(keep.qty)} → ${fmt(quantity)}` })
      steps.push({ kind: 'remove', ids: op.remove_line_ids, label: `Remove duplicate ${remove.map((p) => `Pos. ${p?.oz}`).join(', ')}` })
    } else {
      skipped.push({ op: op.op, reason: 'Linking alternatives is not supported in the list yet.' })
    }
  }
  return { steps: skipped.length ? [] : steps, skipped }
}

function sameTakeoff(current: Position[], assessed: Position[]) {
  if (current.length !== assessed.length) return false
  const byId = new Map(assessed.map((position) => [position.id, position]))
  return current.every((position) => {
    const original = byId.get(position.id)
    return original && position.oz === original.oz && position.qty === original.qty
      && canonicalUnit(position.unit) === canonicalUnit(original.unit)
      && (position.short ?? '') === (original.short ?? '') && (position.long ?? '') === (original.long ?? '')
      && pathCodes(position) === pathCodes(original) && Boolean(position.lumpSum) === Boolean(original.lumpSum)
  })
}

const pathCodes = (position: Position) => JSON.stringify(position.path?.map((part) => part.oz) ?? [])

function stagePlan(positions: Position[], steps: FixStep[]) {
  if (!steps.length) return positions
  const staged = new Map(positions.map((position) => [position.id, position]))
  for (const step of steps) {
    if (step.kind === 'add') staged.set(step.position.id, step.position)
    else if (step.kind === 'remove') step.ids.forEach((id) => staged.delete(id))
    else {
      const position = staged.get(step.id)
      if (!position) continue
      if (step.kind === 'qty') staged.set(step.id, { ...position, qty: step.value })
      else if (step.kind === 'up') staged.set(step.id, { ...position, up: step.value })
      else staged.set(step.id, { ...position, ...step.patch })
    }
  }
  return [...staged.values()]
}

/** Plan against one set of edits. Quantity-derived additions use the assessed takeoff. */
export function planFixes(findings: Finding[], positions: Position[], assessed: Position[], newId?: () => string): PlannedFix[] {
  const ordinary: Finding[] = []
  const additions: Finding[] = []
  for (const finding of findings) {
    const includesAddition = fixOperations(finding).some((operation) => operation.op === 'add_line')
    const group = includesAddition ? additions : ordinary
    group.push(finding)
  }
  const plans: PlannedFix[] = []
  let staged = positions
  for (const finding of ordinary) {
    const plan = planFix(finding, staged, newId)
    staged = stagePlan(staged, plan.steps)
    plans.push({ finding, plan })
  }
  const takeoffCurrent = !additions.length || sameTakeoff(staged, assessed)
  const added = new Set<string>()
  for (const finding of additions) {
    let plan = planFix(finding, staged, newId)
    if (plan.steps.length) {
      const keys = plan.steps.flatMap((step) => {
        if (step.kind !== 'add') return []
        const { short, long, unit } = step.position
        const scope = finding.scope === 'bom' ? '' : pathCodes(step.position)
        return [JSON.stringify([scope, short.trim().toLowerCase(), (long ?? '').trim().toLowerCase(), canonicalUnit(unit)])]
      })
      if (!takeoffCurrent) {
        plan = { steps: [], skipped: [{ op: 'add_line', reason: 'The list differs from the assessed takeoff. Confirm the remaining scope and quantity before adding a position.' }] }
      } else if (keys.some((key) => added.has(key)) || new Set(keys).size !== keys.length) {
        plan = { steps: [], skipped: [{ op: 'add_line', reason: 'Another proposed position covers this wording. Review the scope before adding both.' }] }
      } else {
        keys.forEach((key) => added.add(key))
        staged = stagePlan(staged, plan.steps)
      }
    }
    plans.push({ finding, plan })
  }
  return plans
}

export const canAutoFix = (finding: Finding, positions: Position[]) => planFix(finding, positions, () => 'preview').steps.length > 0

/** the store calls one plan needs; the caller takes the undo snapshot */
export type FixTarget = {
  setQty: (listId: string, pid: string, q: number) => void
  setUp: (listId: string, pid: string, up: number | null) => void
  patchPosition: (listId: string, pid: string, p: Partial<Pick<Position, 'unit' | 'short' | 'long'>>) => void
  addPosition: (listId: string, p: Position) => void
  removePositions: (listId: string, pids: string[]) => void
}

export function runSteps(store: FixTarget, listId: string, steps: FixStep[]) {
  for (const step of steps) {
    if (step.kind === 'qty') store.setQty(listId, step.id, step.value)
    else if (step.kind === 'up') store.setUp(listId, step.id, step.value)
    else if (step.kind === 'patch') store.patchPosition(listId, step.id, step.patch)
    else if (step.kind === 'add') store.addPosition(listId, step.position)
    else store.removePositions(listId, step.ids)
  }
}
