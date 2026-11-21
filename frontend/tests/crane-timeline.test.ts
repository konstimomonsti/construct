import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLists } from '../src/lib/gaeb-diff'
import type { Position } from '../src/lib/types'

test('lifecycle progression diff: X83 -> X84 -> X86', () => {
  // Stage 1: X83 Tender received from client (unpriced)
  const x83Positions: Position[] = [
    { id: 'pos-1', oz: '01.01.0010', short: 'Baustelleneinrichtung', qty: 1, unit: 'psch', up: null, category: '01' },
    { id: 'pos-2', oz: '01.01.0020', short: 'Bauzaun aufstellen', qty: 100, unit: 'm', up: null, category: '01' },
    { id: 'pos-3', oz: '01.02.0010', short: 'Erdarbeiten Aushub', qty: 500, unit: 'm3', up: null, category: '01' },
  ]

  // Stage 2: X84 Offer generated and priced by contractor
  const x84Positions: Position[] = [
    { id: 'pos-1', oz: '01.01.0010', short: 'Baustelleneinrichtung', qty: 1, unit: 'psch', up: 12000, category: '01' },
    { id: 'pos-2', oz: '01.01.0020', short: 'Bauzaun aufstellen', qty: 100, unit: 'm', up: 25, category: '01' },
    { id: 'pos-3', oz: '01.02.0010', short: 'Erdarbeiten Aushub', qty: 500, unit: 'm3', up: 45, category: '01' },
  ]

  const diffX84vsX83 = diffLists(x83Positions, x84Positions)
  assert.equal(diffX84vsX83.pricesAdded, 3)
  assert.equal(diffX84vsX83.baselineTotal, 0)
  assert.equal(diffX84vsX83.currentTotal, 12000 + (100 * 25) + (500 * 45)) // 12000 + 2500 + 22500 = 37000
  assert.equal(diffX84vsX83.deltaTotal, 37000)

  // Stage 3: X86 Award received with client price cuts
  const x86Positions: Position[] = [
    { id: 'pos-1', oz: '01.01.0010', short: 'Baustelleneinrichtung', qty: 1, unit: 'psch', up: 10000, category: '01' }, // cut by 2000
    { id: 'pos-2', oz: '01.01.0020', short: 'Bauzaun aufstellen', qty: 100, unit: 'm', up: 25, category: '01' },
    { id: 'pos-3', oz: '01.02.0010', short: 'Erdarbeiten Aushub', qty: 500, unit: 'm3', up: 40, category: '01' }, // cut by 5 per m3 (-2500)
  ]

  const diffX86vsX84 = diffLists(x84Positions, x86Positions)
  assert.equal(diffX86vsX84.pricesChanged, 2)
  assert.equal(diffX86vsX84.deltaTotal, -4500)
  assert.equal(diffX86vsX84.currentTotal, 32500)
})
