import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { clsx } from 'clsx'
import { Button, Dialog, Icon, inputCls, Menu, toast, kbdCls } from './ui'
import { MOD_KEY } from '../lib/keys'
import {
  CATALOGUES, CATALOGUE_UNITS, catalogueAmount, catalogueDate, catalogueErrorField, cataloguePriceSource, isoFromGerman, isPriced, parseCataloguePrice, requestCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueKind, type ProductOptions,
} from '../lib/catalogues'

/** where the editor puts the cursor when it opens: the name (default), the contact fields or the unit price */
export type EditorFocus = 'contact' | 'price'

/** the app's one field style (a borderless well, ringed on hover and focus, red after a rejected save) */
const fieldCls = inputCls

/**
 * the dialog as a sheet that fits the visible viewport: only its body scrolls, and the footer with Save and Cancel
 * stays in view (above the home indicator on phones). Passed through Dialog's width, which lands on the panel.
 */
const SHEET = clsx(
  'flex max-h-[calc(100dvh-0.5rem)] flex-col sm:max-h-[calc(100dvh-2rem)]',
  // the first label sits close under the title instead of a 24px gap
  '[&>div:nth-child(2)]:max-h-none [&>div:nth-child(2)]:min-h-0 [&>div:nth-child(2)]:flex-1 [&>div:nth-child(2)]:overscroll-contain [&>div:nth-child(2)]:pt-1',
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

/** the trigger of a Menu drawn as a field, like a native select: the arrow keys open the list too */
function SelectButton({ t, control, disabled, label, value, placeholder, className }: {
  t: Parameters<Parameters<typeof Menu>[0]['trigger']>[0]
  control: ControlProps
  disabled?: boolean
  label: string
  value?: string
  placeholder: string
  className?: string
}) {
  return (
    <button {...t} type="button" disabled={disabled} aria-label={label} {...control}
      onKeyDown={(event) => {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !t['aria-expanded']) { event.preventDefault(); t.onClick() }
      }}
      className={clsx(fieldCls, 'flex h-10 items-center justify-between gap-2 text-left disabled:opacity-60', className)}>
      <span className={clsx('truncate', !value && 'text-slate-600')}>{value || placeholder}</span>
      <Icon name="expand_more" size={20} className="shrink-0 text-slate-600" />
    </button>
  )
}

/**
 * a picker of the usual values, drawn like a select (the unit, the category); the last item ("Other unit…",
 * "New category…") turns it into a text field for anything else. A stored value that is not in the list stays in
 * it, so editing never changes it by accident. A hidden input carries the value into the form.
 */
