import { useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CatalogueEditor, type EditorFocus } from '../components/CatalogueEditor'
import { Skeleton } from '../components/Page'
import { Chips, EmptyState, MetaLink, PageFrame, PageHeader, RowList, RowMenu } from '../components/Kit'
import { Button, Dialog, Icon, toast } from '../components/ui'
import { int, plural } from '../lib/format'
import {
  CATALOGUES, CATALOGUE_PAGE_SIZE, CATALOGUE_SCAN_PAGES, cataloguePriceSource, formatCataloguePrice, isPriced, scanCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueFilters, type CatalogueKind,
} from '../lib/catalogues'

const SUBTITLE: Record<CatalogueKind, string> = {
  products: 'Items and prices you quote from',
  suppliers: 'Companies you buy materials from',
  subcontractors: 'Companies you hire for trades',
}
const EMPTY_TEXT: Record<CatalogueKind, string> = {
  products: 'Add the items you buy often with their unit prices, so positions can be priced from them.',
  suppliers: 'Add the companies you buy from. Products can then be linked to a supplier.',
  subcontractors: 'Add each company with its trade, a contact person, email and phone.',
}

type PriceFilter = 'all' | 'priced' | 'unpriced'
const PRICE_FILTERS: PriceFilter[] = ['all', 'priced', 'unpriced']

/** every row of a result, with the filters it was read for, so it can stay on screen while the next one loads */
type Scan = { key: string; filters: CatalogueFilters; rows: CatalogueEntry[]; done: boolean; capped: boolean; error?: string }

/** price coverage is only worked out for suppliers with up to this many products (it reads all of their pages) */
const COVERAGE_LIMIT = 500

/** products get a package, so the catalogue never borrows the archive box that means "Archived" */
const catalogueIcon = (kind: CatalogueKind) => (kind === 'products' ? 'package_2' : CATALOGUES[kind].icon)

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

type Tag = { text: string; label: string }

/**
 * products that share a name and category get one more detail on line two that tells them apart: the first of
 * item code, supplier, unit or price source that differs between all of them, else "Copy 2 of 3"
 */
