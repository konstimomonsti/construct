import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planFixAll } from '../src/lib/apply-fix'
import type { ChangeOrderSignal, Finding } from '../src/lib/risk-assessment'
import type { Position } from '../src/lib/types'

const path = [{ oz: '01', label: 'Estrich' }]
const positions: Position[] = [
  { id: 'a', oz: '01.0010', short: 'Zementestrich', qty: 120, unit: 'm2', up: null, category: 'Estrich', path },
  { id: 'd', oz: '01.0040', short: 'Baustelle einrichten', qty: 1, unit: 'St', up: null, category: 'Estrich', path },
]
const finding = (id: string, extra: Partial<Finding> = {}, withFix = true): Finding => ({
  id, layer: 1, rule_id: 'L1.TEST', severity: 'warning', title: 'Test', message: '',
  target: { line_id: null, section_id: null, field: null }, related_line_ids: [],
  suggested_fix: withFix
    ? { rationale: '', operations: [{ op: 'set_field', line_id: 'd', field: 'unit', old_value: 'ea', new_value: 'lump_sum' }] }
    : null,
  ...extra,
})
const signal: ChangeOrderSignal = { id: 'co_1', kind: 'scope_gap', line_id: 'a', line_code: '01.0010', title: 'Scope', message: '', points: 5, finding_ids: [] }

test('planFixAll splits fixable findings from the rest', () => {
  const { plans, rest } = planFixAll([finding('f1'), finding('f2', {}, false)], positions, true)
  assert.deepEqual(plans.map((p) => p.finding.id), ['f1'])
  assert.deepEqual(rest, ['f2'])
})

test('planFixAll puts llm findings and change-order signals in the rest', () => {
  const { plans, rest } = planFixAll([finding('f1'), finding('f3', { origin: 'llm' }), signal], positions, true)
  assert.deepEqual(plans.map((p) => p.finding.id), ['f1'])
  assert.deepEqual(rest, ['f3', 'co_1'])
})

test('planFixAll plans nothing when fixes are not allowed', () => {
  const { plans, rest } = planFixAll([finding('f1'), finding('f2', {}, false), signal], positions, false)
  assert.deepEqual(plans, [])
  assert.deepEqual(rest, ['f1', 'f2', 'co_1'])
})