function ChoicePicker({ name, label, value, onChange, choices, none, other, maxLength, disabled, control }: {
  name: string
  /** the field's label, for the trigger and the text field */
  label: string
  value: string
  onChange: (value: string) => void
  choices: readonly string[]
  /** the empty choice ("No unit"); left out when a value is required */
  none?: string
  /** the menu item that switches to typing, the text field's placeholder, and the way back to the list */
  other: { item: string; placeholder: string; back: string }
  maxLength: number
  disabled?: boolean
  control: ControlProps
}) {
  const listed = choices.includes(value)
  const [typing, setTyping] = useState(false)
  // switching between the list and the text field keeps the cursor on the field, whichever control is showing
  const switched = useRef(false)
  const box = useRef<HTMLSpanElement>(null)
  const choose = (next: boolean) => { switched.current = true; setTyping(next) }
  useEffect(() => {
    if (!switched.current) return
    switched.current = false
    box.current?.querySelector<HTMLElement>(typing ? 'input:not([type=hidden])' : 'button')?.focus()
  }, [typing])
  const options = [...(value && !listed ? [value] : []), ...choices]
  const noun = label.toLowerCase()
  return (
    <span ref={box} className="block">
      <input type="hidden" name={name} value={value} />
      {typing ? (
        <span className="relative block">
          <input aria-label={label} maxLength={maxLength} value={value} onChange={(e) => onChange(e.target.value)} placeholder={other.placeholder} autoComplete="off"
            onKeyDown={(e) => { if (e.key === 'Escape' && value === '') { e.stopPropagation(); choose(false) } }}
            {...control} className={clsx(fieldCls, 'pr-11')} />
          <button type="button" onClick={() => choose(false)} aria-label={other.back} title={other.back}
            className="absolute top-0 right-0 bottom-0 flex w-10 items-center justify-center rounded-r-md text-slate-600 hover:bg-slate-200 hover:text-slate-900">
            <Icon name="list" size={20} />
          </button>
        </span>
      ) : (
        <Menu
          label={`Choose a ${noun}`}
          align="start"
          width={options.some((o) => o.length > 16) ? 'w-72' : 'w-48'}
          items={[
            ...(none ? [{ label: none, checked: !value, onSelect: () => onChange('') }, 'sep' as const] : []),
            ...options.map((option) => ({ label: option, checked: value === option, onSelect: () => onChange(option) })),
            'sep' as const,
            { label: other.item, icon: 'edit', onSelect: () => choose(true) },
          ]}
          trigger={(t) => <SelectButton t={t} control={control} disabled={disabled} label={`${label}: ${value || none || 'none chosen'}`} value={value} placeholder={none ?? `Choose a ${noun}`} />}
        />
      )}
    </span>
  )
}

/** the price being typed, kept by the editor so the footer can preview a revised price beside Save */
type PriceDraft = { price: string; from: string; unit?: string }

/** today the German way (21.11.2026), as the effective date starts out */
const germanToday = () => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date())

/** what a revised price will do, for the hint under Effective from: when it applies and what shows until then */
function effectHint(draft: PriceDraft, entry: CatalogueEntry | null) {
  const iso = isoFromGerman(draft.from)
  if (!iso) return 'Use DD.MM.YYYY'
  const now = isoFromGerman(germanToday())!
  const current = entry && isPriced(entry) ? catalogueAmount(entry.unit_price!, entry.currency!, entry.unit) : null
  if (iso > now) return current ? `Until then the catalogue shows ${current}.` : 'Until then the product stays not priced.'
  if (current && entry?.valid_from && iso < entry.valid_from) return `Older than the current price, so the catalogue keeps ${current}.`
  return current ? `Replaces ${current} from today.` : 'The catalogue shows it from today.'
}

