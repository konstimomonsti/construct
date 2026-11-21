import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLists } from '../src/lib/gaeb-diff'
import type { Position } from '../src/lib/types'
import { budgetStatus } from '../src/lib/format'
import { markVersions, type ListView } from '../src/lib/store'

const basePositions: Position[] = [
  { id: 'p1', oz: '01.01.0010', short: 'Baustelleneinrichtung', qty: 1, unit: 'psch', up: null, category: '01' },
  { id: 'p2', oz: '01.01.0020', short: 'Bauzaun mieten', qty: 100, unit: 'm', up: null, category: '01' },
  { id: 'p3', oz: '01.01.0030', short: 'Entsorgung Bauschutt', qty: 50, unit: 't', up: 20, category: '01' },
]

test('diffLists detects added prices and quantity changes', () => {
  const modified: Position[] = [
    { id: 'p1', oz: '01.01.0010', short: 'Baustelleneinrichtung', qty: 1, unit: 'psch', up: 5000, category: '01' },
    { id: 'p2', oz: '01.01.0020', short: 'Bauzaun mieten (korrigiert)', qty: 120, unit: 'm', up: 15, category: '01' },
    { id: 'p3', oz: '01.01.0030', short: 'Entsorgung Bauschutt', qty: 50, unit: 't', up: 25, category: '01' },
  ]

  const diff = diffLists(basePositions, modified)
  assert.equal(diff.pricesAdded, 2) // p1 and p2 got prices
  assert.equal(diff.pricesChanged, 1) // p3 price changed from 20 to 25
  assert.equal(diff.qtysChanged, 1) // p2 qty changed from 100 to 120
  assert.equal(diff.textsChanged, 1) // p2 text changed
  assert.equal(diff.baselineTotal, 1000) // 50 * 20
  assert.equal(diff.currentTotal, 5000 + (120 * 15) + (50 * 25)) // 5000 + 1800 + 1250 = 8050
  assert.equal(diff.deltaTotal, 7050)
  assert.ok(diff.byPositionId.has('p1'))
  assert.ok(diff.byPositionId.has('p2'))
  assert.ok(diff.byPositionId.has('p3'))
})

test('diffLists detects added and removed lines', () => {
  const modified: Position[] = [
    { id: 'p1', oz: '01.01.0010', short: 'Baustelleneinrichtung', qty: 1, unit: 'psch', up: null, category: '01' },
    { id: 'p4', oz: '01.01.0040', short: 'Zusatzleistung', qty: 10, unit: 'Stk', up: 100, category: '01' },
  ]

  const diff = diffLists(basePositions, modified)
  assert.equal(diff.linesAdded, 1) // p4 added
  assert.equal(diff.linesRemoved, 2) // p2 and p3 removed
})

test('cross-file comparisons require explicit stable identities', () => {
  // Simulates X84 offer vs X86 award from different files where IDs are different
  const awardPositions: Position[] = [
    { id: 'award_uuid_1', oz: '01.01.0010', short: 'Baustelleneinrichtung', qty: 1, unit: 'psch', up: 4800, category: '01' },
    { id: 'award_uuid_2', oz: '01.01.0020', short: 'Bauzaun mieten', qty: 100, unit: 'm', up: 12, category: '01' },
    { id: 'award_uuid_3', oz: '01.01.0030', short: 'Entsorgung Bauschutt', qty: 50, unit: 't', up: 20, category: '01' },
  ]

  const unknown = diffLists(basePositions, awardPositions, 'linked-revisions')
  assert.equal(unknown.linesAdded, 3)
  assert.equal(unknown.linesRemoved, 3)
  const identified = (rows: Position[]) => rows.map((position, index) => ({ ...position, positionKey: `shared-${index}` }))
  const diff = diffLists(identified(basePositions), identified(awardPositions).reverse(), 'linked-revisions')
  assert.equal(diff.linesAdded, 0)
  assert.equal(diff.linesRemoved, 0)
  assert.equal(diff.pricesAdded, 2) // p1 and p2 got prices
  assert.equal(diff.currentTotal, 4800 + (100 * 12) + (50 * 20)) // 4800 + 1200 + 1000 = 7000
})

