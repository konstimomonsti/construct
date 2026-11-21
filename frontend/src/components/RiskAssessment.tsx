import { clsx } from 'clsx'
import { Icon, Menu, type MenuItem } from './ui'
import { ToolButton } from './Kit'
import { SEVERITIES, type Finding, type Severity } from '../lib/risk-assessment'

/**
 * severity colours for the risk UI, built on the themed status tokens so they hold in dark mode.
 * A note has no colour of its own: it is information, not a problem, so it stays neutral.
 */
export const RISK_UI: Record<Severity, { label: string; plural: string; icon: string; chip: string; row: string }> = {
  error: { label: 'Error', plural: 'Errors', icon: 'error', chip: 'bg-rose-50 text-rose-800 ring-rose-600/40', row: 'bg-rose-50/70 hover:bg-rose-50' },
  warning: { label: 'Warning', plural: 'Warnings', icon: 'warning', chip: 'bg-amber-50 text-amber-900 ring-amber-500/50', row: 'bg-amber-50/60 hover:bg-amber-50' },
  info: { label: 'Note', plural: 'Notes', icon: 'info', chip: 'bg-slate-100 text-slate-700 ring-slate-400/70', row: 'hover:bg-slate-100' },
}

export function FindingBadge({ severity, children }: { severity: Severity; children?: React.ReactNode }) {
  const style = RISK_UI[severity]
  return (
    <span className={clsx('inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-[13px] font-semibold ring-1 ring-inset', style.chip)}>
      <Icon name={style.icon} size={15} fill className="shrink-0" />
      {children ?? style.label}
    </span>
  )
}

export function FindingText({ finding }: { finding: Finding }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <FindingBadge severity={finding.severity} />
        <h4 className="text-[15px] font-semibold text-slate-900">{finding.title}</h4>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-700">{finding.message}</p>
      {finding.suggested_fix?.rationale && <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-600">{finding.suggested_fix.rationale}</p>}
      <p className="mt-1 text-[13px] text-slate-500">Check layer {finding.layer}</p>
    </div>
  )
}

/** filter rows by their upload findings: flagged, reviewed, a severity or one kind of finding */
export function FindingFilter({ rows, reviewed, value, onChange }: {
  rows: Finding[][]
  reviewed: Set<string>
  value: string
  onChange: (value: string) => void
}) {
  const severities = new Map<Severity, number>()
  const types = new Map<string, { title: string; count: number }>()
  let flagged = 0
  let reviewedRows = 0
  for (const findings of rows) {
    const open = findings.filter((finding) => !reviewed.has(finding.id))
    if (open.length) flagged++
    if (open.length < findings.length) reviewedRows++
    for (const severity of new Set(open.map((finding) => finding.severity))) {
      severities.set(severity, (severities.get(severity) ?? 0) + 1)
    }
    const openTypes = new Set(open.map((finding) => finding.rule_id))
    for (const [id, title] of new Map(findings.map((finding) => [finding.rule_id, finding.title]))) {
      types.set(id, { title, count: (types.get(id)?.count ?? 0) + Number(openTypes.has(id)) })
    }
  }
  if (!types.size && value === 'all') return null

  const option = (key: string, label: string, count?: number, icon?: string): MenuItem => ({
    label, icon, checked: value === key, hint: count === undefined ? undefined : String(count), onSelect: () => onChange(key),
  })
  const sortedTypes = [...types].sort(([, a], [, b]) => a.title.localeCompare(b.title))
  const items: (MenuItem | 'sep')[] = [
    option('all', 'All rows'),
    option('flagged', 'Flagged rows', flagged),
    option('reviewed', 'Reviewed rows', reviewedRows),
    'sep',
    ...SEVERITIES.filter((severity) => severities.get(severity)).map((severity) => option(severity, RISK_UI[severity].plural, severities.get(severity), RISK_UI[severity].icon)),
    ...(sortedTypes.length ? ['sep' as const, ...sortedTypes.map(([id, type]) => option(`rule:${id}`, type.title, type.count))] : []),
  ]
  const current = value === 'all' ? null
    : value === 'flagged' ? 'Flagged'
    : value === 'reviewed' ? 'Reviewed'
    : value.startsWith('rule:') ? types.get(value.slice(5))?.title ?? 'Finding'
    : RISK_UI[value as Severity]?.plural ?? null

  return (
    <Menu
      label="Filter rows by finding"
      width="w-72"
      items={items}
      trigger={(p) => (
        <ToolButton {...p} icon="flag" active={!!current}>
          <span className="max-w-[16ch] truncate">{current ?? 'Findings'}</span>
          {!current && flagged > 0 && <span className="num rounded bg-amber-50 px-1.5 text-[13px] font-semibold text-amber-900 ring-1 ring-amber-500/50 ring-inset">{flagged}</span>}
        </ToolButton>
      )}
    />
  )
}
