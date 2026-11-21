import { useState, type FormEvent } from 'react'
import { money } from '../lib/format'
import type { CatStat } from '../lib/resolve'
import type { CategoryNode } from '../lib/types'
import { Button, Dialog, Field, inputCls } from './ui'

export interface PricingSection { id: string; name: string; cost: number; color: string }

/** brand and slate tones only: section colours must never read as a budget status (green/amber/red) */
const RAMP = ['#edb03e', '#9b7428', '#f6d28f', '#6b4c16', '#c9a46a', '#d98a1c', '#e8dcc4']

/** top-level categories with their cost and a stable colour from the ramp */
export function pricingSections(tree: CategoryNode[], stats: Map<string, CatStat>): PricingSection[] {
  return tree.map((category, index) => ({
    id: category.oz,
    name: category.label || category.oz,
    cost: stats.get(category.oz)?.total ?? 0,
    color: RAMP[index % RAMP.length],
  }))
    // largest first, in the bar and the legend; colours stay tied to the section, not to its rank
    .sort((a, b) => b.cost - a.cost)
}

/** one bar for the whole list, split by pricing section; the cap is the full width (or a marker when exceeded) */
export function PricingMeter({ sections, total, cap, className }: { sections: PricingSection[]; total: number; cap: number; className?: string }) {
  // positive costs fill the bar; credits still count toward the net total and appear in the legend
  const charges = sections.reduce((sum, s) => sum + Math.max(0, s.cost), 0)
  const scale = Math.max(cap, charges, 1)
  return (
    <div
      role="meter"
      aria-label="Budget used"
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={Math.min(cap, Math.max(0, total))}
      aria-valuetext={`${money(total)} of ${money(cap)}`}
      className={`relative flex h-2 gap-px overflow-hidden rounded-[2px] bg-slate-300 ${className ?? ''}`}
    >
      {sections.filter((s) => s.cost > 0).map((s) => (
        <span key={s.id} title={`${s.name} · ${money(s.cost)}`} className="h-full first:rounded-l-full" style={{ width: `${(s.cost / scale) * 100}%`, backgroundColor: s.color }} />
      ))}
      {charges > cap && <span title={`Budget limit · ${money(cap)}`} className="absolute inset-y-0 w-0.5 bg-slate-950 ring-1 ring-white" style={{ left: `${(cap / scale) * 100}%` }} />}
    </div>
  )
}

export function PricingLegend({ sections, id }: { sections: PricingSection[]; id?: string }) {
  return (
    <ul id={id} aria-label="Costs by section" className="mt-3 grid max-w-xl gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
      {sections.map((s) => (
        <li key={s.id} className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="size-2.5 shrink-0 rounded-md" style={{ backgroundColor: s.color }} />
          <span title={s.name} className="min-w-0 flex-1 truncate text-slate-700">{s.name}</span>
          <span className="num shrink-0 text-slate-900">{money(s.cost)}</span>
        </li>
      ))}
    </ul>
  )
}

export function AddSectionDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (name: string) => void }) {
  const [name, setName] = useState('')
  const close = () => {
    setName('')
    onClose()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    onAdd(name.trim())
    close()
  }
  if (!open) return null
  return (
    <Dialog open onClose={close} title="Add pricing section" description="A new top-level category. Move or add positions into it to price it." footer={
      <>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" type="submit" form="pricing-section-form" disabled={!name.trim()}>Add section</Button>
      </>
    }>
      <form id="pricing-section-form" onSubmit={submit}>
        <Field label="Section name">
          <input data-autofocus value={name} onChange={(event) => setName(event.target.value)} className={inputCls} maxLength={100} placeholder="e.g. Installation" />
        </Field>
      </form>
    </Dialog>
  )
}
