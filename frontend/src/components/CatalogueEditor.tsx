import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { clsx } from 'clsx'
import { Button, Dialog, Icon, inputCls, Menu, toast, kbdCls } from './ui'
import { MOD_KEY } from '../lib/keys'
import {
  CATALOGUES, CATALOGUE_UNITS, catalogueErrorField, cataloguePriceSource, formatCataloguePrice, requestCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueKind, type ProductOptions,
} from '../lib/catalogues'

/** where the editor puts the cursor when it opens: the name (default) or the contact fields */
export type EditorFocus = 'contact'

/** placeholders one step darker than the shared field, so they keep 4.5:1 on the field fill; a server error rings it red */
const fieldCls = clsx(inputCls.replace('placeholder:text-slate-500', 'placeholder:text-slate-600'), 'aria-invalid:ring-2 aria-invalid:ring-rose-600')

/**
 * the dialog as a sheet that fits the visible viewport: only its body scrolls, and the footer with Save and Cancel
 * stays in view (above the home indicator on phones). Passed through Dialog's width, which lands on the panel.
 */
const SHEET = clsx(
  'flex max-h-[calc(100dvh-0.5rem)] flex-col sm:max-h-[calc(100dvh-2rem)]',
  '[&>div:nth-child(2)]:max-h-none [&>div:nth-child(2)]:min-h-0 [&>div:nth-child(2)]:flex-1 [&>div:nth-child(2)]:overscroll-contain',
  '[&>div:last-child]:shrink-0 max-sm:[&>div:last-child]:border-t max-sm:[&>div:last-child]:border-slate-200 max-sm:[&>div:last-child]:pt-3 max-sm:[&>div:last-child]:pb-[max(1rem,env(safe-area-inset-bottom))]',
)

/** the server's answer to the last save, and the field it is about when it names one */
type SaveError = { message: string; field?: string }
const SaveErrorContext = createContext<SaveError | null>(null)

/** what a control needs from its field: the ids that describe it, and whether the last save rejected it */
type ControlProps = { 'aria-describedby'?: string; 'aria-invalid'?: true }

/** a labelled field; its hint and, after a failed save, the server's message sit under it and describe the control */
function EditorField({ label, name, required, hint, describedBy, children }: {
  label: string
  /** the form field name, so a server error about it shows here */
  name: string
  required?: boolean
  hint?: string
  /** more ids that describe the control, such as a section's intro */
  describedBy?: string
  children: (control: ControlProps) => ReactNode
}) {
  const hintId = useId()
  const errorId = useId()
  const error = useContext(SaveErrorContext)
  const invalid = error?.field === name
  const ids = [describedBy, hint && hintId, invalid && errorId].filter(Boolean).join(' ') || undefined
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-slate-800">
        {label}{required && <span aria-hidden className="ml-0.5 text-rose-700">*</span>}
      </span>
      {children({ 'aria-describedby': ids, 'aria-invalid': invalid || undefined })}
      {invalid && (
        <span id={errorId} className="flex items-start gap-1.5 text-sm font-medium text-rose-800">
          <Icon name="error" size={16} className="mt-0.5 shrink-0" />{error.message}
        </span>
      )}
      {hint && <span id={hintId} className="block text-xs text-slate-600">{hint}</span>}
    </label>
  )
}

