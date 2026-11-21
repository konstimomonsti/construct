import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CatalogueEditor } from '../components/CatalogueEditor'
import { Skeleton } from '../components/Page'
import { Chips, EmptyState, PageFrame, PageHeader, Row, RowList, RowMenu } from '../components/Kit'
import { Button, Dialog, Icon, toast } from '../components/ui'
import { int, plural } from '../lib/format'
import { useMedia } from '../lib/hooks'
import {
  CATALOGUES, CATALOGUE_PAGE_SIZE, cataloguePriceSource, formatCataloguePrice, requestCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueKind,
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

type Listing = { rows: CatalogueEntry[]; has_more: boolean }
/** a fetched page, with the filters it was fetched for, so it can stay on screen while the next one loads */
type Result = { key: string; q: string; supplier: string | null; archived: boolean; page: number; data?: Listing; error?: string }

/** products get a package, so the catalogue never borrows the archive box that means "Archived" */
const catalogueIcon = (kind: CatalogueKind) => (kind === 'products' ? 'package_2' : CATALOGUES[kind].icon)

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** a short piece of the description that tells same-named products apart; nothing when it only repeats the name */
function excerpt(name: string, description?: string) {
  const title = squash(name).toLowerCase()
  let text = squash(description ?? '')
  // descriptions often open with the product name: keep only what they add
  if (title && text.toLowerCase().startsWith(title)) text = text.slice(title.length).replace(/^[\s,.;:–—-]+/, '')
  if (!text || text.toLowerCase() === title) return ''
  if (text.length <= 60) return text
  const cut = text.slice(0, 60)
  const space = cut.lastIndexOf(' ')
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`
}

const shortId = (id: string, length = 6) => id.replace(/[^\da-z]/gi, '').slice(0, length).toLowerCase()

/**
 * products that share a name and category in the current result get one more detail on line two that tells them apart:
 * the first of item code, supplier, unit or price source that differs between all of them, else a short record id
 */
function discriminators(entries: CatalogueEntry[]) {
  const groups = new Map<string, CatalogueEntry[]>()
  for (const entry of entries) {
    const key = `${squash(entry.name).toLowerCase()}|${squash(entry.category ?? '').toLowerCase()}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const candidates: ((entry: CatalogueEntry) => { text: string; label: string } | null)[] = [
    (e) => (e.sku ? { text: `Item code ${e.sku}`, label: `item code ${e.sku}` } : null),
    (e) => (e.supplier ? { text: e.supplier, label: `from ${e.supplier}` } : null),
    (e) => (e.unit ? { text: e.unit, label: `per ${e.unit}` } : null),
    (e) => (e.valid_from ? { text: cataloguePriceSource(e), label: `price from ${cataloguePriceSource(e)}` } : null),
  ]
  const tags = new Map<string, { text: string; label: string }>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const pick = candidates.find((candidate) => {
      const values = group.map((entry) => candidate(entry)?.text)
      return values.every(Boolean) && new Set(values).size === group.length
    })
    let length = 6
    while (!pick && length < 32 && new Set(group.map((entry) => shortId(entry.id, length))).size < group.length) length += 2
    for (const entry of group) {
      const id = shortId(entry.id, length)
      tags.set(entry.id, pick?.(entry) ?? { text: `#${id}`, label: `record ${id}` })
    }
  }
  return tags
}

/** the second line of a row: only the details that exist, so empty columns never become a wall of dashes */
function details(kind: CatalogueKind, entry: CatalogueEntry) {
  if (kind === 'products') {
    const specifics = [entry.unit, entry.sku && `Item code ${entry.sku}`, entry.supplier].filter(Boolean)
    const parts = [entry.category, ...specifics, !specifics.length && excerpt(entry.name, entry.description)].filter(Boolean)
    return parts.length ? parts.join(' · ') : 'No supplier or item code yet'
  }
  const shown = [kind === 'subcontractors' ? entry.trade : null, entry.contact_name, entry.email, entry.phone].filter(Boolean)
  return shown.length ? shown.join(' · ') : 'No contact details yet'
}

