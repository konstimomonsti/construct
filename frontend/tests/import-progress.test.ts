import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimatePct, expectedMs, overallPercent, recordDuration } from '../src/lib/import-progress'

test('overallPercent is the size-weighted mean', () => {
  assert.equal(overallPercent([]), 0)
  assert.equal(overallPercent([{ size: 100, pct: 50 }]), 50)
  assert.equal(overallPercent([{ size: 300, pct: 100 }, { size: 100, pct: 0 }]), 75)
})

test('estimatePct eases out and never reaches 95 %', () => {
  assert.equal(estimatePct(0, 5000), 0)
  const at1 = estimatePct(5000, 5000)
  assert.ok(at1 > 0.55 && at1 < 0.68, String(at1))
  const at25 = estimatePct(12500, 5000)
  assert.ok(at25 > 0.85 && at25 <= 0.92, String(at25))
  assert.ok(estimatePct(10_000_000, 5000) <= 0.95)
  assert.ok(estimatePct(2000, 5000) < estimatePct(4000, 5000))
})

test('expectedMs has a floor and works without storage', () => {
  assert.equal(expectedMs(1024), 4000)
  assert.equal(expectedMs(1024 * 1000), 25_000)
  recordDuration(1024, 100) // no localStorage in node: must not throw
})
