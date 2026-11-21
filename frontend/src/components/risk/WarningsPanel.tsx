import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, Icon, kbdCls } from '../ui'
import { ChangeOrderText, FindingText, RISK_UI } from '../RiskAssessment'
import { DismissMenu, accepted } from './DecisionControls'
import { planFix, type FixPlan } from '../../lib/apply-fix'
import { int, plural } from '../../lib/format'
import { SEVERITIES, type Decision, type Decisions, type Finding, type ReviewItem, type Severity } from '../../lib/risk-assessment'
import type { Position } from '../../lib/types'

export type WarningEntry = { item: ReviewItem; position: Position | null }

const isFinding = (item: ReviewItem): item is Finding => 'severity' in item
const kindOf = (item: ReviewItem): Severity | 'change' => (isFinding(item) ? item.severity : 'change')
const KIND_LABEL: Record<Severity | 'change', string> = { error: 'Critical', warning: 'Warning', info: 'Note', change: 'Change order' }
const KIND_PLURAL: Record<Severity | 'change', string> = { error: 'Critical', warning: 'Warnings', info: 'Notes', change: 'Change orders' }

/**
 * The warnings of the uploaded tender at a glance: counts per kind, one line per type that jumps to the positions,
 * "Fix all" for every warning that carries an applicable fix, and a one-at-a-time review that walks the open warnings
 * without scrolling the list. Nothing changes without a click; every bulk change can be undone.
 */