function discriminators(entries: CatalogueEntry[]) {
  const groups = new Map<string, CatalogueEntry[]>()
  for (const entry of entries) {
    const key = `${squash(entry.name).toLowerCase()}|${squash(entry.category ?? '').toLowerCase()}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const candidates: ((entry: CatalogueEntry) => Tag | null)[] = [
    (e) => (e.sku ? { text: `Item code ${e.sku}`, label: `item code ${e.sku}` } : null),
    (e) => (e.supplier ? { text: e.supplier, label: `from ${e.supplier}` } : null),
    (e) => (e.unit ? { text: e.unit, label: `per ${e.unit}` } : null),
    (e) => (e.valid_from ? { text: cataloguePriceSource(e), label: `price from ${cataloguePriceSource(e)}` } : null),
  ]
  const tags = new Map<string, Tag>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const pick = candidates.find((candidate) => {
      const values = group.map((entry) => candidate(entry)?.text)
      return values.every(Boolean) && new Set(values).size === group.length
    })
    group.forEach((entry, i) => {
      const copy = `Copy ${int(i + 1)} of ${int(group.length)}`
      tags.set(entry.id, pick?.(entry) ?? { text: copy, label: copy.toLowerCase() })
    })
  }
  return tags
}

/** the second line of a product row: only the details that exist, so empty columns never become a wall of dashes */
function productDetails(entry: CatalogueEntry) {
  const parts = [entry.category, entry.unit, entry.sku && `Item code ${entry.sku}`, entry.supplier].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'No supplier or item code yet'
}

function CatalogueRows({ kind, entries, all, hidePrice, coverage, onEdit, onArchive, onRestore }: {
  kind: CatalogueKind
  /** the rows on this page */
  entries: CatalogueEntry[]
  /** every row of the result, so same-named products are numbered across pages */
  all: CatalogueEntry[]
  /** no row on this page has a price: the column stays empty and the heading says so once */
  hidePrice: boolean
  /** priced products per supplier id, once known */
  coverage: Record<string, number>
  onEdit: (entry: CatalogueEntry, focus?: EditorFocus) => void
  onArchive: (entry: CatalogueEntry) => void
  onRestore: (entry: CatalogueEntry) => void
}) {
  const navigate = useNavigate()
  const { item } = CATALOGUES[kind]
  // the name travels along so the Products filter chip can say whose products these are
  const showProducts = (entry: CatalogueEntry) => navigate(`/catalogues/products?supplier=${encodeURIComponent(entry.id)}`, { state: { supplierName: entry.name } })
  const tags = kind === 'products' ? discriminators(all) : new Map<string, Tag>()
  return (
    <RowList>
      {entries.map((entry) => {
        const archived = !!entry.archived_at
        const tag = tags.get(entry.id)
        const name = tag ? `${entry.name} (${tag.label})` : entry.name
        const products = kind === 'suppliers' ? entry.product_count ?? 0 : 0

        let subtitle: ReactNode
        if (kind === 'products') {
          const line = productDetails(entry)
          subtitle = tag && !line.split(' · ').includes(tag.text) ? `${line} · ${tag.text}` : line
        } else {
          const shown = [kind === 'subcontractors' ? entry.trade : null, entry.contact_name, entry.email, entry.phone].filter(Boolean)
          const contact = entry.contact_name || entry.email || entry.phone
          subtitle = contact || archived ? (shown.join(' · ') || 'No contact details') : (
            <>
              {shown.length > 0 && `${shown.join(' · ')} · `}
              {/* above the row's own button, so it opens the editor at the contact fields */}
              <button
                type="button"
                onClick={() => onEdit(entry, 'contact')}
                className="pointer-events-auto relative z-10 font-medium text-brand-700 underline-offset-2 after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:underline"
              >
                Add contact details<span className="sr-only"> for {entry.name}</span>
              </button>
            </>
          )
        }

        let amount: ReactNode = null
        let meta: ReactNode = null
        if (kind === 'products' && !hidePrice) {
          amount = isPriced(entry) ? formatCataloguePrice(entry) : <span className="text-sm font-normal text-slate-600">No price</span>
          const source = [entry.unit && `per ${entry.unit}`, cataloguePriceSource(entry)].filter(Boolean).join(' · ')
          if (isPriced(entry) && source) meta = <span className="text-sm text-slate-600">{source}</span>
        } else if (kind === 'suppliers') {
          const priced = coverage[entry.id]
          const figure = <>{plural(products, 'product', 'products')}{priced !== undefined && <> · {int(priced)} priced</>}</>
          amount = products && !archived ? (
            // a stationary figure that filters Products by this supplier; above the row's own button
            <span className="pointer-events-auto relative z-10 inline-flex text-sm">
              <MetaLink onClick={() => showProducts(entry)}>
                <span className="sr-only">View </span><span className="num">{figure}</span><span className="sr-only"> from {entry.name}</span>
              </MetaLink>
            </span>
          ) : <span className="num text-sm font-normal text-slate-600">{figure}</span>
        }

        const menu = (
          <RowMenu
            label={`More actions for ${name}`}
            items={archived ? [
              { label: 'Restore', icon: 'restore', onSelect: () => onRestore(entry) },
            ] : [
              { label: `Edit ${item}`, icon: 'edit', onSelect: () => onEdit(entry) },
              ...(products ? [{ label: `View ${plural(products, 'product', 'products')}`, icon: 'package_2', onSelect: () => showProducts(entry) }] : []),
              'sep' as const,
              { label: 'Archive', icon: 'archive', danger: true, onSelect: () => onArchive(entry) },
            ]}
          />
        )
        return (
          <div key={entry.id} data-row="catalogue" className="group relative flex items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-slate-100 sm:items-center sm:gap-4 sm:px-3">
            <button
              type="button"
              data-nav
              aria-label={archived ? `Restore ${item} ${name}` : `Edit ${item} ${name}`}
              onClick={() => (archived ? onRestore(entry) : onEdit(entry))}
              className="absolute inset-0 z-0 rounded-lg"
            />
            {/* names lead: no icon tile, since it would be the same on every row */}
            <div className="pointer-events-none relative grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6">
              <span lang="de" className="col-span-2 row-start-1 line-clamp-2 min-w-0 text-[15px] leading-snug font-semibold break-normal hyphens-auto text-slate-900 sm:col-span-1 sm:line-clamp-1">{entry.name}</span>
              <span className="col-span-2 row-start-2 min-w-0 truncate text-sm text-slate-600 sm:col-span-1 sm:col-start-1">{subtitle}</span>
              {amount != null && <div className="num col-start-1 row-start-3 text-[15px] font-semibold whitespace-nowrap text-slate-900 sm:col-start-2 sm:row-start-1 sm:text-right">{amount}</div>}
              {meta != null && <div className="col-start-2 row-start-3 flex min-w-0 justify-end sm:row-start-2">{meta}</div>}
            </div>
            {/* a fixed gutter for the ⋯, so figures never move when it appears (on hover or focus with a mouse) */}
            <div className="relative z-10 -my-1.5 -mr-1 w-10 shrink-0 transition-opacity sm:my-0 sm:-mr-1.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:has-[[aria-expanded=true]]:opacity-100">
              {menu}
            </div>
          </div>
        )
      })}
    </RowList>
  )
}

/** the price filter, drawn like Kit's Chips but with counts in German format (1.294) */
function PriceChips({ value, options, onChange }: { value: PriceFilter; options: { key: PriceFilter; label: string; count?: number }[]; onChange: (k: PriceFilter) => void }) {
  return (
    <div role="group" aria-label="Filter by price" className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = o.key === value
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange(o.key)}
            className={clsx('inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors', on ? 'bg-slate-900 font-semibold text-white' : 'bg-slate-100 text-slate-800 hover:bg-slate-200')}>
            {o.label}
            {o.count !== undefined && <span className={clsx('num', on ? 'text-slate-200' : 'text-slate-600')}>{int(o.count)}</span>}
          </button>
        )
      })}
    </div>
  )
}

function Catalogue({ kind }: { kind: CatalogueKind }) {
  const { title, item } = CATALOGUES[kind]
  const icon = catalogueIcon(kind)
  const [filters, setFilters] = useSearchParams()
  const location = useLocation()
  const supplier = kind === 'products' ? filters.get('supplier') : null
  const archived = filters.get('view') === 'archived'
  const priceParam = filters.get('price')
  const price: PriceFilter = kind === 'products' && (priceParam === 'priced' || priceParam === 'unpriced') ? priceParam : 'all'
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [scan, setScan] = useState<Scan | null>(null)
  const [settled, setSettled] = useState<Scan | null>(null)
  const [coverage, setCoverage] = useState<Record<string, number>>({})
  const [editing, setEditing] = useState<{ entry: CatalogueEntry | null; focus?: EditorFocus } | undefined>(undefined)
  const [confirm, setConfirm] = useState<{ entry: CatalogueEntry; action: 'archive' | 'restore' } | null>(null)
  const [busy, setBusy] = useState(false)

  const trimmed = query.trim()
  const key = `${trimmed}|${supplier ?? ''}|${archived}#${reload}`

  useEffect(() => {
    const controller = new AbortController()
    const snapshot = { key, filters: { q: trimmed, supplier, archived } }
    const timer = setTimeout(async () => {
      try {
        const { rows, capped } = await scanCatalogue(kind, snapshot.filters, controller.signal, (rows) => {
          if (!controller.signal.aborted) setScan({ ...snapshot, rows, done: false, capped: false })
        })
        if (controller.signal.aborted) return
        const done = { ...snapshot, rows, done: true, capped }
        setScan(done)
        setSettled(done)
      } catch (error) {
        if (!controller.signal.aborted) setScan({ ...snapshot, rows: [], done: true, capped: false, error: (error as Error).message })
      }
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [kind, key, trimmed, supplier, archived])

  function setFilter(name: string, value?: string) {
    const next = new URLSearchParams(filters)
    if (value) next.set(name, value)
    else next.delete(name)
    setFilters(next)
    setPage(1)
  }

  // while the next search or page loads, the last complete result stays on screen (only the first load shows a
  // skeleton); everything below describes what is shown, so a stale result never borrows the new query's wording
  const current = scan?.key === key ? scan : null
  const covered = !!current && (current.done || (price === 'all' && current.rows.length >= page * CATALOGUE_PAGE_SIZE))
  const view = covered ? current : settled ?? (current?.rows.length ? current : null)
  const refreshing = !!view && (view !== current || !view.done)
  const all = view?.rows ?? []
  const pricedCount = kind === 'products' ? all.filter(isPriced).length : 0
  const rows = price === 'priced' ? all.filter(isPriced) : price === 'unpriced' ? all.filter((entry) => !isPriced(entry)) : all
  const lastPage = Math.max(1, Math.ceil(rows.length / CATALOGUE_PAGE_SIZE))
  const shownPage = view?.done ? Math.min(page, lastPage) : page
  const pageRows = rows.slice((shownPage - 1) * CATALOGUE_PAGE_SIZE, shownPage * CATALOGUE_PAGE_SIZE)
  // a brand-new catalogue: the empty state explains it, and the search has nothing to search yet
  const blank = !!view?.done && !all.length && !view.filters.q && !view.filters.supplier && !view.filters.archived
  // nothing to search in (an empty catalogue or an empty Archived view)
  const noSearch = !!view?.done && !all.length && !view.filters.q && !trimmed
  const supplierName = (location.state as { supplierName?: string } | null)?.supplierName
    ?? all.find((entry) => entry.supplier_id === supplier)?.supplier ?? undefined

  // price coverage for the suppliers on this page, one supplier at a time so a long list never floods the API
  const coverageKey = kind === 'suppliers'
    ? pageRows.filter((e) => !e.archived_at && (e.product_count ?? 0) > 0 && (e.product_count ?? 0) <= COVERAGE_LIMIT).map((e) => e.id).join(',')
    : ''
  useEffect(() => {
    if (!coverageKey) return
    const controller = new AbortController()
    void (async () => {
      for (const id of coverageKey.split(',')) {
        try {
          const { rows } = await scanCatalogue('products', { q: '', supplier: id, archived: false }, controller.signal)
          if (controller.signal.aborted) return
          setCoverage((known) => ({ ...known, [id]: rows.filter(isPriced).length }))
        } catch {
          if (controller.signal.aborted) return
        }
      }
    })()
    return () => controller.abort()
  }, [coverageKey, reload])

  async function changeArchive(entry: CatalogueEntry, action: 'archive' | 'restore') {
    if (busy) return
    setBusy(true)
    try {
      await writeCatalogue(kind, { id: entry.id, action })
      toast(action === 'archive' ? `Archived ${entry.name}` : `Restored ${entry.name}`)
      setConfirm(null)
      setReload((n) => n + 1)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  // the section heading with a muted count beside it, like "Projects 14" elsewhere: exact once every page is read
  const noun = title.toLowerCase()
  const q = view?.filters.q
  const heading = q
    ? `${view?.filters.archived ? 'Archived matches' : 'Matches'} for “${q}”`
    : view?.filters.archived ? `Archived ${noun}` : title
  const countText = view?.done ? `${int(rows.length)}${view.capped ? '+' : ''}` : ''
  const nonePriced = kind === 'products' && !!view?.done && all.length > 0 && pricedCount === 0
  // the price filter only when it can tell something apart (or is already set, so it can be cleared)
  const showPriceFilter = kind === 'products' && !!view?.done && (price !== 'all' || (pricedCount > 0 && pricedCount < all.length))
  const withCounts = !!view?.done && !view.capped
  const priceOptions = PRICE_FILTERS.map((k) => ({
    key: k,
    label: k === 'all' ? 'All' : k === 'priced' ? 'Priced' : 'Not priced',
    count: !withCounts || k === 'all' ? undefined : k === 'priced' ? pricedCount : all.length - pricedCount,
  }))

  return (
    <PageFrame>
      <PageHeader
        title={title}
        subtitle={SUBTITLE[kind]}
        aside={<Button variant="primary" size="lg" icon="add" onClick={() => setEditing({ entry: null })} aria-label={`Add ${item}`} className="max-sm:px-4"><span>Add<span className="max-sm:hidden"> {item}</span></span></Button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* an empty list has nothing to search: the field steps out of sight but keeps its place, so the
            Active / Archived chips sit where they do on every catalogue */}
        <div className={noSearch ? 'invisible w-72 max-sm:hidden' : 'relative w-full sm:w-72'} aria-hidden={noSearch || undefined}>
          {!noSearch && <>
            <Icon name="search" size={20} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-600" />
            <input
              type="search"
              aria-label={`Search ${noun}`}
              placeholder={`Search ${noun}`}
              value={query}
              maxLength={200}
              onChange={(event) => { setQuery(event.target.value); setPage(1) }}
              className="h-10 w-full rounded-md bg-slate-100 pr-3 pl-11 text-sm text-slate-900 ring-1 ring-slate-400 transition-[background-color,box-shadow] outline-none ring-inset placeholder:text-slate-600 hover:bg-slate-200/70 focus:bg-white focus:ring-2 focus:ring-brand-700"
            />
          </>}
        </div>
        <Chips
          label="Catalogue status"
          value={archived ? 'archived' : 'active'}
          onChange={(k) => setFilter('view', k === 'archived' ? 'archived' : undefined)}
          options={[{ key: 'active', label: 'Active' }, { key: 'archived', label: 'Archived' }]}
        />
        {supplier && (
          <button type="button" onClick={() => setFilter('supplier')} aria-label={`Clear supplier filter: ${supplierName ?? 'one supplier'}`} className="inline-flex h-10 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-slate-900 px-3.5 text-sm font-semibold text-white hover:bg-slate-800">
            <span className="truncate">{supplierName ?? 'One supplier'}</span><Icon name="close" size={18} className="shrink-0" />
          </button>
        )}
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {view?.done && !current?.error ? `${countText} ${rows.length === 1 && !view.capped ? item : noun}${nonePriced ? ', none priced yet' : ''}` : ''}
      </p>

      {!view && !current?.error && <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-lg" /></div>}
      {current?.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-rose-50 p-4 text-sm font-medium text-rose-800 ring-1 ring-rose-200 ring-inset">
          <Icon name="error" size={20} />{current.error}
          <Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {view && !current?.error && (all.length ? (
        <section aria-labelledby="catalogue-rows" aria-busy={refreshing} className="mb-8">
          <div className="mb-2 flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h2 id="catalogue-rows" className="min-w-0 font-heading text-base font-bold break-words text-slate-900">
              {heading}
              {countText && <span className="num ml-2 font-sans text-sm font-medium text-slate-600">{countText}</span>}
              {nonePriced && <span className="ml-1 font-sans text-sm font-normal text-slate-600">· None priced yet</span>}
            </h2>
            {showPriceFilter && (
              <PriceChips value={price} onChange={(k) => setFilter('price', k === 'all' ? undefined : k)} options={priceOptions} />
            )}
          </div>
          {pageRows.length ? (
            <CatalogueRows kind={kind} entries={pageRows} all={all} coverage={coverage}
              hidePrice={pageRows.every((entry) => !isPriced(entry))}
              onEdit={(entry, focus) => setEditing({ entry, focus })}
              onArchive={(entry) => setConfirm({ entry, action: 'archive' })}
              onRestore={(entry) => setConfirm({ entry, action: 'restore' })} />
          ) : view.done ? (
            <EmptyState compact icon="search_off"
              title={price === 'priced' ? `No priced ${noun} here` : `Every ${item} here is priced`}
              text={price === 'priced' ? 'Add a unit price to a product and it shows up here.' : undefined}>
              <Button onClick={() => setFilter('price')}>Show all {noun}</Button>
            </EmptyState>
          ) : <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-lg" /></div>}
          {(view.done ? lastPage > 1 : rows.length >= CATALOGUE_PAGE_SIZE) && (
            <nav aria-label="Catalogue pages" className="mt-4 flex flex-wrap items-center justify-end gap-3 text-sm text-slate-600">
              {view.capped && shownPage === lastPage && <span className="mr-auto">Only the first {int(CATALOGUE_SCAN_PAGES * CATALOGUE_PAGE_SIZE)} are listed. Search to narrow the list.</span>}
              <Button size="sm" disabled={shownPage === 1} onClick={() => setPage(shownPage - 1)}>Previous</Button>
              <span aria-live="polite" className="num">Page {int(shownPage)}{view.done && ` of ${int(lastPage)}`}</span>
              <Button size="sm" disabled={view.done && shownPage >= lastPage} onClick={() => setPage(shownPage + 1)}>Next</Button>
            </nav>
          )}
        </section>
      ) : view.done ? (
        <EmptyState
          icon={view.filters.q || view.filters.supplier ? 'search_off' : icon}
          title={view.filters.q || view.filters.supplier ? 'No matching entries' : `No ${view.filters.archived ? 'archived ' : ''}${noun} yet`}
          text={view.filters.q ? 'Try a different search, or clear it to see everything.'
            : view.filters.supplier ? `This supplier has no ${view.filters.archived ? 'archived ' : ''}${noun} yet.`
            : view.filters.archived ? `Archived ${noun} land here, and you can restore them any time.`
            : EMPTY_TEXT[kind]}
        >
          {view.filters.q ? <Button size="lg" onClick={() => { setQuery(''); setPage(1) }}>Clear search</Button>
            // the header keeps the one primary Add button; this one is a quieter second way in
            : blank && <Button size="lg" icon="add" onClick={() => setEditing({ entry: null })}>Add {item}</Button>}
        </EmptyState>
      ) : <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-lg" /></div>)}

      {editing !== undefined && (
        <CatalogueEditor kind={kind} entry={editing.entry} focus={editing.focus}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            if (editing.entry === null) { setFilter('view'); setQuery('') }
            setEditing(undefined)
            setReload((n) => n + 1)
          }} />
      )}
      {confirm && (
        <Dialog open onClose={() => { if (!busy) setConfirm(null) }} title={`${confirm.action === 'archive' ? 'Archive' : 'Restore'} ${item}`} footer={<>
          <Button disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant={confirm.action === 'archive' ? 'danger' : 'primary'} disabled={busy} onClick={() => { void changeArchive(confirm.entry, confirm.action) }}>
            {confirm.action === 'archive' ? 'Archive' : 'Restore'}
          </Button>
        </>}>
          <p className="text-sm leading-relaxed text-slate-700">
            <strong className="text-slate-900">{confirm.entry.name}</strong>
            {confirm.action === 'archive' ? ' moves to Archived and stops showing up when you price positions. You can restore it any time.' : ' moves back to the active catalogue.'}
          </p>
        </Dialog>
      )}
    </PageFrame>
  )
}

export function CataloguePage() {
  const { kind = '' } = useParams()
  if (!Object.hasOwn(CATALOGUES, kind)) {
    return (
      <PageFrame>
        <EmptyState icon="search_off" title="Catalogue not found" text="Choose Products, Suppliers or Subcontractors in the sidebar." />
      </PageFrame>
    )
  }
  return <Catalogue key={kind} kind={kind as CatalogueKind} />
}
