import { createContext, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Button, Dialog, Icon, inputCls, Menu, toast, kbdCls } from './ui'
import { MOD_KEY } from '../lib/keys'
import {
  CATALOGUES, cataloguePriceSource, formatCataloguePrice, requestCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueKind, type ProductOptions,
} from '../lib/catalogues'

/** placeholders one step darker than the shared field, so they keep 4.5:1 on the field fill */
const fieldCls = inputCls.replace('placeholder:text-slate-500', 'placeholder:text-slate-600')

/**
 * the dialog as a sheet that fits the visible viewport: only its body scrolls, and the footer with Save and Cancel
 * stays in view (above the home indicator on phones). Passed through Dialog's width, which lands on the panel.
 */
const SHEET = clsx(
  'flex max-h-[calc(100dvh-0.5rem)] flex-col sm:max-h-[calc(100dvh-2rem)]',
  '[&>div:nth-child(2)]:max-h-none [&>div:nth-child(2)]:min-h-0 [&>div:nth-child(2)]:flex-1 [&>div:nth-child(2)]:overscroll-contain',
  '[&>div:last-child]:shrink-0 max-sm:[&>div:last-child]:border-t max-sm:[&>div:last-child]:border-slate-200 max-sm:[&>div:last-child]:pt-3 max-sm:[&>div:last-child]:pb-[max(1rem,env(safe-area-inset-bottom))]',
)

/** the form's error, when there is one, so every field can point at it */
const ErrorId = createContext<string | undefined>(undefined)

/** a labelled field whose hint (and the form's error) is tied to the control through aria-describedby */
function EditorField({ label, hint, describedBy, children }: {
  label: string
  hint?: string
  /** more ids that describe the control, such as a section's intro */
  describedBy?: string
  children: (describedBy: string | undefined) => ReactNode
}) {
  const hintId = useId()
  const errorId = useContext(ErrorId)
  const ids = [describedBy, hint && hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-slate-800">{label}</span>
      {children(ids)}
      {hint && <span id={hintId} className="block text-xs text-slate-600">{hint}</span>}
    </label>
  )
}

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
        <EditorField label="Category">
          {(ids) => <>
            <input required name="category" list={categoriesId} maxLength={160} defaultValue={entry?.category} aria-describedby={ids} className={fieldCls} />
            <datalist id={categoriesId}>
              {options.categories.map(({ name }) => <option key={name} value={name} />)}
            </datalist>
          </>}
        </EditorField>
        {/* the same field as Category, so both labels and controls share one baseline */}
        <EditorField label="Supplier" hint={locked ? 'Fixed for approved products' : undefined}>
          {(ids) => <>
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
              <button {...t} type="button" disabled={locked} aria-label={`Supplier: ${supplierName ?? 'No supplier'}`} aria-describedby={ids}
                // like a native select: the arrow keys open the list too (Enter and Space already do)
                onKeyDown={(event) => {
                  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !t['aria-expanded']) { event.preventDefault(); t.onClick() }
                }}
                className={clsx(fieldCls, 'flex h-10 items-center justify-between gap-2 text-left disabled:opacity-60')}>
                <span className={clsx('truncate', !supplierName && 'text-slate-600')}>{supplierName ?? 'No supplier'}</span>
                <Icon name="expand_more" size={20} className="shrink-0 text-slate-600" />
              </button>
            )}
          />
          </>}
        </EditorField>
        <EditorField label="Item code" hint="The supplier's article number">
          {(ids) => <input name="sku" maxLength={160} defaultValue={entry?.sku ?? ''} aria-describedby={ids} className={fieldCls} />}
        </EditorField>
        <EditorField label="Unit" hint={locked ? 'Fixed for approved products' : undefined}>
          {(ids) => <input name="unit" disabled={locked} maxLength={64} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m², Stk, h…" aria-describedby={ids} className={fieldCls} />}
        </EditorField>
      </div>
      <EditorField label="Description">
        {(ids) => <textarea required name="description" rows={4} maxLength={250000} defaultValue={entry?.description} aria-describedby={ids} className={`${fieldCls} h-auto resize-y py-2`} />}
      </EditorField>
      <section aria-labelledby={`${categoriesId}-price`} className="space-y-3 border-t border-slate-200 pt-4">
        <div>
          <h3 id={`${categoriesId}-price`} className="text-sm font-semibold text-slate-900">Price <span className="font-normal text-slate-600">(optional)</span></h3>
          <p id={`${categoriesId}-price-intro`} className="mt-0.5 text-sm text-slate-600">{entry?.unit_price != null ? 'A new price is added to the history from its date. Leave it blank to keep the current one.' : 'A price is stored with the date it applies from. You can add it later.'}</p>
        </div>
        {entry?.unit_price != null && (
          <p className="text-sm text-slate-600">
            Current price <strong className="num text-slate-900">{formatCataloguePrice(entry)}</strong>
            {cataloguePriceSource(entry) && <span className="ml-2">{cataloguePriceSource(entry)}</span>}
          </p>
        )}
        <input type="hidden" name="currency" value={currency} />
        <div className="grid items-start gap-4 sm:grid-cols-2">
          {/* blank means no price: the placeholder says so in words, so it never reads as a stored 0,00 € */}
          <EditorField label={entry?.unit_price != null ? 'New unit price' : 'Unit price'} hint={`In ${currency}${unit.trim() ? ` per ${unit.trim()}` : ''}`} describedBy={`${categoriesId}-price-intro`}>
            {(ids) => (
              <span className="relative block">
                <input name="unit_price" inputMode="decimal" maxLength={24} placeholder={entry?.unit_price != null ? 'Keep current price' : 'No price set'} aria-describedby={ids} className={clsx(fieldCls, 'num pr-9 text-right')} />
                <span aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-sm text-slate-600">{symbol}</span>
              </span>
            )}
          </EditorField>
          <EditorField label="Effective from" hint={`DD.MM.YYYY, for example ${today}`}>
            {(ids) => <input name="valid_from" inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" title={`DD.MM.YYYY, for example ${today}`} defaultValue={today} aria-describedby={ids} className={clsx(fieldCls, 'num')} />}
          </EditorField>
        </div>
      </section>
    </>
  )
}

