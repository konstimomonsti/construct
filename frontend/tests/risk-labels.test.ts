import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDecision } from '../src/lib/risk-assessment'
import { categoryLabel, partialAnalysis, sectionPoints } from '../src/lib/risk-labels'
import { riskReport } from './fixtures/risk-report'
import type { Position } from '../src/lib/types'

test('risk stays unqualified when coverage completes or AI is never requested', () => {
  assert.equal(partialAnalysis([]), null)
  assert.equal(partialAnalysis(['layer 3 coverage: 16/16 batches']), null)
  assert.equal(partialAnalysis(['layer 3 coverage: 0/0 batches']), null)
})

test('reports skipped batches and keeps the provider details expandable', () => {
  const details = ['L3.SCOPE.TEST: 1 batch(es) not checked', 'layer 3 coverage: 15/16 batches; skipped: L3.SCOPE.TEST×1']
  assert.deepEqual(partialAnalysis(details), { message: '1 AI batch was skipped.', details })
})

test('failed AI checks qualify the risk even when the coverage count looks complete', () => {
  for (const details of [
    ['L3.SCOPE.TEST: service timed out', 'layer 3 coverage: 16/16 batches'],
    ['layer 3: provider unavailable', 'layer 3 coverage: 0/0 batches'],
    ['layer 3: failed unexpectedly; findings are from layers 1 and 2 only'],
  ]) {
    assert.deepEqual(partialAnalysis(details), { message: 'One or more AI checks could not finish.', details })
  }
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
