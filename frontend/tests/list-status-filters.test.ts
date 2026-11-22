import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesPricingFilter, type PriceSuggestion, type PricingFilter } from '../src/lib/price-suggestions'
import type { Position } from '../src/lib/types'
import { researchFilterOf } from '../src/lib/workspace-catalogue'

test('pricing counts and filters distinguish pending, unpriced, priced zero quantities and edits', () => {
  const position = (id: string, up: number | null, qty = 1): Position =>
    ({ id, oz: id, short: id, qty, up, unit: 'St', category: 'Test' })
  const items = [position('unpriced', null, 0), position('proposed', null),
    position('zero quantity', 12, 0), position('zero price', 0), position('edited', 8)]
  const pending = new Map([['proposed', { price: 5 } as PriceSuggestion]])
  const edited = new Set(['edited', 'zero quantity'])
  const matching = (filter: PricingFilter) => items.filter(p => matchesPricingFilter(filter, p, pending, edited)).map(p => p.id)
  assert.deepEqual(matching('unpriced'), ['unpriced'])
  assert.deepEqual(matching('pending'), ['proposed'])
  assert.deepEqual(matching('zero'), ['zero quantity'])
  assert.deepEqual(matching('edited'), ['zero quantity', 'edited'])
})

test('catalogue filters exclude ongoing research and positions that do not require a match', () => {
  assert.equal(researchFilterOf('matched'), 'matched')
  assert.equal(researchFilterOf('suggested'), 'suggested')
  for (const state of ['failed', 'no_evidence', 'needs_description', 'research_disabled'] as const) {
    assert.equal(researchFilterOf(state), 'unresolved')
  }
  for (const state of ['activity', 'queued', 'researching', undefined] as const) {
    assert.equal(researchFilterOf(state), null)
  }
})
