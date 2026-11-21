import { clsx } from 'clsx'
import { Icon, Menu, type MenuItem } from './ui'
import { ToolButton } from './Kit'
import { SEVERITIES, type Finding, type Severity } from '../lib/risk-assessment'

/**
 * severity colours for the risk UI, built on the themed status tokens so they hold in dark mode.
 * Findings are outlined flag chips, so they never read as the filled budget chips ("Near cap");
 * a flagged row carries a 3px severity bar on its leading edge instead of a full-row tint.
 */
export const RISK_UI: Record<Severity, { label: string; plural: string; icon: string; chip: string; row: string; bar: string }> = {
  error: { label: 'Error', plural: 'Errors', icon: 'flag', chip: 'text-rose-800 ring-rose-600', row: '[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-rose-600)]', bar: 'border-rose-600' },
  warning: { label: 'Warning', plural: 'Warnings', icon: 'flag', chip: 'text-amber-900 ring-amber-500', row: '[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-amber-500)]', bar: 'border-amber-500' },
  info: { label: 'Note', plural: 'Notes', icon: 'flag', chip: 'text-slate-700 ring-slate-400', row: '[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-slate-400)]', bar: 'border-slate-400' },
}

export function FindingBadge({ severity, children }: { severity: Severity; children?: React.ReactNode }) {
  const style = RISK_UI[severity]
  return (
    <span className={clsx('inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-white px-1.5 text-[13px] font-semibold ring-1 ring-inset', style.chip)}>
      <Icon name={style.icon} size={15} fill className="shrink-0" />
      {children ?? style.label}
    </span>
  )
}

/** one finding: a severity bar on the leading edge, the badge and title, then the explanation */
export function FindingText({ finding, reviewed, changed, hideRationale }: { finding: Finding; reviewed?: boolean; changed?: boolean; hideRationale?: boolean }) {
  const muted = reviewed || changed
  return (
    <div className={clsx('min-w-0 border-l-[3px] pl-3', muted ? 'border-slate-300' : RISK_UI[finding.severity].bar)}>
      <div className="flex flex-wrap items-center gap-2">
        {reviewed ? (
          <span className="inline-flex h-6 items-center gap-1 rounded-md bg-slate-100 px-1.5 text-[13px] font-semibold text-slate-700">
            <Icon name="check" size={15} className="shrink-0" />Reviewed
          </span>
        ) : changed ? (
          <span className="inline-flex h-6 items-center gap-1 rounded-md bg-slate-100 px-1.5 text-[13px] font-semibold text-slate-700">
            <Icon name="edit" size={15} className="shrink-0" />Changed since upload
          </span>
        ) : <FindingBadge severity={finding.severity} />}
        <h4 className={clsx('text-[15px] font-semibold', muted ? 'text-slate-700' : 'text-slate-900')}>{finding.title}</h4>
      </div>
      {changed && !reviewed && <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-700">You edited this value after the upload check. The note below describes the uploaded version.</p>}
      <p className={clsx('mt-1 text-sm leading-relaxed text-pretty', muted ? 'text-slate-600' : 'text-slate-700')}>{finding.message}</p>
      {!hideRationale && finding.suggested_fix?.rationale && <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-600">{finding.suggested_fix.rationale}</p>}
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
    option('all', 'All positions'),
    option('flagged', 'Flagged positions', flagged),
    option('reviewed', 'Reviewed positions', reviewedRows),
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
      label="Filter positions by upload check"
      width="w-72"
      items={items}
      trigger={(p) => (
        <ToolButton {...p} icon="flag" active={!!current}>
          <span className="max-w-[16ch] truncate">{current ?? 'Upload check'}</span>
          {!current && flagged > 0 && (
            <span className="num rounded bg-amber-50 px-1.5 text-[13px] font-semibold text-amber-900 ring-1 ring-amber-500/50 ring-inset">
              {flagged}<span className="sr-only"> flagged {flagged === 1 ? 'position' : 'positions'}</span>
            </span>
          )}
        </ToolButton>
      )}
    />
  )
}
