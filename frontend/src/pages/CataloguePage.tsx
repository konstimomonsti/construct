import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CatalogueEditor } from '../components/CatalogueEditor'
import { Skeleton } from '../components/Page'
import { Chips, EmptyState, PageFrame, PageHeader, Row, RowList, RowMenu, Section } from '../components/Kit'
import { Button, Dialog, Icon, toast } from '../components/ui'
import { plural } from '../lib/format'
import { useMedia } from '../lib/hooks'
import {
  CATALOGUES, cataloguePriceSource, formatCataloguePrice, requestCatalogue, writeCatalogue,
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
  subcontractors: 'Add the companies you hire, with their trade and contact details.',
}

type Listing = { rows: CatalogueEntry[]; has_more: boolean }

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
  const showProducts = (entry: CatalogueEntry) => navigate(`/catalogues/products?supplier=${entry.id}`)
  return (
    <RowList>
      {entries.map((entry) => {
        const archived = !!entry.archived_at
        const price = kind === 'products' ? formatCataloguePrice(entry) : null
        const priced = price && price !== '—'
        const products = kind === 'suppliers' ? entry.product_count ?? 0 : 0
        const menu = (
          <RowMenu
            label={`Actions for ${entry.name}`}
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
          ? (priced ? price : <span className="font-normal text-slate-500"><span aria-hidden>—</span><span className="sr-only">Not priced</span></span>)
          : kind === 'suppliers' ? (products && !archived ? (
            // a link to the supplier's products; above the row's own button, so it never opens the editor
            <button
              type="button"
              aria-label={`View ${plural(products, 'product', 'products')} from ${entry.name}`}
              onClick={(event) => { event.stopPropagation(); showProducts(entry) }}
              className="pointer-events-auto relative z-10 -my-1 inline-flex items-center gap-0.5 rounded py-1 text-sm font-normal text-slate-600 underline-offset-2 transition-colors after:absolute after:-inset-x-2 after:-inset-y-1.5 after:content-[''] hover:text-brand-700 hover:underline"
            >
              {plural(products, 'product', 'products')}
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
            label={archived ? `Restore ${entry.name}` : `Edit ${entry.name}`}
            onOpen={() => (archived ? onRestore(entry) : onEdit(entry))}
            icon={icon}
            title={entry.name}
            subtitle={details(kind, entry)}
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
  const supplier = kind === 'products' ? filters.get('supplier') : null
  const archived = filters.get('view') === 'archived'
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<{ key: string; data?: Listing; error?: string } | null>(null)
  const [editing, setEditing] = useState<CatalogueEntry | null | undefined>(undefined)
  const [confirm, setConfirm] = useState<{ entry: CatalogueEntry; action: 'archive' | 'restore' } | null>(null)
  const [busy, setBusy] = useState(false)

  const params = new URLSearchParams({ q: query.trim(), page: String(page) })
  if (supplier) params.set('supplier', supplier)
  if (archived) params.set('view', 'archived')
  const request = `?${params}`
  const key = `${request}#${reload}`
  const current = result?.key === key ? result : null

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const data = await requestCatalogue<Listing>(kind, request, { signal: controller.signal })
        if (!controller.signal.aborted) setResult({ key, data })
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: (error as Error).message })
      }
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [kind, request, key])

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
      if (current?.data?.rows.length === 1) setPage((n) => Math.max(1, n - 1))
      setReload((n) => n + 1)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const searching = !!query.trim() || !!supplier
  // a brand-new catalogue: one call to action in the empty state (the header's Add button steps aside)
  const blank = !!current?.data && !current.data.rows.length && !searching && !archived && page === 1
  const rows = current?.data?.rows ?? []
  const count = current?.data && !current.data.has_more && page === 1 ? rows.length : undefined

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
          <button type="button" onClick={() => setFilter('supplier')} className="inline-flex h-10 items-center gap-1.5 rounded-md bg-slate-900 px-3.5 text-sm font-semibold text-white hover:bg-slate-800">
            One supplier<Icon name="close" size={18} /><span className="sr-only">Clear supplier filter</span>
          </button>
        )}
      </div>

      {!current && <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-lg" /></div>}
      {current?.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-rose-50 p-4 text-sm font-medium text-rose-800 ring-1 ring-rose-200 ring-inset">
          <Icon name="error" size={20} />{current.error}
          <Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {current?.data && (rows.length ? (
        <Section title={archived ? 'Archived' : 'Active'} count={count} id="catalogue-rows">
          <CatalogueRows kind={kind} entries={rows} onEdit={setEditing}
            onArchive={(entry) => setConfirm({ entry, action: 'archive' })}
            onRestore={(entry) => setConfirm({ entry, action: 'restore' })} />
        </Section>
      ) : (
        <EmptyState
          icon={query.trim() || supplier ? 'search_off' : icon}
          hint={!query.trim() && !archived && !supplier && (
            <button type="button" onClick={() => setFilter('view', 'archived')} className="relative inline-block py-2 font-medium text-slate-600 underline underline-offset-2 transition-colors after:absolute after:-inset-x-2 after:inset-y-0 after:content-[''] hover:text-brand-700">
              Show archived
            </button>
          )}
          title={query.trim() || supplier ? 'No matching entries' : `No ${archived ? 'archived ' : ''}${title.toLowerCase()} yet`}
          text={query.trim() ? 'Try a different search, or clear it to see everything.'
            : archived ? `Archived ${title.toLowerCase()} land here, and you can restore them any time.`
            : EMPTY_TEXT[kind]}
        >
          {query.trim() ? <Button size="lg" onClick={() => setQuery('')}>Clear search</Button>
            : !archived && !supplier && <Button variant="primary" size="lg" icon="add" onClick={() => setEditing(null)}>Add {item}</Button>}
        </EmptyState>
      ))}
      {current?.data && (page > 1 || current.data.has_more) && (
        <nav aria-label="Catalogue pages" className="mt-4 flex items-center justify-end gap-3 text-sm text-slate-600">
          <Button size="sm" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Previous</Button>
          <span aria-live="polite" className="num">Page {page}</span>
          <Button size="sm" disabled={!current.data.has_more} onClick={() => setPage((n) => n + 1)}>Next</Button>
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
