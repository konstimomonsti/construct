import { clsx } from 'clsx'
import { int, money } from '../../lib/format'
import { openExposure, openSections, rescore, type analysisCoverage, type Decisions, type Risk, type RiskLevel } from '../../lib/risk-assessment'

const LEVEL: Record<RiskLevel, { label: string; text: string; bar: string }> = {
  low: { label: 'Low', text: 'text-slate-800', bar: 'bg-slate-400' },
  medium: { label: 'Medium', text: 'text-amber-900', bar: 'bg-amber-500' },
  high: { label: 'High', text: 'text-orange-700', bar: 'bg-orange-500' },
  critical: { label: 'Critical', text: 'text-rose-700', bar: 'bg-rose-600' },
}

export function RiskSummary({ risk, decisions, coverage, outdated }: {
  risk: Risk; decisions: Decisions; coverage: ReturnType<typeof analysisCoverage> | null; outdated: boolean
}) {
  const live = rescore(risk, decisions)
  const level = LEVEL[live.level]
  const exposure = openExposure(risk, decisions)
  const atStake = exposure == null ? null : Number(exposure)
  const sections = openSections(risk, decisions)

  return (
    <section aria-label="Risk summary" className="mb-5">
      {outdated && <p role="status" className="mb-2 text-sm font-semibold text-amber-900">Previous assessment</p>}
      {coverage && (
        <div className={clsx('mb-2 max-w-xl rounded-lg px-4 py-3 text-[13px]', coverage.partial ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-700')}>
          <p role="note">{coverage.message}</p>
          {coverage.details.length > 0 && <details className="mt-1">
            <summary className="cursor-pointer font-medium">Analysis details</summary>
            <ul className="mt-1 list-disc space-y-1 break-words ps-5">
              {coverage.details.map((error, index) => <li key={index}>{error}</li>)}
            </ul>
          </details>}
        </div>
      )}
      <dl className="flex max-w-2xl flex-wrap items-center gap-x-6 gap-y-3 rounded-lg bg-slate-50 px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <dt className="text-[13px] font-medium whitespace-nowrap text-slate-600">Risk score</dt>
          <dd className="num flex min-w-0 flex-1 items-center gap-3" aria-live="polite">
            <span className="text-lg font-semibold whitespace-nowrap text-slate-900">{int(live.score)} <span className={clsx('text-sm', level.text)}>{level.label}</span></span>
            <span aria-hidden className="block h-1.5 min-w-16 flex-1 rounded-full bg-slate-200">
              <span className={clsx('block h-1.5 rounded-full transition-[width]', level.bar)} style={{ width: `${live.score}%` }} />
            </span>
            {live.score !== risk.score && <span className="text-[13px] whitespace-nowrap text-slate-600">{int(risk.score)} at upload</span>}
          </dd>
        </div>
        <div aria-hidden className="h-6 w-px bg-slate-200 max-sm:hidden" />
        <div className="flex items-center gap-3">
          <dt className="text-[13px] font-medium whitespace-nowrap text-slate-600">Money at stake</dt>
          <dd className="num text-lg font-semibold whitespace-nowrap text-slate-900">
            {atStake != null && Number.isFinite(atStake) && risk.priced
              ? money(atStake)
              : <span className="text-sm font-medium text-slate-600">{risk.priced ? 'Unavailable' : 'Not priced'}</span>}
          </dd>
        </div>
      </dl>
      {sections.length > 0 && <details className="mt-2 text-sm text-slate-700">
        <summary className="cursor-pointer font-medium">Risk by section</summary>
        <ul className="mt-1 space-y-1">
          {sections.map(section => <li key={section.section_id ?? 'list'}>
            {[section.code, section.title].filter(Boolean).join(' ') || 'Whole list'} · {section.open} open
          </li>)}
        </ul>
      </details>}
    </section>
  )
}
