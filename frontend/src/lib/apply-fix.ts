import type { Finding } from './risk-assessment'
import type { Position } from './types'
import { globalStep, leafOz, nextPositionOz } from './resolve'

/* ------------------------------------------------------------------ */
/* Fix operations (backend/analysis/contracts.py, CLAUDE.md §5.1)      */
/* ------------------------------------------------------------------ */

export type SetFieldOp = { op: 'set_field'; line_id: string; field: string; old_value?: unknown; new_value?: unknown }
export type AddLineOp = {
  op: 'add_line'; section_id?: string | null; after_line_id?: string | null
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
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value))
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
  const byId = new Map(positions.map((position) => [position.id, position]))
  const taken = new Set(positions.map((position) => position.oz))
  for (const op of fixOperations(finding)) {
    if (op.op === 'set_field') {
      const position = byId.get(op.line_id)
      if (!position) { skipped.push({ op: op.op, reason: 'The position is no longer in the list.' }); continue }
      const where = `Pos. ${position.oz}`
      if (op.field === 'quantity' || op.field === 'unit_price') {
        const value = toNumber(op.new_value)
        const current = op.field === 'quantity' ? position.qty : position.up
        const old = toNumber(op.old_value)
        if (value === null && op.field === 'quantity') { skipped.push({ op: op.op, reason: 'No new quantity given.' }); continue }
        if (old !== null && current !== old) { skipped.push({ op: op.op, reason: `${where} was changed since the check.` }); continue }
        steps.push(op.field === 'quantity'
          ? { kind: 'qty', id: position.id, value: value!, label: `${where}: quantity ${fmt(position.qty)} → ${fmt(value!)}` }
          : { kind: 'up', id: position.id, value, label: `${where}: unit price → ${value === null ? 'empty' : fmt(value)}` })
      } else if (op.field === 'unit') {
        const target = typeof op.new_value === 'string' ? op.new_value : null
        if (!target) { skipped.push({ op: op.op, reason: 'No new unit given.' }); continue }
        if (op.old_value != null && canonicalUnit(position.unit) !== canonicalUnit(String(op.old_value))) {
          skipped.push({ op: op.op, reason: `${where} was changed since the check.` }); continue
        }
        const unit = listUnit(target, positions)
        steps.push({ kind: 'patch', id: position.id, patch: { unit }, label: `${where}: unit ${position.unit || '—'} → ${unit}` })
      } else if (op.field === 'short_text' || op.field === 'long_text') {
        const key = op.field === 'short_text' ? 'short' : 'long'
        const current = position[key] ?? ''
        if (typeof op.new_value !== 'string') { skipped.push({ op: op.op, reason: 'No new text given.' }); continue }
        if (op.old_value != null && String(op.old_value) !== current) { skipped.push({ op: op.op, reason: `${where} was changed since the check.` }); continue }
        steps.push({ kind: 'patch', id: position.id, patch: { [key]: op.new_value }, label: `${where}: ${key === 'short' ? 'short text' : 'long text'} corrected` })
      } else {
        skipped.push({ op: op.op, reason: `The list has no field for ${op.field.replaceAll('_', ' ')}.` })
      }
    } else if (op.op === 'add_line') {
      const after = op.after_line_id ? byId.get(op.after_line_id) : undefined
      const sibling = after ?? positions.find((position) => op.section_id && position.path?.some((part) => part.oz === op.section_id))
      const path = sibling?.path
      const cat = sibling ? leafOz(sibling) : ''
      const oz = nextPositionOz(cat, positions.filter((position) => leafOz(position) === cat).map((position) => position.oz), taken, globalStep(positions))
      taken.add(oz)
      const lump = op.line.pricing_basis === 'lump_sum'
      const quantity = toNumber(op.line.quantity) ?? (lump ? 1 : 0)
      const unit = op.line.unit ? listUnit(op.line.unit, positions) : lump ? listUnit('lump_sum', positions) : ''
      const position: Position = {
        id: newId(), oz, short: op.line.short_text, long: op.line.long_text ?? undefined, qty: quantity, unit, up: null,
        category: path?.at(-1)?.label ?? sibling?.category ?? 'Eigene Positionen', path, lumpSum: lump || undefined,
      }
      steps.push({ kind: 'add', position, label: `Add Pos. ${oz}: ${short(op.line.short_text)}${quantity ? `, ${fmt(quantity)} ${unit}` : ''}` })
    } else if (op.op === 'remove_line') {
      const position = byId.get(op.line_id)
      if (!position) { skipped.push({ op: op.op, reason: 'The position is already gone.' }); continue }
      steps.push({ kind: 'remove', ids: [position.id], label: `Remove Pos. ${position.oz}` })
    } else if (op.op === 'merge_lines') {
      const keep = byId.get(op.keep_line_id)
      const remove = op.remove_line_ids.map((id) => byId.get(id)).filter((p): p is Position => !!p)
      if (!keep || !remove.length) { skipped.push({ op: op.op, reason: 'The positions to merge are no longer in the list.' }); continue }
      const quantity = toNumber(op.new_quantity)
      if (quantity !== null) steps.push({ kind: 'qty', id: keep.id, value: quantity, label: `Pos. ${keep.oz}: quantity ${fmt(keep.qty)} → ${fmt(quantity)}` })
      steps.push({ kind: 'remove', ids: remove.map((p) => p.id), label: `Remove duplicate ${remove.map((p) => `Pos. ${p.oz}`).join(', ')}` })
    } else {
      skipped.push({ op: op.op, reason: 'Linking alternatives is not supported in the list yet.' })
    }
  }
  return { steps, skipped }
}

export const canAutoFix = (finding: Finding, positions: Position[]) => planFix(finding, positions, () => 'preview').steps.length > 0

/**
 * "Fix all": every open rule finding with an applicable fix goes into `plans`; the ids of everything else open
 * (no fix, layer 3, or all of it when fixes are not allowed) go into `rest`.
 */
export function planFixAll(open: Finding[], positions: Position[], allowFixes: boolean): { plans: { finding: Finding; plan: FixPlan }[]; rest: string[] } {
  const plans: { finding: Finding; plan: FixPlan }[] = []
  const rest: string[] = []
  for (const item of open) {
    if (allowFixes && item.origin !== 'llm') {
      const plan = planFix(item, positions)
      if (plan.steps.length) { plans.push({ finding: item, plan }); continue }
    }
    rest.push(item.id)
  }
  return { plans, rest }
}

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
