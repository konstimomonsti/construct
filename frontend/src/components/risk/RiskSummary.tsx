import { clsx } from 'clsx'
import { int, money } from '../../lib/format'
import { rescore, useUploadAssessment, type Decisions, type Risk, type RiskLevel } from '../../lib/risk-assessment'
import { categoryLabel, categoryPoints, layer3Coverage, sectionPoints } from '../../lib/risk-labels'
import { useStore } from '../../lib/store'

const LEVEL: Record<RiskLevel, { label: string; text: string; bar: string }> = {
  low: { label: 'Low', text: 'text-slate-800', bar: 'bg-slate-400' },
  medium: { label: 'Medium', text: 'text-amber-900', bar: 'bg-amber-500' },
  high: { label: 'High', text: 'text-orange-700', bar: 'bg-orange-500' },
  critical: { label: 'Critical', text: 'text-rose-700', bar: 'bg-rose-600' },
}

export function RiskSummary({ risk, decisions }: { risk: Risk; decisions: Decisions }) {
  const listId = /^\/list\/([^/]+)/.exec(window.location.pathname)?.[1] ?? null
  const assessment = useUploadAssessment(listId)
  const report = assessment?.state === 'ready' ? assessment.report : null
  const positions = useStore((state) => state.userLists.find((list) => list.id === listId)?.positions)
  const coverage = report ? layer3Coverage(report.errors) : null
  const partial = coverage && coverage.run < coverage.planned
  const hasDecisions = Object.keys(decisions).length > 0
  const sections = report && positions ? sectionPoints(risk, report, positions, decisions) : hasDecisions ? [] : risk.by_section
  const categories = report ? categoryPoints(risk, report, decisions) : hasDecisions ? [] : Object.entries(risk.by_category).sort((a, b) => b[1] - a[1])
  const live = rescore(risk, decisions)
  const level = LEVEL[live.level]
  const atStake = risk.money_at_stake == null ? null : Number(risk.money_at_stake)

  return (
    <section aria-label="Risk summary" className="mb-5">
      <dl className="grid max-w-xl grid-cols-2 gap-3">
        <div className="min-w-0 rounded-lg bg-slate-50 px-4 py-3">
          <dt className="text-[13px] font-medium text-slate-600">Risk score{partial ? ' · based on partial analysis' : ''}</dt>
          <dd className="num mt-0.5 text-xl font-semibold text-slate-900" aria-live="polite">
            {int(live.score)} <span className={clsx('text-base', level.text)}>{level.label}</span>
            <span aria-hidden className="mt-1.5 block h-1.5 rounded-full bg-slate-200">
              <span className={clsx('block h-1.5 rounded-full transition-[width]', level.bar)} style={{ width: `${live.score}%` }} />
            </span>
          </dd>
          {live.score !== risk.score && <dd className="text-[13px] text-slate-600">{int(risk.score)} at upload</dd>}
        </div>
        <div className="min-w-0 rounded-lg bg-slate-50 px-4 py-3">
          <dt className="text-[13px] font-medium text-slate-600">Money at stake{partial ? ' · based on partial analysis' : ''}</dt>
          <dd className="num mt-0.5 text-xl font-semibold text-slate-900">
            {atStake != null && Number.isFinite(atStake) && risk.priced
              ? money(atStake)
              : <span className="text-base text-slate-600">{risk.priced ? 'Unavailable' : 'Not priced'}</span>}
          </dd>
        </div>
      </dl>
      {partial && <div className="mt-2 max-w-xl text-sm text-amber-900">
        <p>{coverage.skipped} AI {coverage.skipped === 1 ? 'check was' : 'checks were'} skipped. These results may change when the remaining checks run.</p>
        <details className="mt-1 text-xs"><summary className="cursor-pointer">Technical details</summary><p>{coverage.details}</p></details>
      </div>}
      {sections.length > 0 && <div className="mt-5 max-w-xl">
        <h3 className="text-sm font-semibold text-slate-900">Risk by section (open)</h3>
        <ul className="mt-2 space-y-1 text-sm">{sections.filter((section) => section.points > 0).map((section) => <li key={section.section_id} className="flex justify-between gap-3">
          <span className="truncate">{section.code && section.code !== 'null' ? `${section.code} ` : ''}{section.title}</span><span className="num">{int(section.points)} pts</span>
        </li>)}</ul>
      </div>}
      {categories.length > 0 && <div className="mt-5 max-w-xl">
        <h3 className="text-sm font-semibold text-slate-900">Risk by category (open)</h3>
        <ul className="mt-2 space-y-1 text-sm">{categories.map(([category, points]) => <li key={category} className="flex justify-between gap-3"><span>{categoryLabel(category)}</span><span className="num">{int(points)} pts</span></li>)}</ul>
      </div>}
    </section>
  )
}
