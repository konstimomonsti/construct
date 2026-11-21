import { clsx } from 'clsx'
import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Icon } from './ui'
import { money } from '../lib/format'

type Level = 'yellow' | 'orange' | 'red'
type Shown = Level | 'ok'
const LEVELS: Level[] = ['yellow', 'orange', 'red']
const TAB_LABEL: Record<Level, string> = { yellow: 'Caution (75%)', orange: 'Approaching Cap (90%)', red: 'Budget Exceeded (>100%)' }
const ARIA: Record<Level, string> = { yellow: 'Caution', orange: 'Approaching Cap', red: 'Budget Exceeded' }

const theme = {
  yellow: {
    box: 'border-amber-200 bg-amber-50/70', rule: 'border-amber-200/60', tile: 'bg-amber-100 text-amber-700 border-amber-200',
    h: 'text-amber-900', chip: 'bg-amber-100/70 text-amber-800 border-amber-200/60', p: 'text-amber-800/90', strong: 'text-amber-900',
    b2: 'border-amber-300 hover:bg-amber-50 text-amber-900', tab: 'bg-amber-500 text-white',
    dot: 'bg-amber-500 ring-2 ring-amber-200', pill: 'bg-amber-100 text-amber-800 border-amber-200', pulse: 'bg-amber-600', icon: 'warning',
  },
  orange: {
    box: 'border-orange-200 bg-orange-50/70', rule: 'border-orange-200/60', tile: 'bg-orange-100 text-orange-700 border-orange-200',
    h: 'text-orange-950', chip: 'bg-orange-100/70 text-orange-900 border-orange-200/60', p: 'text-orange-900/90', strong: 'text-orange-950',
    b2: 'border-orange-300 hover:bg-orange-50 text-orange-900', tab: 'bg-orange-600 text-white',
    dot: 'bg-orange-500 ring-2 ring-orange-200', pill: 'bg-orange-100 text-orange-800 border-orange-200', pulse: 'bg-orange-600', icon: 'gpp_maybe',
  },
  red: {
    box: 'border-rose-200 bg-rose-50/70', rule: 'border-rose-200/60', tile: 'bg-rose-100 text-rose-700 border-rose-200',
    h: 'text-rose-950', chip: 'bg-rose-100 text-rose-800 border-rose-300 font-semibold', p: 'text-rose-900/90', strong: 'text-rose-950',
    b2: 'border-rose-300 hover:bg-rose-50 text-rose-900', tab: 'bg-rose-600 text-white',
    dot: 'bg-rose-600 ring-2 ring-rose-200', pill: 'bg-rose-100 text-rose-700 border-rose-200', pulse: 'bg-rose-600', icon: 'error',
  },
  ok: {
    box: 'border-emerald-200 bg-emerald-50/70', rule: 'border-emerald-200/60', tile: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    h: 'text-emerald-950', chip: 'bg-emerald-100/70 text-emerald-800 border-emerald-200/60', p: 'text-emerald-900/90', strong: 'text-emerald-950',
    b2: 'border-emerald-300 hover:bg-emerald-50 text-emerald-900', tab: 'bg-emerald-600 text-white',
    dot: 'bg-emerald-500 ring-2 ring-emerald-200', pill: 'bg-emerald-100 text-emerald-800 border-emerald-200', pulse: 'bg-emerald-600', icon: 'verified',
  },
} as const

export interface BudgetAlertProps {
  total: number
  cap: number
  largest: { short: string; amount: number } | null
  onReview: () => void
}

