import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chooseSubcontractor, declineOffer, offerOf, setOffer, toRequest, type SubcontractPackage,
} from '../src/lib/subcontract'
import { matchOffer, ozOverlap } from '../src/lib/subcontract-offer'

const pkg = (id: string, extra: Partial<SubcontractPackage> = {}): SubcontractPackage => ({
  id, name: id, positionIds: ['a', 'b'], subcontractorIds: ['s1', 's2'], budget: { perPosition: {}, total: 1000 }, format: 'x83', status: 'sent', sentAt: '2026-01-02', ...extra,
})

test('offerOf returns an empty offer when none exists', () => {
  assert.deepEqual(offerOf(pkg('p'), 's1'), {})
  assert.equal(offerOf(pkg('p', { offers: { s1: { amount: 5 } } }), 's1').amount, 5)
})

test('setOffer merges into one subcontractor and leaves other packages alone', () => {
  const list = [pkg('p'), pkg('q')]
  const a = setOffer(list, 'p', 's1', { amount: 100, note: 'by mail' })
  const b = setOffer(a, 'p', 's1', { amount: 120, note: undefined })
  assert.deepEqual(b[0].offers?.s1, { amount: 120 })
  assert.equal(b[1], list[1])
  assert.equal(list[0].offers, undefined, 'input is not mutated')
})

test('chooseSubcontractor sets chosenId and moves the package to offer_received', () => {
  const next = chooseSubcontractor([pkg('p', { status: 'sent' })], 'p', 's2')
  assert.equal(next[0].chosenId, 's2')
  assert.equal(next[0].status, 'offer_received')
  const cleared = chooseSubcontractor(next, 'p', null)
  assert.equal(cleared[0].chosenId, undefined)
  assert.equal(cleared[0].status, 'offer_received')
})

test('choosing a declined offer reopens it', () => {
  const list = declineOffer([pkg('p')], 'p', 's1', true)
  const next = chooseSubcontractor(list, 'p', 's1')
  assert.equal(next[0].offers?.s1.declined, false)
  assert.equal(next[0].chosenId, 's1')
})

test('declining the chosen offer clears the choice, declining another keeps it', () => {
  const base = chooseSubcontractor([pkg('p')], 'p', 's1')
  assert.equal(declineOffer(base, 'p', 's2', true)[0].chosenId, 's1')
  const out = declineOffer(base, 'p', 's1', true)
  assert.equal(out[0].chosenId, undefined)
  assert.equal(out[0].offers?.s1.declined, true)
  assert.equal(declineOffer(out, 'p', 's1', false)[0].offers?.s1.declined, false)
})

test('offers and the choice never reach a request', () => {
  const p = setOffer([pkg('p')], 'p', 's1', { amount: 999, note: 'secret' })[0]
  const req = JSON.stringify(toRequest({ ...p, chosenId: 's1' }))
  assert.ok(!req.includes('999') && !req.includes('secret') && !req.includes('s1'))
})

const ours = [
  { id: 'a', oz: '01.02.0010', qty: 10 },
  { id: 'b', oz: '01.02.0020', qty: 5 },
  { id: 'c', oz: '01.02.0030', qty: 2 },
]

test('matchOffer: full match sums qty × unit price', () => {
  const offer = { positions: [
    { oz: '1.2.10', qty: 10, up: 3 },
    { oz: '1.2.20', qty: 5, up: 4.5 },
    { oz: '1.2.30', qty: 2, up: 100 },
  ] }
  const r = matchOffer(ours, offer)
  assert.equal(r.amount, 252.5)
  assert.equal(r.matched, 3)
  assert.deepEqual(r.missing, [])
  assert.equal(r.extra, 0)
})

test('matchOffer: partial match lists missing ids and counts extras', () => {
  const offer = { positions: [{ oz: '1.2.10', qty: 10, up: 3 }, { oz: '9.9.9', qty: 1, up: 1 }] }
  const r = matchOffer(ours, offer)
  assert.equal(r.matched, 1)
  assert.deepEqual(r.missing, ['b', 'c'])
  assert.equal(r.extra, 1)
  assert.equal(r.amount, 30)
})

test('matchOffer: unpriced offer lines count as missing', () => {
  const offer = { positions: [{ oz: '1.2.10', qty: 0, up: 2 }, { oz: '1.2.20', qty: 5, up: null }] }
  const r = matchOffer(ours.slice(0, 2), offer)
  assert.equal(r.amount, 20)
  assert.equal(r.qtyDiffs, 0, 'a qty of 0 in the offer is not a difference')
  assert.deepEqual(r.missing, ['b'])
})

test('matchOffer: leading zeros in the OZ are normalized, and our LV quantity is used', () => {
  const r = matchOffer([{ id: 'a', oz: '01.02.0010', qty: 10 }], { positions: [{ oz: '1.2.10', qty: 12, up: 1.5 }] })
  assert.equal(r.amount, 15)
  assert.equal(r.qtyDiffs, 1)
  assert.deepEqual(r.prices, { a: 1.5 })
})

test('ozOverlap counts package positions present in the file', () => {
  assert.equal(ozOverlap(ours, { positions: [{ oz: '1.2.10' }, { oz: '1.2.30' }, { oz: '5' }] }), 2)
})

test('matchOffer: a PDF-style OZ with a trailing dot matches the GAEB reply', () => {
  const r = matchOffer([{ id: 'a', oz: '1.1.10.', qty: 1 }], { positions: [{ oz: '1.1.10', qty: 1, up: 5 }] })
  assert.equal(r.matched, 1)
  assert.equal(ozOverlap([{ oz: '1.1.10.' }], { positions: [{ oz: '1.1.10' }] }), 1)
})
