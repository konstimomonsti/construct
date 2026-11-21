import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDecision } from '../src/lib/risk-assessment'
import { categoryLabel, layer3Coverage, sectionPoints } from '../src/lib/risk-labels'
import { riskReport } from './fixtures/risk-report'
import type { Position } from '../src/lib/types'

test('layer 3 coverage is partial only when fewer batches ran', () => {
  assert.deepEqual(layer3Coverage(['other error', 'layer 3 coverage: 17/20 batches; skipped: L3.QTY.IMPLAUSIBLE×3']), {
    run: 17, planned: 20, skipped: 3, details: 'layer 3 coverage: 17/20 batches; skipped: L3.QTY.IMPLAUSIBLE×3',
  })
  assert.equal(layer3Coverage(['layer 3 coverage: 20/20 batches'])?.skipped, 0)
  assert.equal(layer3Coverage(['layer 3 did not run']), null)
})

test('category labels cover known ids and make unknown ids readable', () => {
  assert.equal(categoryLabel('dependency'), 'Missing work')
  assert.equal(categoryLabel('change_order'), 'Change-order risk')
  assert.equal(categoryLabel('custom_scope_gap'), 'Custom Scope Gap')
})

test('section points fall on accept and return on reopen', () => {
  const risk = riskReport.risk!
  const positions = [{ id: 'p1', path: [{ oz: '3.2', label: 'Stahlbetonfertigteile' }] }] as Position[]
  const initial = sectionPoints(risk, riskReport, positions, {})[0].points
  const accepted = applyDecision({}, ['f_din_grade'], { status: 'accepted', at: '' }).findingDecisions
  assert.equal(sectionPoints(risk, riskReport, positions, accepted)[0].points, initial - risk.points.f_din_grade)
  const reopened = applyDecision(accepted, ['f_din_grade'], null).findingDecisions
  assert.equal(sectionPoints(risk, riskReport, positions, reopened)[0].points, initial)
})
