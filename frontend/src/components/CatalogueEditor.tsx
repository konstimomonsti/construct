import { useEffect, useId, useState, type FormEvent } from 'react'
import { Button, Dialog, Field, inputCls, toast } from './ui'
import {
  CATALOGUES, cataloguePriceSource, formatCataloguePrice, requestCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueKind, type ProductOptions,
} from '../lib/catalogues'

function ProductFields({ entry, options }: { entry: CatalogueEntry | null; options: ProductOptions }) {
  const categoriesId = useId()
  const locked = entry?.review_status === 'approved'
  const [today] = useState(() => new Date().toLocaleDateString('sv-SE'))
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category">
          <input required name="category" list={categoriesId} maxLength={160} defaultValue={entry?.category} className={inputCls} />
          <datalist id={categoriesId}>
            {options.categories.map(({ name }) => <option key={name} value={name} />)}
          </datalist>
        </Field>
        <Field label="Supplier">
          <select aria-label="Supplier" name="supplier_id" disabled={locked} defaultValue={entry?.supplier_id ?? ''} className={inputCls}>
            <option value="">Select a supplier</option>
            {entry?.supplier_id && entry.supplier_archived_at && <option value={entry.supplier_id}>{entry.supplier} (archived)</option>}
            {options.suppliers.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </Field>
        <Field label="ID" hint="Supplier item code">
          <input name="sku" maxLength={160} defaultValue={entry?.sku ?? ''} className={inputCls} />
        </Field>
        <Field label="Unit" hint={locked ? 'Fixed for approved products' : undefined}>
          <input name="unit" disabled={locked} maxLength={64} defaultValue={entry?.unit ?? ''} className={inputCls} />
        </Field>
      </div>
      <Field label="Description">
        <textarea required name="description" rows={4} maxLength={250000} defaultValue={entry?.description} className={`${inputCls} h-auto resize-y py-2`} />
      </Field>
      <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <legend className="px-1 text-xs font-semibold text-slate-700">Price</legend>
        {entry?.unit_price != null && (
          <p className="text-xs text-slate-600">
            Current price <strong className="text-slate-900">{formatCataloguePrice(entry)}</strong>
            {cataloguePriceSource(entry) && <span className="ml-2">{cataloguePriceSource(entry)}</span>}
          </p>
        )}
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_6rem_1fr]">
          <Field label={entry?.unit_price != null ? 'New unit price' : 'Unit price'}>
            <input name="unit_price" inputMode="decimal" maxLength={24} className={inputCls} />
          </Field>
          <Field label="Currency">
            <input name="currency" maxLength={3} defaultValue={entry?.currency ?? 'EUR'} className={inputCls} />
          </Field>
          <Field label="Effective from">
            <input type="date" name="valid_from" defaultValue={today} className={inputCls} />
          </Field>
        </div>
      </fieldset>
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
      <div className="grid gap-3 sm:grid-cols-2">
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
        <form id={formId} onSubmit={submit} className="space-y-3">
          <Field label={isProduct ? 'Product name' : 'Company name'}>
            <input data-autofocus required name="name" maxLength={isProduct ? 300 : 160} defaultValue={current?.name} className={inputCls} />
          </Field>
          {isProduct && product
            ? <ProductFields options={product.options} entry={product.detail} />
            : <CompanyFields kind={kind} entry={entry} />}
          {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
        </form>
      )}
    </Dialog>
  )
}