function ProductFields({ entry, options }: { entry: CatalogueEntry | null; options: ProductOptions }) {
  const ids = useId()
  const locked = entry?.review_status === 'approved'
  // dates are typed and shown the German way (21.11.2026); submit turns them back into ISO
  const [today] = useState(() => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()))
  const [supplierId, setSupplierId] = useState(entry?.supplier_id ?? '')
  const [unit, setUnit] = useState(entry?.unit ?? '')
  const [price, setPrice] = useState('')
  const suppliers = [
    ...(entry?.supplier_id && entry.supplier_archived_at ? [{ id: entry.supplier_id, name: `${entry.supplier} (archived)` }] : []),
    ...options.suppliers,
  ]
  const supplierName = suppliers.find((s) => s.id === supplierId)?.name
  const currency = entry?.currency ?? 'EUR'
  const symbol = currency === 'EUR' ? '€' : currency
  const stored = entry?.unit_price != null
  const perUnit = unit.trim() ? `per ${unit.trim()}` : undefined
  return (
    <>
      {/* what a price means comes first: the unit, then the price per unit and the date it applies from */}
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <EditorField label="Unit" name="unit" hint={locked ? 'Fixed for approved products' : undefined}>
          {(control) => <>
            <input name="unit" list={`${ids}-units`} disabled={locked} maxLength={64} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m², Stk, h…" autoComplete="off" {...control} className={fieldCls} />
            <datalist id={`${ids}-units`}>
              {CATALOGUE_UNITS.map((u) => <option key={u} value={u} />)}
            </datalist>
          </>}
        </EditorField>
        <EditorField label={stored ? 'New unit price' : 'Unit price'} name="unit_price" hint={perUnit} describedBy={stored ? `${ids}-current` : undefined}>
          {(control) => (
            <span className="relative block">
              <input name="unit_price" inputMode="decimal" maxLength={24} placeholder="0,00" value={price} onChange={(e) => setPrice(e.target.value)} {...control} className={clsx(fieldCls, 'num pr-9 text-right')} />
              <span aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-sm text-slate-600">{symbol}</span>
            </span>
          )}
        </EditorField>
        {/* asked for only once there is a new price to date */}
        {price.trim() && (
          <div className="sm:col-start-2">
            <EditorField label="Effective from" name="valid_from" required hint="DD.MM.YYYY">
              {(control) => <input required name="valid_from" inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" title="DD.MM.YYYY" defaultValue={today} {...control} className={clsx(fieldCls, 'num')} />}
            </EditorField>
          </div>
        )}
      </div>
      <input type="hidden" name="currency" value={currency} />
      {stored && (
        <p id={`${ids}-current`} className="text-sm text-slate-600">
          Current price <strong className="num font-semibold text-slate-900">{formatCataloguePrice(entry)}</strong>
          {entry.unit && ` per ${entry.unit}`}
          {cataloguePriceSource(entry) && <span className="num"> · {cataloguePriceSource(entry)}</span>}
          . Leave the new price blank to keep it.
        </p>
      )}
      <div className="space-y-4 border-t border-slate-200 pt-4">
        <EditorField label="Description" name="description" required>
          {(control) => <textarea required name="description" rows={4} maxLength={250000} defaultValue={entry?.description} {...control} className={`${fieldCls} h-auto resize-y py-2`} />}
        </EditorField>
        <div className="grid gap-4 sm:grid-cols-2">
          <EditorField label="Category" name="category" required>
            {(control) => <>
              <input required name="category" list={`${ids}-categories`} maxLength={160} defaultValue={entry?.category} {...control} className={fieldCls} />
              <datalist id={`${ids}-categories`}>
                {options.categories.map(({ name }) => <option key={name} value={name} />)}
              </datalist>
            </>}
          </EditorField>
          {/* the same field as Category, so both labels and controls share one baseline */}
          <EditorField label="Supplier" name="supplier_id" hint={locked ? 'Fixed for approved products' : undefined}>
            {(control) => <>
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
                  <button {...t} type="button" disabled={locked} aria-label={`Supplier: ${supplierName ?? 'No supplier'}`} {...control}
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
          <EditorField label="Supplier item code" name="sku">
            {(control) => <input name="sku" maxLength={160} defaultValue={entry?.sku ?? ''} {...control} className={fieldCls} />}
          </EditorField>
        </div>
      </div>
    </>
  )
}

function CompanyFields({ kind, entry, contactRef }: { kind: CatalogueKind; entry: CatalogueEntry | null; contactRef: Ref<HTMLInputElement> }) {
  return (
    <>
      {kind === 'subcontractors' && (
        <EditorField label="Trade" name="trade" required>
          {(control) => <input required name="trade" maxLength={120} defaultValue={entry?.trade} {...control} className={fieldCls} />}
        </EditorField>
      )}
      <EditorField label="Contact name" name="contact_name">
        {(control) => <input ref={contactRef} name="contact_name" autoComplete="off" maxLength={120} defaultValue={entry?.contact_name ?? ''} {...control} className={fieldCls} />}
      </EditorField>
      <div className="grid gap-4 sm:grid-cols-2">
        <EditorField label="Email" name="email">
          {(control) => <input type="email" name="email" maxLength={254} defaultValue={entry?.email ?? ''} {...control} className={fieldCls} />}
        </EditorField>
        <EditorField label="Phone" name="phone">
          {(control) => <input type="tel" name="phone" maxLength={60} defaultValue={entry?.phone ?? ''} {...control} className={fieldCls} />}
        </EditorField>
      </div>
    </>
  )
}

export function CatalogueEditor({ kind, entry, focus, onClose, onSaved }: {
  kind: CatalogueKind
  entry: CatalogueEntry | null
  focus?: EditorFocus
  onClose: () => void
  onSaved: () => void
}) {
  const formId = useId()
  const errorId = useId()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<SaveError | null>(null)
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
  const contactRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)

  // Dialog re-runs its focus effect whenever onClose changes, which sends focus back to its close button; a stable
  // callback keeps focus where the editor puts it (in a rejected field after a failed save, for one)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  const close = useCallback(() => { if (!submitting.current) onCloseRef.current() }, [])

  // the dialog focuses its first control (the close button, which stays first in the tab order); the name field
  // (or the contact fields, when the editor was opened to add them) takes focus once the form is there, unless the
  // user already tabbed or clicked somewhere themselves
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
      if (!moved.current) (focus === 'contact' && contactRef.current ? contactRef : nameRef).current?.focus()
    }, 60)
    return () => clearTimeout(timer)
  }, [ready, focus])

  // a failed save puts the cursor in the field the server rejected
  useEffect(() => {
    if (!error?.field) return
    document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [error, formId])

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
    setError(null)
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form))
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
      const message = (error as Error).message
      const field = catalogueErrorField(message)
      // beside its field when the form has that field, else under the form
      setError({ message, field: field && form.elements.namedItem(field) ? field : undefined })
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={close}
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
        <SaveErrorContext.Provider value={error}>
          <form id={formId} onSubmit={submit}
            // editing the rejected field clears its message
            onChange={(event) => { if (error?.field && (event.target as Element).getAttribute('name') === error.field) setError(null) }}
            className="space-y-4">
            <p className="text-xs text-slate-600"><span aria-hidden className="text-rose-700">*</span> Required</p>
            <EditorField label={isProduct ? 'Product name' : 'Company name'} name="name" required>
              {(control) => <input ref={nameRef} data-autofocus required name="name" maxLength={isProduct ? 300 : 160} defaultValue={current?.name} {...control} className={fieldCls} />}
            </EditorField>
            {isProduct && product
              ? <ProductFields options={product.options} entry={product.detail} />
              : <CompanyFields kind={kind} entry={entry} contactRef={contactRef} />}
            {error && !error.field && <p id={errorId} role="alert" className="text-sm font-medium text-rose-800">{error.message}</p>}
          </form>
        </SaveErrorContext.Provider>
      )}
    </Dialog>
  )
}
