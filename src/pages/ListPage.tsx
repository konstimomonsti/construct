import { clsx } from 'clsx'
import { lazy, Suspense, use, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Dialog, Field, Icon, Menu, inputCls, toast } from '../components/ui'
import { Page, TableSkeleton } from '../components/Page'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { LedgerTable } from '../components/LedgerTable'
import { BudgetAlert } from '../components/BudgetAlert'
import { DetailDrawer } from '../components/DetailDrawer'
import { fileUrl, loadList } from '../lib/data'
import { downloadText, safeName, toCsv } from '../lib/export'
import { CategoryTree, useExpanded, type CheckState } from '../components/split/CategoryTree'
import { MoveToCategory } from '../components/split/MoveToCategory'
import { money, moneyCompact, niceCap, plural } from '../lib/format'
import { positionTotal } from '../lib/money'
import { applyMoves, indexTree, leafOz, nextChildOz, resolveList, treeStats, type CatStat } from '../lib/resolve'
import { statsOf, useModel, useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'
import type { CategoryNode, ListDoc, Position } from '../lib/types'

const SplitOverlay = lazy(() => import('../components/split/SplitOverlay').then((m) => ({ default: m.SplitOverlay })))

export function ListPage() {
  const { listId = '' } = useParams()
  useEffect(() => {
    if (listId) useStore.getState().openTab(listId)
  }, [listId])
  return (
    <Page className="mx-auto flex w-full max-w-7xl flex-col px-4 pt-5 pb-16 sm:px-6">
      <ErrorBoundary key={listId}>
        <Suspense fallback={<><div className="mb-4 h-8" /><TableSkeleton /></>}>
          <Loaded id={listId} />
        </Suspense>
      </ErrorBoundary>
    </Page>
  )
}

function Loaded({ id }: { id: string }) {
  const doc = use(loadList(id))
  return <ListDetail key={doc.id} doc={doc} />
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function TabsBar({ activeId, folderId }: { activeId: string; folderId: string }) {
  const tabs = useStore((s) => s.openTabs)
  const { lists } = useModel()
  const navigate = useNavigate()
  const setPalette = useUi((s) => s.setPalette)
  const byId = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists])
  const visible = tabs.filter((t) => byId.has(t) && !byId.get(t)!.trashedAt)

  const close = (id: string) => {
    const i = visible.indexOf(id)
    useStore.getState().closeTab(id)
    if (id === activeId) {
      const next = visible[i + 1] ?? visible[i - 1]
      navigate(next ? `/list/${next}` : `/folder/${folderId}`)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1 rounded-xl border border-slate-200/90 bg-white p-1 shadow-xs">
      <nav aria-label="Open lists" className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {visible.map((id) => {
          const l = byId.get(id)!
          const active = id === activeId
          return (
            <div key={id} className="group relative flex shrink-0 items-center">
              {active && <motion.span layoutId="tab-pill" className="absolute inset-0 rounded-lg bg-slate-100" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
              <Link
                to={`/list/${id}`}
                aria-current={active ? 'page' : undefined}
                title={l.title}
                className={clsx(
                  'relative flex max-w-[15rem] items-center gap-2 rounded-lg py-1.5 pr-7 pl-3 text-xs transition-colors',
                  active ? 'font-semibold text-slate-900' : 'font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-800',
                )}
              >
                <Icon name="description" size={15} className={active ? 'text-brand-600' : 'text-slate-400'} />
                <span className="truncate">{l.fileName}</span>
                {l.pricedCount > 0 && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500 transition-opacity group-focus-within:opacity-0 group-hover:opacity-0" aria-label="has prices" />}
              </Link>
              <button
                type="button"
                aria-label={`Close ${l.fileName}`}
                onClick={() => close(id)}
                className="absolute right-1.5 flex size-4 items-center justify-center rounded text-slate-400 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-slate-200 hover:text-slate-700"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )
        })}
      </nav>
      <button type="button" title="Open another list" aria-label="Open another list" onClick={() => setPalette(true)} className="shrink-0 rounded-lg px-2 py-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
        <Icon name="add" size={16} />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Category filter                                                     */
/* ------------------------------------------------------------------ */

function CategoryFilter({ tree, stats, value, onChange }: { tree: CategoryNode[]; stats: Map<string, CatStat>; value: Set<string> | null; onChange: (v: Set<string> | null) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  const ex = useExpanded(tree, 'all')
  const idx = useMemo(() => indexTree(tree), [tree])
  const allOz = useMemo(() => [...idx.node.keys()], [idx])
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  const subtree = (oz: string): string[] => {
    const out: string[] = []
    const walk = (n: CategoryNode) => (out.push(n.oz), n.children.forEach(walk))
    const n = idx.node.get(oz)
    if (n) walk(n)
    return out
  }
  const checkState = (_k: 'cat' | 'pos', oz: string): CheckState => {
    if (!value) return 'on'
    const ids = subtree(oz)
    const n = ids.filter((x) => value.has(x)).length
    return n === 0 ? 'off' : n === ids.length ? 'on' : 'mixed'
  }
  const toggle = (_k: 'cat' | 'pos', oz: string) => {
    const cur = new Set(value ?? allOz)
    const ids = subtree(oz)
    if (ids.every((x) => cur.has(x))) ids.forEach((x) => cur.delete(x))
    else ids.forEach((x) => cur.add(x))
    onChange(cur.size === allOz.length ? null : cur)
  }
  return (
    <div ref={root} className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-2 rounded-lg border border-slate-200/80 bg-white px-3.5 text-xs font-medium text-slate-700 shadow-xs transition-colors hover:bg-slate-50"
      >
        <Icon name="filter_alt" size={16} className="text-slate-500" />
        <span>Filter Categories</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">{value ? `${value.size}/${allOz.length}` : `All ${allOz.length}`}</span>
        <Icon name="expand_more" size={16} className={clsx('text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-0 z-40 mt-1.5 w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_4px_20px_-2px_rgba(15,23,42,0.1)]"
          >
            <div className="flex items-center gap-2 px-1.5 py-1.5">
              <input aria-label="Search categories" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search categories…" className="h-7 min-w-0 flex-1 rounded-md border border-slate-200 px-2 text-xs outline-none focus:border-brand-500" />
              <span className="flex gap-3 text-[11px] font-medium text-brand-600">
                <button type="button" className="hover:underline" onClick={() => onChange(null)}>All</button>
                <button type="button" className="hover:underline" onClick={() => onChange(new Set())}>None</button>
              </span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              <CategoryTree tree={tree} stats={stats} expanded={ex.expanded} onToggleExpand={ex.toggle} mode="check" label="Filter by category" query={query} checkState={checkState} onToggle={toggle} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Add item                                                            */
/* ------------------------------------------------------------------ */

function AddItemDialog({ open, onClose, listId, cats, nextOz }: { open: boolean; onClose: () => void; listId: string; cats: string[]; nextOz: string }) {
  const [f, setF] = useState({ oz: '', short: '', qty: '1', unit: 'St', up: '', cat: '' })
  const dl = useId()
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }))
  const num = (s: string) => Number(s.trim().replace(',', '.'))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!f.short.trim()) return
    const q = f.qty.trim() === '' ? 1 : num(f.qty)
    const up = f.up.trim() === '' ? null : num(f.up)
    if (!Number.isFinite(q) || q < 0 || (up !== null && !Number.isFinite(up))) {
      toast('Please enter valid numbers for quantity and price', 'error')
      return
    }
    const p: Position = {
      id: `u${Date.now().toString(36)}`,
      oz: f.oz.trim() || nextOz,
      short: f.short.trim(),
      qty: q,
      unit: f.unit.trim() || 'St',
      up,
      category: f.cat.trim() || 'Eigene Positionen',
    }
    useStore.getState().addPosition(listId, p)
    toast(`Added ${p.oz}`)
    setF({ oz: '', short: '', qty: '1', unit: 'St', up: '', cat: '' })
    onClose()
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add item"
      description="Adds a new position to this list."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-item-form" disabled={!f.short.trim()}>Add item</Button>
        </>
      }
    >
      <form id="add-item-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="OZ"><input className={`${inputCls} font-mono`} value={f.oz} onChange={set('oz')} placeholder={nextOz} /></Field>
        <Field label="Einheit"><input className={inputCls} value={f.unit} onChange={set('unit')} placeholder="St, m, m2, psch" /></Field>
        <div className="col-span-2">
          <Field label="Kurztext"><input data-autofocus className={inputCls} value={f.short} onChange={set('short')} maxLength={200} /></Field>
        </div>
        <Field label="Menge"><input inputMode="decimal" className={`${inputCls} font-mono`} value={f.qty} onChange={set('qty')} /></Field>
        <Field label="Einheitspreis (EP, €)"><input inputMode="decimal" className={`${inputCls} font-mono`} value={f.up} onChange={set('up')} placeholder="optional" /></Field>
        <div className="col-span-2">
          <Field label="Kategorie">
            <input className={inputCls} list={dl} value={f.cat} onChange={set('cat')} placeholder="Eigene Positionen" />
            <datalist id={dl}>{cats.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
        </div>
      </form>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function ListDetail({ doc }: { doc: ListDoc }) {
  const [params] = useSearchParams()
  const { lists, folders } = useModel()
  const openDialog = useUi((s) => s.openDialog)
  const view = lists.find((l) => l.id === doc.id)
  const folder = folders.find((f) => f.id === (view?.folderId ?? doc.folderId))
  const edits = useStore((s) => s.edits[doc.id])
  const resolved = useMemo(() => resolveList(doc, edits), [doc, edits])
  const positions = resolved.positions
  const tree = resolved.tree
  const catStats = useMemo(() => treeStats(positions), [positions])
  const st = useMemo(() => statsOf(positions), [positions])

  const [q, setQ] = useState('')
  const [cats, setCats] = useState<Set<string> | null>(null)
  const [sortTotal, setSortTotal] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [splitPre, setSplitPre] = useState<string[] | null>(null)
  const [splitMounted, setSplitMounted] = useState(false)
  const [movePids, setMovePids] = useState<string[] | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const focusId = params.get('pos')

  useEffect(() => {
    useStore.getState().recordStats(doc.id, st)
  }, [doc.id, st])
  useEffect(() => {
    setSelected(new Set())
  }, [doc.id])

  const title = view?.title ?? doc.title
  const cap = view?.cap ?? niceCap(doc.total)
  const used = cap ? (st.total / cap) * 100 : 0
  const categories = useMemo(() => [...new Set(positions.map((p) => p.category))].sort((a, b) => a.localeCompare(b, 'de')), [positions])
  const editedIds = useMemo(() => new Set([...Object.keys(edits?.qty ?? {}), ...Object.keys(edits?.up ?? {}), ...Object.keys(edits?.patch ?? {}), ...Object.keys(edits?.moves ?? {})]), [edits])
  const addedIds = useMemo(() => new Set((edits?.added ?? []).map((p) => p.id)), [edits])

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    let r = positions.filter(
      (p) => (!cats || cats.has(leafOz(p))) && (!t || p.oz.toLowerCase().includes(t) || p.short.toLowerCase().includes(t) || p.category.toLowerCase().includes(t)),
    )
    if (sortTotal) r = [...r].sort((a, b) => positionTotal(b) - positionTotal(a))
    return r
  }, [positions, q, cats, sortTotal])

  const largest = useMemo(() => {
    let best: Position | null = null
    for (const p of positions) if (!best || positionTotal(p) > positionTotal(best)) best = p
    return best && positionTotal(best) > 0 ? { short: best.short, amount: positionTotal(best) } : null
  }, [positions])

  const detail = detailId ? positions.find((p) => p.id === detailId) ?? null : null

  const exportCsv = () => downloadText(`${safeName(title)}.csv`, toCsv(positions), 'text/csv')
  const exportJson = () =>
    downloadText(`${safeName(title)}.json`, JSON.stringify({ ...doc, title, total: st.total, positionsCount: st.positionsCount, pricedCount: st.pricedCount, positions }, null, 2), 'application/json')

  const removeSelected = () => {
    const ids = [...selected]
    useStore.getState().removePositions(doc.id, ids)
    setSelected(new Set())
    toast(`Removed ${plural(ids.length, 'position', 'positions')}`, 'ok', { label: 'Undo', run: () => useStore.getState().restorePositions(doc.id, ids) })
  }

  const split = () => {
    setSplitMounted(true)
    setSplitPre([...selected])
  }

  const addCategory = (parentOz: string | null, label: string) => {
    const oz = nextChildOz(tree, parentOz)
    useStore.getState().addCategory(doc.id, oz, label, parentOz)
    return oz
  }
  const renameCategory = (oz: string, label: string) => useStore.getState().renameCategory(doc.id, oz, label)

  const confirmMove = (targetOz: string) => {
    const pids = movePids ?? []
    const prev = useStore.getState().edits[doc.id]
    const r = applyMoves(positions, tree, pids.map((id) => [id, targetOz] as [string, string]))
    useStore.getState().movePositions(doc.id, pids, targetOz)
    setMovePids(null)
    const first = [...r.changes.values()][0]
    const label = indexTree(tree).node.get(targetOz)?.label ?? targetOz
    toast(`Moved ${plural(r.changes.size, 'position', 'positions')} to ${label}${first ? ` (${first.from} → ${first.to})` : ''}`, 'ok', {
      label: 'Undo',
      run: () => useStore.getState().setEdits(doc.id, prev),
    })
  }

  const review = () => {
    setSortTotal(true)
    setQ('')
    setCats(null)
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
  }

  const meta = [doc.format, doc.phase, doc.projectLabel ?? doc.project, doc.date].filter(Boolean)

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs font-medium text-slate-500">
        <Link to="/" className="inline-flex items-center gap-1 transition-colors hover:text-slate-800">
          <Icon name="home" size={15} className="text-slate-400" />
          Home
        </Link>
        <Icon name="chevron_right" size={13} className="text-slate-300" />
        <Link to="/" className="inline-flex items-center gap-1 transition-colors hover:text-slate-800">
          <Icon name="source" size={15} className="text-slate-400" />
          Repositories
        </Link>
        <Icon name="chevron_right" size={13} className="text-slate-300" />
        <Link to={`/folder/${folder?.id ?? doc.folderId}`} className="inline-flex max-w-[16rem] items-center gap-1 transition-colors hover:text-slate-800">
          <Icon name="folder" size={15} className="text-slate-400" />
          <span className="truncate">{folder?.name ?? 'Folder'}</span>
        </Link>
        <Icon name="chevron_right" size={13} className="text-slate-300" />
        <span title={title} className="inline-flex max-w-[18rem] items-center gap-1 rounded border border-slate-200/60 bg-slate-100/80 px-2 py-0.5 font-semibold text-slate-800">
          <Icon name="description" size={14} className="text-brand-600" />
          <span className="truncate">{doc.fileName}</span>
        </span>
      </nav>

      {view?.trashedAt && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
          <span className="flex items-center gap-2"><Icon name="delete" size={16} />This list is in the Trash.</span>
          <button type="button" className="font-semibold hover:underline" onClick={() => useStore.getState().patchList(doc.id, { trashedAt: undefined })}>Restore</button>
        </div>
      )}

      <div className="flex min-w-0 items-center justify-between gap-3 pb-4">
        <TabsBar activeId={doc.id} folderId={folder?.id ?? doc.folderId} />
        <Menu
          label="Export"
          width="w-52"
          items={[
            { label: 'Export as CSV', icon: 'table_view', onSelect: exportCsv },
            { label: 'Export as JSON', icon: 'data_object', onSelect: exportJson },
            ...(doc.file ? ([{ label: 'Original file', icon: 'attach_file', onSelect: () => window.open(fileUrl(doc.file), '_blank') }] as const) : []),
          ]}
          trigger={(p) => (
            <button {...p} type="button" className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-xs transition-colors hover:bg-slate-50">
              <Icon name="file_download" size={15} className="text-slate-500" />
              Export
            </button>
          )}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              aria-label="Search positions"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search OZ, Kurztext, category..."
              className="h-9 w-full rounded-lg border border-slate-200 bg-white pr-3 pl-9 text-xs text-slate-800 shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <CategoryFilter tree={tree} stats={catStats} value={cats} onChange={setCats} />
        </div>
        <div className="flex items-center gap-2">
          <Button size="lg" className="h-9" icon="call_split" iconClass="text-slate-500" onClick={split}>Split List</Button>
          <Button variant="primary" size="lg" className="h-9" icon="add" onClick={() => setAdding(true)}>Add Item</Button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div role="toolbar" aria-label="Selected rows" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-xs">
              <span className="font-semibold text-brand-700" aria-live="polite">{selected.size} selected</span>
              <span className="mx-1 h-4 w-px bg-brand-200" />
              <button type="button" onClick={removeSelected} className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-rose-600 hover:bg-rose-50">
                <Icon name="delete" size={15} />Remove selected
              </button>
              <button type="button" onClick={() => setMovePids([...selected])} className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-700 hover:bg-white">
                <Icon name="drive_file_move" size={15} />Move to category…
              </button>
              <button type="button" onClick={split} className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-700 hover:bg-white">
                <Icon name="call_split" size={15} />Split into new list
              </button>
              <button type="button" onClick={() => setSelected(new Set())} className="ml-auto rounded-md px-2 py-1 font-medium text-slate-500 hover:bg-white hover:text-slate-800">Clear</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div ref={tableRef} className="scroll-mt-20">
        <LedgerTable
          listId={doc.id}
          rows={rows}
          allPositions={positions}
          selected={selected}
          setSelected={setSelected}
          over75={cap > 0 && used >= 75}
          focusId={focusId}
          onOpen={(p) => setDetailId(p.id)}
          onMove={(pid) => setMovePids([pid])}
          editedIds={editedIds}
          sortActive={sortTotal}
          onResetSort={() => setSortTotal(false)}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-[11px] text-slate-500">
              <span>{[...meta, `${st.positionsCount} positions`, `${st.pricedCount} priced`].join(' · ')}</span>
              <span>
                Total <span className="font-mono font-semibold text-slate-700">{money(st.total)}</span> of cap{' '}
                <button type="button" title="Edit budget cap" onClick={() => openDialog({ kind: 'cap', target: 'list', id: doc.id })} className="font-mono font-medium text-slate-600 transition-colors hover:text-brand-600">
                  {cap ? moneyCompact(cap) : 'Set cap'}
                </button>
              </span>
            </div>
          }
          resetKey={`${q}|${cats ? [...cats].join(',') : '*'}|${sortTotal}`}
        />
      </div>

      <BudgetAlert
        total={st.total}
        cap={cap}
        largest={largest}
        onReview={review}
        onSetCap={(prefill) => openDialog({ kind: 'cap', target: 'list', id: doc.id, prefill })}
      />

      {doc.notes && (
        <section className="mt-4 rounded-xl border border-slate-200 bg-white shadow-xs">
          <button
            type="button"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-xs font-semibold text-slate-800"
          >
            <span className="flex items-center gap-2"><Icon name="notes" size={17} className="text-slate-400" />Vorbemerkungen</span>
            <Icon name="expand_more" size={18} className={clsx('text-slate-400 transition-transform', notesOpen && 'rotate-180')} />
          </button>
          <AnimatePresence initial={false}>
            {notesOpen && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
                <div className="max-h-96 overflow-y-auto border-t border-slate-100 px-4 py-3 text-xs leading-relaxed whitespace-pre-line text-slate-600">{doc.notes}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}

      <AddItemDialog open={adding} onClose={() => setAdding(false)} listId={doc.id} cats={categories} nextOz={String(positions.length + 1)} />
      <DetailDrawer
        p={detail}
        onClose={() => setDetailId(null)}
        edited={!!detail && editedIds.has(detail.id)}
        added={!!detail && addedIds.has(detail.id)}
        onPatch={(patch) => detail && useStore.getState().patchPosition(doc.id, detail.id, patch)}
        onQty={(n) => detail && useStore.getState().setQty(doc.id, detail.id, n)}
        onUp={(n) => detail && useStore.getState().setUp(doc.id, detail.id, n)}
        onReset={() => detail && useStore.getState().resetPosition(doc.id, detail.id)}
        onMoveCategory={() => detail && setMovePids([detail.id])}
      />
      <MoveToCategory
        open={!!movePids}
        onClose={() => setMovePids(null)}
        tree={tree}
        positions={positions}
        pids={movePids ?? []}
        onAddCategory={addCategory}
        onRename={renameCategory}
        onConfirm={confirmMove}
      />
      {splitMounted && (
        <Suspense fallback={null}>
          <SplitOverlay
            open={splitPre !== null}
            onClose={() => setSplitPre(null)}
            doc={doc}
            title={title}
            positions={positions}
            tree={tree}
            folders={folders.filter((f) => !f.trashedAt).map((f) => ({ id: f.id, name: f.name }))}
            folderId={view?.folderId ?? doc.folderId}
            preselected={splitPre ?? []}
            onAddCategory={addCategory}
            onRenameCategory={renameCategory}
          />
        </Suspense>
      )}
    </>
  )
}