function CompanyFields({ kind, entry }: { kind: CatalogueKind; entry: CatalogueEntry | null }) {
  return (
    <>
      {kind === 'subcontractors' && (
        <EditorField label="Trade">
          {(ids) => <input required name="trade" maxLength={120} defaultValue={entry?.trade} aria-describedby={ids} className={fieldCls} />}
        </EditorField>
      )}
      <EditorField label="Contact name">
        {(ids) => <input name="contact_name" autoComplete="off" maxLength={120} defaultValue={entry?.contact_name ?? ''} aria-describedby={ids} className={fieldCls} />}
      </EditorField>
      <div className="grid gap-4 sm:grid-cols-2">
        <EditorField label="Email">
          {(ids) => <input type="email" name="email" maxLength={254} defaultValue={entry?.email ?? ''} aria-describedby={ids} className={fieldCls} />}
        </EditorField>
        <EditorField label="Phone">
          {(ids) => <input type="tel" name="phone" maxLength={60} defaultValue={entry?.phone ?? ''} aria-describedby={ids} className={fieldCls} />}
        </EditorField>
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
  const errorId = useId()
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
  const nameRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)

  // the dialog focuses its first control (the close button, which stays first in the tab order); the name field
  // takes focus once the form is there, unless the user already tabbed or clicked somewhere themselves
  const moved = useRef(false)
  const focused = useRef(false)
  useEffect(() => {
    const mark = () => { moved.current = true }
    window.addEventListener('pointerdown', mark, true)
    window.addEventListener('keydown', mark, true)
    return () => {
      window.removeEventListener('pointerdown', mark, true)
      window.removeEventListener('keydown', mark, true)
    }
  }, [])
  useEffect(() => {
    if (!ready || focused.current) return
    // after the dialog's own initial focus (30 ms), so it doesn't take focus back to the close button
    const timer = setTimeout(() => {
      focused.current = true
      if (!moved.current) nameRef.current?.focus()
    }, 60)
    return () => clearTimeout(timer)
  }, [ready])

  // ⌘/Ctrl+Enter saves from anywhere in the dialog: any field, the supplier menu or the footer buttons
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
      const form = document.getElementById(formId)
      if (!(form instanceof HTMLFormElement)) return
      event.preventDefault()
      form.requestSubmit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [formId])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // a ref, not state: two quick submits in one frame would both still see saving === false
    if (submitting.current || !ready) return
    submitting.current = true
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
      submitting.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => { if (!saving) onClose() }}
      title={`${entry ? 'Edit' : 'Add'} ${CATALOGUES[kind].item}`}
      width={clsx(isProduct ? 'max-w-xl' : 'max-w-md', SHEET)}
      footer={<>
        <span className="mr-auto text-[13px] text-slate-500 max-sm:hidden"><kbd className={kbdCls}>{MOD_KEY}</kbd> <kbd className={kbdCls}>↵</kbd> to save</span>
        <Button size="lg" disabled={saving} onClick={onClose}>Cancel</Button>
        <Button size="lg" variant="primary" type="submit" form={formId} disabled={saving || !ready}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      {!ready ? (
        loadError ? <div role="alert" className="space-y-3 text-sm text-rose-800">
          <p>{loadError}</p>
          <Button size="sm" onClick={() => { setLoadError(''); setRetry((n) => n + 1) }}>Retry</Button>
        </div> : <p role="status" className="text-sm text-slate-600">Loading product details…</p>
      ) : (
        <ErrorId.Provider value={error ? errorId : undefined}>
          <form id={formId} onSubmit={submit} className="space-y-4">
            <EditorField label={isProduct ? 'Product name' : 'Company name'}>
              {(ids) => <input ref={nameRef} data-autofocus required name="name" maxLength={isProduct ? 300 : 160} defaultValue={current?.name} aria-describedby={ids} className={fieldCls} />}
            </EditorField>
            {isProduct && product
              ? <ProductFields options={product.options} entry={product.detail} />
              : <CompanyFields kind={kind} entry={entry} />}
            {error && <p id={errorId} role="alert" className="text-sm font-medium text-rose-800">{error}</p>}
          </form>
        </ErrorId.Provider>
      )}
    </Dialog>
  )
}
