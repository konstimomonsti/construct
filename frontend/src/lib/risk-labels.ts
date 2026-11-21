import type { Position } from './types'
import type { Decisions, Report, Risk } from './risk-assessment'

const CATEGORY: Record<string, string> = {
  change_order: 'Change-order risk', din: 'DIN 1045-2', dependency: 'Missing work',
  arithmetic: 'Sums', text: 'Text', unit: 'Units', price: 'Prices',
  quantity: 'Quantities', scope: 'Scope', completeness: 'Completeness', optimization: 'Optimization',
}

export function categoryLabel(id: string): string {
  return CATEGORY[id] ?? id.replaceAll('_', ' ').replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
}

export function layer3Coverage(errors: string[]): { run: number; planned: number; skipped: number; details: string } | null {
  const line = errors.find((error) => /^layer 3 coverage: \d+\/\d+ batches(?:; skipped: .+)?$/.test(error))
  if (!line) return null
  const match = /^layer 3 coverage: (\d+)\/(\d+) batches/.exec(line)!
  const run = Number(match[1]), planned = Number(match[2])
  return { run, planned, skipped: Math.max(0, planned - run), details: line }
}

export function sectionPoints(risk: Risk, report: Report, positions: Position[], decisions: Decisions) {
  const byLine = new Map(positions.map((position) => [position.id, position]))
  const sections = risk.by_section.map((section) => ({ ...section, points: 0, open: 0 }))
  const sectionFor = (lineId: string | null | undefined, sectionId?: string | null) => {
    const direct = sections.find((section) => section.section_id === sectionId || section.code === sectionId)
    if (direct) return direct
    const path = lineId ? byLine.get(lineId)?.path ?? [] : []
    return sections.find((section) => path.some((part) => part.oz === section.code || part.oz === section.section_id))
  }
  for (const finding of report.findings) {
    if (decisions[finding.id]) continue
    const section = sectionFor(finding.target.line_id ?? finding.related_line_ids[0], finding.target.section_id)
    if (section) { section.points += risk.points[finding.id] ?? 0; section.open++ }
  }
  for (const signal of risk.change_order_signals) {
    if (decisions[signal.id]) continue
    const section = sectionFor(signal.line_id)
    if (section) { section.points += risk.points[signal.id] ?? 0; section.open++ }
  }
  return sections
}

export function categoryPoints(risk: Risk, report: Report, decisions: Decisions) {
  const points = new Map<string, number>()
  for (const finding of report.findings) {
    if (!decisions[finding.id]) {
      const category = finding.category || 'other'
      points.set(category, (points.get(category) ?? 0) + (risk.points[finding.id] ?? 0))
    }
  }
  for (const signal of risk.change_order_signals) {
    if (!decisions[signal.id]) points.set('change_order', (points.get('change_order') ?? 0) + (risk.points[signal.id] ?? 0))
  }
  return [...points].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1])
}