function CatalogueRows({ kind, entries, onEdit, onArchive, onRestore }: {
  kind: CatalogueKind
  entries: CatalogueEntry[]
  onEdit: (entry: CatalogueEntry) => void
  onArchive: (entry: CatalogueEntry) => void
  onRestore: (entry: CatalogueEntry) => void
}) {
  const navigate = useNavigate()
  const icon = catalogueIcon(kind)
  // touch screens can't hover, so the ⋯ stays visible in its own column there
  const touch = useMedia('(hover: none)')
  // the name travels along so the Products filter chip can say whose products these are
  const showProducts = (entry: CatalogueEntry) => navigate(`/catalogues/products?supplier=${encodeURIComponent(entry.id)}`, { state: { supplierName: entry.name } })
  const tags = kind === 'products' ? discriminators(entries) : new Map<string, { text: string; label: string }>()
  return (
    <RowList>
      {entries.map((entry) => {
        const archived = !!entry.archived_at
        const tag = tags.get(entry.id)
        const name = tag ? `${entry.name} (${tag.label})` : entry.name
        const line = details(kind, entry)
        const subtitle = tag && !line.split(' · ').includes(tag.text) ? `${line} · ${tag.text}` : line
        const price = kind === 'products' ? formatCataloguePrice(entry) : null
        const priced = price && price !== '—'
        const products = kind === 'suppliers' ? entry.product_count ?? 0 : 0
        const menu = (
          <RowMenu
            label={`Actions for ${name}`}
            items={archived ? [
              { label: 'Restore', icon: 'restore', onSelect: () => onRestore(entry) },
            ] : [
              { label: 'Edit', icon: 'edit', onSelect: () => onEdit(entry) },
              ...(products ? [{ label: `View ${plural(products, 'product', 'products')}`, icon: 'package_2', onSelect: () => showProducts(entry) }] : []),
              'sep' as const,
              { label: 'Archive', icon: 'archive', danger: true, onSelect: () => onArchive(entry) },
            ]}
          />
        )
        const amount: ReactNode = kind === 'products'
          ? (priced ? price : <span className="text-sm font-normal text-slate-600">No price</span>)
          : kind === 'suppliers' ? (products && !archived ? (
            // a link to the supplier's products; above the row's own button, so it never opens the editor
            <button
              type="button"
              aria-label={`View ${plural(products, 'product', 'products')} from ${entry.name}`}
              onClick={(event) => { event.stopPropagation(); showProducts(entry) }}
              className="group/link pointer-events-auto relative z-10 -my-1 inline-flex items-center gap-0.5 rounded py-1 text-sm font-normal text-slate-600 transition-colors after:absolute after:-inset-x-2 after:-inset-y-1.5 after:content-[''] hover:text-brand-700"
            >
              {/* underlined like the page's other text links; the chevron stays out of the underline */}
              <span className="underline decoration-slate-400 underline-offset-2 group-hover/link:decoration-current">{plural(products, 'product', 'products')}</span>
              <Icon name="chevron_right" size={18} className="-mr-1" />
            </button>
          ) : <span className="text-sm font-normal text-slate-600">{plural(products, 'product', 'products')}</span>) : null
        const meta: ReactNode = kind === 'products' && priced
          ? <span className="text-sm text-slate-600">{entry.unit ? `per ${entry.unit}` : 'no unit'}{entry.valid_from ? ` · ${cataloguePriceSource(entry)}` : ''}</span>
          : null
        return (
          <Row
            key={entry.id}
            dataRow="catalogue"
            label={archived ? `Restore ${name}` : `Edit ${name}`}
            onOpen={() => (archived ? onRestore(entry) : onEdit(entry))}
            icon={icon}
            title={entry.name}
            subtitle={subtitle}
            // with a mouse, the ⋯ floats over the row's right end instead of keeping a column of its own,
            // so prices and product links end on the same edge as the header's Add button
            amount={touch ? amount ?? undefined : (
              <>
                {amount != null && <Reveal>{amount}</Reveal>}
                <span className="pointer-events-auto absolute top-1/2 -right-2 z-10 -translate-y-1/2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100">{menu}</span>
              </>
            )}
            meta={meta == null ? undefined : touch ? meta : <Reveal>{meta}</Reveal>}
            menu={touch ? menu : undefined}
          />
        )
      })}
    </RowList>
  )
}

