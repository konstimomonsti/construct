import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, Dialog, Icon, inputCls } from '../ui'
import { CategoryTree, useExpanded } from './CategoryTree'
import { applyMoves, indexTree, treeStats } from '../../lib/resolve'
import type { CategoryNode, Position } from '../../lib/types'

/**
 * Searchable single-select category picker with inline "+ New category here" and a renumbering
 * preview ("1.1.40 → 2.3.130") before confirming.
 */
export function MoveToCategory({
  open, onClose, title = 'Move to category', tree, positions, pids, onConfirm, onAddCategory, onRename, initialOz,
}: {
  open: boolean
  onClose: () => void
  title?: string
  /** live (resolved) tree + positions of the list */
  tree: CategoryNode[]
  positions: Position[]
  pids: string[]
  onConfirm: (targetOz: string) => void
  /** creates a category and returns its OZ (the tree prop updates afterwards) */
  onAddCategory: (parentOz: string | null, label: string) => string
  onRename?: (oz: string, label: string) => void
  initialOz?: string
}) {
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<string | undefined>(initialOz)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const ex = useExpanded(tree, 'roots')
  const stats = useMemo(() => treeStats(positions), [positions])
  const idx = useMemo(() => indexTree(tree), [tree])

  useEffect(() => {
    if (open) {
      setQuery('')
      setAdding(false)
      setLabel('')
      setTarget(initialOz)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const preview = useMemo(() => {
    if (!target) return []
    const r = applyMoves(positions, tree, pids.map((id) => [id, target] as [string, string]))
    return pids
      .map((id) => ({ p: positions.find((x) => x.id === id), ch: r.changes.get(id) }))
      .filter((x): x is { p: Position; ch: { from: string; to: string; target: string } | undefined } => !!x.p)
  }, [target, positions, tree, pids])
  const changed = preview.filter((x) => x.ch).length

  const addCat = (e: FormEvent) => {
    e.preventDefault()
    const l = label.trim()
    if (!l) return
    const oz = onAddCategory(target ?? null, l)
    if (target) ex.open(target)
    setTarget(oz)
    setLabel('')
    setAdding(false)
  }

  const targetNode = target ? idx.node.get(target) : undefined

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={`${pids.length} position${pids.length === 1 ? '' : 's'} will get the next free OZ in the chosen category.`}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!target || !changed} onClick={() => target && onConfirm(target)}>
            Move {changed || ''} position{changed === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input data-autofocus aria-label="Search categories" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search categories…" className={`${inputCls} pl-9`} />
        </div>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 p-1">
          <CategoryTree
            tree={tree}
            stats={stats}
            expanded={ex.expanded}
            onToggleExpand={ex.toggle}
            mode="pick"
            label="Target category"
            query={query}
            selectedOz={target}
            onPick={setTarget}
            onRename={onRename}
            hideTotals
          />
        </div>
        {adding ? (
          <form onSubmit={addCat} className="flex items-center gap-2">
            <input
              autoFocus
              aria-label="New category name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={targetNode ? `New sub-category in ${targetNode.oz}` : 'New top-level category'}
              className={inputCls}
              maxLength={120}
            />
            <Button variant="primary" type="submit" disabled={!label.trim()}>Add</Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline">
            <Icon name="add" size={15} />
            New category {targetNode ? `in ${targetNode.oz}` : 'here'}
          </button>
        )}
        {target && (
          <div aria-live="polite" className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Renumbering preview</div>
            {changed === 0 ? (
              <p className="text-xs text-slate-500">Already in this category.</p>
            ) : (
              <ul className="space-y-1">
                {preview.slice(0, 6).map(({ p, ch }) => (
                  <li key={p.id} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-slate-400">{ch?.from ?? p.oz}</span>
                    <Icon name="arrow_forward" size={13} className="text-slate-300" />
                    <span className="font-mono font-semibold text-brand-700" data-testid="renumber-to">{ch?.to ?? p.oz}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-500">{p.short}</span>
                  </li>
                ))}
                {preview.length > 6 && <li className="text-[11px] text-slate-400">+ {preview.length - 6} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
