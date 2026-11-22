import { useEffect, useState } from 'react'
import { partialAnalysis } from './risk-labels'
import { round2 } from './money'
import type { Position } from './types'
import type { FixOperation } from './apply-fix'

export type Severity = 'error' | 'warning' | 'info'
export const SEVERITIES: Severity[] = ['error', 'warning', 'info']
export const RISK_STYLE = {
  error: { label: 'Critical', icon: 'error', chip: 'bg-rose-100 text-rose-800', row: 'bg-rose-50 hover:bg-rose-100/75 max-lg:bg-rose-50' },
  warning: { label: 'Warning', icon: 'warning', chip: 'bg-amber-100 text-amber-900', row: 'bg-amber-50 hover:bg-amber-100/75 max-lg:bg-amber-50' },
  info: { label: 'Info', icon: 'info', chip: 'bg-sky-100 text-sky-800', row: 'bg-sky-50 hover:bg-sky-100/75 max-lg:bg-sky-50' },
} as const

export type Evidence = {
  din?: { grade?: string; exposure?: string[]; required_min?: string }
  extracted?: Record<string, unknown>
  bieterfrage_de?: string
  amount_at_stake?: string
  change_order?: boolean
  standard?: string
  excerpt?: string
  clause?: string
  dependency_review?: { verdict?: string; quote?: string; quote_line_code?: string; reason?: string }
  [key: string]: unknown
}

export type Finding = {
  id: string
  review_key?: string
  layer: number
  rule_id: string
  category?: string
  severity: Severity
  scope?: 'line' | 'section' | 'area' | 'bom'
  title: string
  message: string
  target: { line_id: string | null; line_code?: string | null; section_id: string | null; field: string | null }
  related_line_ids: string[]
  evidence?: Evidence
  suggested_fix: { rationale: string; operations?: FixOperation[]; confidence?: number } | null
  origin?: 'rule' | 'llm'
  model?: string | null
}

/** contract v0.2 (CLAUDE.md §5.4); decimals are strings */
export type ChangeOrderSignal = {
  id: string; kind: string; line_id: string | null; line_code: string | null
  title: string; message: string; points: number; finding_ids: string[]
}
export type ReviewItem = Finding | ChangeOrderSignal

export const findingCategory = (category: string) => category === 'din'
  ? 'DIN 1045-2' : category.charAt(0).toUpperCase() + category.slice(1).replaceAll('_', ' ')

export type TopRisk = {
  line_id: string; line_code: string; short_text: string; points: number
  amount: string | null; reasons: string[]; item_ids: string[]
}
export type Risk = {
  version: string
  score: number
  level: RiskLevel
  scale: number
  priced: boolean
  currency: string
  money_at_stake: string | null
  points: Record<string, number>
  open_counts: Record<Severity, number>
  top_risks: TopRisk[]
  by_section: { section_id: string | null; code: string | null; title: string | null; points: number; open: number }[]
  by_category: Record<string, number>
  change_order_signals: ChangeOrderSignal[]
  item_sections?: Record<string, string | null>
  item_exposure?: Record<string, [string, string]>
}
export type Question = { id: string; topic: string; text_de: string; line_codes: string[]; finding_ids: string[]; rule_id: string | null }

export const openQuestions = (questions: Question[], decisions: Decisions) =>
  questions.filter((question) => !question.finding_ids.length || question.finding_ids.some((id) => decisions[id]?.status !== 'dismissed'))

export type AdvisoryStatus = {
  state: 'disabled' | 'no-candidates' | 'complete' | 'degraded' | 'unavailable'
  provider: string | null
  audit_provider: string | null
  planned: number
  attempted: number
  validated: number
  cached: number
  failed: number
  skipped: number
  dropped: number
  reasons: string[]
}

export type Report = {
  run_id?: string
  findings: Finding[]
  errors: string[]
  source_notice: string | null
  layers_run?: number[]
  l3_status?: AdvisoryStatus | null
  summary?: Record<string, unknown>
  risk?: Risk | null
  review_metrics?: Pick<Risk, 'item_sections' | 'item_exposure'> | null
  questions?: Question[] | null
  outdated?: boolean
  assessed_revision?: number
  target_revision?: number
  assessed_edits?: unknown
  graph_valid?: boolean | null
  totals?: {
    currency: string | null
    working_net: string | null
    complete: boolean
    counted_positions: number
    missing_amounts: number
    source_net: string | null
  } | null
  phase_validation?: { state: 'unverified' | 'invalid' | 'verified'; reason?: string; predecessor_id?: string; matched_positions?: number; missing_positions?: string[]; added_positions?: string[] }
  cap_comparison?:
    | { state: 'unverified' | 'unavailable'; reason: string }
    | { state: 'over' | 'at' | 'almost' | 'near' | 'under'; cap: string; working_net: string; currency: string; confirmation_reference: string }
  reopened_finding_ids?: string[]
  state?: string
}

