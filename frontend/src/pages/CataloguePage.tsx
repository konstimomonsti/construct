import { clsx } from 'clsx'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CatalogueEditor } from '../components/CatalogueEditor'
import { Skeleton } from '../components/Page'
import { Chips, EmptyState, PageFrame, PageHeader } from '../components/Kit'
import { Button, Dialog, Icon, IconButton, toast } from '../components/ui'
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

function CatalogueTable({ kind, entries, onEdit, onDelete, onRestore, busy }: {
  kind: CatalogueKind
  entries: CatalogueEntry[]
  onEdit: (entry: CatalogueEntry) => void
  onDelete: (entry: CatalogueEntry) => void
  onRestore: (entry: CatalogueEntry) => void
  busy: boolean
}) {
  const columns = kind === 'products'
    ? ['Product', 'Category', 'Supplier', 'ID', 'Unit', 'Price', 'Actions']
    : ['Company', ...(kind === 'subcontractors' ? ['Trade'] : []), 'Contact', 'Email', 'Phone', ...(kind === 'suppliers' ? ['Products'] : []), 'Actions']

  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-slate-300 ring-inset">
      <table className="w-full text-left text-sm whitespace-nowrap">
        <thead className="border-b border-slate-300 bg-slate-50 text-[13px] font-semibold text-slate-600">
          <tr>{columns.map((column) => (
            <th key={column} scope="col" className={clsx('px-4 py-2.5', (column === 'Price' || column === 'Actions') && 'text-right', (column === 'ID' || column === 'Category') && 'max-md:hidden')}>
              {column === 'Actions' ? <span className="sr-only">Actions</span> : column === 'ID' ? <abbr title="Supplier item code" className="no-underline">Item code</abbr> : column}
            </th>
          ))}</tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {entries.map((entry) => (
            <tr key={entry.id} className="text-slate-700 transition-colors hover:bg-slate-100">
              <th scope="row" className="max-w-80 min-w-48 px-4 py-3 text-[15px] font-semibold whitespace-normal text-pretty wrap-anywhere text-slate-900">{entry.name}</th>
              {kind === 'products' ? (
                <>
                  <td className="px-4 py-3 max-md:hidden"><span className="inline-flex h-6 items-center rounded-md px-2 text-[13px] font-medium text-slate-700 ring-1 ring-slate-300 ring-inset">{entry.category}</span></td>
                  <td className="px-4 py-3">{entry.supplier ?? '—'}</td>
                  <td className="num px-4 py-3 text-slate-600 max-md:hidden">{entry.sku ?? '—'}</td>
                  <td className="px-4 py-3">{entry.unit ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="num font-semibold text-slate-900">{formatCataloguePrice(entry)}</div>
                    {entry.valid_from && <div className="mt-0.5 text-[13px] text-slate-500">{cataloguePriceSource(entry)}</div>}
                  </td>
                </>
              ) : (
                <>
                  {kind === 'subcontractors' && <td className="px-4 py-3">{entry.trade}</td>}
                  <td className="px-4 py-3">{entry.contact_name ?? '—'}</td>
                  <td className="px-4 py-3">{entry.email ?? '—'}</td>
                  <td className="px-4 py-3">{entry.phone ?? '—'}</td>
                  {kind === 'suppliers' && (
                    <td className="px-4 py-3">
                      {entry.product_count ? (
                        <Link className="num font-semibold text-slate-900 underline decoration-slate-400 underline-offset-4 hover:decoration-slate-900" to={`/catalogues/products?supplier=${entry.id}`} aria-label={`View products from ${entry.name}`}>
                          {entry.product_count}
                        </Link>
                      ) : 0}
                    </td>
                  )}
                </>
              )}
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  {entry.archived_at ? (
                    <Button size="sm" icon="restore" disabled={busy} onClick={() => onRestore(entry)} aria-label={`Restore ${entry.name}`}>Restore</Button>
                  ) : (
                    <>
                      <Button size="sm" icon="edit" onClick={() => onEdit(entry)} aria-label={`Edit ${entry.name}`}>Edit</Button>
                      <IconButton icon="delete" label={`Delete ${entry.name}`} title="Delete" onClick={() => onDelete(entry)} className="hover:bg-rose-50 hover:text-rose-700" />
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Catalogue({ kind }: { kind: CatalogueKind }) {
  const { title, item, icon } = CATALOGUES[kind]
  const [filters, setFilters] = useSearchParams()
  const supplier = kind === 'products' ? filters.get('supplier') : null
  const archived = filters.get('view') === 'archived'
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<{ key: string; data?: Listing; error?: string } | null>(null)
  const [editing, setEditing] = useState<CatalogueEntry | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<CatalogueEntry | null>(null)
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
      toast(action === 'archive' ? 'Entry moved to Archived' : 'Entry restored')
      setDeleting(null)
      if (current?.data?.rows.length === 1) setPage((n) => Math.max(1, n - 1))
      setReload((n) => n + 1)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageFrame>
      <PageHeader
        title={title}
        subtitle={SUBTITLE[kind]}
        aside={<Button variant="primary" size="lg" icon="add" onClick={() => setEditing(null)}>Add {item}</Button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Icon name="search" size={20} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-600" />
          <input
            type="search"
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder={`Search ${title.toLowerCase()}`}
            value={query}
            maxLength={200}
            onChange={(event) => { setQuery(event.target.value); setPage(1) }}
            className="h-10 w-full rounded-md bg-slate-100 pr-3 pl-11 text-sm text-slate-900 ring-1 ring-slate-400 transition-[background-color,box-shadow] outline-none ring-inset placeholder:text-slate-600 hover:bg-slate-200/70 focus:bg-white focus:ring-2 focus:ring-brand-700"
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
      {current?.data && (current.data.rows.length ? (
        <CatalogueTable kind={kind} entries={current.data.rows} onEdit={setEditing} onDelete={setDeleting}
          onRestore={(entry) => { void changeArchive(entry, 'restore') }} busy={busy} />
      ) : (
        <EmptyState
          icon={query.trim() || supplier ? 'search_off' : icon}
          title={query.trim() || supplier ? 'No matching entries' : `No ${archived ? 'archived ' : ''}${title.toLowerCase()} yet`}
          text={query.trim() ? 'Try a different search, or clear it to see everything.'
            : archived ? `Deleted ${title.toLowerCase()} land here, and you can restore them any time.`
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
      {deleting && (
        <Dialog open onClose={() => { if (!busy) setDeleting(null) }} title={`Delete ${item}`} footer={<>
          <Button disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => { void changeArchive(deleting, 'archive') }}>Delete</Button>
        </>}>
          <p className="text-sm leading-relaxed text-slate-700"><strong className="text-slate-900">{deleting.name}</strong> moves to Archived, where you can restore it.</p>
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