export function BudgetAlert({ total, cap, largest, onReview }: BudgetAlertProps) {
  const reduce = useReducedMotion()
  const [sel, setSel] = useState<Level | null>(null)

  const used = (total / cap) * 100
  const current: Shown = used > 100 ? 'red' : used >= 90 ? 'orange' : used >= 75 ? 'yellow' : 'ok'
  const shown: Shown = sel ?? current
  const preview = shown !== current
  const t = theme[shown]
  const idx = shown === 'ok' ? -1 : LEVELS.indexOf(shown)
  const over = Math.max(0, total - cap)
  const remaining = Math.max(0, cap - total)
  const share = largest && total > 0 ? (largest.amount / total) * 100 : 0
  const name = largest ? <strong className={clsx('font-semibold', t.strong)}>'{largest.short}'</strong> : null
  const step = (d: 1 | -1) => setSel(LEVELS[idx === -1 ? (d === 1 ? 0 : 2) : (idx + d + 3) % 3])
  const pillText = { red: 'Critical Overrun', orange: 'Approaching Cap', yellow: 'Caution', ok: 'Within Budget' }[current]
  const cur = theme[current]

  const content: Record<Shown, { title: string; chip: string; body: React.ReactNode }> = {
    yellow: {
      title: 'Caution: Approaching Soft Allocation Limit',
      chip: 'Threshold 75% Exceeded',
      body: (
        <>
          This list has used <span className="font-mono font-semibold">{used.toFixed(1)}%</span> of its budget cap ({money(total)} of {money(cap)}).
          {largest && <> The largest position {name} contributes <span className="font-mono font-semibold">{money(largest.amount)}</span> ({share.toFixed(0)}% of the total).</>}
        </>
      ),
    },
    orange: {
      title: 'High Risk: Ceiling Threshold Warning',
      chip: `${used.toFixed(1)}% Capacity`,
      body: (
        <>
          {largest ? <>The largest position <strong className={clsx('font-semibold', t.strong)}>'{largest.short}' ({money(largest.amount)})</strong> alone makes up {share.toFixed(0)}% of this list. </> : null}
          Only <strong className={clsx('font-mono font-semibold', t.strong)}>{money(remaining)}</strong> remain{remaining === 1 ? 's' : ''} before the cap of {money(cap)} is reached.
        </>
      ),
    },
    red: {
      title: 'Critical Error: Budget Cap Breach Detected',
      chip: `Over Limit (+${money(over)})`,
      body: (
        <>
          Total spend of {money(total)} exceeds the budget cap of {money(cap)} by <strong className={clsx('font-mono font-semibold', t.strong)}>{money(over)}</strong>.
          {largest && <> The largest position {name} ({money(largest.amount)}) is the main cost driver.</>}
        </>
      ),
    },
    ok: {
      title: 'Within budget',
      chip: `${used.toFixed(1)}% of cap`,
      body: (
        <>
          {money(total)} of {money(cap)} used, <strong className={clsx('font-mono font-semibold', t.strong)}>{money(remaining)}</strong> remaining. Alerts start at 75%, 90% and when the cap is exceeded.
          {largest && <> Largest position: {name} ({money(largest.amount)}).</>}
        </>
      ),
    },
  }
  const c = content[shown]

  return (
    <div id="budgetAlertBox" className={clsx('mt-4 rounded-xl border p-4 shadow-xs transition-colors duration-200', t.box)}>
      <div className={clsx('flex flex-wrap items-center justify-between gap-3 border-b pb-3', t.rule)}>
        <div className="flex flex-wrap items-center gap-3">
          <span role="status" className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold', cur.pill)}>
            <span className={clsx('size-1.5 rounded-full', cur.pulse, current !== 'ok' && 'animate-pulse')} />
            {pillText} · {used.toFixed(1)}%
          </span>
          <div className="flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/70 px-2 py-1" role="group" aria-label="Alert levels">
            {LEVELS.map((l, i) => (
              <button
                key={l}
                type="button"
                onClick={() => setSel(l)}
                aria-label={`Alert ${i + 1} of 3: ${ARIA[l]}`}
                aria-pressed={shown === l}
                className={clsx('rounded-full transition-all', shown === l ? `size-2.5 ${theme[l].dot}` : 'size-2 bg-slate-300 hover:bg-slate-400')}
              />
            ))}
            <span className="ml-1 font-mono text-[11px] font-medium text-slate-500">{idx === -1 ? '–' : idx + 1}/3</span>
          </div>
        </div>
        <div role="tablist" aria-label="Alert level preview" className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200/80 bg-white/80 p-0.5 shadow-2xs">
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={shown === l}
              onClick={() => setSel(l)}
              className={clsx('rounded-md px-2.5 py-1 text-xs font-semibold transition-all', shown === l ? `${theme[l].tab} shadow-xs` : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}
            >
              {TAB_LABEL[l]}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={shown}
          role="tabpanel"
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="pt-3.5"
        >
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
            <div className="flex items-start gap-3.5">
              <div className={clsx('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border', t.tile)}>
                <Icon name={t.icon} size={20} />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className={clsx('font-heading text-sm font-bold tracking-tight', t.h)}>{c.title}</h4>
                  <span className={clsx('rounded border px-1.5 py-0.5 font-mono text-[11px]', t.chip)}>{c.chip}</span>
                  {preview && <span className="rounded bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">Preview · current {used.toFixed(1)}%</span>}
                </div>
                <p className={clsx('mt-1 max-w-3xl text-xs leading-relaxed', t.p)}>{c.body}</p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button type="button" onClick={onReview} className={clsx('flex h-8 items-center gap-1.5 rounded-lg border bg-white px-3 text-xs font-medium shadow-xs transition-colors', t.b2)}>
                <Icon name="analytics" size={15} />
                Review Overages
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>

      <div className={clsx('mt-3.5 flex items-center justify-between border-t pt-2.5 text-xs text-slate-500', t.rule)}>
        <span className="text-[11px]">{sel && sel !== current ? (
          <button type="button" className="font-medium text-slate-600 underline-offset-2 hover:underline" onClick={() => setSel(null)}>Back to current status</button>
        ) : null}</span>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous alert" title="Previous alert" onClick={() => step(-1)} className="flex items-center justify-center rounded-md border border-slate-200 bg-white p-1 text-slate-600 shadow-2xs transition-colors hover:bg-slate-50 hover:text-slate-900">
            <Icon name="chevron_left" size={16} />
          </button>
          <button type="button" aria-label="Next alert" title="Next alert" onClick={() => step(1)} className="flex items-center justify-center rounded-md border border-slate-200 bg-white p-1 text-slate-600 shadow-2xs transition-colors hover:bg-slate-50 hover:text-slate-900">
            <Icon name="chevron_right" size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
