import assert from 'node:assert/strict'
import { test } from 'node:test'
import { partialAnalysis } from '../src/lib/risk-labels'

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
