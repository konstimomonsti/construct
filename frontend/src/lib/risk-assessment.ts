import { useEffect, useMemo, useRef, useState } from 'react'
import type { CategoryNode, ListDoc, Position } from './types'

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
  scope: string
  title: string
  message: string
  target: { line_id: string | null; line_code: string | null; section_id: string | null; field: string | null }
  related_line_ids: string[]
  suggested_fix: { rationale: string } | null
}

type Report = {
  findings: Finding[]
  errors: string[]
  layers_run: number[]
  used_source: boolean
  source_notice: string | null
  summary: { by_severity: Partial<Record<Severity, number>> }
}

type Section = { id: string; parent_id: string | null; title: string; code_parts: string[] }

export function buildAssessment(doc: ListDoc, positions: Position[], tree: CategoryNode[]) {
  const phase = doc.phase?.match(/^(?:X|D)?(8[1-6])$/i)?.[1] ?? null
  const currency = /^[A-Z]{3}$/.test(doc.currency) ? doc.currency : null
  const sections: Section[] = []
  function visit(nodes: CategoryNode[], parent_id: string | null = null) {
    for (const node of nodes) {
      sections.push({ id: node.oz, parent_id, title: node.label, code_parts: phase ? node.oz.split('.') : [] })
      visit(node.children, node.oz)
    }
  }
  visit(tree)
  const bid = phase === '84' || phase === '86'
  return {
    project: { currency, gaeb_phase: phase, source_document: { filename: doc.fileName, format: doc.source?.kind } },
    bom: { title: doc.title },
    sections,
    lines: positions.map((position) => ({
      id: position.id,
      code: position.oz || null,
      section_id: position.path?.at(-1)?.oz,
      short_text: position.short === '(ohne Kurztext)' ? null : position.short,
      long_text: position.long,
      quantity: position.qty,
      unit: position.unit,
      pricing_basis: position.lumpSum || /^psch\.?$/i.test(position.unit) ? 'lump_sum' : 'unit_rate',
      ...(bid
        ? { source_amounts: { unit_price: position.up } }
        : position.up != null ? { price: { unit_price: position.up, currency, source: 'client' } } : {}),
    })),
  }
}

export function findingRows(finding: Finding, positions: Position[]) {
  const ids = new Set(finding.related_line_ids)
  if (finding.target.line_id) ids.add(finding.target.line_id)
  if (!ids.size && finding.target.section_id) {
    const section = finding.target.section_id
    for (const position of positions) {
      if (position.path?.some((part) => part.oz === section)) ids.add(position.id)
    }
  }
  return ids
}

export function useRiskAssessment(snapshot: ReturnType<typeof buildAssessment>, doc: ListDoc, originalId?: string) {
  const [aiAvailable, setAiAvailable] = useState(false)
  const [includeAi, setIncludeAi] = useState(false)
  const [run, setRun] = useState<{ report: Report; basis: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const basis = useMemo(() => JSON.stringify(snapshot), [snapshot])
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/workspace/analysis', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((result) => { if (result?.ai_available) setAiAvailable(true) })
      .catch(() => {})
    return () => {
      controller.abort()
      pending.current?.abort()
    }
  }, [])

  async function assess() {
    if (running || !snapshot.lines.length) return
    setRunning(true)
    setError('')
    const controller = new AbortController()
    pending.current = controller
    try {
      const params = new URLSearchParams()
      if (originalId && (doc.source?.kind === 'gaeb-xml' || doc.source?.kind === 'gaeb90')) {
        params.set('id', doc.id)
        params.set('original', originalId)
      }
      const response = await fetch(`/api/workspace/analysis?${params}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshot,
          layers: includeAi ? [1, 2, 3] : [1, 2],
          original_codes: params.has('original') ? Object.fromEntries(doc.positions.map((p) => [p.id, p.oz])) : undefined,
        }),
      })
      const result = await response.json()
      if (!response.ok || !Array.isArray(result.findings)) {
        throw new Error(result.error || 'The risk assessment could not be completed.')
      }
      if (!controller.signal.aborted) setRun({ report: result, basis })
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message)
    } finally {
      if (!controller.signal.aborted) setRunning(false)
      pending.current = null
    }
  }

  return { report: run?.report ?? null, stale: !!run && run.basis !== basis, running, error,
    aiAvailable, includeAi, setIncludeAi, assess }
}
