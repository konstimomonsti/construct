import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalUnit, listUnit, planFix, runSteps, type FixOperation, type FixStep } from '../src/lib/apply-fix'
import type { Finding } from '../src/lib/risk-assessment'
import type { Position } from '../src/lib/types'

const path = [{ oz: '01', label: 'Estrich' }]
const positions: Position[] = [
  { id: 'a', oz: '01.0010', short: 'Zementestrich', qty: 120, unit: 'm2', up: null, category: 'Estrich', path },
  { id: 'b', oz: '01.0020', short: 'Fugen schneiden', qty: 18, unit: 'm', up: 4.5, category: 'Estrich', path },
  { id: 'c', oz: '01.0030', short: 'Fugen schneiden', qty: 6, unit: 'm', up: 4.5, category: 'Estrich', path },
  { id: 'd', oz: '01.0040', short: 'Baustelle einrichten', qty: 1, unit: 'St', up: null, category: 'Estrich', path },
]
const finding = (...operations: FixOperation[]): Finding => ({
  id: 'f', layer: 1, rule_id: 'L1.TEST', severity: 'warning', title: 'Test', message: '',
  target: { line_id: null, section_id: null, field: null }, related_line_ids: [],
  suggested_fix: { rationale: '', operations },
})

test('units map between canonical and the list notation', () => {
  assert.equal(canonicalUnit('m2'), 'm²')
  assert.equal(canonicalUnit('Stk.'), 'ea')
  assert.equal(canonicalUnit('psch'), 'lump_sum')
  assert.equal(listUnit('m²', positions), 'm2')
  assert.equal(listUnit('ea', positions), 'St')
  assert.equal(listUnit('lump_sum', positions), 'psch')
})

test('set_field maps quantity, price, unit and text onto edits', () => {
  const plan = planFix(finding(
    { op: 'set_field', line_id: 'd', field: 'unit', old_value: 'ea', new_value: 'lump_sum' },
    { op: 'set_field', line_id: 'a', field: 'quantity', old_value: '120', new_value: '125.5' },
    { op: 'set_field', line_id: 'b', field: 'unit_price', old_value: null, new_value: '5' },
    { op: 'set_field', line_id: 'b', field: 'short_text', old_value: 'Fugen schneiden', new_value: 'Fugen schneiden, 3 mm' },
  ), positions)
  assert.deepEqual(plan.skipped, [])
  assert.deepEqual(plan.steps.map((s) => s.kind), ['patch', 'qty', 'up', 'patch'])
  assert.deepEqual((plan.steps[0] as Extract<FixStep, { kind: 'patch' }>).patch, { unit: 'psch' })
  assert.equal((plan.steps[1] as Extract<FixStep, { kind: 'qty' }>).value, 125.5)
})

test('a value changed since the check and unsupported fields are skipped', () => {
  const plan = planFix(finding(
    { op: 'set_field', line_id: 'a', field: 'quantity', old_value: '100', new_value: '110' },
    { op: 'set_field', line_id: 'a', field: 'pricing_basis', new_value: 'lump_sum' },
    { op: 'set_field', line_id: 'gone', field: 'unit', new_value: 'm' },
    { op: 'link_alternative', line_id: 'a', alternative_for: 'b' },
  ), positions)
  assert.equal(plan.steps.length, 0)
  assert.equal(plan.skipped.length, 4)
  assert.match(plan.skipped[0].reason, /changed since/)
})

test('add_line places a new position in the section with the list notation', () => {
  const plan = planFix(finding({ op: 'add_line', section_id: '01', after_line_id: 'a', line: { short_text: 'Randdämmstreifen', unit: 'm', quantity: null } }), positions, () => 'new')
  const step = plan.steps[0] as Extract<FixStep, { kind: 'add' }>
  assert.equal(step.kind, 'add')
  assert.equal(step.position.id, 'new')
  assert.equal(step.position.oz, '01.0050')
  assert.deepEqual(step.position.path, path)
  assert.equal(step.position.unit, 'm')
})

test('merge_lines sets the kept quantity and removes the duplicate; remove_line removes', () => {
  const merge = planFix(finding({ op: 'merge_lines', keep_line_id: 'b', remove_line_ids: ['c'], new_quantity: '24.000' }), positions)
  assert.deepEqual(merge.steps.map((s) => s.kind), ['qty', 'remove'])
  const remove = planFix(finding({ op: 'remove_line', line_id: 'd' }), positions)
  assert.deepEqual((remove.steps[0] as Extract<FixStep, { kind: 'remove' }>).ids, ['d'])
})

test('runSteps calls the store once per step', () => {
  const calls: string[] = []
  const store = {
    setQty: (_l: string, id: string, q: number) => calls.push(`qty ${id} ${q}`),
    setUp: (_l: string, id: string) => calls.push(`up ${id}`),
    patchPosition: (_l: string, id: string) => calls.push(`patch ${id}`),
    addPosition: (_l: string, p: Position) => calls.push(`add ${p.id}`),
    removePositions: (_l: string, ids: string[]) => calls.push(`remove ${ids.join(',')}`),
  }
  const plan = planFix(finding({ op: 'merge_lines', keep_line_id: 'b', remove_line_ids: ['c'], new_quantity: 24 }), positions)
  runSteps(store, 'list', plan.steps)
  assert.deepEqual(calls, ['qty b 24', 'remove c'])
})
