/** Check the fix planner against findings from the normal upload assessment. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { planFixes } from '../src/lib/apply-fix'
import { resolveList } from '../src/lib/resolve'
import type { Finding } from '../src/lib/risk-assessment'
import type { ListDoc } from '../src/lib/types'

const pipe = 'L2.SANITARY.POTABLE_WATER_NEEDS_PIPE_INSULATION'
const measured = new Map([
  ['L2.FLOOR.SCREED_NEEDS_PRIMER_AND_LEVELING', 80],
  ['L2.FLOOR.SCREED_NEEDS_FLOOR_COVERING', 80],
  [pipe, 10],
])
const unmeasured = [
  'L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION',
  'L2.SANITARY.POTABLE_WATER_NEEDS_PRESSURE_TEST',
]

const file = process.argv[2]
assert.ok(file, 'Provide the findings file from analysis.eval.uploads --write-fix-input.')
const lines = (await readFile(file, 'utf8')).trim().split('\n')
for (const line of lines) {
  const { path, document, findings } = JSON.parse(line) as { path: string; document: ListDoc; findings: Finding[] }
  const conflicted = basename(path).startsWith('fix-planning-conflict.')
  const expected = new Map(measured)
  if (conflicted) expected.delete(pipe)
  const positions = resolveList(document).positions
  assert.equal(positions.length, 2, path)
  let id = 0
  const plans = planFixes(findings, positions, positions, () => `replay-${++id}`)
  const added = plans.flatMap(({ finding, plan }) => plan.steps.flatMap((step) =>
    step.kind === 'add' ? [{ rule: finding.rule_id, ...step.position }] : []))
  assert.equal(added.length, expected.size, path)
  assert.equal(new Set([...positions, ...added].map((position) => position.oz)).size, positions.length + added.length, path)
  for (const entry of added) assert.equal(entry.qty, expected.get(entry.rule), path)
  if (conflicted) {
    const sourceConflict = findings.find((finding) => finding.rule_id === 'L1.QTY.WRITTEN_CONFLICT')
    const dependency = findings.find((finding) => finding.rule_id === pipe)
    assert.ok(sourceConflict?.source_locator, path)
    assert.equal(dependency?.evidence?.reason, 'quantity_not_assessable', path)
    assert.ok(!dependency?.suggested_fix?.operations?.length, path)
  }
  const pending = conflicted ? unmeasured.slice(0, 1) : unmeasured
  for (const rule of pending) {
    const item = plans.find(({ finding }) => finding.rule_id === rule)
    assert.match(item?.plan.skipped[0]?.reason ?? '', /Confirm the quantity and unit/, `${path} ${rule}`)
  }
  const changed = positions.map((position, index) => index === 0 ? { ...position, qty: position.qty + 5 } : position)
  const stale = planFixes(findings, changed, positions, () => 'stale')
  assert.ok(stale.every(({ plan }) => plan.steps.every((step) => step.kind !== 'add')), path)
  console.log(`${path}\t${added.length} measured additions\t${pending.length} unmeasured reviews\tstale additions held${conflicted ? "\tpipe fix held by source conflict" : ""}`)
}