/** the trailing text slides aside while the floating ⋯ shows, on the row's hover fill so it never runs into a long name */
function Reveal({ children }: { children: ReactNode }) {
  return (
    <span className="-ml-2 inline-block rounded pl-2 transition-transform duration-150 group-hover:-translate-x-11 group-hover:bg-slate-100 group-focus-within:-translate-x-11 group-has-[[aria-expanded=true]]:-translate-x-11">
      {children}
    </span>
  )
}

function Catalogue({ kind }: { kind: CatalogueKind }) {
  const { title, item } = CATALOGUES[kind]
  const icon = catalogueIcon(kind)
  const [filters, setFilters] = useSearchParams()
  const location = useLocation()
  const supplier = kind === 'products' ? filters.get('supplier') : null
  const archived = filters.get('view') === 'archived'
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<Result | null>(null)
  const [editing, setEditing] = useState<CatalogueEntry | null | undefined>(undefined)
  const [confirm, setConfirm] = useState<{ entry: CatalogueEntry; action: 'archive' | 'restore' } | null>(null)
  const [busy, setBusy] = useState(false)

  const params = new URLSearchParams({ q: query.trim(), page: String(page) })
  if (supplier) params.set('supplier', supplier)
  if (archived) params.set('view', 'archived')
  const request = `?${params}`
  const key = `${request}#${reload}`
  const current = result?.key === key ? result : null
  const trimmed = query.trim()

  useEffect(() => {
    const controller = new AbortController()
    const snapshot = { key, q: trimmed, supplier, archived, page }
    const timer = setTimeout(async () => {
      try {
        const data = await requestCatalogue<Listing>(kind, request, { signal: controller.signal })
        if (!controller.signal.aborted) setResult({ ...snapshot, data })
      } catch (error) {
        if (!controller.signal.aborted) setResult({ ...snapshot, error: (error as Error).message })
      }
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [kind, request, key, trimmed, supplier, archived, page])

  function setFilter(name: string, value?: string) {
    const next = new URLSearchParams(filters)
    if (value) next.set(name, value)
    else next.delete(name)
    setFilters(next)
    setPage(1)
  }

  async function changeArchive(entry: CatalogueEntry, action: 'archive' | 'restore') {
    if (busy) return
    setBusy(true)
    try {
      await writeCatalogue(kind, { id: entry.id, action })
      toast(action === 'archive' ? `Archived ${entry.name}` : `Restored ${entry.name}`)
      setConfirm(null)
      if (view?.data?.rows.length === 1) setPage((n) => Math.max(1, n - 1))
      setReload((n) => n + 1)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  // while the next page or search loads, the last result stays on screen (only the first load shows a skeleton);
  // everything below describes what is shown, so a stale result never borrows the new query's wording
  const view = current ?? (result?.data ? result : null)
  const refreshing = !current && !!view
  const rows = view?.data?.rows ?? []
  // a brand-new catalogue: one call to action in the empty state (the header's Add button steps aside)
  const blank = !!view?.data && !rows.length && !view.q && !view.supplier && !view.archived && view.page === 1
  const supplierName = (location.state as { supplierName?: string } | null)?.supplierName
    ?? rows.find((entry) => entry.supplier_id === supplier)?.supplier ?? undefined

  // one result heading with the count: exact when this is the last page, else at least what has been paged through
  const noun = title.toLowerCase()
  let heading = ''
  if (view?.data && rows.length) {
    const seen = (view.page - 1) * CATALOGUE_PAGE_SIZE + rows.length
    const n = view.data.has_more ? `${int(seen)}+` : int(seen)
    const many = view.data.has_more || seen !== 1
    heading = view.q
      ? `${n} ${many ? 'matches' : 'match'} for “${view.q}”${view.archived ? ' in Archived' : ''}`
      : `${n} ${view.archived ? 'archived ' : ''}${many ? noun : item}`
  }

  return (
    <PageFrame>
      <PageHeader
        title={title}
        subtitle={SUBTITLE[kind]}
        aside={!blank && <Button variant="primary" size="lg" icon="add" onClick={() => setEditing(null)} aria-label={`Add ${item}`} className="max-sm:px-4"><span>Add<span className="max-sm:hidden"> {item}</span></span></Button>}
      />

      {/* kept on an empty catalogue too (search disabled), so switching catalogues never shifts the page */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Icon name="search" size={20} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-600" />
          <input
            type="search"
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder={`Search ${title.toLowerCase()}`}
            value={query}
            disabled={blank}
            maxLength={200}
            onChange={(event) => { setQuery(event.target.value); setPage(1) }}
            className="h-10 w-full rounded-md bg-slate-100 pr-3 pl-11 text-sm text-slate-900 ring-1 ring-slate-400 transition-[background-color,box-shadow] outline-none ring-inset placeholder:text-slate-600 hover:bg-slate-200/70 focus:bg-white focus:ring-2 focus:ring-brand-700 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-slate-100"
          />
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
        {/* the result heading sits on the toolbar's line, and updates in place while a search refreshes */}
        <h2 id="catalogue-rows" aria-live="polite" aria-atomic="true" className="num text-sm font-semibold text-slate-700 empty:hidden max-sm:w-full sm:ml-auto">{heading}</h2>
      </div>

      {!view && !current?.error && <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-lg" /></div>}
      {current?.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-rose-50 p-4 text-sm font-medium text-rose-800 ring-1 ring-rose-200 ring-inset">
          <Icon name="error" size={20} />{current.error}
          <Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {view?.data && !current?.error && (rows.length ? (
        <section aria-labelledby="catalogue-rows" aria-busy={refreshing} className="mb-8">
          <CatalogueRows kind={kind} entries={rows} onEdit={setEditing}
            onArchive={(entry) => setConfirm({ entry, action: 'archive' })}
            onRestore={(entry) => setConfirm({ entry, action: 'restore' })} />
        </section>
      ) : (
        <EmptyState
          icon={view.q || view.supplier ? 'search_off' : icon}
          hint={!view.q && !view.archived && !view.supplier && (
            <button type="button" onClick={() => setFilter('view', 'archived')} className="relative inline-block py-2 font-medium text-slate-600 underline underline-offset-2 transition-colors after:absolute after:-inset-x-2 after:inset-y-0 after:content-[''] hover:text-brand-700">
              Show archived
            </button>
          )}
          title={view.q || view.supplier ? 'No matching entries' : `No ${view.archived ? 'archived ' : ''}${noun} yet`}
          text={view.q ? 'Try a different search, or clear it to see everything.'
            : view.archived ? `Archived ${noun} land here, and you can restore them any time.`
            : EMPTY_TEXT[kind]}
        >
          {view.q ? <Button size="lg" onClick={() => { setQuery(''); setPage(1) }}>Clear search</Button>
            : !view.archived && !view.supplier && <Button variant="primary" size="lg" icon="add" onClick={() => setEditing(null)}>Add {item}</Button>}
        </EmptyState>
      ))}
      {view?.data && !current?.error && (view.page > 1 || view.data.has_more) && (
        <nav aria-label="Catalogue pages" className="mt-4 flex items-center justify-end gap-3 text-sm text-slate-600">
          <Button size="sm" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Previous</Button>
          <span aria-live="polite" className="num">Page {int(page)}</span>
          <Button size="sm" disabled={!view.data.has_more || refreshing} onClick={() => setPage((n) => n + 1)}>Next</Button>
        </nav>
      )}
      {editing !== undefined && (
        <CatalogueEditor kind={kind} entry={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            if (editing === null) { setFilter('view'); setQuery('') }
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
