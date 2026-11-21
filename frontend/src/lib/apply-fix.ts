import type { Finding, FixOperation } from './risk-assessment'
import type { Position, CategoryNode } from './types'
import { globalStep, indexTree, leafOz, nextPositionOz, pathOf } from './resolve'

export type Step =
  | { kind: 'setQty'; id: string; value: number; preview: string }
  | { kind: 'setUp'; id: string; value: number | null; preview: string }
  | { kind: 'patchPosition'; id: string; patch: Partial<Pick<Position, 'unit' | 'short' | 'long'>>; preview: string }
  | { kind: 'addPosition'; position: Position; preview: string }
  | { kind: 'removePositions'; ids: string[]; preview: string }

const units: Record<string, string> = { ea: 'St', m: 'm', 'm²': 'm2', 'm³': 'm3', t: 't', kg: 'kg', h: 'h', lump_sum: 'psch' }
const canonical = (unit: string) => Object.entries(units).find(([key, value]) => key.toLowerCase() === unit.toLowerCase() || value.toLowerCase() === unit.toLowerCase())?.[0] ?? unit
const unitFor = (unit: string, positions: Position[]) => positions.find(p => canonical(p.unit) === unit)?.unit ?? units[unit] ?? unit
const numeric = (value: unknown) => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null

export function planFix(finding: Finding, list: { positions: Position[]; tree: CategoryNode[] }, quantities: Record<number, number> = {}): { steps: Step[]; skipped: { op: FixOperation; reason: string }[] } {
  const steps: Step[] = [], skipped: { op: FixOperation; reason: string }[] = []
  const positions = list.positions.map(p => ({ ...p }))
  const skip = (op: FixOperation, reason: string) => skipped.push({ op, reason })
  for (const [i, op] of (finding.suggested_fix?.operations ?? []).entries()) {
    if (op.op === 'set_field') {
      const p = positions.find(x => x.id === op.line_id)
      const fields = { quantity: 'qty', unit_price: 'up', unit: 'unit', short_text: 'short', long_text: 'long' } as const
      const field = fields[op.field as keyof typeof fields]
      if (!field) { skip(op, 'This field is not supported by the list editor.'); continue }
      if (!p) { skip(op, 'Position no longer exists.'); continue }
      const old = p[field] ?? null
      const same = field === 'unit' ? canonical(String(old ?? '')) === canonical(String(op.old_value ?? '')) : field === 'qty' || field === 'up' ? (op.old_value == null ? old == null : numeric(op.old_value) === old) : (op.old_value ?? null) === old
      if (!same) { skip(op, 'The value has changed since the upload check.'); continue }
      const label = op.field.replaceAll('_', ' ')
      if (field === 'qty' || field === 'up') {
        const value = numeric(op.new_value)
        if ((value === null && !(field === 'up' && op.new_value == null)) || (value !== null && value < 0)) { skip(op, 'The new value is invalid.'); continue }
        if (field === 'qty') { p.qty = value!; steps.push({ kind: 'setQty', id: p.id, value: value!, preview: `${label}: ${old} → ${value}` }) }
        else { p.up = value; steps.push({ kind: 'setUp', id: p.id, value, preview: `${label}: ${old ?? '—'} → ${value ?? '—'}` }) }
      } else {
        if (typeof op.new_value !== 'string' && !(field === 'long' && op.new_value == null)) { skip(op, 'The new value is invalid.'); continue }
        const value = field === 'unit' ? unitFor(String(op.new_value), positions) : String(op.new_value ?? '')
        p[field] = value
        steps.push({ kind: 'patchPosition', id: p.id, patch: { [field]: value }, preview: `${label}: ${old ?? '—'} → ${value}` })
      }
    } else if (op.op === 'add_line') {
      const after = op.after_line_id ? positions.find(p => p.id === op.after_line_id) : undefined
      if (op.after_line_id && !after) { skip(op, 'The insertion position no longer exists.'); continue }
      const idx = indexTree(list.tree), section = after ? leafOz(after) : op.section_id ?? ''
      if (section && !idx.node.has(section)) { skip(op, 'The insertion section no longer exists.'); continue }
      const quantity = numeric(op.line.quantity ?? quantities[i])
      if (quantity === null || quantity < 0) { skip(op, 'The suggested quantity must be supplied before adding this position.'); continue }
      const path = after?.path ?? pathOf(idx, section)
      let id = `fix-${finding.id}-${i}`, n = 1
      while (positions.some(p => p.id === id)) id = `fix-${finding.id}-${i}-${n++}`
      const siblings = positions.filter(p => leafOz(p) === section)
      const taken = new Set(positions.map(p => p.oz))
      let oz = nextPositionOz(section, siblings.map(p => p.oz), taken, globalStep(positions))
      if (after) { let suffix = 1; oz = after.oz + '.' + suffix; while (taken.has(oz)) oz = after.oz + '.' + ++suffix }
      const position: Position = { id, oz, short: op.line.short_text, long: op.line.long_text ?? undefined, qty: quantity, unit: unitFor(op.line.unit ?? '', positions), up: null, category: path.at(-1)?.label ?? 'Allgemein', path }
      positions.push(position); steps.push({ kind: 'addPosition', position, preview: `Add position: ${position.short}, ${quantity} ${position.unit}` })
    } else if (op.op === 'remove_line') {
      if (!positions.some(p => p.id === op.line_id)) { skip(op, 'Position no longer exists.'); continue }
      positions.splice(positions.findIndex(p => p.id === op.line_id), 1); steps.push({ kind: 'removePositions', ids: [op.line_id], preview: `Remove position: ${op.line_id}` })
    } else if (op.op === 'merge_lines') {
      const keep = positions.find(p => p.id === op.keep_line_id), quantity = numeric(op.new_quantity)
      if (!keep || op.remove_line_ids.some(id => id === op.keep_line_id || !positions.some(p => p.id === id)) || (op.new_quantity != null && (quantity === null || quantity < 0))) { skip(op, 'The merge positions or quantity are no longer valid.'); continue }
      steps.push({ kind: 'removePositions', ids: op.remove_line_ids, preview: `Remove ${op.remove_line_ids.length} merged position(s)` })
      for (const id of op.remove_line_ids) positions.splice(positions.findIndex(p => p.id === id), 1)
      if (quantity !== null) { keep.qty = quantity; steps.push({ kind: 'setQty', id: keep.id, value: quantity, preview: `Quantity: → ${quantity}` }) }
    } else skip(op, 'Alternative links are not supported by the list editor.')
  }
  return { steps, skipped }
}
