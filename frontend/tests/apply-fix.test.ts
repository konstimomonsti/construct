import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalUnit, listUnit, planFix, planFixes, runSteps, type FixOperation, type FixStep } from '../src/lib/apply-fix'
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
    { op: 'set_field', line_id: 'b', field: 'unit_price', old_value: '4.5', new_value: '5' },
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
  const plan = planFix(finding({ op: 'add_line', section_id: '01', after_line_id: 'a', line: { short_text: 'Randdämmstreifen', unit: 'm', quantity: '24' } }), positions, () => 'new')
  const step = plan.steps[0] as Extract<FixStep, { kind: 'add' }>
  assert.equal(step.kind, 'add')
  assert.equal(step.position.id, 'new')
  assert.equal(step.position.oz, '01.0050')
  assert.deepEqual(step.position.path, path)
  assert.equal(step.position.unit, 'm')
})

const addition = (name: string, overrides: Partial<Extract<FixOperation, { op: 'add_line' }>> = {}) => ({
  ...finding({ op: 'add_line', section_id: '01', after_line_id: 'a',
    line: { short_text: name, unit: 'm', quantity: 12 }, ...overrides }),
  id: name,
  scope: 'bom' as const,
})

test('unmeasured and room-scoped recommendations stay open for manual review', () => {
  for (const quantity of [null, 0, -2, 'foo']) {
    const pending = addition('Kabelrinne', { line: { short_text: 'Kabelrinne', unit: 'm', quantity } })
    const { steps, skipped } = planFix(pending, positions)
    assert.deepEqual(steps, [])
    assert.match(skipped[0].reason, /Confirm the quantity and unit/)
  }
  const room = addition('Rohrdämmung', { distributions: [{ area_id: 'room', quantity: 12 }] })
  assert.match(planFix(room, positions).skipped[0].reason, /room allocations/)
  const gone = addition('Kabelrinne', { after_line_id: 'gone' })
  assert.match(planFix(gone, positions).skipped[0].reason, /source position/)
})

test('Fix all gives measured additions distinct position numbers and leaves overlap open', () => {
  let next = 0
  const proposals = [addition('Rohrdämmung'), addition('Randdämmstreifen'), addition('rohrdämmung')]
  const plans = planFixes(proposals, positions, positions, () => `new-${++next}`)
  const issued = plans.flatMap(({ plan }) => plan.steps).flatMap((step) => step.kind === 'add' ? [step.position.oz] : [])
  assert.deepEqual(issued, ['01.0050', '01.0060'])
  assert.deepEqual(plans[2].plan.steps, [])
  assert.match(plans[2].plan.skipped[0].reason, /proposed position/)
})

test('measured proposals check the original takeoff and account for edits staged in the same batch', () => {
  const proposal = addition('Randdämmstreifen')
  const changedQty = positions.map((position) => position.id === 'a' ? { ...position, qty: 110 } : position)
  const revised = planFixes([proposal], changedQty, positions)[0].plan
  assert.deepEqual(revised.steps, [])
  assert.match(revised.skipped[0].reason, /assessed takeoff/)
  const newCoverage = [...positions, { ...positions[0], id: 'cover', oz: '01.0090', short: 'Randdämmstreifen' }]
  assert.equal(planFixes([proposal], newCoverage, positions)[0].plan.steps.length, 0)
  const changedPrice = positions.map((position) => ({ ...position, up: 7 }))
  assert.equal(planFixes([proposal], changedPrice, positions, () => 'new')[0].plan.steps.length, 1)
  const correction = finding({ op: 'set_field', line_id: 'a', field: 'quantity', old_value: 120, new_value: 115 })
  const batch = planFixes([proposal, correction], positions, positions)
  assert.equal(batch[0].plan.steps[0].kind, 'qty')
  assert.equal(batch[1].plan.steps.length, 0)
})

test('a stale field or incomplete merge prevents a partial fix', () => {
  const partial = finding(
    { op: 'set_field', line_id: 'a', field: 'short_text', old_value: 'Zementestrich', new_value: 'Zementestrich schwimmend' },
    { op: 'set_field', line_id: 'b', field: 'unit_price', old_value: null, new_value: '5' },
  )
  assert.deepEqual(planFix(partial, positions).steps, [])
  const merge = finding({ op: 'merge_lines', keep_line_id: 'b', remove_line_ids: ['c', 'gone'], new_quantity: 99 })
  assert.deepEqual(planFix(merge, positions).steps, [])
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
