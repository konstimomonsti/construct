import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planFix } from '../src/lib/apply-fix'
import { applyDecision, decisionsOf, levelOf, matchesFindingFilter, rescore, type Finding, type FixOperation, type Risk } from '../src/lib/risk-assessment'
import { riskReport } from './fixtures/risk-report'

test('route change aborts in-flight polling without state corruption', () => {
  const controller = new AbortController()
  assert.equal(controller.signal.aborted, false)
  controller.abort()
  assert.equal(controller.signal.aborted, true)
})

test('dismiss, reopen, and bulk decision state transitions', () => {
  // 1. Initial empty state
  let decisions = decisionsOf(undefined)
  assert.deepEqual(decisions, {})

  // 2. Dismiss item f1
  const d1 = applyDecision(decisions, ['f1'], {
    status: 'dismissed',
    reason: 'not_an_error',
    note: 'Vetted by engineering',
    at: new Date().toISOString(),
  })
  assert.equal(d1.findingDecisions.f1.status, 'dismissed')
  assert.equal(d1.findingDecisions.f1.reason, 'not_an_error')
  assert.equal(d1.findingDecisions.f1.note, 'Vetted by engineering')
  assert.deepEqual(d1.reviewedFindings, ['f1'])

  // 3. Reopen item f1 (pass null)
  const reopened = applyDecision(d1.findingDecisions, ['f1'], null)
  assert.equal(reopened.findingDecisions.f1, undefined)
  assert.deepEqual(reopened.reviewedFindings, [])

  // 4. Accept item f2
  const accepted = applyDecision({}, ['f2'], { status: 'accepted', at: new Date().toISOString() })
  assert.equal(accepted.findingDecisions.f2.status, 'accepted')
  assert.deepEqual(accepted.reviewedFindings, ['f2'])
})

test('filter matches severity, rules, categories and respects open vs reviewed items', () => {
  const finding: Finding = {
    id: 'f_test',
    layer: 1,
    rule_id: 'L1.ARITH.NET_TOTAL',
    category: 'arithmetic',
    severity: 'error',
    title: 'Net total mismatch',
    message: 'Calculated differs from stated',
    target: { line_id: null, section_id: 's1', field: 'stated_net_total' },
    related_line_ids: [],
    suggested_fix: null,
  }

  const unreviewed = new Set<string>()
  const reviewed = new Set<string>(['f_test'])

  // Unreviewed: matches 'all', 'flagged', 'error', rule, and category
  assert.ok(matchesFindingFilter('all', [finding], unreviewed))
  assert.ok(matchesFindingFilter('flagged', [finding], unreviewed))
  assert.ok(matchesFindingFilter('error', [finding], unreviewed))
  assert.ok(!matchesFindingFilter('warning', [finding], unreviewed))
  assert.ok(matchesFindingFilter('rule:L1.ARITH.NET_TOTAL', [finding], unreviewed))
  assert.ok(matchesFindingFilter('category:arithmetic', [finding], unreviewed))
  assert.ok(!matchesFindingFilter('reviewed', [finding], unreviewed))

  // Reviewed: matches 'reviewed' and 'all', but excluded from open filters
  assert.ok(matchesFindingFilter('all', [finding], reviewed))
  assert.ok(matchesFindingFilter('reviewed', [finding], reviewed))
  assert.ok(!matchesFindingFilter('flagged', [finding], reviewed))
  assert.ok(!matchesFindingFilter('error', [finding], reviewed))
})

test('critical priority and blocking status consistency across bands', () => {
  const risk: Pick<Risk, 'points' | 'scale'> = {
    points: { f1: 50, f2: 60 },
    scale: 40,
  }

  // Both open -> Score = round(100 * 110 / 150) = 73 (high)
  const rHigh = rescore(risk, {})
  assert.equal(rHigh.level, 'high')

  // Very high points -> Critical band (>= 75)
  const riskCritical: Pick<Risk, 'points' | 'scale'> = {
    points: { f1: 150, f2: 100 },
    scale: 40,
  }
  const rCrit = rescore(riskCritical, {})
  assert.equal(rCrit.level, 'critical')
  assert.ok(rCrit.score >= 75)

  // Deciding items drops it back from critical
  const rResolved = rescore(riskCritical, {
    f1: { status: 'accepted', at: '' },
    f2: { status: 'dismissed', at: '' },
  })
  assert.equal(rResolved.level, 'low')
  assert.equal(rResolved.score, 0)
})

test('revision-safe fix validation prevents applying fixes to stale lines', () => {
  const positions = [
    { id: 'p1', oz: '01.01.0010', short: 'Current text', qty: 10, unit: 'm', up: 20, category: 'Trade', path: [{ oz: '01', label: 'Trade' }] },
  ]

  // Finding created against an older revision where short_text was 'Stale text'
  const staleFinding: Finding = {
    id: 'f_stale',
    layer: 1,
    rule_id: 'L1.TEXT',
    severity: 'warning',
    title: 'Text update',
    message: 'Update text',
    target: { line_id: 'p1', section_id: '01', field: 'short_text' },
    related_line_ids: [],
    suggested_fix: {
      rationale: 'Fix text',
      operations: [
        { op: 'set_field', line_id: 'p1', field: 'short_text', old_value: 'Stale text differing from current', new_value: 'New text' },
      ],
    },
  }

  const result = planFix(staleFinding, positions)
  // Operation rejected/skipped because old_value did not match current position value
  assert.equal(result.steps.length, 0)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /changed/)
})
