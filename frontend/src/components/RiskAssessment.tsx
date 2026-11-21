import { clsx } from 'clsx'
import { Icon, inputCls } from './ui'
import { RISK_STYLE, SEVERITIES, type Finding, type Severity } from '../lib/risk-assessment'

export function FindingBadge({ severity, children }: { severity: Severity; children?: React.ReactNode }) {
  const style = RISK_STYLE[severity]
  return <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold', style.chip)}>
    <Icon name={style.icon} size={13} />{children ?? style.label}
  </span>
}

export function FindingText({ finding }: { finding: Finding }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <FindingBadge severity={finding.severity} />
        <span className="font-medium text-slate-500">Layer {finding.layer}</span>
      </div>
      <h4 className="font-semibold text-slate-900">{finding.title}</h4>
      <p className="mt-0.5 text-slate-700">{finding.message}</p>
      {finding.suggested_fix?.rationale && <p className="mt-1 text-slate-600">{finding.suggested_fix.rationale}</p>}
    </div>
  )
}

const severityLabels = { error: 'Errors', warning: 'Warnings', info: 'Information' }

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

  const sortedTypes = [...types].sort(([, a], [, b]) => a.title.localeCompare(b.title))
  return (
    <div className="relative inline-flex max-w-full items-center">
      <Icon name="flag" size={16} className="pointer-events-none absolute left-3 text-slate-500" />
      <select aria-label="Filter rows by finding" value={value} onChange={(e) => onChange(e.target.value)}
        className={clsx(inputCls, 'h-9 w-44 truncate py-0 pr-6 pl-9 font-medium', value !== 'all' && 'border-brand-300 bg-brand-50 text-brand-800')}>
        <option value="all">All rows</option>
        <option value="flagged">Flagged rows ({flagged})</option>
        <option value="reviewed">Reviewed rows ({reviewedRows})</option>
        <optgroup label="Severity">
          {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severityLabels[severity]} ({severities.get(severity) ?? 0})</option>)}
        </optgroup>
        {sortedTypes.length > 0 && <optgroup label="Finding type">
          {sortedTypes.map(([id, type]) => <option key={id} value={`rule:${id}`}>{type.title} ({type.count})</option>)}
        </optgroup>}
      </select>
    </div>
  )
}
