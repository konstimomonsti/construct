import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { EmptyNote, Page, Skeleton } from '../components/Page'
import { Button, Dialog, Field, Icon, inputCls, toast } from '../components/ui'

const CATALOGUES = {
  products: { title: 'Products', icon: 'inventory_2' },
  suppliers: { title: 'Suppliers', icon: 'local_shipping' },
  subcontractors: { title: 'Subcontractors', icon: 'engineering' },
} as const

type Kind = keyof typeof CATALOGUES
type CompanyKind = Exclude<Kind, 'products'>

type Entry = {
  id: string
  name: string
  category?: string
  sku?: string | null
  unit?: string | null
  supplier?: string | null
  product_count?: number
  trade?: string
  contact_name?: string | null
  email?: string | null
  phone?: string | null
}
type Listing = { rows: Entry[]; has_more: boolean }

const PHRASES = {
  suppliers: 'supplier',
  subcontractors: 'subcontractor',
} as const

async function requestCatalogue<T>(kind: Kind, params = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/catalogues/${kind}${params}`, { cache: 'no-store', ...init })
  if (!response.ok) {
    const message = await response.json().catch(() => null)
    throw new Error(message?.error || 'Could not load the catalogue.')
  }
  return response.json()
}

function CompanyEditor({ kind, entry, onClose, onSaved }: {
  kind: CompanyKind
  entry: Entry | null
  onClose: () => void
  onSaved: () => void
}) {
  const formId = useId()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError('')
    const values = Object.fromEntries(new FormData(event.currentTarget))
    try {
      await requestCatalogue(kind, '', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, ...(entry && { id: entry.id }) }),
      })
      toast(entry ? 'Company updated' : 'Company added')
      onSaved()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={() => { if (!saving) onClose() }} title={`${entry ? 'Edit' : 'Add'} ${PHRASES[kind]}`} footer={
      <>
        <Button disabled={saving} onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>
    }>
      <form id={formId} onSubmit={submit} className="space-y-3">
        <Field label="Company name">
          <input data-autofocus required name="name" maxLength={160} defaultValue={entry?.name} className={inputCls} />
        </Field>
        {kind === 'subcontractors' && (
          <Field label="Trade">
            <input required name="trade" maxLength={120} defaultValue={entry?.trade} className={inputCls} />
          </Field>
        )}
        <Field label="Contact name">
          <input name="contact_name" autoComplete="off" maxLength={120} defaultValue={entry?.contact_name ?? ''} className={inputCls} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email">
            <input type="email" name="email" maxLength={254} defaultValue={entry?.email ?? ''} className={inputCls} />
          </Field>
          <Field label="Phone">
            <input type="tel" name="phone" maxLength={60} defaultValue={entry?.phone ?? ''} className={inputCls} />
          </Field>
        </div>
        {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
      </form>
    </Dialog>
  )
}

function CatalogueTable({ kind, entries, onEdit }: { kind: Kind; entries: Entry[]; onEdit: (entry: Entry) => void }) {
  const columns = kind === 'products'
    ? ['Product', 'Category', 'Supplier', 'SKU', 'Unit']
    : ['Company', ...(kind === 'subcontractors' ? ['Trade'] : []), 'Contact', 'Email', 'Phone', ...(kind === 'suppliers' ? ['Products'] : []), 'Actions']

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full whitespace-nowrap text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
          <tr>{columns.map((column) => <th key={column} scope="col" className="px-4 py-3">{column}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((entry) => (
            <tr key={entry.id} className="text-slate-600 hover:bg-slate-50/70">
              <th scope="row" className="max-w-72 overflow-hidden px-4 py-3 text-sm font-semibold whitespace-normal wrap-anywhere text-slate-900">{entry.name}</th>
              {kind === 'products' ? (
                <>
                  <td className="px-4 py-3">{entry.category}</td>
                  <td className="px-4 py-3">{entry.supplier ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs">{entry.sku ?? '—'}</td>
                  <td className="px-4 py-3">{entry.unit ?? '—'}</td>
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
                  <td className="px-4 py-3">
                    <Button size="sm" onClick={() => onEdit(entry)} aria-label={`Edit ${entry.name}`}>Edit</Button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Catalogue({ kind }: { kind: Kind }) {
  const { title, icon } = CATALOGUES[kind]
  const [filters, setFilters] = useSearchParams()
  const supplier = kind === 'products' ? filters.get('supplier') : null
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<{ key: string; data?: Listing; error?: string } | null>(null)
  const [editing, setEditing] = useState<Entry | null | undefined>(undefined)

  const params = new URLSearchParams({ q: query.trim(), page: String(page) })
  if (supplier) params.set('supplier', supplier)
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

  return (
    <Page className="mx-auto w-full max-w-7xl px-4 pt-6 pb-12 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Catalogues</p>
          <h1 className="font-heading text-xl font-bold text-slate-900">{title}</h1>
        </div>
        {kind !== 'products' && <Button variant="primary" icon="add" onClick={() => setEditing(null)}>Add {PHRASES[kind]}</Button>}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:max-w-80">
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
        {supplier && (
          <Button size="sm" icon="close" onClick={() => { setFilters({}); setPage(1) }}>Clear supplier filter</Button>
        )}
      </div>

      {!current && <Skeleton className="h-40 rounded-xl" />}
      {current?.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {current.error}
          <Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {current?.data && (current.data.rows.length ? (
        <CatalogueTable kind={kind} entries={current.data.rows} onEdit={setEditing} />
      ) : (
        <EmptyNote
          icon={icon}
          title={query.trim() || supplier ? 'No matching entries' : `No ${title.toLowerCase()} yet`}
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
      {kind !== 'products' && editing !== undefined && (
        <CompanyEditor
          kind={kind}
          entry={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); setReload((n) => n + 1) }}
        />
      )}
    </Page>
  )
}

export function CataloguePage() {
  const { kind = '' } = useParams()
  if (!Object.hasOwn(CATALOGUES, kind)) {
    return <Page className="mx-auto max-w-7xl p-6"><EmptyNote title="Catalogue not found" /></Page>
  }
  return <Catalogue key={kind} kind={kind as Kind} />
}
