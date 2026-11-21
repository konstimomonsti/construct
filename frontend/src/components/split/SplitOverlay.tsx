import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { Button, Icon, inputCls, toast } from '../ui'
import { CategoryTree, PIDS_MIME, useExpanded, type CheckState } from './CategoryTree'
import { MoveToCategory } from './MoveToCategory'
import { money, moneyCompact, plural } from '../../lib/format'
import { positionTotal } from '../../lib/money'
import { useMedia } from '../../lib/hooks'
import { makeListDoc } from '../../lib/import'
import { applyMoves, indexTree, leafOz, pruneTree, treeStats } from '../../lib/resolve'
import { useStore } from '../../lib/store'
import type { CategoryNode, ListDoc, Position } from '../../lib/types'

interface Props {
  open: boolean
  onClose: () => void
  doc: ListDoc
  title: string
  /** resolved list (final OZ / paths) */
  positions: Position[]
  tree: CategoryNode[]
  folders: { id: string; name: string }[]
  folderId: string
  preselected: string[]
  onAddCategory: (parentOz: string | null, label: string) => string
  onRenameCategory: (oz: string, label: string) => void
}

const ease = [0.16, 1, 0.3, 1] as const

export function SplitOverlay(props: Props) {
  return createPortal(
    <AnimatePresence>{props.open && <Panel key="split" {...props} />}</AnimatePresence>,
    document.body,
  )
}

