import { useEffect, useState } from 'react'
import type { Position } from './types'

export type Severity = 'error' | 'warning' | 'info'
export const SEVERITIES: Severity[] = ['error', 'warning', 'info']
export const RISK_STYLE = {
  error: { label: 'Error', icon: 'error', chip: 'bg-rose-100 text-rose-800', row: 'bg-rose-50 hover:bg-rose-100/75 max-lg:bg-rose-50' },
  warning: { label: 'Warning', icon: 'warning', chip: 'bg-amber-100 text-amber-900', row: 'bg-amber-50 hover:bg-amber-100/75 max-lg:bg-amber-50' },
  info: { label: 'Info', icon: 'info', chip: 'bg-sky-100 text-sky-800', row: 'bg-sky-50 hover:bg-sky-100/75 max-lg:bg-sky-50' },
} as const

export type Finding = {
  id: string
  layer: number
  rule_id: string
  severity: Severity
  title: string
  message: string
  target: { line_id: string | null; section_id: string | null; field: string | null }
  related_line_ids: string[]
  suggested_fix: { rationale: string } | null
}

type Report = { findings: Finding[]; errors: string[]; source_notice: string | null }
type Assessment = { state: 'waiting' | 'failed' | 'unavailable' } | { state: 'ready'; report: Report }

export function indexFindings(findings: Finding[], positions: Position[]) {
  const byRow = new Map<string, Finding[]>()
  const listWide: Finding[] = []
  const bySection = new Map<string, string[]>()
  for (const position of positions) {
    for (const part of position.path ?? []) {
      const members = bySection.get(part.oz)
      if (members) members.push(position.id)
      else bySection.set(part.oz, [position.id])
    }
  }
  for (const finding of findings) {
    const ids = new Set(finding.related_line_ids)
    if (finding.target.line_id) ids.add(finding.target.line_id)
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

export function matchesFindingFilter(filter: string, findings: Finding[], reviewed: Set<string>) {
  if (filter === 'all') return true
  if (filter === 'reviewed') return findings.some((finding) => reviewed.has(finding.id))
  return findings.some((finding) => !reviewed.has(finding.id) && (
    filter === 'flagged' || filter === finding.severity || filter === `rule:${finding.rule_id}`
  ))
}

export function useUploadAssessment(id: string | null): Assessment | null {
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
          setAssessment({ state: 'ready', report: result.report })
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
  }, [id])
  return id ? assessment : null
}