export function dependencyReviewLines(finding: Finding): string[] {
  const review = finding.evidence?.dependency_review
  if (!review?.verdict) return []
  const title = review.verdict === 'included' ? 'AI found possible coverage'
    : review.verdict === 'excluded' ? 'AI found a possible scope exclusion' : 'AI found no additional coverage'
  return [
    title,
    ...(review.quote ? [`${review.quote_line_code ? `Position ${review.quote_line_code} · ` : ''}“${review.quote}”`] : []),
    ...(review.reason ? [review.reason] : []),
  ]
}

export function reportRisk(report: Report | null): Risk | null {
  const risk = report?.risk
  return risk ? { ...risk, ...report?.review_metrics } : null
}

export function analysisCoverage(report: Report): { message: string; details: string[]; partial: boolean } {
  const status = report.l3_status
  if (!status) {
    const legacy = partialAnalysis(report.errors)
    if (legacy) return { ...legacy, message: `Based on partial analysis. ${legacy.message}`, partial: true }
    return {
      message: report.layers_run?.includes(3) === false ? 'Rules-only analysis.' : 'AI coverage is unknown for this report.',
      details: [], partial: false,
    }
  }
  const details = status.reasons
  switch (status.state) {
    case 'disabled': return { message: 'Rules-only analysis.', details: [], partial: false }
    case 'no-candidates': return { message: 'Rules-only results. No positions qualified for AI checks.', details, partial: false }
    case 'complete': return { message: `AI checks complete (${status.validated}/${status.planned} batches).`, details, partial: false }
    case 'degraded': return {
      message: `Based on partial analysis. AI validated ${status.validated} of ${status.planned} batches with ${status.dropped} rejected items.`,
      details, partial: true,
    }
    case 'unavailable': return { message: 'AI checks unavailable. Rules results remain available.', details, partial: true }
  }
}
export type AssessmentState = 'waiting' | 'ready' | 'stale' | 'partial' | 'failed' | 'unavailable'
export type Assessment =
  | { state: 'waiting' | 'failed' | 'unavailable'; report?: Report | null }
  | { state: 'ready' | 'stale' | 'partial'; report: Report }

function sameSnapshotValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => sameSnapshotValue(value, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left).filter(key => left[key] !== undefined)
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length
    && keys.every(key => sameSnapshotValue(left[key], right[key]))
}

export function assessmentMatchesEdits(report: Report, edits: unknown): boolean {
  return report.assessed_revision != null && report.target_revision === report.assessed_revision
    && report.outdated !== true && sameSnapshotValue(report.assessed_edits ?? null, edits ?? null)
}

export function canApplyAssessmentFix(assessment: Assessment | null, edits: unknown): boolean {
  return !!assessment && (assessment.state === 'ready' || assessment.state === 'partial')
    && assessment.report.graph_valid === true && assessmentMatchesEdits(assessment.report, edits)
}

/* ------------------------------------------------------------------ */
/* Reviewer decisions (CLAUDE.md §5.5)                                 */
/* ------------------------------------------------------------------ */

export type DecisionReason = 'not_an_error' | 'covered_elsewhere' | 'by_client' | 'will_ask_client' | 'other'
export type Decision = { status: 'accepted' | 'dismissed'; reason?: DecisionReason; note?: string; at: string; applied?: string; reviewKey?: string }
export type Decisions = Record<string, Decision>
export const REASONS: Record<DecisionReason, string> = {
  not_an_error: 'Not an error',
  covered_elsewhere: 'Covered elsewhere',
  by_client: 'Provided by the client',
  will_ask_client: 'Will ask the client',
  other: 'Other',
}

/** decisions of a list, falling back to the legacy "reviewed" ids (read as accepted) */
export function decisionsOf(patch: { findingDecisions?: Decisions; reviewedFindings?: string[] } | undefined): Decisions {
  if (patch?.findingDecisions) return patch.findingDecisions
  return Object.fromEntries((patch?.reviewedFindings ?? []).map((id) => [id, { status: 'accepted', at: '' } satisfies Decision]))
}

export function currentDecisions(decisions: Decisions, report: Report | null): Decisions {
  if (!report) return decisions
  const byId = new Map(report.findings.map(finding => [finding.id, finding.review_key]))
  const reopened = new Set(report.reopened_finding_ids)
  return Object.fromEntries(Object.entries(decisions).filter(([id, decision]) =>
    !byId.has(id) || (decision.reviewKey == null ? !reopened.has(id) : decision.reviewKey === byId.get(id)),
  ))
}

/** sets (or with null, clears) the decision of several items; keeps the legacy reviewedFindings in sync */
export function applyDecision(current: Decisions, ids: string[], decision: Decision | null) {
  const findingDecisions = { ...current }
  for (const id of ids) {
    if (decision) findingDecisions[id] = decision
    else delete findingDecisions[id]
  }
  return { findingDecisions, reviewedFindings: Object.keys(findingDecisions) }
}

/* ------------------------------------------------------------------ */
/* Live score                                                          */
/* ------------------------------------------------------------------ */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export const levelOf = (score: number): RiskLevel => (score < 25 ? 'low' : score < 50 ? 'medium' : score < 75 ? 'high' : 'critical')

