import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { planFix } from '../src/lib/apply-fix'
import type { Finding, FixOperation } from '../src/lib/risk-assessment'
import type { Position } from '../src/lib/types'

const positions: Position[] = [{ id: 'a', oz: '1.10', short: 'A', long: 'old', qty: 2, unit: 'm', up: 3, category: 'Floor', path: [{ oz: '1', label: 'Floor' }] }, { id: 'b', oz: '1.20', short: 'B', qty: 4, unit: 'St', up: null, category: 'Floor', path: [{ oz: '1', label: 'Floor' }] }]
const list = { positions, tree: [{ oz: '1', label: 'Floor', depth: 1, children: [] }] }
const finding = (operations: FixOperation[]): Finding => ({ id: 'f', layer: 1, rule_id: 'r', severity: 'warning', title: 't', message: 'm', target: { line_id: 'a', section_id: '1', field: null }, related_line_ids: [], suggested_fix: { rationale: '', operations } })
const set = (field: string, old_value: unknown, new_value: unknown): FixOperation => ({ op: 'set_field', line_id: 'a', field, old_value, new_value })

test('plans supported fields, converts canonical units, and rejects stale values', () => {
  const result = planFix(finding([set('quantity', '2', '5'), set('unit_price', '3', '8'), set('unit', 'm', 'ea'), set('short_text', 'A', 'New'), set('long_text', 'old', 'New long'), set('quantity', 2, 9)]), list)
  assert.deepEqual(result.steps.map(s => s.kind), ['setQty', 'setUp', 'patchPosition', 'patchPosition', 'patchPosition'])
  assert.equal(result.steps[2].kind === 'patchPosition' && result.steps[2].patch.unit, 'St')
  assert.match(result.skipped[0].reason, /changed/)
  for (const [canonical, expected] of [['m²', 'm2'], ['m³', 'm3'], ['lump_sum', 'psch']] as const) {
    const step = planFix(finding([set('unit', 'm', canonical)]), list).steps[0]
    assert.equal(step.kind === 'patchPosition' && step.patch.unit, expected)
  }
  assert.equal(positions[0].qty, 2)
})

test('adds after the anchor, removes, merges, and reports unsupported operations', () => {
  const result = planFix(finding([
    { op: 'add_line', section_id: '1', after_line_id: 'a', line: { short_text: 'Randdämmstreifen', quantity: '120', unit: 'm' } },
    { op: 'merge_lines', keep_line_id: 'a', remove_line_ids: ['b'], new_quantity: '6' },
    { op: 'remove_line', line_id: 'a' },
    { op: 'link_alternative', line_id: 'a', alternative_for: 'b' },
    set('pricing_basis', 'unit_rate', 'lump_sum'), set('total_rule', null, 'x'), set('alternative_for', null, 'b'),
  ]), list)
  assert.deepEqual(result.steps.map(s => s.kind), ['addPosition', 'removePositions', 'setQty', 'removePositions'])
  const add = result.steps[0]
  assert.ok(add.kind === 'addPosition')
  assert.equal(add.position.qty, 120)
  assert.equal(add.position.path?.[0].oz, '1')
  assert.equal(result.skipped.length, 4)
})
import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'
import { parseListFile } from '../src/lib/parse-list-file'
import { resolveList } from '../src/lib/resolve'

Object.assign(globalThis, { DOMParser })

test('plans the planted hall edge insulation with a reviewer-supplied quantity', async () => {
  const bytes = await readFile(new URL('../../data/demo/building_hall_planted.X83', import.meta.url))
  const parsed = await parseListFile(new File([new Uint8Array(bytes)], 'building_hall_planted.X83'))
  assert.ok(parsed)
  const anchor = parsed.positions.find(p => p.oz === '02.02.0010')
  assert.ok(anchor)
  const operation: FixOperation = { op: 'add_line', section_id: null, after_line_id: anchor.id, line: { short_text: 'Randdämmstreifen', quantity: null, unit: 'm' } }
  const actualList = { positions: parsed.positions, tree: parsed.tree ?? [] }
  assert.equal(planFix(finding([operation]), actualList).steps.length, 0)
  const plan = planFix(finding([operation]), actualList, { 0: 120 })
  const step = plan.steps[0]
  assert.ok(step?.kind === 'addPosition')
  assert.equal(step.position.qty, 120)
  const doc = { id: 'demo', folderId: 'f', fileName: 'demo.X83', title: 'demo', format: parsed.format, currency: 'EUR', positionsCount: parsed.positions.length, pricedCount: 0, total: 0, categories: 0, positions: parsed.positions, tree: parsed.tree }
  const corrected = resolveList(doc, { added: [step.position] })
  assert.equal(corrected.positions.length, parsed.positions.length + 1)
  assert.equal(resolveList(doc).positions.length, parsed.positions.length)
  assert.ok(corrected.positions.findIndex(p => p.id === step.position.id) > corrected.positions.findIndex(p => p.id === anchor.id))
})
