import { useEffect, useMemo, useState } from 'react'
import { Button, Icon, inputCls } from '../ui'
import { CategoryTree, useExpanded, type CheckState } from '../split/CategoryTree'
import { plural, qty } from '../../lib/format'
import { leafOz, treeStats } from '../../lib/resolve'
import { summarize, type Conflict } from '../../lib/subcontract'
import type { CategoryNode, Position } from '../../lib/types'

/** step 1: which positions or sections the subcontractor should do */
export function WhatPane({
  tree, positions, sel, onSel, conflicts, onKeepHere, onDeselect,
}: {
  tree: CategoryNode[]
  positions: Position[]
  sel: Set<string>
  onSel: (next: Set<string>) => void
  /** selected positions another package already holds */
  conflicts: Conflict[]
  onKeepHere: (ids: string[]) => void
  onDeselect: (ids: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const ex = useExpanded(tree, 'roots')
  const stats = useMemo(() => treeStats(positions), [positions])
  const byCat = useMemo(() => {
    const m = new Map<string, Position[]>()
    for (const p of positions) {
      const k = leafOz(p)
      m.set(k, [...(m.get(k) ?? []), p])
    }
    return m
  }, [positions])

  // open the categories that hold the starting selection, so it is visible
  useEffect(() => {
    for (const p of positions) if (sel.has(p.id)) for (const r of p.path ?? []) ex.open(r.oz)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const checkState = (kind: 'cat' | 'pos', id: string): CheckState => {
    if (kind === 'pos') return sel.has(id) ? 'on' : 'off'
    const pids = stats.get(id)?.pids ?? []
    if (!pids.length) return 'off'
    const n = pids.filter((p) => sel.has(p)).length
    return n === 0 ? 'off' : n === pids.length ? 'on' : 'mixed'
  }
  const toggle = (kind: 'cat' | 'pos', id: string) => {
    const n = new Set(sel)
    if (kind === 'pos') {
      if (n.has(id)) n.delete(id)
      else n.add(id)
    } else {
      const pids = stats.get(id)?.pids ?? []
      if (pids.length && pids.every((p) => n.has(p))) pids.forEach((p) => n.delete(p))
      else pids.forEach((p) => n.add(p))
    }
    onSel(n)
  }

  const chosen = useMemo(() => positions.filter((p) => sel.has(p.id)), [positions, sel])
  const sum = useMemo(() => summarize(chosen), [chosen])
  const byPackage = useMemo(() => {
    const m = new Map<string, { name: string; ids: string[] }>()
    for (const c of conflicts) m.set(c.pkg.id, { name: c.pkg.name, ids: [...(m.get(c.pkg.id)?.ids ?? []), c.positionId] })
    return [...m.values()]
  }, [conflicts])

  return (
    <section aria-label="Select positions" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2.5">
        <div className="relative min-w-40 flex-1">
          <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
          <input aria-label="Filter sections and positions" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter sections / positions…" className={`${inputCls} h-8 pl-8`} />
        </div>
        <button type="button" onClick={ex.expandAll} className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">Expand all</button>
        <button type="button" onClick={ex.collapseAll} className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">Collapse all</button>
        <span className="hidden h-4 w-px bg-slate-200 sm:block" />
        <button type="button" onClick={() => onSel(new Set(positions.map((p) => p.id)))} className="rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">Select all</button>
        <button type="button" onClick={() => onSel(new Set())} className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100">Clear</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <CategoryTree
          tree={tree}
          stats={stats}
          positions={byCat}
          expanded={ex.expanded}
          onToggleExpand={ex.toggle}
          mode="check"
          label="Sections and positions"
          query={query}
          checkState={checkState}
          onToggle={toggle}
          hideTotals
        />
      </div>
      {byPackage.length > 0 && (
        <div role="alert" data-testid="sc-conflict" className="space-y-2 border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <p className="flex items-start gap-2 font-semibold">
            <Icon name="warning" size={16} className="mt-px shrink-0" />
            A position can be in only one package.
          </p>
          {byPackage.map((g) => (
            <div key={g.name} className="flex flex-wrap items-center justify-between gap-2 pl-6">
              <span>{plural(g.ids.length, 'selected position is', 'selected positions are')} already in “{g.name}”.</span>
              <span className="flex gap-1.5">
                <Button size="sm" onClick={() => onKeepHere(g.ids)}>Move to this package</Button>
                <Button size="sm" variant="ghost" onClick={() => onDeselect(g.ids)}>Deselect them</Button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-xs" aria-live="polite" data-testid="sc-summary">
        <span className="font-semibold text-slate-700">{plural(sum.count, 'position', 'positions')} selected</span>
        <span className="min-w-0 truncate text-slate-600">
          {sum.byUnit.slice(0, 4).map((u) => `${qty(u.qty)} ${u.unit}`).join(' · ')}
          {sum.byUnit.length > 4 ? ' · …' : ''}
        </span>
      </div>
    </section>
  )
}
