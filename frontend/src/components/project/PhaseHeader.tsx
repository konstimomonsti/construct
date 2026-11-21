import { clsx } from 'clsx'
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../ui'
import { CraneProgress } from './CraneProgress'
import { money, moneyWhole } from '../../lib/format'
import { raisedCls } from '../../lib/cls'
import type { WorkflowPhase, WorkflowState } from '../../lib/workflow'

export type Phase = WorkflowPhase

export const PHASES: { id: Phase; label: string; hint: string }[] = [
  { id: 'x83', label: 'X83', hint: 'Received tender: resolve errors' },
  { id: 'subcontractors', label: 'Subcontractors', hint: 'Requests and replies' },
  { id: 'x84', label: 'X84', hint: 'Our offer' },
  { id: 'x86', label: 'X86', hint: 'Award' },
]

export const isPhase = (value: string | null): value is Phase => PHASES.some((p) => p.id === value)

export const tabId = (phase: Phase) => `phase-tab-${phase}`
export const panelId = (phase: Phase) => `phase-panel-${phase}`

/** the tab panel of one phase, wired to its tab */
export function PhasePanel({ phase, children }: { phase: Phase; children: ReactNode }) {
  return <div role="tabpanel" id={panelId(phase)} aria-labelledby={tabId(phase)} className="outline-none">{children}</div>
}

/**
 * The list hero: the "Left" figure, the crane jib showing workflow progress, the phase tabs directly under the jib
 * (the tick marks on the jib sit at the tab boundaries), then the meta row, the research note and the expandable legend.
 */
export function PhaseHeader({
  cap, total, onEditCap, sub, meta, note, extra, phase, onPhase, badges, workflow,
}: {
  cap: number
  total: number
  onEditCap?: () => void
  /** one quiet line, e.g. money that is proposed but not counted yet */
  sub?: ReactNode
  meta?: ReactNode
  note?: ReactNode
  extra?: ReactNode
  phase: Phase
  onPhase: (phase: Phase) => void
  /** small muted marker per tab: a count, or ✓ */
  badges: Partial<Record<Phase, string | number | null>>
  /** where the project stands (`currentPhase`): drives the crane and the check marks */
  workflow: WorkflowState
}) {
  const left = cap - total
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = e.key === 'ArrowRight' ? (index + 1) % PHASES.length
      : e.key === 'ArrowLeft' ? (index - 1 + PHASES.length) % PHASES.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? PHASES.length - 1
      : -1
    if (next < 0) return
    e.preventDefault()
    onPhase(PHASES[next].id)
    tabs.current[next]?.focus()
  }

  return (
    <section aria-label="List budget and workflow" className="mb-6">
      <div className="flex min-h-[3.25rem] flex-wrap items-end justify-end gap-x-10 gap-y-2">
        {cap > 0 ? (
          <dl className="text-right">
            <dt className="text-sm font-semibold text-slate-800">{left >= 0 ? 'Left' : 'Over'}</dt>
            <dd className={clsx('num mt-0.5 text-xl font-bold sm:text-[28px]', left >= 0 ? 'text-slate-900' : 'text-rose-700')}>{money(Math.abs(left))}</dd>
            <dd className="text-sm text-slate-600">
              {left >= 0 ? 'before the cap' : 'past the cap'}
              {onEditCap && (
                <button
                  type="button"
                  onClick={onEditCap}
                  aria-label={`Cap: ${moneyWhole(cap)}. Edit budget cap`}
                  title={`Cap: ${moneyWhole(cap)}. Edit budget cap`}
                  className="relative ml-1 inline-flex size-7 items-center justify-center rounded-md align-middle text-slate-600 transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-slate-100 hover:text-slate-900"
                >
                  <Icon name="edit" size={16} />
                </button>
              )}
            </dd>
          </dl>
        ) : (
          onEditCap && <button type="button" onClick={onEditCap} className={clsx('h-9 rounded-md px-3 text-sm font-semibold', raisedCls)}>Set a cap</button>
        )}
      </div>
      {sub && <div className="mt-1.5 text-right text-sm text-slate-600">{sub}</div>}

      <div className="relative mt-3 sm:mt-4">
        <CraneProgress state={workflow} valueText={workflow.complete ? `Phase ${PHASES.length} of ${PHASES.length}: ${PHASES[PHASES.length - 1].label}, done` : `Phase ${workflow.index + 1} of ${PHASES.length}: ${PHASES[workflow.index].label}`} />
        {/* one tick per tab boundary; only where the tabs share the width evenly */}
        {[25, 50, 75].map((at) => (
          <span key={at} aria-hidden className="pointer-events-none absolute top-[-3px] h-6 w-px bg-slate-500 max-sm:hidden" style={{ left: `${at}%` }} />
        ))}
      </div>

      <div role="tablist" aria-label="Project phase" className="-mx-4 flex overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {PHASES.map((p, index) => {
          const on = p.id === phase
          const badge = badges[p.id]
          return (
            <button
              key={p.id}
              ref={(el) => { tabs.current[index] = el }}
              type="button"
              role="tab"
              id={tabId(p.id)}
              aria-selected={on}
              aria-controls={panelId(p.id)}
              tabIndex={on ? 0 : -1}
              title={p.hint}
              onClick={() => onPhase(p.id)}
              onKeyDown={(e) => onKey(e, index)}
              className={clsx(
                'relative flex h-11 min-w-[7.5rem] flex-1 items-center justify-center gap-1.5 border-b-2 px-3 text-sm whitespace-nowrap transition-colors',
                on ? 'border-brand-600 font-semibold text-slate-900' : 'border-slate-200 font-medium text-slate-600 hover:border-slate-400 hover:text-slate-900',
              )}
            >
              {p.label}
              {workflow.done.includes(p.id) && <><Icon name="check_circle" size={16} fill className="text-emerald-700" /><span className="sr-only">(done)</span></>}
              {badge != null && badge !== '' && <span className={clsx('num text-[13px] font-medium', on ? 'text-slate-700' : 'text-slate-500')}>{badge}</span>}
            </button>
          )
        })}
      </div>

      {(meta || note) && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm text-slate-600">
          {note ? <span>{note}</span> : <span />}
          {meta && <div>{meta}</div>}
        </div>
      )}
      {extra}
    </section>
  )
}
