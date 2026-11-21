import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bidAssumptions, type PricingTender } from '../src/lib/bid-pricing'

const tender: PricingTender = {
  input_hash: 'reference', currency: 'EUR', assessment_layers: [1, 2], opportunities: [],
  positions: [
    { key: '01.0010', id: 'first', text: 'Fixture', quantity: '10', unit: 'St', can_change_quantity: true },
    { key: '01.0020', id: 'second', text: 'Seat', quantity: '3', unit: 'St', can_change_quantity: false },
  ],
  quantity_conflicts: [{
    position: '01.0020', quantity: '3', unit: 'St',
    written: [{ quantity: '6', quote: 'Abrechnungsmenge: 6 St.' }],
  }],
}
const rate = { cost: '10', standard: '20', floor: '', ceiling: '' }
const rates = { '01.0010': rate, '01.0020': rate }
const markets = [{ id: 1, threshold: '300', chance: '100' }]

test('quantity conflicts preserve the base scenario and changes for other positions', () => {
  const payload = bidAssumptions(tender, rates, markets, [
    { position: '01.0010', quantity: '1', share: '100', other: '' },
  ], '25')
  assert.deepEqual(payload.assumptions.scenarios.map(({ changes }) => Object.keys(changes)), [[], ['01.0010']])
  assert.deepEqual(Object.keys(payload.assumptions.prices), ['01.0010', '01.0020'])
})

test('a stale manual draft cannot add units to a conflicting position', () => {
  assert.throws(() => bidAssumptions(tender, rates, markets, [
    { position: '01.0020', quantity: '3', share: '100', other: '' },
  ], '25'), /Confirm the written quantity for 01.0020/)
})
