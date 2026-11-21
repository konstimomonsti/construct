import { clsx } from 'clsx'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CatalogueEditor } from '../components/CatalogueEditor'
import { EmptyNote, Page, Skeleton } from '../components/Page'
import { Button, Dialog, Icon, inputCls, toast } from '../components/ui'
import {
  CATALOGUES, cataloguePriceSource, formatCataloguePrice, requestCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueKind,
} from '../lib/catalogues'

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
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-xs">
      <table className="w-full whitespace-nowrap text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
          <tr>{columns.map((column) => (
            <th key={column} scope="col" className={clsx('px-4 py-3', (column === 'Price' || column === 'Actions') && 'text-right')}>
              {column === 'ID' ? <span title="Supplier item code">ID</span> : column}
            </th>
          ))}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((entry) => (
            <tr key={entry.id} className="text-slate-600 hover:bg-slate-50/70">
              <th scope="row" className="min-w-48 max-w-80 px-4 py-3 text-sm font-semibold whitespace-normal wrap-anywhere text-slate-900">{entry.name}</th>
              {kind === 'products' ? (
                <>
                  <td className="px-4 py-3"><span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium">{entry.category}</span></td>
                  <td className="px-4 py-3">{entry.supplier ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs">{entry.sku ?? '—'}</td>
                  <td className="px-4 py-3">{entry.unit ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="font-medium text-slate-900 tabular-nums">{formatCataloguePrice(entry)}</div>
                    {entry.valid_from && <div className="mt-0.5 text-[11px] text-slate-500">{cataloguePriceSource(entry)}</div>}
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
                        <Link className="font-semibold text-brand-700 hover:underline" to={`/catalogues/products?supplier=${entry.id}`} aria-label={`View products from ${entry.name}`}>
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
                      <Button size="sm" variant="ghost" icon="edit" onClick={() => onEdit(entry)} aria-label={`Edit ${entry.name}`}>Edit</Button>
                      <Button size="sm" variant="ghost" icon="delete_outline" onClick={() => onDelete(entry)} aria-label={`Delete ${entry.name}`} title="Delete" className="hover:text-rose-700" />
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
    <Page className="mx-auto w-full max-w-7xl px-4 pt-6 pb-12 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
            <Icon name={icon} size={23} />
          </span>
          <div>
            <p className="mb-0.5 text-xs font-medium text-slate-500">Catalogues</p>
            <h1 className="font-heading text-xl font-bold text-slate-900">{title}</h1>
          </div>
        </div>
        <Button variant="primary" icon="add" onClick={() => setEditing(null)}>Add {item}</Button>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:max-w-72">
          <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder={`Search ${title.toLowerCase()}`}
            value={query}
            maxLength={200}
            onChange={(event) => { setQuery(event.target.value); setPage(1) }}
            className={`${inputCls} pl-9`}
          />
        </div>
        <div role="group" aria-label="Catalogue status" className="ml-auto inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5">
          <Button size="sm" variant={archived ? 'ghost' : 'secondary'} aria-pressed={!archived} onClick={() => setFilter('view')}>Active</Button>
          <Button size="sm" variant={archived ? 'secondary' : 'ghost'} aria-pressed={archived} onClick={() => setFilter('view', 'archived')}>Archived</Button>
        </div>
        {supplier && <Button size="sm" icon="close" onClick={() => setFilter('supplier')}>Clear supplier filter</Button>}
      </div>

      {!current && <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-xl" /></div>}
      {current?.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {current.error}
          <Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {current?.data && (current.data.rows.length ? (
        <CatalogueTable kind={kind} entries={current.data.rows} onEdit={setEditing} onDelete={setDeleting}
          onRestore={(entry) => { void changeArchive(entry, 'restore') }} busy={busy} />
      ) : (
        <EmptyNote
          icon={icon}
          title={query.trim() || supplier ? 'No matching entries' : `No ${archived ? 'archived ' : ''}${title.toLowerCase()} yet`}
          text={query.trim() ? 'Try a different search.' : undefined}
        />
      ))}
      {current?.data && (page > 1 || current.data.has_more) && (
        <nav aria-label="Catalogue pages" className="mt-4 flex items-center justify-end gap-3 text-xs text-slate-600">
          <Button size="sm" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Previous</Button>
          <span aria-live="polite">Page {page}</span>
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
          <p className="text-sm text-slate-700"><strong>{deleting.name}</strong> will move to Archived, where it can be restored.</p>
        </Dialog>
      )}
    </Page>
  )
}

export function CataloguePage() {
  const { kind = '' } = useParams()
  if (!Object.hasOwn(CATALOGUES, kind)) {
    return <Page className="mx-auto max-w-7xl p-6"><EmptyNote title="Catalogue not found" /></Page>
  }
  return <Catalogue key={kind} kind={kind as CatalogueKind} />
}
