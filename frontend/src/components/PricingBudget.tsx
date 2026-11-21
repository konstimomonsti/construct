import { useState, type FormEvent } from 'react'
import { money } from '../lib/format'
import type { CatStat } from '../lib/resolve'
import type { CategoryNode } from '../lib/types'
import { Button, Dialog, Field, inputCls } from './ui'

export function PricingBudget({ tree, stats, total, cap, onAdd }: {
  tree: CategoryNode[]
  stats: Map<string, CatStat>
  total: number
  cap: number
  onAdd: (name: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const close = () => {
    setAdding(false)
    setName('')
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    onAdd(name.trim())
    close()
  }
  const sections = tree.map((category, index) => ({
    id: category.oz,
    name: category.label || category.oz,
    cost: stats.get(category.oz)?.total ?? 0,
    color: `hsl(${(217 + index * 137.508) % 360} 66% 43%)`,
  }))
  // Positive costs fill the bar. Credits still contribute to the net total and are shown in the legend.
  const charges = sections.reduce((sum, section) => sum + Math.max(0, section.cost), 0)
  const scale = Math.max(cap, charges)
  return (
    <section aria-labelledby="pricing-budget" className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="pricing-budget" className="text-sm font-semibold text-slate-900">Pricing budget</h2>
          <p className="mt-1 font-mono text-xs text-slate-500">
            <strong className="text-slate-900">{money(total)}</strong> of {money(cap)}
          </p>
        </div>
        <Button icon="add" onClick={() => setAdding(true)}>Add pricing section</Button>
      </div>
      <div role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(cap, Math.max(0, total))}
        aria-valuetext={`${money(total)} of ${money(cap)}`} className="relative mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100">
        {sections.filter((section) => section.cost > 0).map((section) => (
          <span key={section.id} title={`${section.name} · ${money(section.cost)}`}
            style={{ width: `${(section.cost / scale) * 100}%`, backgroundColor: section.color }} />
        ))}
        {charges > cap && <span title={`Budget limit · ${money(cap)}`} className="absolute inset-y-0 w-0.5 bg-slate-950 ring-1 ring-white" style={{ left: `${(cap / scale) * 100}%` }} />}
      </div>
      {sections.length > 0 && (
        <ul aria-label="Costs by category" className="mt-3 grid gap-x-5 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((section) => (
            <li key={section.id} className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: section.color }} />
              <span title={section.name} className="min-w-0 flex-1 truncate text-slate-700">{section.name}</span>
              <span className="shrink-0 font-mono text-slate-600">{money(section.cost)}</span>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <Dialog open onClose={close} title="Add pricing section" footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="pricing-section-form" disabled={!name.trim()}>Add section</Button>
          </>
        }>
          <form id="pricing-section-form" onSubmit={submit}>
            <Field label="Section name">
              <input data-autofocus value={name} onChange={(event) => setName(event.target.value)} className={inputCls} maxLength={100} placeholder="Installation" />
            </Field>
          </form>
        </Dialog>
      )}
    </section>
  )
}