test('diffLists handles reordered positions cleanly via OZ matching', () => {
  const reordered: Position[] = [
    { id: 'p3', oz: '01.01.0030', short: 'Entsorgung Bauschutt', qty: 50, unit: 't', up: 20, category: '01' },
    { id: 'p1', oz: '01.01.0010', short: 'Baustelleneinrichtung', qty: 1, unit: 'psch', up: null, category: '01' },
    { id: 'p2', oz: '01.01.0020', short: 'Bauzaun mieten', qty: 100, unit: 'm', up: null, category: '01' },
  ]
  const diff = diffLists(basePositions, reordered)
  assert.equal(diff.totalChanges, 0)
  assert.equal(diff.linesAdded, 0)
  assert.equal(diff.linesRemoved, 0)
})

test('budgetStatus handles exact cap boundary and threshold progression', () => {
  // Below 75%
  assert.equal(budgetStatus(70000, 100000).word, 'On track')
  assert.equal(budgetStatus(70000, 100000).tone, 'ok')

  // 75% - 89% (near cap)
  assert.equal(budgetStatus(75000, 100000).word, 'Near cap')
  assert.equal(budgetStatus(75000, 100000).tone, 'caution')

  // 90% - 99% (almost at cap)
  assert.equal(budgetStatus(95000, 100000).word, 'Almost at cap')
  assert.equal(budgetStatus(95000, 100000).tone, 'warn')

  // Exact cap boundary (100.0%)
  const exact = budgetStatus(100000, 100000)
  assert.equal(exact.word, 'At cap')
  assert.equal(exact.tone, 'warn')
  assert.equal(exact.pct, 100)

  // Over cap (> 100%)
  const over = budgetStatus(100001, 100000)
  assert.equal(over.word, 'Over cap')
  assert.equal(over.tone, 'over')
})

test('markVersions validates currency, phase progression, and duplicate awards', () => {
  const dummyList = (id: string, fileName: string, phaseCode: string, currency = 'EUR'): ListView => ({
    id,
    fileName,
    phaseCode,
    phaseName: phaseCode,
    currency,
    folderId: 'f1',
    title: fileName,
    total: 10000,
    pricedCount: 5,
    positionsCount: 5,
    phase: phaseCode,
    phaseIdentity: { packageId: 'eur-package', revision: id },
    phasePositionKeys: ['shared-1'],
  })

  // 1. Phase progression: 83 is superseded by 86, but 86 is NOT superseded by 83
  const tender = dummyList('l1', 'tender.X83', 'X83')
  const offer = { ...dummyList('l2', 'renamed.X84', 'X84'),
    phaseLink: { predecessorId: 'l1', predecessorRevision: 'l1', revision: 'l2' } }
  const award = { ...dummyList('l3', 'renamed-again.X86', 'X86'),
    phaseLink: { predecessorId: 'l2', predecessorRevision: 'l2', revision: 'l3' } }
  const versions = markVersions([tender, offer, award])

  const vTender = versions.find((v) => v.id === 'l1')!
  const vOffer = versions.find((v) => v.id === 'l2')!
  const vAward = versions.find((v) => v.id === 'l3')!
  assert.equal(vTender.supersededBy, 'X86')
  assert.equal(vOffer.supersededBy, 'X86')
  assert.equal(vAward.supersededBy, undefined)
  assert.equal(vTender.pairedX86Id, 'l3')

  // 2. Currency mismatch: tender in EUR, different tender with same stem in CHF -> not grouped!
  const chfTender = dummyList('l_chf', 'tender.X83', 'X83', 'CHF')
  const chfOffer = { ...dummyList('l_chf_offer', 'tender.X84', 'X84', 'CHF'),
    phaseLink: { predecessorId: 'l1', predecessorRevision: 'l1', revision: 'l_chf_offer' } }
  const mixed = markVersions([tender, chfTender, chfOffer])
  const mixedEur = mixed.find((v) => v.id === 'l1')!
  const mixedChf = mixed.find((v) => v.id === 'l_chf')!
  assert.equal(mixedEur.supersededBy, undefined) // Not superseded by CHF offer
  assert.equal(mixedChf.supersededBy, undefined)

  // 3. Duplicate award warning
  // Same folder, same stem "tender" if file is tender_2.x86
  const dup1 = dummyList('d1', 'contract.X86', 'X86')
  const dup2 = dummyList('d2', 'contract.X86', 'X86')
  const markedDups = markVersions([dup1, dup2])
  assert.equal(markedDups[0].duplicateAwardWarning, true)
  assert.equal(markedDups[1].duplicateAwardWarning, true)
})
