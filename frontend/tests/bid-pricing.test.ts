import assert from 'node:assert/strict'
import test from 'node:test'
import { bidAssumptions, selectedOpportunity, selectQuantityChange, type PricingTender } from '../src/lib/bid-pricing'

const tender: PricingTender = {
  input_hash: 'assessment-hash', currency: 'EUR', assessment_layers: [1, 2, 3],
  positions: [{ key: '01.0020', id: 'chairs', text: 'Chairs', quantity: '20', unit: 'St', can_change_quantity: true }],
  opportunities: [{ position: '01.0020', position_id: 'chairs', quantity: '20', title: 'Potential quantity shortfall',
    rule_id: 'L3.QTY.RELATIONSHIP', finding_id: 'f_chairs', ai_reviewed: false }],
}

test('row handoff preselects the current finding once and submits its ID', () => {
  const selection = { inputHash: tender.input_hash, positionId: 'chairs', findingId: 'f_chairs' }
  const opportunity = selectedOpportunity(tender, selection)
  assert.ok(opportunity)
  const changes = selectQuantityChange([], opportunity.position, opportunity)
  assert.equal(changes[0].quantity, '20')
  changes[0].share = '0'
  changes[0].other = '20'
  assert.equal(selectQuantityChange(changes, opportunity.position, opportunity), changes)
  const rates = { '01.0020': { cost: '20', standard: '30', floor: '', ceiling: '40' } }
  const markets = [{ id: 1, threshold: '800', chance: '100' }]
  const request = bidAssumptions(tender, rates, markets, changes, '80')
  assert.equal(request.input_hash, tender.input_hash)
  assert.deepEqual(request.assumptions.scenarios[1].changes['01.0020'], {
    finding_id: 'f_chairs', quoted_rate_share: '0.0000', other_unit_rate: 20,
  })
  assert.throws(() => bidAssumptions(tender, { '01.0020': { ...rates['01.0020'], cost: '' } }, markets, changes, '80'), /unit cost/)
  assert.equal(selectedOpportunity(tender, { ...selection, inputHash: 'stale' }), false)
  assert.equal(selectedOpportunity(tender, { ...selection, positionId: 'tables' }), undefined)
  assert.equal(selectedOpportunity(tender, { ...selection, findingId: 'another' }), undefined)
})
