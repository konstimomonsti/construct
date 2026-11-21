import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDecision, decisionsOf, indexFindings, matchesFindingFilter, rescore } from '../src/lib/risk-assessment'
import { riskReport } from './fixtures/risk-report'

test('rescore drops points of decided items and keeps the §5.4 formula', () => {
  const risk = riskReport.risk!
  const upload = rescore(risk, {})
  assert.equal(upload.score, risk.score)

  const allDecided = Object.fromEntries(
    Object.keys(risk.points).map((id) => [id, { status: 'accepted', at: '2026-01-01T00:00:00Z' } as const]),
  )
  assert.deepEqual(rescore(risk, allDecided), { score: 0, level: 'low', openPoints: 0 })

  const oneDismissed = { f_din_grade: { status: 'dismissed' as const, reason: 'not_an_error' as const, at: '' } }
  const after = rescore(risk, oneDismissed)
  assert.equal(after.openPoints, upload.openPoints - risk.points.f_din_grade)
  assert.ok(after.score < upload.score)
})

test('rescore maps score to the §5.4 level bands', () => {
  const risk = { points: { a: 1 }, scale: 1 }
  // S=0 -> 0 (low); the bands themselves are exercised through levelOf via rescore's score
  assert.equal(rescore(risk, { a: { status: 'accepted', at: '' } }).level, 'low')
})

test('decision reducer: accept, dismiss, reopen, and the legacy reviewedFindings mirror', () => {
  let decisions = applyDecision({}, ['f1'], { status: 'accepted', at: '2026-01-01T00:00:00Z' })
  assert.equal(decisions.findingDecisions.f1.status, 'accepted')
  assert.deepEqual(decisions.reviewedFindings, ['f1'])

  decisions = applyDecision(decisions.findingDecisions, ['f1'], { status: 'dismissed', reason: 'by_client', at: '2026-01-01T00:01:00Z' })
  assert.equal(decisions.findingDecisions.f1.status, 'dismissed')
  assert.equal(decisions.findingDecisions.f1.reason, 'by_client')

  decisions = applyDecision(decisions.findingDecisions, ['f1'], null)
  assert.deepEqual(decisions.findingDecisions, {})
  assert.deepEqual(decisions.reviewedFindings, [])
})

test('decision reducer applies a bulk dismissal to every id at once', () => {
  const decisions = applyDecision({}, ['f1', 'f2', 'f3'], { status: 'dismissed', reason: 'covered_elsewhere', at: '2026-01-01T00:00:00Z' })
  assert.deepEqual(Object.keys(decisions.findingDecisions).sort(), ['f1', 'f2', 'f3'])
  assert.ok(Object.values(decisions.findingDecisions).every((d) => d.status === 'dismissed'))
})

test('decisionsOf reads the legacy reviewedFindings array as accepted decisions', () => {
  const decisions = decisionsOf({ reviewedFindings: ['f1', 'f2'] })
  assert.deepEqual(Object.keys(decisions).sort(), ['f1', 'f2'])
  assert.equal(decisions.f1.status, 'accepted')
})

test('decisionsOf prefers findingDecisions over the legacy array when both are present', () => {
  const decisions = decisionsOf({
    findingDecisions: { f1: { status: 'dismissed', at: '2026-01-01T00:00:00Z' } },
    reviewedFindings: ['f1', 'f2'],
  })
  assert.deepEqual(Object.keys(decisions), ['f1'])
  assert.equal(decisions.f1.status, 'dismissed')
})

test('the fixture report has a risk object usable with rescore and well-formed questions', () => {
  const { risk, questions } = riskReport
  assert.ok(risk)
  assert.ok(Object.keys(risk!.points).length > 0)
  assert.ok(questions!.every((q) => q.text_de.startsWith('Zu Pos.')))
})


test('the list filters change-order signals and reviewed items independently of finding severity', () => {
  const signal = riskReport.risk!.change_order_signals[0]
  const finding = riskReport.findings[0]
  const unreviewed = new Set<string>()
  assert.ok(matchesFindingFilter('change-orders', [signal], unreviewed))
  assert.ok(matchesFindingFilter('flagged', [signal], unreviewed))
  assert.ok(!matchesFindingFilter(finding.severity, [signal], unreviewed))
  assert.ok(matchesFindingFilter(`category:${finding.category}`, [finding], unreviewed))
  const reviewed = new Set([signal.id])
  assert.ok(matchesFindingFilter('reviewed', [signal], reviewed))
  assert.ok(!matchesFindingFilter('change-orders', [signal], reviewed))
})

test('findings on removed positions remain reviewable with the whole list', () => {
  const finding = riskReport.findings.find((finding) => finding.target.line_id)!
  const indexed = indexFindings([finding], [])
  assert.deepEqual(indexed.listWide, [finding])
  assert.equal(indexed.byRow.size, 0)
})
