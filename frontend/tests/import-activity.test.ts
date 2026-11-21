import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { startImport, useImportActivity } from '../src/lib/import-activity'

const names = () => useImportActivity.getState().importing

beforeEach(() => useImportActivity.setState({ importing: [] }))

test('start adds the names and the returned function removes them', () => {
  const done = startImport(['a.pdf', 'b.x83'])
  assert.deepEqual(names(), ['a.pdf', 'b.x83'])
  done()
  assert.deepEqual(names(), [])
})

test('calling the stop function twice is harmless', () => {
  const first = startImport(['a.pdf'])
  const second = startImport(['a.pdf'])
  first()
  first()
  assert.deepEqual(names(), ['a.pdf'])
  second()
  assert.deepEqual(names(), [])
})

test('overlapping batches only remove their own names', () => {
  const one = startImport(['a.pdf', 'b.pdf'])
  const two = startImport(['c.xlsx'])
  assert.deepEqual(names(), ['a.pdf', 'b.pdf', 'c.xlsx'])
  one()
  assert.deepEqual(names(), ['c.xlsx'])
  two()
  assert.deepEqual(names(), [])
})
