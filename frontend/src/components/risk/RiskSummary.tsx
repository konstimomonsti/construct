import { clsx } from 'clsx'
import { int, money } from '../../lib/format'
import { rescore, type Decisions, type Risk, type RiskLevel } from '../../lib/risk-assessment'

const LEVEL: Record<RiskLevel, { label: string; text: string; bar: string }> = {
  low: { label: 'Low', text: 'text-slate-800', bar: 'bg-slate-400' },
  medium: { label: 'Medium', text: 'text-amber-900', bar: 'bg-amber-500' },
  high: { label: 'High', text: 'text-orange-700', bar: 'bg-orange-500' },
  critical: { label: 'Critical', text: 'text-rose-700', bar: 'bg-rose-600' },
}

export function RiskSummary({ risk, decisions }: { risk: Risk; decisions: Decisions }) {
  const live = rescore(risk, decisions)
  const level = LEVEL[live.level]
  const atStake = risk.money_at_stake == null ? null : Number(risk.money_at_stake)
  const isBlocking = live.level === 'critical'

  return (
    <section aria-label="Risk summary" className="mb-5">
      {isBlocking && (
        <div role="alert" className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm text-rose-900">
          <div className="flex items-center gap-2 font-semibold">
            <span className="size-2 rounded-full bg-rose-600" />
            Critical Priority · Action Required
          </div>
          <p className="mt-0.5 text-xs text-rose-700">High aggregate risk. Review or resolve open critical items before tender submission.</p>
        </div>
      )}
      <dl className="grid max-w-xl grid-cols-2 gap-3">
        <div className="min-w-0 rounded-lg bg-slate-50 px-4 py-3">
          <dt className="text-[13px] font-medium text-slate-600">Risk score</dt>
          <dd className="num mt-0.5 text-xl font-semibold text-slate-900" aria-live="polite">
            {int(live.score)} <span className={clsx('text-base', level.text)}>{level.label}</span>
            <span aria-hidden className="mt-1.5 block h-1.5 rounded-full bg-slate-200">
              <span className={clsx('block h-1.5 rounded-full transition-[width]', level.bar)} style={{ width: `${live.score}%` }} />
            </span>
          </dd>
          {live.score !== risk.score && <dd className="text-[13px] text-slate-600">{int(risk.score)} at upload</dd>}
        </div>
        <div className="min-w-0 rounded-lg bg-slate-50 px-4 py-3">
          <dt className="text-[13px] font-medium text-slate-600">Money at stake</dt>
          <dd className="num mt-0.5 text-xl font-semibold text-slate-900">
            {atStake != null && Number.isFinite(atStake) && risk.priced
              ? money(atStake)
              : <span className="text-base text-slate-600">{risk.priced ? 'Unavailable' : 'Not priced'}</span>}
          </dd>
        </div>
      </dl>
    </section>
  )
}
