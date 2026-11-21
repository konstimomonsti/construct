import { useEffect, useId, useState, type FormEvent } from 'react'
import { clsx } from 'clsx'
import { Button, Dialog, Field, Icon, inputCls, Menu, toast } from './ui'
import { MOD_KEY } from '../lib/keys'
import {
  CATALOGUES, cataloguePriceSource, formatCataloguePrice, requestCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueKind, type ProductOptions,
} from '../lib/catalogues'

function ProductFields({ entry, options }: { entry: CatalogueEntry | null; options: ProductOptions }) {
  const categoriesId = useId()
  const locked = entry?.review_status === 'approved'
  // dates are typed and shown the German way (21.11.2026); submit turns them back into ISO
  const [today] = useState(() => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()))
  const [supplierId, setSupplierId] = useState(entry?.supplier_id ?? '')
  const [unit, setUnit] = useState(entry?.unit ?? '')
  const suppliers = [
    ...(entry?.supplier_id && entry.supplier_archived_at ? [{ id: entry.supplier_id, name: `${entry.supplier} (archived)` }] : []),
    ...options.suppliers,
  ]
  const supplierName = suppliers.find((s) => s.id === supplierId)?.name
  const currency = entry?.currency ?? 'EUR'
  const symbol = currency === 'EUR' ? '€' : currency
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category">
          <input required name="category" list={categoriesId} maxLength={160} defaultValue={entry?.category} className={inputCls} />
          <datalist id={categoriesId}>
            {options.categories.map(({ name }) => <option key={name} value={name} />)}
          </datalist>
        </Field>
        <div className="space-y-1.5">
          <span id={`${categoriesId}-sup`} className="block text-sm font-semibold text-slate-800">Supplier</span>
          <input type="hidden" name="supplier_id" value={supplierId} />
          <Menu
            label="Choose a supplier"
            align="start"
            width="w-64"
            items={[
              { label: 'No supplier', checked: !supplierId, onSelect: () => setSupplierId('') },
              ...(suppliers.length ? ['sep' as const] : []),
              ...suppliers.map(({ id, name }) => ({ label: name, checked: supplierId === id, onSelect: () => setSupplierId(id) })),
            ]}
            trigger={(t) => (
              <button {...t} type="button" disabled={locked} aria-labelledby={`${categoriesId}-sup ${categoriesId}-supv`}
                className={clsx(inputCls, 'flex items-center justify-between gap-2 text-left disabled:opacity-60')}>
                <span id={`${categoriesId}-supv`} className={clsx('truncate', !supplierName && 'text-slate-500')}>{supplierName ?? 'No supplier'}</span>
                <Icon name="expand_more" size={20} className="shrink-0 text-slate-600" />
              </button>
            )}
          />
          {locked && <span className="block text-xs text-slate-600">Fixed for approved products</span>}
        </div>
        <Field label="Item code" hint="The supplier's article number">
          <input name="sku" maxLength={160} defaultValue={entry?.sku ?? ''} className={inputCls} />
        </Field>
        <Field label="Unit" hint={locked ? 'Fixed for approved products' : undefined}>
          <input name="unit" disabled={locked} maxLength={64} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m², Stk, h…" className={inputCls} />
        </Field>
      </div>
      <Field label="Description">
        <textarea required name="description" rows={4} maxLength={250000} defaultValue={entry?.description} className={`${inputCls} h-auto resize-y py-2`} />
      </Field>
      <section aria-labelledby={`${categoriesId}-price`} className="space-y-3 border-t border-slate-200 pt-4">
        <div>
          <h3 id={`${categoriesId}-price`} className="text-[15px] font-semibold text-slate-900">Price <span className="font-normal text-slate-600">(optional)</span></h3>
          <p className="mt-0.5 text-sm text-slate-600">{entry?.unit_price != null ? 'A new price is added to the history from its date. Leave it blank to keep the current one.' : 'A price is stored with the date it applies from. You can add it later.'}</p>
        </div>
        {entry?.unit_price != null && (
          <p className="text-sm text-slate-600">
            Current price <strong className="num text-slate-900">{formatCataloguePrice(entry)}</strong>
            {cataloguePriceSource(entry) && <span className="ml-2">{cataloguePriceSource(entry)}</span>}
          </p>
        )}
        <input type="hidden" name="currency" value={currency} />
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label={entry?.unit_price != null ? 'New unit price' : 'Unit price'} hint={unit.trim() ? `Per ${unit.trim()}` : 'Per unit'}>
            <span className="relative block">
              <input name="unit_price" inputMode="decimal" maxLength={24} placeholder="0,00" className={clsx(inputCls, 'num pr-9 text-right')} />
              <span aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-sm text-slate-600">{symbol}</span>
            </span>
          </Field>
          <Field label="Effective from" hint="Day.Month.Year">
            <input name="valid_from" inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" title="For example 21.11.2026" defaultValue={today} className={clsx(inputCls, 'num')} />
          </Field>
        </div>
      </section>
    </>
  )
}