/** §5.4: score = round(100 * S / (S + scale)), S = points of items without a decision */
export function rescore(risk: Pick<Risk, 'points' | 'scale'>, decisions: Decisions) {
  let open = 0
  for (const [id, points] of Object.entries(risk.points)) if (!decisions[id]) open += points
  const score = open > 0 ? Math.round((100 * open) / (open + risk.scale)) : 0
  return { score, level: levelOf(score), openPoints: open }
}

export function openExposure(risk: Risk, decisions: Decisions): string | null {
  if (!risk.priced || !risk.item_exposure) return risk.money_at_stake
  const byLine = new Map<string, number>()
  for (const [id, [line, expected]] of Object.entries(risk.item_exposure)) {
    if (!decisions[id]) byLine.set(line, Math.max(Number(expected), byLine.get(line) ?? 0))
  }
  return round2([...byLine.values()].reduce((sum, amount) => sum + amount, 0)).toFixed(2)
}

export function openSections(risk: Risk, decisions: Decisions): Risk['by_section'] {
  if (!risk.item_sections) return risk.by_section
  const bySection = new Map(risk.by_section.map(section => [section.section_id, { ...section, points: 0, open: 0 }]))
  for (const [id, key] of Object.entries(risk.item_sections)) {
    const section = bySection.get(key)
    if (!decisions[id] && section) {
      section.open++
      section.points += risk.points[id] ?? 0
    }
  }
  return [...bySection.values()].sort((a, b) => b.points - a.points)
}

export function indexFindings(findings: Finding[], positions: Position[]) {
  const byRow = new Map<string, Finding[]>()
  const listWide: Finding[] = []
  const bySection = new Map<string, string[]>()
  const positionIds = new Set(positions.map((position) => position.id))
  for (const position of positions) {
    for (const part of position.path ?? []) {
      const members = bySection.get(part.oz)
      if (members) members.push(position.id)
      else bySection.set(part.oz, [position.id])
    }
  }
  for (const finding of findings) {
    const ids = new Set(finding.related_line_ids.filter((id) => positionIds.has(id)))
    if (finding.target.line_id && positionIds.has(finding.target.line_id)) ids.add(finding.target.line_id)
    if (!ids.size && finding.target.section_id) {
      for (const id of bySection.get(finding.target.section_id) ?? []) ids.add(id)
    }
    if (!ids.size) listWide.push(finding)
    for (const id of ids) {
      const row = byRow.get(id)
      if (row) row.push(finding)
      else byRow.set(id, [finding])
    }
  }
  return { byRow, listWide }
}

export function matchesFindingFilter(filter: string, findings: ReviewItem[], reviewed: Set<string>) {
  if (filter === 'all') return true
  if (filter === 'reviewed') return findings.some((finding) => reviewed.has(finding.id))
  return findings.some((item) => {
    if (reviewed.has(item.id)) return false
    if (filter === 'flagged') return true
    if (!('severity' in item)) return filter === 'change-orders'
    return filter === item.severity || filter === `rule:${item.rule_id}` || filter === `category:${item.category}`
  })
}

export function useUploadAssessment(id: string | null): Assessment | null {
  const [current, setCurrent] = useState<{ id: string; assessment: Assessment } | null>(null)
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let missing = 0
    const setAssessment = (assessment: Assessment) => setCurrent({ id, assessment })
    const url = `/api/workspace/analysis?id=${encodeURIComponent(id)}`
    async function refresh() {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
        if (controller.signal.aborted) return
        if (response.status === 404) { // The upload may still be syncing.
          setAssessment({ state: ++missing < 10 ? 'waiting' : 'unavailable' })
          timer = setTimeout(refresh, missing < 10 ? 2000 : 10000)
          return
        }
        if (!response.ok) throw new Error()
        missing = 0
        const result = await response.json()
        if (controller.signal.aborted) return
        if ((result.state === 'ready' || result.state === 'partial') && Array.isArray(result.report?.findings)) {
          setAssessment({ state: result.state, report: result.report })
          timer = setTimeout(refresh, 4000)
        } else if (result.state === 'stale' && Array.isArray(result.report?.findings)) {
          setAssessment({ state: 'stale', report: result.report })
          timer = setTimeout(refresh, 2000)
        } else if (result.state === 'failed') {
          setAssessment({ state: 'failed', report: result.report })
          timer = setTimeout(refresh, 5000)
        } else if (result.state === 'queued' || result.state === 'running') {
          if (Array.isArray(result.report?.findings)) {
            setAssessment({ state: 'stale', report: result.report })
          } else {
            setAssessment({ state: 'waiting' })
          }
          timer = setTimeout(refresh, 2000)
        } else {
          throw new Error()
        }
      } catch {
        if (!controller.signal.aborted) {
          setAssessment({ state: 'unavailable' })
          timer = setTimeout(refresh, 5000)
        }
      }
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [id])
  if (!id) return null
  return current?.id === id ? current.assessment : { state: 'waiting' }
}
