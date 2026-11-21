import { clsx } from 'clsx'
import { useState } from 'react'
import { Button, Icon } from './ui'
import { RISK_STYLE, SEVERITIES, type Finding, type Severity, type useRiskAssessment } from '../lib/risk-assessment'
import type { Position } from '../lib/types'

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
      <h3 className="font-semibold text-slate-900">{finding.title}</h3>
      <p className="mt-0.5 text-slate-700">{finding.message}</p>
      {finding.suggested_fix?.rationale && <p className="mt-1 text-slate-600">{finding.suggested_fix.rationale}</p>}
    </div>
  )
}

export function RiskAssessment({
  assessment, positions, affected, onEdit, onlyFlagged, onToggleFlagged,
}: {
  assessment: ReturnType<typeof useRiskAssessment>
  positions: Position[]
  affected: Map<string, Set<string>>
  onEdit: (id: string, field?: string | null) => void
  onlyFlagged: boolean
  onToggleFlagged: () => void
}) {
  const [severity, setSeverity] = useState<Severity | null>(null)
  const [showAll, setShowAll] = useState(false)
  const { report, stale, running, error, aiAvailable, includeAi, setIncludeAi, assess } = assessment
  const visible = report?.findings.filter((finding) => !severity || finding.severity === severity) ?? []
  const positionsById = new Map(positions.map((p) => [p.id, p]))

  return (
    <section aria-label="Risk assessment" className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Icon name="rule" size={18} className="text-brand-700" />Risk assessment
          </h2>
          {stale ? (
            <p role="status" className="mt-1 text-xs font-medium text-amber-800">List changed. Run the assessment again to refresh the findings.</p>
          ) : (
            <p className="mt-1 text-xs text-slate-600">
              {report ? `Layers ${report.layers_run.join(', ')} checked${report.used_source ? ' · Original GAEB cross-checked' : ''}` :
                'Check quantities, prices, descriptions, and construction dependencies.'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className={clsx('inline-flex items-center gap-1.5 text-xs', aiAvailable ? 'text-slate-700' : 'text-slate-500')}
            title={aiAvailable ? undefined : 'Layer 3 needs a configured AI provider'}>
            <input type="checkbox" disabled={running || !aiAvailable} checked={includeAi} onChange={(e) => setIncludeAi(e.target.checked)} />
            {aiAvailable ? 'Include AI review' : 'AI review unavailable'}
          </label>
          <Button variant="primary" size="sm" icon="play_arrow" onClick={() => { setSeverity(null); setShowAll(false); void assess() }}
            disabled={running || !positions.length}>
            {running ? 'Assessing…' : report ? 'Run again' : 'Run assessment'}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-xs text-rose-800">{error}</p>}
      {report?.source_notice && <p className="mt-3 text-xs text-slate-600">{report.source_notice}</p>}
      {!!report?.errors.length && (
        <details className="mt-3 text-xs text-amber-800">
          <summary className="cursor-pointer">Some checks could not run</summary>
          <ul className="mt-1 list-disc pl-5">{report.errors.map((message, i) => <li key={i}>{message}</li>)}</ul>
        </details>
      )}
      {report && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter findings by severity">
              {SEVERITIES.map((value) => {
                const count = report.summary.by_severity[value] ?? 0
                return (
                  <button key={value} type="button" aria-pressed={severity === value} disabled={!count}
                    className={clsx('rounded-md ring-brand-600 disabled:opacity-50', severity === value && 'ring-1 ring-offset-1')}
                    onClick={() => { setSeverity(severity === value ? null : value); setShowAll(false) }}>
                    <FindingBadge severity={value}>{count} {RISK_STYLE[value].label.toLowerCase()}{count !== 1 ? 's' : ''}</FindingBadge>
                  </button>
                )
              })}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-700">
              <input type="checkbox" checked={onlyFlagged} disabled={!report.findings.length} onChange={onToggleFlagged} />
              Flagged rows only
            </label>
          </div>
          {report.findings.length ? (
            <>
              <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {visible.slice(0, showAll ? undefined : 8).map((finding) => {
                  const ids = affected.get(finding.id) ?? new Set<string>()
                  const rows = [...ids].map((id) => positionsById.get(id)).filter((p) => p !== undefined)
                  return (
                    <li key={finding.id} className="flex flex-wrap items-start justify-between gap-2 p-3 text-xs">
                      <FindingText finding={finding} />
                      <div className="flex flex-wrap gap-1">
                        {rows.slice(0, 3).map((row) => (
                          <Button key={row.id} size="sm" icon="edit" onClick={() => onEdit(row.id, finding.target.field)}>
                            Edit {row.oz}
                          </Button>
                        ))}
                        {rows.length > 3 && <span className="self-center text-slate-500">+{rows.length - 3} rows</span>}
                      </div>
                    </li>
                  )
                })}
              </ul>
              {visible.length > 8 && !showAll && (
                <Button size="sm" className="mt-2" onClick={() => setShowAll(true)}>Show all {visible.length} findings</Button>
              )}
            </>
          ) : <p className="mt-3 text-xs font-medium text-emerald-800">No findings from the completed checks.</p>}
        </div>
      )}
    </section>
  )
}
