import { clsx } from 'clsx'
import { lazy, Suspense, use, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Dialog, Field, Icon, inputCls, toast, type MenuItem } from '../components/ui'
import { TableSkeleton } from '../components/Page'
import { PageFrame, PageHeader, RowMenu, SortMenu, Summary, statusText } from '../components/Kit'
import { phaseLabel } from '../components/ListCard'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { LedgerTable } from '../components/LedgerTable'
import { DetailDrawer } from '../components/DetailDrawer'
import { loadList } from '../lib/data'
import { ExportMenu } from '../components/ExportMenu'
import { CategoryTree, useExpanded, type CheckState } from '../components/split/CategoryTree'
import { MoveToCategory } from '../components/split/MoveToCategory'
import { budgetStatus, int, money, niceCap, parseNumber, plural } from '../lib/format'
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
    <PageFrame>
      <ErrorBoundary key={listId}>
        <Suspense fallback={<TableSkeleton />}>
          <Loaded id={listId} />
        </Suspense>
      </ErrorBoundary>
    </PageFrame>
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

  if (visible.length < 2) return null
  return (
    <div className="mb-5 flex min-w-0 items-center gap-1">
      <nav aria-label="Open lists" className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {visible.map((id) => {
          const l = byId.get(id)!
          const active = id === activeId
          return (
            <div key={id} className="group relative flex shrink-0 items-center">
              {active && <motion.span layoutId="tab-pill" className="absolute inset-0 rounded-full bg-brand-50 ring-1 ring-brand-200" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
              <Link
                to={`/list/${id}`}
                aria-current={active ? 'page' : undefined}
                title={l.title}
                className={clsx(
                  'relative flex h-10 max-w-[16rem] items-center gap-2 rounded-full pr-10 pl-4 text-sm transition-colors',
                  active ? 'font-semibold text-brand-700' : 'bg-slate-100 font-medium text-slate-800 hover:bg-slate-200 hover:text-slate-900',
                )}
              >
                <span className="truncate">{l.fileName}</span>
              </Link>
              <button
                type="button"
                aria-label={`Close ${l.fileName}`}
                onClick={() => close(id)}
                className={clsx('absolute right-1 flex size-8 items-center justify-center rounded-full transition-colors', active ? 'text-brand-700 hover:bg-brand-100' : 'text-slate-600 hover:bg-slate-300/60 hover:text-slate-900')}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )
        })}
      </nav>
      <button type="button" title="Open another list" aria-label="Open another list" onClick={() => setPalette(true)} className="flex size-10 shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900">
        <Icon name="add" size={20} />
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
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  const ex = useExpanded(tree, 'all')
  const idx = useMemo(() => indexTree(tree), [tree])
  const allOz = useMemo(() => [...idx.node.keys()], [idx])
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    // focus moves into the panel so keyboard users land on the search field
    requestAnimationFrame(() => search.current?.focus())
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
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={clsx('flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors', value ? 'bg-brand-50 font-semibold text-brand-700 ring-1 ring-brand-200' : 'bg-slate-100 text-slate-800 hover:bg-slate-200')}
      >
        <Icon name="filter_list" size={18} />
        <span>{value ? `${value.size} of ${allOz.length} categories` : 'Categories'}</span>
        <Icon name="expand_more" size={18} className={clsx('transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            role="dialog"
            aria-label="Filter by category"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-0 z-40 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-2 shadow-[0_8px_30px_-4px_rgba(15,23,42,0.18)] ring-1 ring-slate-200"
          >
            <div className="flex items-center gap-2 px-1.5 py-1.5">
              <input ref={search} aria-label="Search categories" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search categories…" className="h-10 min-w-0 flex-1 rounded-full border border-transparent bg-slate-100 px-4 text-sm outline-none placeholder:text-slate-600 focus:border-brand-600 focus:bg-white" />
              <span className="flex gap-1 text-sm font-semibold text-slate-800">
                <button type="button" className="h-10 rounded-full px-3 hover:bg-slate-100" onClick={() => onChange(null)}>All</button>
                <button type="button" className="h-10 rounded-full px-3 hover:bg-slate-100" onClick={() => onChange(new Set())}>None</button>
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
  const num = (s: string) => parseNumber(s) ?? NaN
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
      title="Add position"
      description="Adds a new position to this list."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-item-form" disabled={!f.short.trim()}>Add position</Button>
        </>
      }
    >
      <form id="add-item-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="OZ"><input className={`${inputCls} num`} value={f.oz} onChange={set('oz')} placeholder={nextOz} /></Field>
        <Field label="Einheit"><input className={inputCls} value={f.unit} onChange={set('unit')} placeholder="St, m, m2, psch" /></Field>
        <div className="col-span-2">
          <Field label="Kurztext"><input data-autofocus className={inputCls} value={f.short} onChange={set('short')} maxLength={200} /></Field>
        </div>
        <Field label="Menge"><input inputMode="decimal" className={`${inputCls} num`} value={f.qty} onChange={set('qty')} /></Field>
        <Field label="Einheitspreis (EP, €)"><input inputMode="decimal" className={`${inputCls} num`} value={f.up} onChange={set('up')} placeholder="optional" /></Field>
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
  const { lists, folders, documents } = useModel()
  const attached = documents.filter((document) => document.listId === doc.id)
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
  const [onlyUnpriced, setOnlyUnpriced] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  // the sticky total only appears once the hero total has scrolled away, so the number is never on screen twice
  const heroEnd = useRef<HTMLDivElement>(null)
  const [heroGone, setHeroGone] = useState(false)
  useEffect(() => {
    const el = heroEnd.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setHeroGone(!e.isIntersecting && e.boundingClientRect.top < 0))
    io.observe(el)
    return () => io.disconnect()
  }, [])
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
  const categories = useMemo(() => [...new Set(positions.map((p) => p.category))].sort((a, b) => a.localeCompare(b, 'de')), [positions])
  const editedIds = useMemo(() => new Set([...Object.keys(edits?.qty ?? {}), ...Object.keys(edits?.up ?? {}), ...Object.keys(edits?.patch ?? {}), ...Object.keys(edits?.moves ?? {})]), [edits])
  const addedIds = useMemo(() => new Set((edits?.added ?? []).map((p) => p.id)), [edits])
  const qtyEdited = useMemo(() => new Set(Object.keys(edits?.qty ?? {})), [edits])
  const upEdited = useMemo(() => new Set(Object.keys(edits?.up ?? {})), [edits])

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    let r = positions.filter(
      (p) => (!cats || cats.has(leafOz(p))) && (!onlyUnpriced || p.up == null) && (!t || p.oz.toLowerCase().includes(t) || p.short.toLowerCase().includes(t) || p.category.toLowerCase().includes(t)),
    )
    if (sortTotal) r = [...r].sort((a, b) => positionTotal(b) - positionTotal(a))
    return r
  }, [positions, q, cats, sortTotal, onlyUnpriced])

  const largest = useMemo(() => {
    let best: Position | null = null
    for (const p of positions) if (!best || positionTotal(p) > positionTotal(best)) best = p
    return best && positionTotal(best) > 0 ? { short: best.short, amount: positionTotal(best) } : null
  }, [positions])

  const detail = detailId ? positions.find((p) => p.id === detailId) ?? null : null
  const detailIdx = detailId ? rows.findIndex((r) => r.id === detailId) : -1

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

  const toTable = () => setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
  const review = () => {
    setSortTotal(true)
    setQ('')
    setCats(null)
    toTable()
  }
  const showUnpriced = () => {
    setOnlyUnpriced(true)
    setQ('')
    setCats(null)
    toTable()
  }

  const phase = view ? phaseLabel(view) : null
  // dedupe tokens: format strings like "GAEB 90 · D86" repeat the phase code the phase label already shows
  const meta = [...new Set([phase, doc.format, !phase ? doc.phase : null, doc.date].filter(Boolean).flatMap((m) => String(m).split(' · ')))]
  // the store already renames lists that share their project's name (see listName); the file name is then the title
  const sameAsFile = title === doc.fileName.replace(/\.[^.]+$/, '')
  const heading = title
  const zeroQty = positions.filter((p) => p.up != null && p.qty === 0).length
  const status = budgetStatus(st.total, cap)
  const unpriced = st.positionsCount - st.pricedCount
  const setCap = () => openDialog({ kind: 'cap', target: 'list', id: doc.id })
  const more: (MenuItem | 'sep')[] = [
    { label: 'Split into new list…', icon: 'call_split', onSelect: split },
    { label: 'Rename list', icon: 'edit', onSelect: () => openDialog({ kind: 'rename-list', id: doc.id }) },
    { label: cap ? 'Change budget cap' : 'Set budget cap', icon: 'tune', onSelect: setCap },
    ...(attached.length
      ? (['sep' as const, ...attached.map((d) => ({ label: d.name, icon: 'attach_file', onSelect: () => openDialog({ kind: 'doc', doc: d }) }))] as (MenuItem | 'sep')[])
      : []),
  ]

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'All Projects', to: '/' }, { label: folder?.name ?? 'Folder', to: `/folder/${folder?.id ?? doc.folderId}` }]}
        title={heading}
        subtitle={[sameAsFile ? null : doc.fileName, ...meta].filter(Boolean).join(' · ')}
        aside={<RowMenu items={more} label={`More actions for ${title}`} />}
      />

      {view?.trashedAt && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="flex items-center gap-2"><Icon name="delete" size={18} />This list is in the Trash.</span>
          <button type="button" className="font-semibold underline underline-offset-4" onClick={() => useStore.getState().patchList(doc.id, { trashedAt: undefined })}>Restore</button>
        </div>
      )}

      {view?.supersededBy && (
        <div role="note" className="mb-5 flex items-start gap-2.5 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <Icon name="info" size={18} className="mt-px text-slate-600" />
          <span>This is an earlier version. The {view.supersededBy} file of the same tender replaces it, so this list doesn't count toward project totals.</span>
        </div>
      )}

      <TabsBar activeId={doc.id} folderId={folder?.id ?? doc.folderId} />

      <Summary
        label="List total"
        compact
        amount={money(st.total)}
        total={st.total}
        cap={cap}
        onSetCap={setCap}
        meta={
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {unpriced > 0 ? (
              <>
                <span className="num">{plural(st.positionsCount, 'position', 'positions')}</span>
                <span aria-hidden>·</span>
                <button type="button" onClick={showUnpriced} className="num rounded font-semibold text-slate-900 underline decoration-slate-500 underline-offset-4 hover:decoration-slate-800">
                  {int(unpriced)} still to price
                </button>
              </>
            ) : (
              <span className="num">{plural(st.positionsCount, 'position', 'positions')}, all priced</span>
            )}
            {zeroQty > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="num">{int(zeroQty)} with quantity 0</span>
              </>
            )}
            {(status.tone === 'warn' || status.tone === 'over') && largest && (
              <>
                <span aria-hidden>·</span>
                <button type="button" onClick={review} className="rounded font-semibold text-brand-700 underline-offset-4 hover:underline">Review the biggest positions</button>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Button variant="primary" size="lg" icon="add" onClick={() => setAdding(true)}>Add position</Button>
            <ExportMenu listId={doc.id} doc={doc} selectedIds={[...selected]} />
          </>
        }
      />

      <div ref={heroEnd} aria-hidden />
      <div ref={tableRef} className="scroll-mt-20">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Icon name="search" size={20} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-600" />
            <input
              type="search"
              aria-label="Search positions"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search positions"
              className="h-10 w-full rounded-full border border-transparent bg-slate-100 pr-4 pl-11 text-sm text-slate-900 transition-colors outline-none placeholder:text-slate-600 hover:bg-slate-200/70 focus:border-brand-600 focus:bg-white"
            />
          </div>
          <CategoryFilter tree={tree} stats={catStats} value={cats} onChange={setCats} />
          {(unpriced > 0 || onlyUnpriced) && (
            <button
              type="button"
              aria-pressed={onlyUnpriced}
              onClick={() => setOnlyUnpriced((v) => !v)}
              className={clsx(
                'inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
                onlyUnpriced ? 'bg-brand-50 font-semibold text-brand-700 ring-1 ring-brand-200' : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
              )}
            >
              Not priced <span className="num">{int(unpriced)}</span>
            </button>
          )}
          <button
            type="button"
            aria-pressed={selectMode || selected.size > 0}
            onClick={() => { if (selectMode) setSelected(new Set()); setSelectMode((v) => !v) }}
            className={clsx(
              'inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors xl:hidden',
              selectMode ? 'bg-brand-50 font-semibold text-brand-700 ring-1 ring-brand-200' : 'bg-slate-100 text-slate-800 hover:bg-slate-200',
            )}
          >
            <Icon name="checklist" size={18} />Select
          </button>
          <div className="ml-auto">
            <SortMenu value={sortTotal ? 'amount' : 'oz'} options={{ oz: 'Position order', amount: 'Highest amount' }} onChange={(k) => setSortTotal(k === 'amount')} noun="positions" />
          </div>
        </div>

        <LedgerTable
          listId={doc.id}
          rows={rows}
          selected={selected}
          setSelected={setSelected}
          focusId={focusId}
          onOpen={(p) => setDetailId(p.id)}
          onMove={(pid) => setMovePids([pid])}
          editedIds={editedIds}
          qtyEdited={qtyEdited}
          upEdited={upEdited}
          sortActive={sortTotal}
          selectMode={selectMode}
        />

        {/* sticky footer: the running total, or the batch actions while rows are selected */}
        <div className={clsx('sticky bottom-0 z-20 -mx-4 mt-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur transition-opacity sm:-mx-8 sm:px-8', !(heroGone || selected.size > 0 || rows.length !== positions.length) && 'pointer-events-none opacity-0')} aria-hidden={!(heroGone || selected.size > 0 || rows.length !== positions.length) || undefined}>
          {selected.size > 0 ? (
            <div role="toolbar" aria-label="Selected positions" className="flex flex-wrap items-center gap-1 text-sm">
              <span className="mr-2 font-semibold text-slate-900" aria-live="polite">{plural(selected.size, 'position', 'positions')} selected</span>
              <button type="button" onClick={() => setMovePids([...selected])} className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 font-medium text-slate-800 hover:bg-slate-100">
                <Icon name="drive_file_move" size={18} />Move
              </button>
              <button type="button" onClick={split} className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 font-medium text-slate-800 hover:bg-slate-100">
                <Icon name="call_split" size={18} />Split into new list
              </button>
              <button type="button" onClick={removeSelected} className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 font-medium text-rose-700 hover:bg-rose-50">
                <Icon name="delete" size={18} />Remove
              </button>
              <button type="button" onClick={() => { setSelected(new Set()); setSelectMode(false) }} className="ml-auto inline-flex h-10 items-center rounded-full bg-slate-100 px-4 font-semibold text-slate-900 hover:bg-slate-200">Clear</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-slate-600">
              <span className={rows.length === positions.length ? 'max-sm:hidden' : undefined}>
                {rows.length !== positions.length
                  ? <><span className="num font-semibold text-slate-900">{int(rows.length)}</span> of <span className="num">{int(positions.length)}</span> positions shown</>
                  : <span className="num">{plural(positions.length, 'position', 'positions')}</span>}
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>List total</span>
                <span className="num text-base font-semibold text-slate-900">{money(st.total)}</span>
                {cap > 0 && st.total > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="num">{Math.round(status.pct)}% of cap</span>
                    <span aria-hidden>·</span>
                    <span className={clsx('font-semibold', statusText[status.tone])}>{status.word}</span>
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      </div>

      {doc.notes && (
        <section className="mt-8 rounded-3xl bg-slate-50">
          <button
            type="button"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 rounded-3xl px-5 py-4 text-left text-[15px] font-semibold text-slate-900"
          >
            <span className="flex items-center gap-2.5"><Icon name="notes" size={20} className="text-slate-500" />Vorbemerkungen</span>
            <Icon name="expand_more" size={20} className={clsx('text-slate-500 transition-transform', notesOpen && 'rotate-180')} />
          </button>
          <AnimatePresence initial={false}>
            {notesOpen && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
                <div className="max-h-96 overflow-y-auto px-5 pb-5 text-sm leading-relaxed whitespace-pre-line text-slate-700">{doc.notes}</div>
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
        onRemove={() => {
          if (!detail) return
          const id = detail.id
          const next = rows[detailIdx + 1]?.id ?? rows[detailIdx - 1]?.id ?? null
          useStore.getState().removePositions(doc.id, [id])
          setDetailId(next)
          toast('Removed 1 position', 'ok', { label: 'Undo', run: () => useStore.getState().restorePositions(doc.id, [id]) })
        }}
        position={detailIdx >= 0 ? `${detailIdx + 1} of ${rows.length}` : undefined}
        listTotal={st.total}
        cap={cap}
        onPrev={detailIdx > 0 ? () => setDetailId(rows[detailIdx - 1].id) : undefined}
        onNext={detailIdx >= 0 && detailIdx < rows.length - 1 ? () => setDetailId(rows[detailIdx + 1].id) : undefined}
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