function CompanyFields({ kind, entry }: { kind: CatalogueKind; entry: CatalogueEntry | null }) {
  return (
    <>
      {kind === 'subcontractors' && (
        <Field label="Trade">
          <input required name="trade" maxLength={120} defaultValue={entry?.trade} className={inputCls} />
        </Field>
      )}
      <Field label="Contact name">
        <input name="contact_name" autoComplete="off" maxLength={120} defaultValue={entry?.contact_name ?? ''} className={inputCls} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email">
          <input type="email" name="email" maxLength={254} defaultValue={entry?.email ?? ''} className={inputCls} />
        </Field>
        <Field label="Phone">
          <input type="tel" name="phone" maxLength={60} defaultValue={entry?.phone ?? ''} className={inputCls} />
        </Field>
      </div>
    </>
  )
}

export function CatalogueEditor({ kind, entry, onClose, onSaved }: {
  kind: CatalogueKind
  entry: CatalogueEntry | null
  onClose: () => void
  onSaved: () => void
}) {
  const formId = useId()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [product, setProduct] = useState<{ options: ProductOptions; detail: CatalogueEntry | null } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const productId = entry?.id
  useEffect(() => {
    if (kind !== 'products') return
    const controller = new AbortController()
    const options = requestCatalogue<ProductOptions>('products', '?options=1', { signal: controller.signal })
    const detail = productId ? requestCatalogue<CatalogueEntry>('products', `?id=${encodeURIComponent(productId)}`, { signal: controller.signal }) : Promise.resolve(null)
    void Promise.all([options, detail]).then(([options, detail]) => {
      if (!controller.signal.aborted) setProduct({ options, detail })
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setLoadError(error.message)
    })
    return () => controller.abort()
  }, [productId, kind, retry])
  const isProduct = kind === 'products'
  const ready = !isProduct || !!product
  const current = isProduct ? product?.detail : entry

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || !ready) return
    setSaving(true)
    setError('')
    const values = Object.fromEntries(new FormData(event.currentTarget))
    const date = typeof values.valid_from === 'string' && values.valid_from.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
    if (date) values.valid_from = `${date[3]}-${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}`
    try {
      await writeCatalogue(kind, {
        ...values,
        ...(entry && { id: entry.id }),
        ...(isProduct && current?.review_status === 'approved' && { supplier_id: current.supplier_id, unit: current.unit }),
      })
      toast(entry ? 'Changes saved' : 'Catalogue entry added')
      onSaved()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => { if (!saving) onClose() }}
      title={`${entry ? 'Edit' : 'Add'} ${CATALOGUES[kind].item}`}
      width={isProduct ? 'max-w-xl' : undefined}
      footer={<>
        <span className="mr-auto text-[13px] text-slate-500 max-sm:hidden"><kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-slate-100 px-1.5 font-sans text-xs font-medium text-slate-700">{MOD_KEY}</kbd> <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-slate-100 px-1.5 font-sans text-xs font-medium text-slate-700">↵</kbd> to save</span>
        <Button disabled={saving} onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} disabled={saving || !ready}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      {!ready ? (
        loadError ? <div role="alert" className="space-y-3 text-sm text-rose-800">
          <p>{loadError}</p>
          <Button size="sm" onClick={() => { setLoadError(''); setRetry((n) => n + 1) }}>Retry</Button>
        </div> : <p role="status" className="text-sm text-slate-600">Loading product details…</p>
      ) : (
        <form id={formId} onSubmit={submit} className="space-y-4"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.requestSubmit() } }}>
          <Field label={isProduct ? 'Product name' : 'Company name'}>
            <input data-autofocus required name="name" maxLength={isProduct ? 300 : 160} defaultValue={current?.name} className={inputCls} />
          </Field>
          {isProduct && product
            ? <ProductFields options={product.options} entry={product.detail} />
            : <CompanyFields kind={kind} entry={entry} />}
          {error && <p role="alert" className="text-sm font-medium text-rose-800">{error}</p>}
        </form>
      )}
    </Dialog>
  )
}
