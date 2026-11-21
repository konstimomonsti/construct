import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentPhase } from '../src/lib/workflow'
import { toRequest, type SubcontractPackage } from '../src/lib/subcontract'

const pkg = (extra: Partial<SubcontractPackage> = {}): SubcontractPackage => ({
  id: 'p', name: 'p', positionIds: ['a'], subcontractorIds: ['s1'], budget: { perPosition: {}, total: 1 }, format: 'x83', status: 'draft', ...extra,
})

test('no packages, or only drafts: phase X83 with the hook in the first phase', () => {
  for (const state of [currentPhase([], false), currentPhase([pkg()], false)]) {
    assert.equal(state.phase, 'x83')
    assert.equal(state.progress, 0.125)
    assert.deepEqual(state.done, [])
  }
})

test('a sent package moves the project to Subcontractors', () => {
  const state = currentPhase([pkg({ status: 'sent', sentAt: '2026-01-02' }), pkg({ id: 'q' })], false)
  assert.equal(state.phase, 'subcontractors')
  assert.equal(state.progress, 0.375)
  assert.deepEqual(state.done, ['x83'])
})

test('X84 needs every package to have a chosen subcontractor', () => {
  const sent = pkg({ status: 'sent', sentAt: '2026-01-02' })
  assert.equal(currentPhase([{ ...sent, chosenId: 's1' }, sent], false).phase, 'subcontractors')
  const all = currentPhase([{ ...sent, chosenId: 's1' }, { ...sent, id: 'q', chosenId: 's2' }], false)
  assert.equal(all.phase, 'x84')
  assert.equal(all.progress, 0.625)
  assert.deepEqual(all.done, ['x83', 'subcontractors'])
})

test('an award document completes the workflow whatever the packages say', () => {
  for (const packages of [[], [pkg()], [pkg({ status: 'sent', sentAt: '2026-01-02' })]]) {
    const state = currentPhase(packages, true)
    assert.equal(state.phase, 'x86')
    assert.equal(state.progress, 1)
    assert.equal(state.complete, true)
    assert.deepEqual(state.done, ['x83', 'subcontractors', 'x84', 'x86'])
  }
})

test('the stored email text never reaches a request', () => {
  const request = toRequest(pkg({ sentText: 'Sehr geehrte Damen und Herren', notes: 'internal' }))
  assert.equal('sentText' in request, false)
  assert.equal('notes' in request, false)
})
