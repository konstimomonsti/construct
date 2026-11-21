import { clsx } from 'clsx'
import { Icon, Menu, type MenuItem } from './ui'
import { ToolButton } from './Kit'
import { REASONS, SEVERITIES, type Decision, type Finding, type Severity } from '../lib/risk-assessment'

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

const statusChip = 'inline-flex h-6 items-center gap-1 rounded-md bg-slate-100 px-1.5 text-[13px] font-semibold text-slate-700'

/** what layer 3 or a DIN rule found, shown under the message in the drawer */
function FindingEvidence({ finding }: { finding: Finding }) {
  const din = finding.evidence?.din
  const extracted = Object.entries(finding.evidence?.extracted ?? {})
  if (!din && !extracted.length) return null
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') || '—' : String(v))
  return (
    <div className="mt-2 space-y-2 text-[13px]">
      {din && (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-slate-700">
          <span className="font-semibold text-slate-900">DIN 1045-2</span>
          {din.grade && <span>Grade <span className="num font-medium">{din.grade}</span></span>}
          {!!din.exposure?.length && <span>Exposure <span className="num font-medium">{din.exposure.join(', ')}</span></span>}
          {din.required_min && <span>Minimum <span className="num font-medium">{din.required_min}</span></span>}
        </p>
      )}
      {extracted.length > 0 && (
        <table className="w-full max-w-sm text-left">
          <caption className="mb-1 text-left font-semibold text-slate-900">Read from the text</caption>
          <tbody>
            {extracted.map(([key, value]) => (
              <tr key={key} className="border-t border-slate-200">
                <th scope="row" className="py-1 pr-3 font-medium text-slate-600">{key.replace(/_/g, ' ')}</th>
                <td className={clsx('num py-1', value == null ? 'text-amber-900' : 'text-slate-900')}>{show(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** one finding: a severity bar on the leading edge, the badge and title, then the explanation */
export function FindingText({ finding, reviewed, decision, changed, hideRationale, details }: {
  finding: Finding; reviewed?: boolean; decision?: Decision; changed?: boolean; hideRationale?: boolean; details?: boolean
}) {
  const decided = reviewed || !!decision
  const muted = decided || changed
  return (
    <div className={clsx('min-w-0 border-l-[3px] pl-3', muted ? 'border-slate-300' : RISK_UI[finding.severity].bar)}>
      <div className="flex flex-wrap items-center gap-2">
        {decision ? (
          <span className={statusChip}>
            <Icon name={decision.status === 'accepted' ? 'check' : 'block'} size={15} className="shrink-0" />
            {decision.status === 'accepted' ? 'Accepted' : `Dismissed${decision.reason ? ` · ${REASONS[decision.reason]}` : ''}`}
          </span>
        ) : reviewed ? (
          <span className={statusChip}><Icon name="check" size={15} className="shrink-0" />Reviewed</span>
        ) : changed ? (
          <span className={statusChip}><Icon name="edit" size={15} className="shrink-0" />Changed since upload</span>
        ) : <FindingBadge severity={finding.severity} />}
        {finding.origin === 'llm' && (
          <span title={finding.model ?? undefined} className="inline-flex h-6 items-center gap-1 rounded-md bg-brand-50 px-1.5 text-[13px] font-semibold text-brand-700 ring-1 ring-brand-300 ring-inset">
            <Icon name="auto_awesome" size={15} className="shrink-0" />AI check{details && finding.model ? ` · ${finding.model}` : ''}
          </span>
        )}
        <h4 className={clsx('text-[15px] font-semibold', muted ? 'text-slate-700' : 'text-slate-900')}>{finding.title}</h4>
      </div>
      {changed && !decided && <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-700">You edited this value after the upload check. The note below describes the uploaded version.</p>}
      <p className={clsx('mt-1 text-sm leading-relaxed text-pretty', muted ? 'text-slate-600' : 'text-slate-700')}>{finding.message}</p>
      {!hideRationale && finding.suggested_fix?.rationale && (
        <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-600">{details && <span className="font-semibold text-slate-700">Suggested fix: </span>}{finding.suggested_fix.rationale}</p>
      )}
      {details && <FindingEvidence finding={finding} />}
      {decision?.note && <p className="mt-1 text-sm text-slate-600">Note: {decision.note}</p>}
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