function Panel({ onClose, doc, title, positions, tree, folders, folderId, preselected, onAddCategory, onRenameCategory }: Props) {
  const navigate = useNavigate()
  const wide = useMedia('(min-width: 768px)')
  const [pane, setPane] = useState<'select' | 'preview'>('select')
  const [sel, setSel] = useState<Set<string>>(() => new Set(preselected))
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<Map<string, string>>(new Map())
  const [name, setName] = useState(`${title} – Teil`)
  const [target, setTarget] = useState(folderId)
  const [mode, setMode] = useState<'move' | 'copy'>('move')
  const [perRoot, setPerRoot] = useState(false)
  const [pickFor, setPickFor] = useState<string[] | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const ex = useExpanded(tree, 'roots')

  const stats = useMemo(() => treeStats(positions), [positions])
  const byCat = useMemo(() => {
    const m = new Map<string, Position[]>()
    for (const p of positions) {
      const k = leafOz(p)
      const l = m.get(k) ?? []
      l.push(p)
      m.set(k, l)
    }
    return m
  }, [positions])
  const idx = useMemo(() => indexTree(tree), [tree])

  // preselected rows: open their categories so the selection is visible
  useEffect(() => {
    const keys = new Set<string>()
    for (const p of positions) if (preselected.includes(p.id)) for (const r of p.path ?? []) keys.add(r.oz)
    keys.forEach((k) => ex.open(k))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // keyboard: Escape + focus trap
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(), 60)
    const onKey = (e: KeyboardEvent) => {
      if (pickFor) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Tab' && panel.current) {
        const f = [...panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null)
        if (!f.length) return
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [onClose, pickFor])

  const checkState = (kind: 'cat' | 'pos', id: string): CheckState => {
    if (kind === 'pos') return sel.has(id) ? 'on' : 'off'
    const pids = stats.get(id)?.pids ?? []
    if (!pids.length) return 'off'
    let n = 0
    for (const p of pids) if (sel.has(p)) n++
    return n === 0 ? 'off' : n === pids.length ? 'on' : 'mixed'
  }
  const toggle = (kind: 'cat' | 'pos', id: string) =>
    setSel((s) => {
      const n = new Set(s)
      if (kind === 'pos') {
        if (n.has(id)) n.delete(id)
        else n.add(id)
      } else {
        const pids = stats.get(id)?.pids ?? []
        if (pids.length && pids.every((p) => n.has(p))) pids.forEach((p) => n.delete(p))
        else pids.forEach((p) => n.add(p))
      }
      return n
    })

  // ---- preview (pending moves applied)
  const moved = useMemo(() => applyMoves(positions, tree, pending), [positions, tree, pending])
  const chosen = useMemo(() => moved.positions.filter((p) => sel.has(p.id)), [moved, sel])
  const groups = useMemo(() => {
    const m = new Map<string, Position[]>()
    for (const p of chosen) {
      const k = leafOz(p)
      m.set(k, [...(m.get(k) ?? []), p])
    }
    return [...m.entries()].sort((a, b) => (idx.order.get(a[0]) ?? 1e9) - (idx.order.get(b[0]) ?? 1e9))
  }, [chosen, idx])
  const total = chosen.reduce((s, p) => s + positionTotal(p), 0)

  const setMoves = (pids: string[], targetOz: string) =>
    setPending((m) => {
      const n = new Map(m)
      for (const id of pids) n.delete(id), n.set(id, targetOz)
      return n
    })
  const dragIds = (pid: string) => (sel.has(pid) && sel.size > 1 ? [...sel] : [pid])

  const selectAll = () => setSel(new Set(positions.map((p) => p.id)))
  const topLevels = new Set(chosen.map((p) => p.path?.[0]?.oz ?? ''))

  const run = () => {
    if (!chosen.length || !name.trim()) return
    const st = useStore.getState()
    const make = (label: string, list: Position[]) => {
      const keep = new Set<string>()
      for (const p of list) for (const r of p.path ?? []) keep.add(r.oz)
      const d = makeListDoc(target, label, `${doc.fileName} (split)`, list.map((p) => ({ ...p })), {
        format: doc.format, phase: doc.phase, project: doc.project, projectLabel: doc.projectLabel, currency: doc.currency,
        date: doc.date, tree: pruneTree(tree, keep), source: doc.source,
      })
      st.addList(d)
      st.openTab(d.id)
      return d
    }
    const created: ListDoc[] = []
    if (perRoot && topLevels.size > 1) {
      const byRoot = new Map<string, Position[]>()
      for (const p of chosen) {
        const k = p.path?.[0]?.oz ?? ''
        byRoot.set(k, [...(byRoot.get(k) ?? []), p])
      }
      for (const [k, list] of byRoot) created.push(make(`${name.trim()} – ${idx.node.get(k)?.label ?? list[0].category}`, list))
    } else created.push(make(name.trim(), chosen))
    const pids = [...sel]
    if (mode === 'move') st.removePositions(doc.id, pids)
    onClose()
    toast(`${mode === 'move' ? 'Moved' : 'Copied'} ${plural(pids.length, 'position', 'positions')} into ${created.length > 1 ? `${created.length} new lists` : `"${created[0].title}"`}`, 'ok', {
      label: 'Undo',
      run: () => {
        const s2 = useStore.getState()
        created.forEach((c) => s2.deleteList(c.id))
        if (mode === 'move') s2.restorePositions(doc.id, pids)
      },
    })
    navigate(created.length === 1 ? `/list/${created[0].id}` : `/folder/${target}`)
  }

  const leftPane = (
    <section aria-label="Select positions" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2.5">
        <div className="relative min-w-40 flex-1">
          <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
          <input data-autofocus aria-label="Filter categories and positions" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter categories / positions…" className={`${inputCls} h-8 pl-8`} />
        </div>
        <button type="button" onClick={ex.expandAll} className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">Expand all</button>
        <button type="button" onClick={ex.collapseAll} className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">Collapse all</button>
        <span className="hidden h-4 w-px bg-slate-200 sm:block" />
        <button type="button" onClick={selectAll} className="rounded-md px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50">Select all</button>
        <button type="button" onClick={() => setSel(new Set())} className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100">Clear</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <CategoryTree
          tree={tree}
          stats={stats}
          positions={byCat}
          expanded={ex.expanded}
          onToggleExpand={ex.toggle}
          mode="check"
          label="Categories and positions"
          query={query}
          checkState={checkState}
          onToggle={toggle}
          onRename={onRenameCategory}
          dragIds={dragIds}
          onDropPositions={(oz, pids) => {
            const ids = pids.filter((id) => sel.has(id))
            if (!ids.length) {
              toast('Drag selected positions only (tick them first)', 'info')
              return
            }
            setMoves(ids, oz)
          }}
        />
      </div>
    </section>
  )

  const rightPane = (
    <section aria-label="Preview of selected positions" className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50/50">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-xs">
        <span className="font-semibold text-slate-700" aria-live="polite" data-testid="split-count">{plural(chosen.length, 'position', 'positions')} selected</span>
        <span className="font-mono font-semibold text-slate-900">{money(total)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!chosen.length && (
          <div className="flex h-full flex-col items-center justify-center text-center text-xs text-slate-400">
            <Icon name="checklist" size={30} className="mb-2 text-slate-300" />
            Tick categories or positions on the left to build the new list.
          </div>
        )}
        {groups.map(([oz, list]) => {
          const g = idx.node.get(oz)
          return (
            <div key={oz} className="overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid="preview-group" data-oz={oz}>
              <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-3 py-1.5 text-xs">
                <span className="font-mono text-[11px] text-slate-400">{oz}</span>
                <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">{g?.label ?? list[0].category}</span>
                <span className="rounded-full bg-white px-1.5 font-mono text-[10px] text-slate-500 ring-1 ring-slate-200">{list.length}</span>
                <span className="font-mono text-[11px] text-slate-600">{moneyCompact(list.reduce((s, p) => s + positionTotal(p), 0))}</span>
              </div>
              <ul>
                {list.map((p) => {
                  const ch = moved.changes.get(p.id)
                  return (
                    <li
                      key={p.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(PIDS_MIME, JSON.stringify([p.id]))
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      data-pid={p.id}
                      className="group/p flex items-center gap-2 border-b border-slate-50 px-3 py-1.5 text-xs last:border-0 hover:bg-slate-50"
                    >
                      <Icon name="drag_indicator" size={15} className="cursor-grab text-slate-300" />
                      <span className="shrink-0 font-mono text-[11px]">
                        {ch ? (
                          <>
                            <span className="text-slate-400 line-through">{ch.from}</span>
                            <Icon name="arrow_forward" size={12} className="mx-0.5 inline text-slate-300" />
                            <span className="font-semibold text-brand-700" data-testid="new-oz">{ch.to}</span>
                          </>
                        ) : (
                          <span className="text-slate-500">{p.oz}</span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-slate-700" title={p.short}>{p.short}</span>
                      <span className="shrink-0 font-mono text-[11px] text-slate-500">{positionTotal(p) > 0 ? moneyCompact(positionTotal(p)) : '—'}</span>
                      <button type="button" title="Move to another category" aria-label={`Move ${p.oz} to another category`} onClick={() => setPickFor([p.id])} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                        <Icon name="drive_file_move" size={16} />
                      </button>
                      <button type="button" title="Remove from selection" aria-label={`Remove ${p.oz} from selection`} onClick={() => toggle('pos', p.id)} className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                        <Icon name="close" size={16} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )

  return (
    <div className="fixed inset-0 z-[78]">
      <motion.div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="split-title"
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24, transition: { duration: 0.16 } }}
        transition={{ duration: 0.22, ease }}
        className="absolute inset-0 flex flex-col overflow-hidden bg-white shadow-2xl md:inset-6 md:rounded-2xl md:border md:border-slate-200 lg:inset-8"
      >
        <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon name="call_split" size={20} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="split-title" className="font-heading text-base font-bold tracking-tight text-slate-900">Split list</h2>
            <p className="truncate font-mono text-[11px] text-slate-400">{doc.fileName}</p>
          </div>
          <button type="button" aria-label="Close split panel" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <Icon name="close" size={20} />
          </button>
        </header>

        {!wide && (
          <div role="group" aria-label="Panel" className="flex gap-1 border-b border-slate-100 p-2">
            {(['select', 'preview'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={pane === k} onClick={() => setPane(k)} className={clsx('flex-1 rounded-lg py-1.5 text-xs font-semibold', pane === k ? 'bg-brand-50 text-brand-700' : 'text-slate-500')}>
                {k === 'select' ? 'Select' : `Preview (${sel.size})`}
              </button>
            ))}
          </div>
        )}

        <div className="flex min-h-0 flex-1 divide-x divide-slate-100">
          {(wide || pane === 'select') && leftPane}
          {(wide || pane === 'preview') && rightPane}
        </div>

        <footer className="space-y-3 border-t border-slate-200 bg-slate-50/60 px-4 py-3 sm:px-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-slate-600">New list name</span>
              <input aria-label="New list name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={100} />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-slate-600">Target folder</span>
              <select aria-label="Target folder" value={target} onChange={(e) => setTarget(e.target.value)} className={inputCls}>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-700">
              <fieldset className="flex items-center gap-4" aria-label="Mode">
                <label className="flex cursor-pointer items-center gap-1.5"><input type="radio" name="split-mode" checked={mode === 'move'} onChange={() => setMode('move')} className="accent-brand-600" />Move to new list</label>
                <label className="flex cursor-pointer items-center gap-1.5"><input type="radio" name="split-mode" checked={mode === 'copy'} onChange={() => setMode('copy')} className="accent-brand-600" />Copy to new list</label>
              </fieldset>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" className="checkbox" checked={perRoot} onChange={(e) => setPerRoot(e.target.checked)} />
                One list per selected top-level category{perRoot && topLevels.size > 1 ? ` (${topLevels.size})` : ''}
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="lg" disabled={!chosen.length || !name.trim()} onClick={run} data-testid="split-run">
                Split {chosen.length} position{chosen.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        </footer>
      </motion.div>

      <MoveToCategory
        open={!!pickFor}
        onClose={() => setPickFor(null)}
        title="Move to category"
        tree={tree}
        positions={moved.positions}
        pids={pickFor ?? []}
        onAddCategory={onAddCategory}
        onRename={onRenameCategory}
        onConfirm={(oz) => {
          if (pickFor) setMoves(pickFor, oz)
          setPickFor(null)
        }}
      />
    </div>
  )
}
