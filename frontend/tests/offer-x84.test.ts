import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import { exportList } from '../src/lib/export/index'
import { offerModel, offerPositions } from '../src/lib/offer-x84'
import { matchOffer } from '../src/lib/subcontract-offer'
import { parseListFile } from '../src/lib/parse-list-file'
import type { SubcontractPackage } from '../src/lib/subcontract'
import type { ListDoc, Position } from '../src/lib/types'

Object.assign(globalThis, { DOMParser })

const path = [{ oz: '1', label: 'Rohbau' }, { oz: '1.1', label: 'Baustelle' }]
const pos = (id: string, oz: string, qty: number, up: number | null = null): Position =>
  ({ id, oz, short: `Pos ${oz}`, long: '', qty, unit: 'm', up, category: 'Baustelle', path })
const positions = [pos('a', '1.1.10', 10), pos('b', '1.1.20', 5), pos('c', '1.1.30', 2, 7), pos('d', '1.1.40', 1)]
const doc: ListDoc = {
  id: 'x', folderId: 'f', fileName: 'LV.pdf', title: 'LV', currency: 'EUR', format: 'PDF', date: '2026-01-01', positions,
  positionsCount: 4, pricedCount: 1, categories: 1, total: 0, source: { kind: 'pdf' },
}
const pkg = (chosenId?: string, extra: Partial<SubcontractPackage> = {}): SubcontractPackage => ({
  id: 'p', name: 'Baustelle', positionIds: ['a', 'b'], subcontractorIds: ['s1', 's2'], budget: { perPosition: { a: 999, b: 999 }, total: 1998 }, format: 'x83', status: 'sent',
  chosenId, offers: { s1: { prices: { a: 3, b: 4 } }, s2: { prices: { a: 2, b: 9 } } }, ...extra,
})
const sure = new Map([['d', { price: 11, unitKnown: true }]])
const listTotal = (ps: readonly Position[]) => ps.reduce((s, p) => s + (p.up ?? 0) * p.qty, 0)

test('matchOffer: prices per position, LV quantity, qtyDiffs', () => {
  const r = matchOffer(positions.slice(0, 2), { positions: [{ oz: '1.1.10', qty: 12, up: 3 }, { oz: '1.1.20', qty: 5, up: 4 }] })
  assert.deepEqual(r.prices, { a: 3, b: 4 })
  assert.equal(r.amount, 10 * 3 + 5 * 4)
  assert.equal(r.qtyDiffs, 1)
})

test('an open package counts its own items in the total', () => {
  const m = offerModel(positions, [pkg()], sure)
  assert.equal(m.open.length, 1)
  assert.equal(m.total, 7 * 2 + 11)
  assert.equal(m.unpriced, 2)
})

test('an offer without amount or prices shows no amount and counts nothing', () => {
  const m = offerModel(positions, [pkg('s1', { offers: { s1: {} } })], sure)
  assert.equal(m.chosen[0].noAmount, true)
  assert.equal(m.noAmountCount, 1)
  assert.equal(m.total, 7 * 2 + 11)
})

test('an old offer with only an amount still counts its amount, and is flagged', () => {
  const m = offerModel(positions, [pkg('s1', { offers: { s1: { amount: 500, missing: [] } } })], sure)
  assert.equal(m.total, 500 + 7 * 2 + 11)
  assert.equal(m.legacyCount, 1)
  assert.deepEqual(m.apply.map((a) => a.id), ['d'])
})

test('after applying the prices the screen total equals the list total and the exported file', async () => {
  const packages = [pkg('s2')]
  const m = offerModel(positions, packages, sure)
  assert.equal(m.total, 10 * 2 + 5 * 9 + 7 * 2 + 11)
  assert.deepEqual(m.apply.map((a) => [a.id, a.price, a.source]), [['a', 2, 'sub'], ['b', 9, 'sub'], ['d', 11, 'db']])
  const applied = positions.map((p) => { const a = m.apply.find((x) => x.id === p.id); return a ? { ...p, up: a.price } : p })
  assert.equal(offerModel(applied, packages, sure).total, listTotal(applied))
  assert.equal(m.total, listTotal(offerPositions(positions, packages, sure)))
  assert.equal(offerModel(applied, packages, sure).apply.length, 0)
})

test('own prices win over subcontractor prices and nothing is overwritten', () => {
  const own = positions.map((p) => (p.id === 'a' ? { ...p, up: 50 } : p))
  const m = offerModel(own, [pkg('s2')], sure)
  assert.deepEqual(m.apply.map((a) => a.id), ['b', 'd'])
  assert.equal(offerPositions(own, [pkg('s2')], sure)[0].up, 50)
})

test('X84 export: <DP>84</DP>, unit prices survive a re-read, and no budget appears', async () => {
  const out = offerPositions(positions, [pkg('s2')], sure)
  const res = await exportList({ doc, resolved: { positions: out, tree: [] }, format: 'x84', edited: false, now: new Date('2026-01-01T10:00:00Z') })
  const xml = new TextDecoder().decode(res.data)
  assert.match(xml, /<DP>84<\/DP>/)
  assert.match(res.fileName, /\.X84$/)
  assert.equal(xml.includes('999'), false)
  const back = await parseListFile(new File([xml], 'LV.X84'))
  assert.equal(back?.phase, 'X84')
  assert.deepEqual(back?.positions.map((p) => p.up), [2, 9, 7, 11])
})