export function WarningsPanel({ entries, decisions, settled, positions, onOpen, onFilter, onDecide, onApplyFixes }: {
  entries: WarningEntry[]
  decisions: Decisions
  settled: Set<string>
  positions: Position[]
  onOpen: (positionId: string) => void
  onFilter: (filter: string) => void
  onDecide: (ids: string[], decision: Decision | null, title?: string) => void
  onApplyFixes: (plans: { finding: Finding; plan: FixPlan }[]) => void
}) {
  const open = useMemo(() => entries.filter(({ item }) => !settled.has(item.id)), [entries, settled])
  const plans = useMemo(() => open.flatMap(({ item }) => {
    if (!isFinding(item)) return []
    const plan = planFix(item, positions)
    return plan.steps.length ? [{ finding: item, plan }] : []
  }), [open, positions])
  const counts = useMemo(() => {
    const out = new Map<Severity | 'change', number>()
    for (const { item } of open) out.set(kindOf(item), (out.get(kindOf(item)) ?? 0) + 1)
    return out
  }, [open])
  const types = useMemo(() => {
    const out = new Map<string, { title: string; kind: Severity | 'change'; entries: WarningEntry[] }>()
    for (const entry of open) {
      const key = isFinding(entry.item) ? `rule:${entry.item.rule_id}` : `change:${entry.item.kind}`
      const group = out.get(key) ?? { title: entry.item.title, kind: kindOf(entry.item), entries: [] }
      group.entries.push(entry)
      out.set(key, group)
    }
    const rank = (kind: Severity | 'change') => (kind === 'change' ? 3 : SEVERITIES.indexOf(kind))
    return [...out].sort(([, a], [, b]) => rank(a.kind) - rank(b.kind) || b.entries.length - a.entries.length)
  }, [open])

  const [confirming, setConfirming] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const decidedCount = entries.length - open.length

  if (!entries.length) return null

  return (
    <section aria-labelledby="warnings-h" className="mb-6 max-w-4xl rounded-lg bg-slate-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="warnings-h" className="font-heading text-base font-bold text-slate-900">
            {open.length ? plural(open.length, 'open warning', 'open warnings') : 'All warnings reviewed'}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-slate-600">
            {([...SEVERITIES, 'change'] as const).filter((kind) => counts.get(kind)).map((kind) => (
              <button key={kind} type="button" onClick={() => onFilter(kind === 'change' ? 'change-orders' : kind)}
                className="inline-flex items-center gap-1 rounded font-medium hover:text-slate-900 hover:underline"
                title={`Show only positions with ${KIND_LABEL[kind].toLowerCase()} warnings`}>
                <Icon name="flag" size={14} fill className={kind === 'change' ? 'text-orange-600' : RISK_UI[kind].ink} />
                <span className="num">{int(counts.get(kind) ?? 0)}</span> {(counts.get(kind) === 1 ? KIND_LABEL : KIND_PLURAL)[kind].toLowerCase()}
              </button>
            ))}
            {decidedCount > 0 && <span><span className="num">{int(decidedCount)}</span> reviewed</span>}
          </p>
        </div>
        {open.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {plans.length > 0 && (
              <Button variant="primary" icon="auto_fix_high" onClick={() => setConfirming(true)}>
                {plans.length === open.length ? 'Fix all' : `Fix all ${int(plans.length)} fixable`}
              </Button>
            )}
            <Button icon={reviewing ? 'close' : 'fact_check'} aria-expanded={reviewing} onClick={() => setReviewing((v) => !v)}>
              {reviewing ? 'Close review' : 'Review one by one'}
            </Button>
          </div>
        )}
      </div>

      {reviewing && open.length > 0 ? (
        <ReviewStepper open={open} positions={positions} decisions={decisions} onOpen={onOpen} onDecide={onDecide}
          onApplyFixes={onApplyFixes} onClose={() => setReviewing(false)} />
      ) : open.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200">
          {types.map(([key, group]) => {
            const isOpen = expanded === key
            return (
              <li key={key}>
                <div className="flex min-h-10 items-center gap-2 py-1">
                  <button type="button" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : key)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-slate-100">
                    <Icon name="expand_more" size={18} className={clsx('shrink-0 text-slate-500 transition-transform', isOpen && 'rotate-180')} />
                    <Icon name="flag" size={15} fill className={clsx('shrink-0', group.kind === 'change' ? 'text-orange-600' : RISK_UI[group.kind].ink)} />
                    <span className="min-w-0 truncate font-medium text-slate-900">{group.title}</span>
                    <span className="num shrink-0 text-slate-600">{int(group.entries.length)}</span>
                  </button>
                  {key.startsWith('rule:') && group.entries.some((entry) => entry.position) && (
                    <Button size="sm" variant="ghost" icon="filter_list" onClick={() => onFilter(key)}>Show in list</Button>
                  )}
                </div>
                {isOpen && (
                  <ul className="mb-2 ml-7 max-h-64 space-y-0.5 overflow-y-auto">
                    {group.entries.map(({ item, position }) => (
                      <li key={item.id}>
                        <button type="button" disabled={!position} onClick={() => position && onOpen(position.id)}
                          className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-slate-100 disabled:hover:bg-transparent">
                          <span className="num w-20 shrink-0 font-mono text-[13px] text-slate-600">{position?.oz ?? 'List'}</span>
                          <span className="min-w-0 flex-1 truncate text-slate-800">{position?.short || item.message}</span>
                          {position && <span className="shrink-0 text-[13px] font-semibold text-brand-700">Go to</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <FixAllDialog open={confirming} plans={plans} remaining={open.length - plans.length} onClose={() => setConfirming(false)}
        onConfirm={() => { onApplyFixes(plans); setConfirming(false) }} />
    </section>
  )
}

function FixAllDialog({ open, plans, remaining, onClose, onConfirm }: {
  open: boolean; plans: { finding: Finding; plan: FixPlan }[]; remaining: number; onClose: () => void; onConfirm: () => void
}) {
  const steps = plans.flatMap(({ plan }) => plan.steps)
  return (
    <Dialog open={open} onClose={onClose} width="max-w-lg"
      title={`Fix ${plural(plans.length, 'warning', 'warnings')}?`}
      description={<>These changes are made as edits you can undo. The uploaded file stays unchanged.{remaining > 0 && <> {plural(remaining, 'other warning has', 'other warnings have')} no automatic fix and stay open for review.</>}</>}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="auto_fix_high" onClick={onConfirm}>Apply {plural(steps.length, 'change', 'changes')}</Button>
      </>}>
      <ul className="max-h-72 space-y-1 overflow-y-auto text-sm text-slate-800">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-2"><Icon name="arrow_right_alt" size={18} className="shrink-0 text-slate-500" />{step.label}</li>
        ))}
      </ul>
    </Dialog>
  )
}

/** one open warning at a time; after each decision the next open one comes up. ← / → move, A accepts, F applies the fix */
function ReviewStepper({ open, positions, decisions, onOpen, onDecide, onApplyFixes, onClose }: {
  open: WarningEntry[]
  positions: Position[]
  decisions: Decisions
  onOpen: (positionId: string) => void
  onDecide: (ids: string[], decision: Decision | null, title?: string) => void
  onApplyFixes: (plans: { finding: Finding; plan: FixPlan }[]) => void
  onClose: () => void
}) {
  // follow the warning by id, so the cursor stays put when earlier ones are decided
  // when the current one is decided it leaves `open`, and the one now at the same place comes up
  const [cursor, setCursor] = useState({ id: open[0]?.item.id, index: 0 })
  const found = open.findIndex(({ item }) => item.id === cursor.id)
  const index = found >= 0 ? found : Math.min(cursor.index, open.length - 1)
  const entry = open[index]
  const item = entry?.item
  const currentId = item?.id
  const plan = item && isFinding(item) ? planFix(item, positions) : null
  const move = (step: number) => {
    const next = (index + step + open.length) % open.length
    setCursor({ id: open[next]?.item.id, index: next })
  }
  const card = useRef<HTMLDivElement>(null)

  const accept = () => item && onDecide([item.id], accepted(), item.title)
  const fix = () => item && plan?.steps.length && isFinding(item) && onApplyFixes([{ finding: item, plan }])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement
      if (target.closest('input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]')) return
      if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); move(1) }
      else if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); move(-1) }
      else if (e.key === 'a') { e.preventDefault(); accept() }
      else if (e.key === 'f') { e.preventDefault(); fix() }
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => { card.current?.focus({ preventScroll: true }) }, [currentId])

  if (!entry || !item) return null
  return (
    <div ref={card} tabIndex={-1} aria-live="polite" className="mt-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 outline-none">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-semibold text-slate-900"><span className="num">{int(index + 1)}</span> of <span className="num">{int(open.length)}</span></span>
        <span className="flex items-center gap-1">
          <Button size="sm" variant="ghost" icon="chevron_left" aria-label="Previous warning" onClick={() => move(-1)} />
          <Button size="sm" variant="ghost" icon="chevron_right" aria-label="Next warning" onClick={() => move(1)} />
        </span>
      </div>
      {entry.position && (
        <button type="button" onClick={() => onOpen(entry.position!.id)}
          className="mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100">
          <span className="num font-mono text-[13px] text-slate-600">{entry.position.oz}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{entry.position.short}</span>
          <span className="shrink-0 text-[13px] font-semibold text-brand-700">Open position</span>
        </button>
      )}
      {isFinding(item) ? <FindingText finding={item} decision={decisions[item.id]} details /> : <ChangeOrderText signal={item} decision={decisions[item.id]} />}
      {plan && (plan.steps.length > 0 || plan.skipped.length > 0) && (
        <div className="mt-3 ml-[15px] rounded-md bg-slate-50 px-3 py-2 text-[13px]">
          {plan.steps.map((step, i) => <p key={i} className="text-slate-800"><Icon name="arrow_right_alt" size={15} className="mr-1 align-[-3px] text-slate-500" />{step.label}</p>)}
          {plan.skipped.map((skip, i) => <p key={i} className="text-slate-600">Not applied: {skip.reason}</p>)}
        </div>
      )}
      <div className="mt-3 ml-[15px] flex flex-wrap items-center gap-2">
        {!!plan?.steps.length && <Button size="sm" variant="primary" icon="auto_fix_high" onClick={fix}>Apply fix <kbd className={clsx(kbdCls, 'ml-1.5')}>F</kbd></Button>}
        <Button size="sm" icon="check" onClick={accept}>Accept <kbd className={clsx(kbdCls, 'ml-1.5')}>A</kbd></Button>
        <DismissMenu label={`Dismiss: ${item.title}`} onDismiss={(decision) => onDecide([item.id], decision, item.title)} />
        <Button size="sm" variant="ghost" onClick={() => move(1)}>Skip</Button>
        <span className="ml-auto text-[13px] text-slate-600 max-sm:hidden"><kbd className={kbdCls}>←</kbd> <kbd className={kbdCls}>→</kbd> to move</span>
      </div>
    </div>
  )
}
