import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CatalogueEditor, type EditorFocus } from '../components/CatalogueEditor'
import { Skeleton } from '../components/Page'
import { Chips, EmptyState, PageFrame, PageHeader, RowList, RowMenu } from '../components/Kit'
import { Button, Dialog, Icon, kbdCls, toast } from '../components/ui'
import { int, plural } from '../lib/format'
import {
  CATALOGUES, CATALOGUE_PAGE_SIZE, CATALOGUE_SCAN_PAGES, catalogueDate, cataloguePriceSource, formatCataloguePrice, isPriced, scanCatalogue, writeCatalogue,
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

/** every row of a result, with the filters it was read for, so it can stay on screen while the next one loads */
type Scan = { key: string; filters: CatalogueFilters; rows: CatalogueEntry[]; done: boolean; capped: boolean; error?: string }

/** price coverage is only worked out for suppliers with up to this many products (it reads all of their pages) */
const COVERAGE_LIMIT = 500

/** what a supplier's products say about its prices: how many are priced, and the newest price date (ISO) */
type Coverage = { priced: number; latest?: string }

/** products get a package, so the catalogue never borrows the archive box that means "Archived" */
const catalogueIcon = (kind: CatalogueKind) => (kind === 'products' ? 'package_2' : CATALOGUES[kind].icon)

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** what tells a same-named product apart: a detail for line two, or (when none differs) a plain Duplicate tag */
type Tag = { text?: string; label: string; duplicate?: boolean }

/**
 * products that share a name and category get one more detail on line two that tells them apart: the first of
 * item code, supplier, unit or price source that differs between all of them. When nothing does, they really are
 * duplicates, and the row says so with a muted tag instead of a made-up difference.
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
      tags.set(entry.id, pick?.(entry) ?? { label: `duplicate ${int(i + 1)} of ${int(group.length)}`, duplicate: true })
    })
  }
  return tags
}

/** the second line of a product row: only the details that exist, so empty columns never become a wall of dashes */
function productDetails(entry: CatalogueEntry) {
  const parts = [entry.category, entry.unit, entry.sku && `Item code ${entry.sku}`, entry.supplier].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'No supplier or item code yet'
}

/** the ⋯ overlays the row's right end on hover devices (as on Kit's Row), so figures end on the content edge at rest */
const MENU_OVERLAY = 'relative z-10 -my-1.5 -mr-1 transition-opacity sm:my-0 [@media(hover:hover)]:absolute [@media(hover:hover)]:top-1/2 [@media(hover:hover)]:right-1 [@media(hover:hover)]:my-0 [@media(hover:hover)]:mr-0 [@media(hover:hover)]:-translate-y-1/2 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:has-[[aria-expanded=true]]:opacity-100 sm:[@media(hover:hover)]:right-2'
/** and the figures slide over to make room for it while it shows */
const MAKE_ROOM = '[@media(hover:hover)]:transition-[padding] [@media(hover:hover)]:group-focus-within:pr-12 [@media(hover:hover)]:group-hover:pr-12 [@media(hover:hover)]:group-has-[[aria-expanded=true]]:pr-12'

function CatalogueRows({ kind, entries, all, coverage, onEdit, onArchive, onRestore }: {
  kind: CatalogueKind
  /** the rows on this page */
  entries: CatalogueEntry[]
  /** every row of the result, so same-named products are told apart across pages */
  all: CatalogueEntry[]
  /** price coverage per supplier id, once known */
  coverage: Record<string, Coverage>
  onEdit: (entry: CatalogueEntry, focus?: EditorFocus) => void
  onArchive: (entry: CatalogueEntry) => void
  onRestore: (entry: CatalogueEntry) => void
}) {
  const navigate = useNavigate()
  const ids = useId()
  const { item } = CATALOGUES[kind]
  // the name travels along so the Products filter chip can say whose products these are (a new tab finds it in the rows)
  const productsLink = (entry: CatalogueEntry) => `/catalogues/products?supplier=${encodeURIComponent(entry.id)}`
  const showProducts = (entry: CatalogueEntry) => navigate(productsLink(entry), { state: { supplierName: entry.name } })
  const tags = kind === 'products' ? discriminators(all) : new Map<string, Tag>()
  return (
    <RowList>
      {entries.map((entry) => {
        const archived = !!entry.archived_at
        const tag = tags.get(entry.id)
        // a detail that tells same-named rows apart joins the name; a plain duplicate is said in the description
        const name = tag && !tag.duplicate ? `${entry.name} (${tag.label})` : entry.name
        const products = kind === 'suppliers' ? entry.product_count ?? 0 : 0
        const descriptionId = `${ids}-${entry.id}`
        // what the row shows beside the name, for the row's own button: the price (or Not priced) and a duplicate
        // tag for products, the contact details (or their absence) and products for companies
        let description = ''

        let subtitle: ReactNode
        if (kind === 'products') {
          const line = productDetails(entry)
          subtitle = tag?.text && !line.split(' · ').includes(tag.text) ? `${line} · ${tag.text}` : line
        } else {
          const shown = [kind === 'subcontractors' ? entry.trade : null, entry.contact_name, entry.email, entry.phone].filter(Boolean)
          const contact = entry.contact_name || entry.email || entry.phone
          description = [shown.join(', '), !contact && 'No contact details', products && plural(products, 'product', 'products')].filter(Boolean).join('. ')
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
        if (kind === 'products') {
          const priceText = isPriced(entry) ? [formatCataloguePrice(entry), entry.unit && `per ${entry.unit}`].filter(Boolean).join(' ') : 'Not priced'
          description = [priceText, tag?.duplicate && `Duplicate, ${tag.label.replace(/^duplicate /, '')}`].filter(Boolean).join('. ')
          if (isPriced(entry)) {
            amount = formatCataloguePrice(entry)
            const source = [entry.unit && `per ${entry.unit}`, cataloguePriceSource(entry)].filter(Boolean).join(' · ')
            if (source) meta = <span className="text-sm text-slate-600">{source}</span>
          } else if (archived) {
            amount = <span className="text-sm font-normal text-slate-600">Not priced</span>
          } else {
            // the state at rest, the action under the pointer: opens the editor at the unit price. The row's own
            // button already opens the editor from the keyboard, so this stays out of the tab order
            amount = (
              <button type="button" tabIndex={-1} onClick={() => onEdit(entry, 'price')}
                className="pointer-events-auto relative z-10 text-sm font-normal text-slate-600 underline-offset-4 after:absolute after:-inset-x-2 after:-inset-y-2 after:content-[''] [@media(hover:hover)]:group-hover:font-medium [@media(hover:hover)]:group-hover:text-brand-700 [@media(hover:hover)]:hover:underline">
                <span className="[@media(hover:hover)]:group-hover:hidden">Not priced</span>
                <span className="hidden [@media(hover:hover)]:group-hover:inline">Set price</span>
              </button>
            )
          }
        } else if (kind === 'suppliers') {
          const known = coverage[entry.id]
          const figure = plural(products, 'product', 'products')
          amount = products && !archived ? (
            // plain ink, and a real link to the supplier's products (so it opens in a new tab and can be shared);
            // above the row's own button
            <Link to={productsLink(entry)} state={{ supplierName: entry.name }}
              className="pointer-events-auto relative z-10 rounded-sm text-slate-900 decoration-slate-500 underline-offset-4 after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:underline focus-visible:underline">
              <span className="sr-only">View </span>{figure}<span className="sr-only"> from {entry.name}</span>
            </Link>
          ) : <span className="text-sm font-normal text-slate-600">{figure}</span>
          if (known && products && !archived) {
            const priced = known.priced === products ? 'All priced' : known.priced ? `${int(known.priced)} priced` : 'None priced yet'
            meta = <span className="num text-sm text-slate-600">{priced}{known.latest && ` · Latest price ${catalogueDate(known.latest)}`}</span>
          }
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
          <div key={entry.id} data-row="catalogue" className="group relative flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-slate-100 sm:items-center sm:gap-4 sm:px-3">
            <button
              type="button"
              data-nav
              aria-label={archived ? `Restore ${item} ${name}` : `Edit ${item} ${name}`}
              aria-describedby={descriptionId}
              onClick={() => (archived ? onRestore(entry) : onEdit(entry))}
              className="absolute inset-0 z-0 rounded-lg"
            />
            {/* names lead: no icon tile, since it would be the same on every row */}
            <div className={clsx('pointer-events-none relative grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6', MAKE_ROOM)}>
              <div className="col-span-2 row-start-1 flex min-w-0 items-baseline gap-2 sm:col-span-1">
                <span lang="de" className="line-clamp-2 min-w-0 text-[15px] leading-snug font-semibold break-normal hyphens-auto text-slate-900 sm:line-clamp-1">{entry.name}</span>
                {tag?.duplicate && (
                  // same name and category, and nothing else to tell them apart
                  <span className="inline-flex h-5 shrink-0 items-center gap-1 self-center rounded bg-slate-200/80 px-1.5 text-xs leading-none font-medium text-slate-700">
                    <Icon name="content_copy" size={13} />Duplicate
                  </span>
                )}
              </div>
              <span className="col-span-2 row-start-2 min-w-0 truncate text-sm text-slate-600 sm:col-span-1 sm:col-start-1">{subtitle}</span>
              {amount != null && <div className="num col-start-1 row-start-3 text-[15px] leading-snug font-semibold whitespace-nowrap text-slate-900 sm:col-start-2 sm:row-start-1 sm:text-right">{amount}</div>}
              {meta != null && <div className="col-start-2 row-start-3 flex min-w-0 justify-end sm:row-start-2">{meta}</div>}
            </div>
            <span id={descriptionId} hidden>{description}</span>
            <div className={MENU_OVERLAY}>{menu}</div>
          </div>
        )
      })}
    </RowList>
  )
}

/**
 * "1–50 of 1.311" with Previous and Next: compact beside the results heading, and again under the rows. The total is
 * left out until every page is read; past the scan limit it reads "5.000+".
 */
function Pager({ page, size, total, done, capped, onPage }: { page: number; size: number; total: number; done: boolean; capped: boolean; onPage: (page: number) => void }) {
  const first = (page - 1) * size + 1
  const last = Math.min(page * size, total)
  const lastPage = Math.max(1, Math.ceil(total / size))
  const arrow = 'flex size-10 items-center justify-center rounded-md text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:pointer-events-none disabled:text-slate-400'
  return (
    <div className="flex items-center gap-1 text-sm text-slate-600">
      <span className="num mr-1 whitespace-nowrap">
        {int(first)}–{int(last)}{done && <> of {int(total)}{capped && '+'}</>}
      </span>
      <button type="button" aria-label="Previous page" title="Previous page" disabled={page === 1} onClick={() => onPage(page - 1)} className={arrow}>
        <Icon name="chevron_left" size={22} />
      </button>
      <button type="button" aria-label="Next page" title="Next page" disabled={done && page >= lastPage} onClick={() => onPage(page + 1)} className={arrow}>
        <Icon name="chevron_right" size={22} />
      </button>
    </div>
  )
}

/**
 * the price filter as the ledger's quick-filter toggles ("Not priced 1.294"): nothing pressed shows everything, so
 * the toolbar's only inverted chip at rest is Active / Archived
 */
function PriceFilters({ value, options, onChange }: { value: PriceFilter; options: { key: Exclude<PriceFilter, 'all'>; label: string; count?: number }[]; onChange: (k: PriceFilter) => void }) {
  return (
    <div role="group" aria-label="Filter by price" className="flex flex-wrap gap-2 sm:ml-auto">
      {options.map((o) => {
        const on = o.key === value
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange(on ? 'all' : o.key)}
            className={clsx('inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-3.5 text-sm whitespace-nowrap transition-colors', on ? 'bg-slate-900 font-semibold text-white hover:bg-slate-800' : 'bg-slate-100 font-medium text-slate-800 hover:bg-slate-200')}>
            {o.label}
            {o.count !== undefined && <span className={clsx('num', on ? 'text-slate-200' : 'text-slate-600')}>{int(o.count)}</span>}
            {on && <Icon name="close" size={16} />}
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
  const [coverage, setCoverage] = useState<Record<string, Coverage>>({})
  const [editing, setEditing] = useState<{ entry: CatalogueEntry | null; focus?: EditorFocus } | undefined>(undefined)
  const [confirm, setConfirm] = useState<{ entry: CatalogueEntry; action: 'archive' | 'restore' } | null>(null)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // paging moves focus to the results heading, so the next Tab lands on the new page's first row
  const paged = useRef(false)
  function goToPage(next: number) {
    paged.current = true
    setPage(next)
  }
  useEffect(() => {
    if (!paged.current) return
    paged.current = false
    headingRef.current?.focus({ preventScroll: true })
    headingRef.current?.scrollIntoView({ block: 'nearest' })
  }, [page])

  // "/" jumps to the search from anywhere on the page, as in the ledger (not while typing, or in a dialog or menu)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const target = event.target as HTMLElement
      if (target.closest('input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]')) return
      if (!searchRef.current) return
      event.preventDefault()
      searchRef.current.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
          const priced = rows.filter(isPriced)
          const latest = priced.reduce<string | undefined>((newest, entry) => (entry.valid_from && (!newest || entry.valid_from > newest) ? entry.valid_from : newest), undefined)
          setCoverage((known) => ({ ...known, [id]: { priced: priced.length, latest } }))
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
  const paginated = !!view && (view.done ? lastPage > 1 : rows.length >= CATALOGUE_PAGE_SIZE)
  const nonePriced = kind === 'products' && !!view?.done && all.length > 0 && pricedCount === 0
  // the price filter only when it can tell something apart (or is already set, so it can be cleared)
  const showPriceFilter = kind === 'products' && !!view?.done && (price !== 'all' || (pricedCount > 0 && pricedCount < all.length))
  const withCounts = !!view?.done && !view.capped
  const priceOptions = [
    { key: 'priced' as const, label: 'Priced', count: withCounts ? pricedCount : undefined },
    { key: 'unpriced' as const, label: 'Not priced', count: withCounts ? all.length - pricedCount : undefined },
  ]

  return (
    <PageFrame>
      <PageHeader
        title={title}
        subtitle={SUBTITLE[kind]}
        // an empty catalogue keeps its one Add button in the empty state; it moves up here once there are entries
        aside={!blank && <Button variant="primary" size="lg" icon="add" onClick={() => setEditing({ entry: null })} aria-label={`Add ${item}`} className="max-sm:px-4"><span>Add<span className="max-sm:hidden"> {item}</span></span></Button>}
      />

      {/* one toolbar: search and Active / Archived on the left, the price filter on the right */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* an empty list has nothing to search, so the field steps out and the chips lead the row */}
        {!noSearch && (
          <div className="relative w-full sm:w-72">
            <Icon name="search" size={20} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-600" />
            <input
              ref={searchRef}
              type="search"
              aria-label={`Search ${noun}`}
              aria-keyshortcuts="/"
              placeholder={`Search ${noun}`}
              value={query}
              maxLength={200}
              onChange={(event) => { setQuery(event.target.value); setPage(1) }}
              className="peer h-10 w-full rounded-md bg-slate-100 pr-10 pl-11 text-sm text-slate-900 ring-1 ring-slate-400 transition-[background-color,box-shadow] outline-none ring-inset placeholder:text-slate-600 hover:bg-slate-200/70 focus:bg-white focus:ring-2 focus:ring-brand-700"
            />
            {!query && <kbd aria-hidden className={clsx(kbdCls, 'pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 peer-focus:hidden [@media(hover:none)]:hidden')}>/</kbd>}
          </div>
        )}
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
        {showPriceFilter && <PriceFilters value={price} onChange={(k) => setFilter('price', k === 'all' ? undefined : k)} options={priceOptions} />}
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
            <h2 id="catalogue-rows" ref={headingRef} tabIndex={-1} className="min-w-0 scroll-mt-20 rounded-sm font-heading text-base font-bold break-words text-slate-900">
              {heading}
              {/* with more than one page, the pager beside it carries the total */}
              {countText && !paginated && <span className="num ml-2 font-sans text-sm font-medium text-slate-600">{countText}</span>}
            </h2>
            {paginated && (
              <nav aria-label="Catalogue pages, top" className="-mr-2">
                <Pager page={shownPage} size={CATALOGUE_PAGE_SIZE} total={rows.length} done={view.done} capped={view.capped} onPage={goToPage} />
              </nav>
            )}
          </div>
          {pageRows.length ? (
            <CatalogueRows kind={kind} entries={pageRows} all={all} coverage={coverage}
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
          {paginated && (
            <nav aria-label="Catalogue pages, bottom" className="mt-3 -mr-2 flex flex-wrap items-center justify-end gap-3 text-sm text-slate-600">
              {view.capped && shownPage === lastPage && <span className="mr-auto">Only the first {int(CATALOGUE_SCAN_PAGES * CATALOGUE_PAGE_SIZE)} are listed. Search to narrow the list.</span>}
              <Pager page={shownPage} size={CATALOGUE_PAGE_SIZE} total={rows.length} done={view.done} capped={view.capped} onPage={goToPage} />
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
            // the page's one Add button while the catalogue is empty (the header leaves it out)
            : blank && <Button variant="primary" size="lg" icon="add" onClick={() => setEditing({ entry: null })}>Add {item}</Button>}
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
