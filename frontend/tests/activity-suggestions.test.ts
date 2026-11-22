import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActivityEntry, ActivityPrice } from '../src/lib/catalogues'
import { activitySuggestion } from '../src/lib/price-suggestions'
import type { Position } from '../src/lib/types'

const path = [{ oz: '02', label: 'Kabel' }]
const position = (over: Partial<Position> = {}): Position => ({
  id: 'p1', oz: '02.01.4010', short: 'Kabel aus Kabelkanal ausbauen, Kabeldurchmesser bis 20 mm MLV-FSB_02014010', qty: 315,
  unit: 'm', up: null, category: 'Kabel', path, ...over,
})
const price = (unit_price: string, subcontractor: string | null = null, over: Partial<ActivityPrice> = {}): ActivityPrice => ({
  unit_price, currency: 'EUR', valid_from: '2026-11-01', valid_until: null, source_note: null,
  subcontractor_id: subcontractor ? `id-${subcontractor}` : null, subcontractor, ...over,
})
const entry = (prices: ActivityPrice[], over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  code: '02.01.4010', name: 'Kabel aus Kabelkanal ausbauen, Kabeldurchmesser bis 20 mm', unit: 'm', kind: 'activity', prices, ...over,
})

test('an own price is proposed as a pending activity price', () => {
  const s = activitySuggestion(position(), entry([price('1.80')]))
  assert.ok(s)
  assert.equal(s.price, 1.8)
  assert.equal(s.kind, 'activity')
  assert.equal(s.product.supplier, 'Own price')
  assert.equal(s.unitKnown, true)
  assert.equal(s.validFrom, '2026-11-01')
})

test('a subcontractor offer is proposed under the subcontractor name', () => {
  const s = activitySuggestion(position(), entry([price('2.40', 'Havelkabel Tiefbau GmbH')]))
  assert.equal(s?.price, 2.4)
  assert.equal(s?.product.supplier, 'Havelkabel Tiefbau GmbH')
})

test('the cheapest valid price wins, and our own price wins a tie', () => {
  assert.equal(activitySuggestion(position(), entry([price('2.40'), price('1.90', 'Sub A'), price('2.10', 'Sub B')]))?.product.supplier, 'Sub A')
  assert.equal(activitySuggestion(position(), entry([price('2.00', 'Sub A'), price('2.00')]))?.product.supplier, 'Own price')
})

test('prices in another currency or that are not numbers are ignored', () => {
  assert.equal(activitySuggestion(position(), entry([price('1.00', null, { currency: 'USD' }), price('abc')])), null)
  assert.equal(activitySuggestion(position(), entry([price('1.00', null, { currency: 'USD' }), price('3.00', 'Sub A')]))?.price, 3)
})

test('the activity must have the same name as the position', () => {
  assert.equal(activitySuggestion(position({ short: 'Kabel aus Halbschale ausbauen, Kabeldurchmesser bis 20 mm' }), entry([price('1.80')])), null)
  // case, punctuation and the numbered Muster-LV suffix do not matter
  assert.ok(activitySuggestion(position({ short: 'KABEL aus Kabelkanal ausbauen; Kabeldurchmesser bis 20 mm' }), entry([price('1.80')])))
})

test('the units must fit, and a missing unit asks the user to check it', () => {
  assert.equal(activitySuggestion(position({ unit: 'St' }), entry([price('1.80')])), null)
  assert.equal(activitySuggestion(position({ unit: '' }), entry([price('1.80')]))?.unitKnown, false)
  assert.equal(activitySuggestion(position({ unit: 'm3' }), entry([price('85.34')], { unit: 'm³' }))?.unitKnown, true)
})

test('no entry means no suggestion', () => {
  assert.equal(activitySuggestion(position(), null), null)
  assert.equal(activitySuggestion(position(), undefined), null)
  assert.equal(activitySuggestion(position(), entry([])), null)
})
