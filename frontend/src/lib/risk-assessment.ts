import { useEffect, useState } from 'react'
import type { Position } from './types'

export type Severity = 'error' | 'warning' | 'info'
export const SEVERITIES: Severity[] = ['error', 'warning', 'info']
export const RISK_STYLE = {
  error: { label: 'Error', icon: 'error', chip: 'bg-rose-100 text-rose-800', row: 'bg-rose-50 hover:bg-rose-100/75 max-lg:bg-rose-50' },
  warning: { label: 'Warning', icon: 'warning', chip: 'bg-amber-100 text-amber-900', row: 'bg-amber-50 hover:bg-amber-100/75 max-lg:bg-amber-50' },
  info: { label: 'Info', icon: 'info', chip: 'bg-sky-100 text-sky-800', row: 'bg-sky-50 hover:bg-sky-100/75 max-lg:bg-sky-50' },
} as const

export type Evidence = {
  din?: { grade?: string | null; exposure?: string[]; required_min?: string | null }
  din_standard?: { identifier: string; edition: string; url: string }
  declarations?: { manufacturer: string; product_code: string; document: string; revision: string; locator: string }[]
  requirement?: { document: string; locator: string }
  extracted?: Record<string, unknown>
  bieterfrage_de?: string
  amount_at_stake?: string
  family?: string
  short_quote?: string
  long_quote?: string
  grade_quote?: string
  grade_field?: string
  exposure_quote?: string
  exposure_field?: string
  change_order?: boolean
  [key: string]: unknown
}

export type Finding = {
  id: string
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
  source_locator?: { page?: number; ocr_pages?: number[]; record?: number | string; source_id?: string; row?: number; sheet?: string; table?: number; paragraph?: number } | null
  suggested_fix: { rationale: string } | null
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
  by_section: { section_id: string; code: string; title: string; points: number; open: number }[]
  by_category: Record<string, number>
  change_order_signals: ChangeOrderSignal[]
}
export type Question = { id: string; topic: string; text_de: string; line_codes: string[]; finding_ids: string[]; rule_id: string | null }

export type Report = {
  findings: Finding[]
  product_evidence_files?: string[]
  errors: string[]
  source_notice: string | null
  layers_run?: number[]
  summary?: Record<string, unknown>
  risk?: Risk | null
  questions?: Question[] | null
}
type Assessment = { state: 'waiting' | 'failed' | 'unavailable' } | { state: 'ready'; report: Report }

/* ------------------------------------------------------------------ */
/* Reviewer decisions (CLAUDE.md §5.5)                                 */
/* ------------------------------------------------------------------ */

export type DecisionReason = 'not_an_error' | 'covered_elsewhere' | 'by_client' | 'will_ask_client' | 'other'
export type Decision = { status: 'accepted' | 'dismissed'; reason?: DecisionReason; note?: string; at: string }
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

export function useUploadAssessment(id: string | null, evidenceSignature = ''): Assessment | null {
  const [assessment, setAssessment] = useState<Assessment>({ state: 'waiting' })
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const url = `/api/workspace/analysis?id=${encodeURIComponent(id)}`
    async function refresh() {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
        if (controller.signal.aborted) return
        if (response.status === 404) { // The upload may still be syncing.
          timer = setTimeout(refresh, 2000)
          return
        }
        if (!response.ok) throw new Error()
        const result = await response.json()
        if (controller.signal.aborted) return
        if (result.state === 'ready' && Array.isArray(result.report?.findings)) {
          const report: Report = result.report
          if ([...(report.product_evidence_files ?? [])].sort().join(',') === evidenceSignature) {
            setAssessment({ state: 'ready', report })
          } else {
            setAssessment({ state: 'waiting' })
            timer = setTimeout(refresh, 2000)
          }
        } else if (result.state === 'failed') {
          setAssessment({ state: 'failed' })
        } else if (result.state === 'queued') {
          setAssessment({ state: 'waiting' })
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
  }, [id, evidenceSignature])
  if (!id) return null
  if (assessment.state === 'ready' && [...(assessment.report.product_evidence_files ?? [])].sort().join(',') !== evidenceSignature) {
    return { state: 'waiting' }
  }
  return assessment
}
