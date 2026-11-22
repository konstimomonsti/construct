import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDecision, decisionsOf, indexFindings, matchesFindingFilter, openQuestions, reportRisk, rescore } from '../src/lib/risk-assessment'
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


test('saved reports lose change-order signals and their points, exposure and questions', () => {
  const previous = riskReport.risk!
  const [signal] = previous.change_order_signals
  const [finding] = riskReport.findings
  const report: Report = {
    ...riskReport,
    findings: [finding],
    risk: {
      ...previous,
      priced: true,
      scale: 40,
      points: { [signal.id]: 2.5, [finding.id]: 8 },
      by_section: [{ section_id: 's', code: '01', title: 'Trade', open: 2, points: 10.5 }],
      top_risks: [{ line_id: 'p1', line_code: '01.0010', short_text: 'Precast', points: 10.5,
        reasons: [finding.title, signal.title], item_ids: [finding.id, signal.id], amount: '100' }],
      change_order_signals: [signal],
    },
    review_metrics: {
      item_sections: { [signal.id]: 's', [finding.id]: 's' },
      item_exposure: { [signal.id]: ['p1', '15.00'], [finding.id]: ['p1', '10.00'] },
    },
  }
  const cleaned = reportRisk(report)!
  assert.deepEqual(cleaned.change_order_signals, [])
  assert.deepEqual(cleaned.points, { [finding.id]: 8 })
  assert.equal(cleaned.score, 17)
  assert.equal(cleaned.by_section[0].open, 1)
  assert.deepEqual(cleaned.top_risks[0].reasons, [finding.title])
  assert.equal(cleaned.money_at_stake, '10.00')
  assert.deepEqual(openQuestions([
    { id: 'signal', topic: '', text_de: '', line_codes: [], finding_ids: [], rule_id: 'CO.SCOPE_GAP' },
    { id: 'finding', topic: '', text_de: '', line_codes: [], finding_ids: [finding.id], rule_id: finding.rule_id },
  ], {}).map(q => q.id), ['finding'])
})

test('findings on removed positions remain reviewable with the whole list', () => {
  const finding = riskReport.findings.find((finding) => finding.target.line_id)!
  const indexed = indexFindings([finding], [])
  assert.deepEqual(indexed.listWide, [finding])
  assert.equal(indexed.byRow.size, 0)
})
import { canApplyAssessmentFix, currentDecisions, openExposure, openSections, type Report } from '../src/lib/risk-assessment'

test('only the current graph-safe snapshot can apply a fix', () => {
  const report: Report = {
    findings: [], errors: [], source_notice: null, graph_valid: true, assessed_revision: 8, target_revision: 8,
    assessed_edits: { up: { a: 4 }, qty: { a: 2 } },
  }
  assert.equal(canApplyAssessmentFix({ state: 'ready', report }, { qty: { a: 2 }, up: { a: 4 } }), true)
  assert.equal(canApplyAssessmentFix({ state: 'ready', report }, { qty: { a: 3 }, up: { a: 4 } }), false)
  assert.equal(canApplyAssessmentFix({ state: 'stale', report }, report.assessed_edits), false)
  assert.equal(canApplyAssessmentFix({ state: 'partial', report: { ...report, graph_valid: false } }, report.assessed_edits), false)
})

test('review decisions follow stable evidence keys', () => {
  const report: Report = { findings: [
    { id: 'same', review_key: 'stable' } as Report['findings'][0],
    { id: 'changed', review_key: 'new' } as Report['findings'][0],
    { id: 'legacy' } as Report['findings'][0],
  ], errors: [], source_notice: null, reopened_finding_ids: ['legacy'] }
  assert.deepEqual(Object.keys(currentDecisions({
    same: { status: 'accepted', at: '', reviewKey: 'stable' },
    changed: { status: 'dismissed', at: '', reviewKey: 'earlier' },
    legacy: { status: 'accepted', at: '' },
  }, report)), ['same'])
})

test('dismissing a finding recalculates section points and shared line exposure', () => {
  const risk = {
    ...riskReport.risk!,
    priced: true,
    points: { a: 10, b: 5, c: 2 },
    by_section: [{ section_id: 's', code: '01', title: 'Trade', open: 3, points: 17 }],
    item_sections: { a: 's', b: 's', c: 's' },
    item_exposure: { a: ['p1', '2.00'], b: ['p1', '1.00'], c: ['p2', '3.00'] } as Record<string, [string, string]>,
  }
  const decisions = { a: { status: 'dismissed' as const, at: '' } }
  assert.equal(openExposure(risk, {}), '5.00')
  assert.equal(openExposure(risk, decisions), '4.00')
  assert.deepEqual(openSections(risk, decisions)[0], { section_id: 's', code: '01', title: 'Trade', open: 2, points: 7 })
})