function ProductFields({ entry, options, priceRef, draft, onDraft, onPicked }: {
  entry: CatalogueEntry | null
  options: ProductOptions
  priceRef: Ref<HTMLInputElement>
  draft: PriceDraft
  onDraft: (draft: PriceDraft) => void
  /** a picker changed its field (pickers fire no change event), so a message about that field can go */
  onPicked: (name: string) => void
}) {
  const ids = useId()
  const locked = entry?.review_status === 'approved'
  const [supplierId, setSupplierId] = useState(entry?.supplier_id ?? '')
  const [category, setCategory] = useState(entry?.category ?? '')
  const unit = draft.unit ?? entry?.unit ?? ''
  const suppliers = [
    ...(entry?.supplier_id && entry.supplier_archived_at ? [{ id: entry.supplier_id, name: `${entry.supplier} (archived)` }] : []),
    ...options.suppliers,
  ]
  const supplierName = suppliers.find((s) => s.id === supplierId)?.name
  const currency = entry?.currency ?? 'EUR'
  const symbol = currency === 'EUR' ? '€' : currency
  const stored = entry?.unit_price != null
  const perUnit = unit.trim()
  // the price field's suffix says what the number is: "€" until there is a unit, then "€ / m²"
  const suffix = perUnit ? `${symbol} / ${perUnit}` : symbol
  // the currency spelled out for screen readers ("in euros per m²"), where the visible suffix is only a symbol
  const currencyName = currency === 'EUR' ? 'euros' : (new Intl.DisplayNames('en', { type: 'currency' }).of(currency) ?? currency)
  const dated = !!draft.price.trim()
  return (
    <>
      {/* three lines to start, growing with the text up to a scroll */}
      <EditorField label="Description" name="description" required>
        {(control) => <textarea required name="description" rows={3} maxLength={250000} defaultValue={entry?.description} {...control} className={clsx(fieldCls, 'h-auto max-h-72 min-h-[calc(3lh+1rem)] resize-y py-2 [field-sizing:content]')} />}
      </EditorField>
      {/* a choice of the catalogue's categories, like the unit and the supplier; a new one can still be typed */}
      <EditorField label="Category" name="category" required>
        {(control) => (
          <ChoicePicker name="category" label="Category" value={category} onChange={(next) => { setCategory(next); onPicked('category') }} choices={options.categories.map(({ name }) => name)}
            other={{ item: 'New category…', placeholder: 'Type a new category', back: 'Choose an existing category' }} maxLength={160} control={control} />
        )}
      </EditorField>
      {/* what it is, above; what it costs and who sells it, below the one rule */}
      <div className="space-y-4 border-t border-slate-200 pt-4">
        {/* the unit, then the price per unit and the date it applies from */}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <EditorField label="Unit" name="unit" hint={locked ? 'Fixed for approved products' : undefined}>
            {(control) => (
              <ChoicePicker name="unit" label="Unit" value={unit} onChange={(next) => { onDraft({ ...draft, unit: next }); onPicked('unit') }} choices={CATALOGUE_UNITS} none="No unit"
                other={{ item: 'Other unit…', placeholder: 'Type a unit', back: 'Choose from the usual units' }} maxLength={64} disabled={locked} control={control} />
            )}
          </EditorField>
          {/* blank means not priced (or, with a stored price, keep it); the hint says so instead of a 0,00 that reads like a price */}
          <EditorField label={stored ? 'New unit price' : 'Unit price'} name="unit_price" hint={stored ? 'Leave blank to keep the current price' : 'Leave blank if not priced'}
            describedBy={[`${ids}-per`, stored && `${ids}-current`].filter(Boolean).join(' ')}>
            {(control) => (
              <span className="relative block">
                <input ref={priceRef} name="unit_price" inputMode="decimal" maxLength={24} value={draft.price} onChange={(e) => onDraft({ ...draft, price: e.target.value })} {...control}
                  style={{ paddingRight: `calc(${Math.min(suffix.length, 14)}ch + 1.25rem)` }}
                  className={clsx(fieldCls, 'num text-right')} />
                <span aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 max-w-[60%] -translate-y-1/2 truncate text-sm text-slate-600">{suffix}</span>
                <span id={`${ids}-per`} hidden>{perUnit ? `in ${currencyName} per ${perUnit}` : `in ${currencyName}`}</span>
              </span>
            )}
          </EditorField>
          {/* asked for only once there is a new price to date; the hint says when it applies and what shows until then */}
          {dated && (
            <div className="sm:col-start-2">
              <EditorField label="Effective from" name="valid_from" required hint={effectHint(draft, entry)}>
                {(control) => <input required name="valid_from" inputMode="numeric" pattern="\d{1,2}\.\d{1,2}\.\d{4}" title="DD.MM.YYYY" value={draft.from} onChange={(e) => onDraft({ ...draft, from: e.target.value })} {...control} className={clsx(fieldCls, 'num')} />}
              </EditorField>
            </div>
          )}
        </div>
        <input type="hidden" name="currency" value={currency} />
        <span role="status" className="sr-only">{dated ? 'Effective from is now required, after the price.' : ''}</span>
        {stored && (
          <p id={`${ids}-current`} className="text-sm text-slate-600">
            Current price <strong className="num font-semibold text-slate-900">{catalogueAmount(entry.unit_price!, currency, entry.unit)}</strong>
            {cataloguePriceSource(entry) && <span className="num"> · {cataloguePriceSource(entry)}</span>}
          </p>
        )}
        {/* who sells it and under which code, side by side */}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <EditorField label="Supplier" name="supplier_id" hint={locked ? 'Fixed for approved products' : undefined}>
            {(control) => <>
              <input type="hidden" name="supplier_id" value={supplierId} />
              <Menu
                label="Choose a supplier"
                align="start"
                width="w-64"
                items={[
                  { label: 'No supplier', checked: !supplierId, onSelect: () => { setSupplierId(''); onPicked('supplier_id') } },
                  ...(suppliers.length ? ['sep' as const] : []),
                  ...suppliers.map(({ id, name }) => ({ label: name, checked: supplierId === id, onSelect: () => { setSupplierId(id); onPicked('supplier_id') } })),
                ]}
                trigger={(t) => <SelectButton t={t} control={control} disabled={locked} label={`Supplier: ${supplierName ?? 'No supplier'}`} value={supplierName} placeholder="No supplier" />}
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
  const [draft, setDraft] = useState<PriceDraft>(() => ({ price: '', from: germanToday() }))
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
  const priceRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)

  // Dialog re-runs its focus effect whenever onClose changes, which sends focus back to its close button; a stable
  // callback keeps focus where the editor puts it (in a rejected field after a failed save, for one)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // closing with edits asks first. Escape, Cancel, the close button and a backdrop click all come through close():
  // an untouched form closes at once; a changed one turns the footer into "Discard your changes?"
  const [confirming, setConfirming] = useState(false)
  const confirmingRef = useRef(false)
  useEffect(() => { confirmingRef.current = confirming }, [confirming])
  const snapshot = useRef<string | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const formState = useCallback(() => {
    const form = document.getElementById(formId)
    return form instanceof HTMLFormElement ? JSON.stringify([...new FormData(form).entries()].map(([k, v]) => [k, String(v)])) : null
  }, [formId])
  // what the form held when it opened, to tell a changed form from an untouched one
  useEffect(() => { if (ready && snapshot.current === null) snapshot.current = formState() }, [ready, formState])
  // Escape inside an open menu (the unit or supplier list) only closes that menu; the shared Menu lets it bubble on
  // to the dialog, so note it in the capture phase and let close() skip it
  const menuEscape = useRef(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !(event.target instanceof Element) || !event.target.closest('[role=menu]')) return
      menuEscape.current = true
      setTimeout(() => { menuEscape.current = false })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const keepEditing = useCallback(() => {
    setConfirming(false)
    const target = returnFocus.current
    setTimeout(() => (target?.isConnected ? target : document.getElementById(formId)?.querySelector<HTMLElement>('input:not([type=hidden]), textarea'))?.focus())
  }, [formId])
  const close = useCallback(() => {
    if (submitting.current || menuEscape.current) return
    // Escape (or the backdrop) while asking means keep editing
    if (confirmingRef.current) { keepEditing(); return }
    const now = formState()
    if (snapshot.current !== null && now !== null && now !== snapshot.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setConfirming(true)
      return
    }
    onCloseRef.current()
  }, [formState, keepEditing])
  useEffect(() => { if (confirming) keepRef.current?.focus() }, [confirming])

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
      if (moved.current) return
      const target = focus === 'contact' ? contactRef.current : focus === 'price' ? priceRef.current : null
      ;(target ?? nameRef.current)?.focus()
    }, 60)
    return () => clearTimeout(timer)
  }, [ready, focus])

  // a failed save puts the cursor in the field the server rejected
  useEffect(() => {
    if (!error?.field) return
    document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [error, formId])

  // ⌘/Ctrl+Enter saves from anywhere in the dialog: any field, the supplier menu or the footer buttons; never while
  // the footer asks whether to discard
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
      const form = document.getElementById(formId)
      if (!(form instanceof HTMLFormElement)) return
      event.preventDefault()
      if (confirmingRef.current) return
      form.requestSubmit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [formId])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // a ref, not state: two quick submits in one frame would both still see saving === false
    if (submitting.current || !ready || confirmingRef.current) return
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form))
    // the category is a picker, which the browser's required check can't see
    if (isProduct && !String(values.category ?? '').trim()) {
      setError({ message: 'Choose a category.', field: 'category' })
      return
    }
    submitting.current = true
    setSaving(true)
    setError(null)
    const iso = typeof values.valid_from === 'string' && isoFromGerman(values.valid_from)
    if (iso) values.valid_from = iso
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

  // revising a stored price: the old and the new price per unit and the date, beside Save
  const detail = product?.detail
  const newPrice = parseCataloguePrice(draft.price)
  const newFrom = isoFromGerman(draft.from)
  const revision = isProduct && detail && isPriced(detail) && newPrice != null && newFrom ? {
    from: catalogueAmount(detail.unit_price!, detail.currency!, detail.unit),
    to: catalogueAmount(newPrice, detail.currency!, draft.unit ?? detail.unit),
    on: catalogueDate(newFrom),
  } : null

  return (
    <Dialog
      open
      onClose={close}
      title={`${entry ? 'Edit' : 'Add'} ${CATALOGUES[kind].item}`}
      width={clsx(isProduct ? 'max-w-xl' : 'max-w-md', SHEET)}
      footerOnly={confirming}
      footer={confirming ? (
        // the question is its own alert dialog: the form behind it is out of reach until Keep editing or Discard
        <div role="alertdialog" aria-modal="true" aria-labelledby={`${formId}-discard`} className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <span id={`${formId}-discard`} className="mr-auto text-sm font-semibold text-slate-900">Discard your changes?</span>
          <Button ref={keepRef} size="lg" onClick={keepEditing}>Keep editing</Button>
          <Button size="lg" variant="danger" onClick={() => onCloseRef.current()}>Discard</Button>
        </div>
      ) : <>
        {revision ? (
          <p className="num mr-auto min-w-0 text-[13px] leading-snug text-slate-600">
            <span className="line-through decoration-slate-400">{revision.from}</span>
            <Icon name="arrow_forward" size={14} className="mx-1 align-[-2px]" />
            <span className="sr-only"> becomes </span>
            <strong className="font-semibold text-slate-900">{revision.to}</strong>
            <span className="whitespace-nowrap"> from {revision.on}</span>
          </p>
        ) : (
          // the legend for the asterisks, then the save shortcut, so neither takes a row of the form
          <span className="mr-auto flex items-center gap-3 text-[13px] text-slate-600">
            <span><span aria-hidden className="text-rose-700">*</span> Required</span>
            <span className="max-sm:hidden"><kbd className={kbdCls}>{MOD_KEY}</kbd> <kbd className={kbdCls}>↵</kbd> to save</span>
          </span>
        )}
        <Button size="lg" disabled={saving} onClick={close}>Cancel</Button>
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
            <EditorField label={isProduct ? 'Product name' : 'Company name'} name="name" required>
              {(control) => <input ref={nameRef} data-autofocus required name="name" maxLength={isProduct ? 300 : 160} defaultValue={current?.name} {...control} className={fieldCls} />}
            </EditorField>
            {isProduct && product
              ? <ProductFields options={product.options} entry={product.detail} priceRef={priceRef} draft={draft} onDraft={setDraft}
                onPicked={(name) => setError((shown) => (shown?.field === name ? null : shown))} />
              : <CompanyFields kind={kind} entry={entry} contactRef={contactRef} />}
            {error && !error.field && <p id={errorId} role="alert" className="text-sm font-medium text-rose-800">{error.message}</p>}
          </form>
        </SaveErrorContext.Provider>
      )}
    </Dialog>
  )
}
