import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CatalogueEditor, type EditorFocus } from '../components/CatalogueEditor'
import { Skeleton } from '../components/Page'
import { Chips, EmptyState, Kbd, MetaLink, PageFrame, PageHeader, RowList, RowMenu, ToolButton } from '../components/Kit'
import { Button, Dialog, Icon, inputCls, kbdCls, Menu, toast } from '../components/ui'
import { raisedCls } from '../lib/cls'
import { int, plural } from '../lib/format'
import {
  CATALOGUES, CATALOGUE_PAGE_SIZE, CATALOGUE_SCAN_PAGES, catalogueDate, cataloguePriceSource, formatCataloguePrice, isPriced, scanCatalogue, writeCatalogue,
  type CatalogueEntry, type CatalogueFilters, type CatalogueKind,
} from '../lib/catalogues'

const SUBTITLE: Record<CatalogueKind, string> = {
  products: 'Items and prices you quote from',
  suppliers: 'Companies you buy materials from',
  subcontractors: 'Companies you hire for trades',
}
const EMPTY_TEXT: Record<CatalogueKind, string> = {
  products: 'Add the items you buy often with their unit prices, so positions can be priced from them.',
  suppliers: 'Add the companies you buy from. Products can then be linked to a supplier.',
  subcontractors: 'Add each company with its trade, contact details and billing address.',
}

type PriceFilter = 'all' | 'priced' | 'unpriced'

/** every row of a result, with the filters it was read for, so it can stay on screen while the next one loads */
type Scan = { key: string; filters: CatalogueFilters; rows: CatalogueEntry[]; done: boolean; capped: boolean; error?: string }

/** price coverage is only worked out for suppliers with up to this many products (it reads all of their pages) */
const COVERAGE_LIMIT = 500

/** what a supplier's products say about it: how many are priced, the newest price date (ISO) and what it sells most */
type Coverage = { priced: number; latest?: string; categories: string[] }

/** products get a package, so the catalogue never borrows the archive box that means "Archived" */
const catalogueIcon = (kind: CatalogueKind) => (kind === 'products' ? 'package_2' : CATALOGUES[kind].icon)

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const familyKey = (entry: CatalogueEntry) => `${squash(entry.name).toLowerCase()}|${squash(entry.category ?? '').toLowerCase()}`

/**
 * what tells a same-named product apart: a detail for line two (none for the price, which the row already shows), or,
 * when nothing differs, its place among the duplicates
 */
type Tag = { text?: string; label: string; duplicate?: boolean }

/**
 * products that share a name and category get the first detail that differs between all of them: item code,
 * supplier, unit, price or price source. When nothing does, they really are duplicates, and they collapse into one
 * row that says how many there are.
 */
function discriminators(entries: CatalogueEntry[]) {
  const groups = new Map<string, CatalogueEntry[]>()
  for (const entry of entries) groups.set(familyKey(entry), [...(groups.get(familyKey(entry)) ?? []), entry])
  const candidates: ((entry: CatalogueEntry) => (Tag & { value: string }) | null)[] = [
    (e) => (e.sku ? { value: e.sku, text: `Item code ${e.sku}`, label: `item code ${e.sku}` } : null),
    (e) => (e.supplier ? { value: e.supplier, text: e.supplier, label: `from ${e.supplier}` } : null),
    (e) => (e.unit ? { value: e.unit, text: e.unit, label: `per ${e.unit}` } : null),
    (e) => {
      const price = isPriced(e) ? formatCataloguePrice(e) : 'not priced'
      return { value: price, label: isPriced(e) ? `at ${price}` : price }
    },
    (e) => (e.valid_from ? { value: cataloguePriceSource(e), text: cataloguePriceSource(e), label: `price from ${cataloguePriceSource(e)}` } : null),
  ]
  const tags = new Map<string, Tag>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const pick = candidates.find((candidate) => {
      const values = group.map((entry) => candidate(entry)?.value)
      return values.every(Boolean) && new Set(values).size === group.length
    })
    group.forEach((entry, i) => {
      const found = pick?.(entry)
      tags.set(entry.id, found ? { text: found.text, label: found.label } : { label: `duplicate ${int(i + 1)} of ${int(group.length)}`, duplicate: true })
    })
  }
  return tags
}

/** one row of the list: a product or company, or a family of identical products that opens to show each of them */
type Item = { key: string; entries: CatalogueEntry[] }

/** identical products (same name and category, nothing else to tell them apart) take one row until it is opened */
function collapse(rows: CatalogueEntry[], tags: Map<string, Tag>) {
  const items: Item[] = []
  const families = new Map<string, Item>()
  for (const entry of rows) {
    if (!tags.get(entry.id)?.duplicate) { items.push({ key: entry.id, entries: [entry] }); continue }
    const family = families.get(familyKey(entry))
    if (family) family.entries.push(entry)
    else {
      const fresh = { key: `family-${entry.id}`, entries: [entry] }
      families.set(familyKey(entry), fresh)
      items.push(fresh)
    }
  }
  return items
}

/**
 * pages of up to CATALOGUE_PAGE_SIZE entries that never split a family, with the entry numbers each page covers, so
 * "1–48 of 1.311" still counts products
 */
function paginate(items: Item[]) {
  const pages: { from: number; to: number; first: number; last: number }[] = []
  let from = 0
  let count = 0
  let seen = 0
  items.forEach((item, i) => {
    if (count > 0 && count + item.entries.length > CATALOGUE_PAGE_SIZE) {
      pages.push({ from, to: i, first: seen - count + 1, last: seen })
      from = i
      count = 0
    }
    count += item.entries.length
    seen += item.entries.length
  })
  if (count) pages.push({ from, to: items.length, first: seen - count + 1, last: seen })
  return pages
}

/** the second line of a product row: only the details that exist, so empty columns never become a wall of dashes */
function productDetails(entry: CatalogueEntry) {
  // a priced row says its unit beside the price ("per m²"), so line two leaves it out
  const parts = [entry.category, !isPriced(entry) && entry.unit, entry.sku && `Item code ${entry.sku}`, entry.supplier].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'No supplier or item code yet'
}

/**
 * a fixed actions gutter, as on the project rows (Kit's Row): the ⋯ shows in it on hover or focus and nothing moves.
 * Where the page has a wide margin (≥1400px) the gutter sits outside the content edge, so figures end on that edge.
 */
const GUTTER = 'sm:max-[1399px]:[@media(hover:hover)]:pr-[60px] min-[1400px]:[@media(hover:hover)]:-mr-10 min-[1400px]:[@media(hover:hover)]:pr-[52px]'
const MENU_OVERLAY = 'relative z-10 -my-1.5 -mr-1 transition-opacity sm:my-0 [@media(hover:hover)]:absolute [@media(hover:hover)]:top-1/2 [@media(hover:hover)]:right-1 [@media(hover:hover)]:my-0 [@media(hover:hover)]:mr-0 [@media(hover:hover)]:-translate-y-1/2 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:has-[[aria-expanded=true]]:opacity-100 sm:[@media(hover:hover)]:right-2 min-[1400px]:[@media(hover:hover)]:right-1.5'
const ROW = clsx('group relative flex items-start gap-3 rounded-lg px-2 py-2 transition-colors sm:items-center sm:gap-4 sm:px-3', GUTTER)
const rowTone = (incomplete: boolean) => incomplete ? 'bg-amber-50 hover:bg-amber-100' : 'hover:bg-slate-100'
const GRID = 'pointer-events-none relative grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6'
const NAME = 'line-clamp-2 min-w-0 text-[15px] leading-snug font-semibold break-normal hyphens-auto text-slate-900'
/** line two wraps (to two lines) instead of cutting off a supplier or item code; the figures beside it never squeeze */
const DETAILS = 'col-span-2 row-start-2 line-clamp-2 min-w-0 text-sm break-words text-slate-600 sm:col-span-1 sm:col-start-1'
const AMOUNT = 'num col-start-1 row-start-3 text-[15px] leading-snug font-semibold whitespace-nowrap text-slate-900 sm:col-start-2 sm:row-start-1 sm:text-right'
const META = 'col-start-2 row-start-3 flex min-w-0 justify-end whitespace-nowrap sm:row-start-2'

type RowActions = {
  onEdit: (entry: CatalogueEntry, focus?: EditorFocus) => void
  onArchive: (entry: CatalogueEntry) => void
  onRestore: (entry: CatalogueEntry) => void
}

function CatalogueWarning({ label, onClick, actionLabel }: { label: string; onClick?: () => void; actionLabel?: string }) {
  const content = <><Icon name="warning" size={16} className="shrink-0" /><span>{label}</span></>
  const style = 'inline-flex items-center gap-1 text-left text-sm font-semibold whitespace-normal text-amber-900'
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={actionLabel}
      className={clsx(style, 'pointer-events-auto relative z-10 rounded-sm underline-offset-4 after:absolute after:-inset-y-2 after:inset-x-0 after:content-[\'\'] hover:underline focus-visible:underline')}>
      {content}
    </button>
  ) : <span className={style}>{content}</span>
}

function EntryRow({ kind, entry, tag, known, ordinal, onEdit, onArchive, onRestore }: RowActions & {
  kind: CatalogueKind
  entry: CatalogueEntry
  tag?: Tag
  /** a supplier's price coverage, once known */
  known?: Coverage
  /** its place in an opened family of identical products */
  ordinal?: { n: number; of: number }
}) {
  const navigate = useNavigate()
  const ids = useId()
  const { item } = CATALOGUES[kind]
  const archived = !!entry.archived_at
  // a detail that tells same-named rows apart joins the name; a duplicate says which one it is
  const name = ordinal ? `${entry.name}, entry ${ordinal.n} of ${ordinal.of}` : tag && !tag.duplicate ? `${entry.name} (${tag.label})` : entry.name
  const products = kind === 'suppliers' ? entry.product_count ?? 0 : 0
  // the name travels along so the Products filter chip can say whose products these are (a new tab finds it in the rows)
  const productsLink = `/catalogues/products?supplier=${encodeURIComponent(entry.id)}`
  const descriptionId = `${ids}-description`
  const metaId = `${ids}-meta`
  const missingPrice = kind === 'products' && !isPriced(entry)
  const missingContact = kind === 'subcontractors' && (!entry.contact_name?.trim() || !(entry.email?.trim() || entry.phone?.trim()))
  const missingBilling = kind === 'subcontractors' && !entry.billing_address?.trim()
  const warning = missingPrice ? 'Missing price'
    : missingContact && missingBilling ? 'Missing contact and billing info'
    : missingContact ? 'Missing contact info'
    : missingBilling ? 'Missing billing address' : ''
  const warningFocus = missingPrice ? 'price' : missingContact ? 'contact' : 'billing'

  // what the row shows besides the name, for the row's own button
  let description = ''
  let subtitle: ReactNode = null
  let amount: ReactNode = null
  let meta: ReactNode = null

  if (kind === 'products') {
    if (!ordinal) {
      const line = productDetails(entry)
      const extra = tag?.duplicate ? tag.label.replace(/^d/, 'D') : tag?.text
      subtitle = extra && !line.split(' · ').includes(extra) ? `${line} · ${extra}` : line
    }
    const priceText = missingPrice ? warning : [formatCataloguePrice(entry), entry.unit && `per ${entry.unit}`].filter(Boolean).join(' ')
    description = [priceText, !ordinal && tag?.duplicate && tag.label.replace(/^d/, 'D')].filter(Boolean).join('. ')
    if (!missingPrice) {
      amount = formatCataloguePrice(entry)
      const source = [entry.unit && `per ${entry.unit}`, cataloguePriceSource(entry)].filter(Boolean).join(' · ')
      if (source) meta = <span className="text-sm text-slate-600">{source}</span>
    }
  } else {
    const shown = [kind === 'subcontractors' ? entry.trade : null, entry.contact_name, entry.email, entry.phone].filter(Boolean)
    const contact = entry.contact_name || entry.email || entry.phone
    const contactLine = kind === 'subcontractors' || contact || archived ? (shown.join(' · ') || 'No contact details') : (
      <>
        {shown.length > 0 && `${shown.join(' · ')} · `}
        {/* above the row's own button, so it opens the editor at the contact fields */}
        <button
          type="button"
          onClick={() => onEdit(entry, 'contact')}
          className="pointer-events-auto relative z-10 font-medium text-brand-700 underline-offset-2 after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:underline"
        >
          Add contact details<span className="sr-only"> for {entry.name}</span>
        </button>
      </>
    )
    // what a supplier sells, from its products, above who to call
    const sells = known?.categories.length ? known.categories.join(' · ') : ''
    subtitle = sells ? <><span className="block truncate">{sells}</span><span className="block">{contactLine}</span></> : contactLine

    let coverage = ''
    if (kind === 'suppliers' && products && !archived) {
      if (known) coverage = `${int(known.priced)} of ${int(products)} priced${known.latest ? ` · Latest price ${catalogueDate(known.latest)}` : ''}`
      else if (products > COVERAGE_LIMIT) coverage = 'Price coverage unavailable'
    }
    description = [sells && `Sells ${sells.replaceAll(' · ', ', ')}`, shown.join(', '), warning || (!contact && 'No contact details'), products && plural(products, 'product', 'products'), coverage].filter(Boolean).join('. ')

    if (kind === 'suppliers') {
      const figure = plural(products, 'product', 'products')
      amount = products && !archived ? (
        // a real link to the supplier's products (so it opens in a new tab and can be shared), with a chevron that
        // says so at rest; its description carries the price coverage
        <Link to={productsLink} state={{ supplierName: entry.name }} aria-describedby={coverage ? metaId : undefined}
          className="pointer-events-auto relative z-10 inline-flex items-center gap-0.5 rounded-sm text-slate-900 decoration-slate-500 underline-offset-4 after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:underline focus-visible:underline">
          <span className="sr-only">View </span>{figure}<span className="sr-only"> from {entry.name}</span>
          <Icon name="chevron_right" size={18} className="-mr-1 text-slate-600" />
        </Link>
      ) : <span className="text-sm font-normal text-slate-600">{figure}</span>
      if (coverage) meta = <span id={metaId} className="num text-sm text-slate-600">{coverage}</span>
    }
  }

  if (warning) {
    amount = <CatalogueWarning label={warning} onClick={archived ? undefined : () => onEdit(entry, warningFocus)}
      actionLabel={missingPrice ? `Missing price. Set price for ${name}` : `${warning}. Edit ${name}`} />
  }

  const menu = (
    <RowMenu
      label={`More actions for ${name}`}
      items={archived ? [
        { label: 'Restore', icon: 'restore', onSelect: () => onRestore(entry) },
      ] : [
        { label: `Edit ${item}`, icon: 'edit', onSelect: () => onEdit(entry) },
        ...(products ? [{ label: `View ${plural(products, 'product', 'products')}`, icon: 'package_2', onSelect: () => navigate(productsLink, { state: { supplierName: entry.name } }) }] : []),
        'sep' as const,
        { label: 'Archive', icon: 'archive', danger: true, onSelect: () => onArchive(entry) },
      ]}
    />
  )
  return (
    <div data-row="catalogue" className={clsx(ROW, rowTone(!!warning))}>
      <button
        type="button"
        data-nav
        aria-label={archived ? `Restore ${item} ${name}` : `Edit ${item} ${name}`}
        aria-describedby={descriptionId}
        onClick={() => (archived ? onRestore(entry) : onEdit(entry))}
        className="absolute inset-0 z-0 rounded-lg"
      />
      {/* names lead: no icon tile, since it would be the same on every row */}
      <div className={GRID}>
        <span lang={ordinal ? undefined : 'de'} className={clsx('col-span-2 row-start-1 sm:col-span-1', ordinal ? 'text-sm font-medium text-slate-800' : NAME)}>
          {ordinal ? `Entry ${ordinal.n} of ${ordinal.of}` : entry.name}
        </span>
        {subtitle != null && <span className={DETAILS}>{subtitle}</span>}
        {amount != null && <div className={clsx(AMOUNT, warning && 'col-span-2 sm:col-span-1')}>{amount}</div>}
        {meta != null && <div className={META}>{meta}</div>}
      </div>
      <span id={descriptionId} hidden>{description}</span>
      <div className={MENU_OVERLAY}>{menu}</div>
    </div>
  )
}

/** identical products as one row ("3 duplicate entries"); opening it lists each one, to price, edit or archive */
function FamilyRow({ entries, actions }: { entries: CatalogueEntry[]; actions: RowActions }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const [first] = entries
  const count = entries.length
  const priced = entries.filter(isPriced)
  const missing = count - priced.length
  const warning = missing === count ? 'Missing price' : `${int(missing)} missing a price`
  const prices = [...new Set(priced.map(formatCataloguePrice))]
  const lowest = priced.length ? priced.reduce((a, b) => (Number(b.unit_price) < Number(a.unit_price) ? b : a)) : null
  return (
    <div>
      <div data-row="catalogue" className={clsx(ROW, rowTone(missing > 0))}>
        <button type="button" data-nav aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}
          aria-label={`${first.name}, ${count} duplicate entries${missing ? `, ${warning.toLowerCase()}` : ''}`}
          className="absolute inset-0 z-0 rounded-lg" />
        <div className={GRID}>
          <span lang="de" className={clsx('col-span-2 row-start-1 sm:col-span-1', NAME)}>{first.name}</span>
          <span className={DETAILS}>
            {productDetails(first)} · <span className="font-medium text-slate-700">{count} duplicate entries</span>
            <Icon name="expand_more" size={18} className={clsx('ml-0.5 align-[-4px] text-slate-600 transition-transform', open && 'rotate-180')} />
          </span>
          {lowest && <div className={AMOUNT}>{prices.length > 1 && <span className="text-sm font-normal text-slate-600">from </span>}{formatCataloguePrice(lowest)}</div>}
          {missing > 0 && <div className={lowest ? META : AMOUNT}><CatalogueWarning label={warning} /></div>}
        </div>
      </div>
      {open && (
        <div id={listId} role="group" aria-label={`${first.name}, duplicate entries`} className="mb-1 ml-3 border-l-2 border-slate-200 pl-1 sm:ml-4">
          {entries.map((entry, i) => <EntryRow key={entry.id} kind="products" entry={entry} ordinal={{ n: i + 1, of: count }} {...actions} />)}
        </div>
      )}
    </div>
  )
}

function CatalogueRows({ kind, items, tags, coverage, ...actions }: RowActions & {
  kind: CatalogueKind
  /** the rows on this page */
  items: Item[]
  /** what tells same-named products apart, worked out over the whole result */
  tags: Map<string, Tag>
  /** price coverage per supplier id, once known */
  coverage: Record<string, Coverage>
}) {
  return (
    <RowList>
      {items.map((it) => (it.entries.length > 1
        ? <FamilyRow key={it.key} entries={it.entries} actions={actions} />
        : <EntryRow key={it.key} kind={kind} entry={it.entries[0]} tag={tags.get(it.entries[0].id)} known={coverage[it.entries[0].id]} {...actions} />))}
    </RowList>
  )
}

/**
 * the range with Previous and Next ("1–50 ‹ ›"). Beside the result count it leaves the total to the count; under the
 * rows it says "1–50 of 1.311". The total is left out until every page is read; past the scan limit it reads "5.000+".
 */
function Pager({ page, first, last, total, done, capped, lastPage, withTotal, onPage }: {
  page: number; first: number; last: number; total: number; done: boolean; capped: boolean; lastPage: number; withTotal?: boolean; onPage: (page: number) => void
}) {
  const arrow = 'flex size-10 items-center justify-center rounded-md text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:pointer-events-none disabled:text-slate-400'
  return (
    <div className="flex items-center gap-1 text-sm text-slate-600">
      <span className="num mr-1 whitespace-nowrap">
        {int(first)}–{int(last)}{withTotal && done && <> of {int(total)}{capped && '+'}</>}
      </span>
      <button type="button" aria-label="Previous page" title="Previous page" disabled={page === 1} onClick={() => onPage(page - 1)} className={arrow}>
        <Icon name="chevron_left" size={22} />
      </button>
      <button type="button" aria-label="Next page" title="Next page" disabled={done && page >= lastPage} onClick={() => onPage(page + 1)} className={arrow}>
        <Icon name="chevron_right" size={22} />
      </button>
    </div>
  )
}

/**
 * the price filter as the ledger's quick-filter toggles ("Not priced 1.294"): nothing pressed shows everything, so
 * the toolbar's only inverted chip at rest is Active / Archived
 */
function PriceFilters({ value, options, onChange }: { value: PriceFilter; options: { key: Exclude<PriceFilter, 'all'>; label: string; count?: number }[]; onChange: (k: PriceFilter) => void }) {
  return (
    <div role="group" aria-label="Filter by price" className="flex flex-wrap gap-2 sm:ml-auto">
      {options.map((o) => {
        const on = o.key === value
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange(on ? 'all' : o.key)}
            className={clsx('inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-3.5 text-sm whitespace-nowrap transition-colors', on ? 'bg-slate-900 font-semibold text-white hover:bg-slate-800' : [raisedCls, 'font-medium'])}>
            {o.label}
            {o.count !== undefined && <span className={clsx('num', on ? 'text-slate-200' : 'text-slate-600')}>{int(o.count)}</span>}
            {on && <Icon name="close" size={16} />}
          </button>
        )
      })}
    </div>
  )
}

/** a filter of the priced view ("All categories ▾"), to compare unit prices of like products */
function FacetMenu({ noun, all, value, options, onChange }: {
  /** what it filters by, for its label ("category") */
  noun: string
  all: string
  value: string | null
  options: { value: string; label: string }[]
  onChange: (value?: string) => void
}) {
  const chosen = options.find((o) => o.value === value)?.label ?? value
  return (
    <Menu
      label={`Filter by ${noun}`}
      align="end"
      width="w-64"
      items={[
        { label: all, checked: !value, onSelect: () => onChange() },
        'sep' as const,
        ...options.map((o) => ({ label: o.label, checked: value === o.value, onSelect: () => onChange(o.value) })),
      ]}
      trigger={(t) => (
        <ToolButton {...t} active={!!value} aria-label={`Filter by ${noun}: ${chosen ?? all}`} className="max-w-56 pr-2.5">
          <span className="truncate">{chosen ?? all}</span>
          <Icon name="expand_more" size={18} className={value ? 'text-white' : 'text-slate-600'} />
        </ToolButton>
      )}
    />
  )
}

/** the distinct values of a field among some rows, A–Z, as facet options */
function facetOptions(rows: CatalogueEntry[], value: (e: CatalogueEntry) => string | null | undefined, label: (e: CatalogueEntry) => string | null | undefined = value) {
  const seen = new Map<string, string>()
  for (const entry of rows) {
    const v = value(entry)
    if (v && !seen.has(v)) seen.set(v, label(entry) ?? v)
  }
  return [...seen].map(([v, l]) => ({ value: v, label: l })).sort((a, b) => a.label.localeCompare(b.label, 'de'))
}

function Catalogue({ kind }: { kind: CatalogueKind }) {
  const { title, item } = CATALOGUES[kind]
  const icon = catalogueIcon(kind)
  const [filters, setFilters] = useSearchParams()
  const location = useLocation()
  const supplier = kind === 'products' ? filters.get('supplier') : null
  const archived = filters.get('view') === 'archived'
  const priceParam = filters.get('price')
  const price: PriceFilter = kind === 'products' && (priceParam === 'priced' || priceParam === 'unpriced') ? priceParam : 'all'
  // the priced view narrows to like products, so unit prices can be compared
  const category = price === 'priced' ? filters.get('category') : null
  const unit = price === 'priced' ? filters.get('unit') : null
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [scan, setScan] = useState<Scan | null>(null)
  const [settled, setSettled] = useState<Scan | null>(null)
  const [coverage, setCoverage] = useState<Record<string, Coverage>>({})
  const [editing, setEditing] = useState<{ entry: CatalogueEntry | null; focus?: EditorFocus } | undefined>(undefined)
  const [confirm, setConfirm] = useState<{ entry: CatalogueEntry; action: 'archive' | 'restore' } | null>(null)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  // paging moves focus to the results heading, so the next Tab lands on the new page's first row
  const paged = useRef(false)
  function goToPage(next: number) {
    paged.current = true
    setPage(next)
  }
  useEffect(() => {
    if (!paged.current) return
    paged.current = false
    headingRef.current?.focus({ preventScroll: true })
    // the results bar stays under the app header, so only a page scrolled past the list's start goes back to it
    const section = sectionRef.current
    if (section && section.getBoundingClientRect().top < 64) section.scrollIntoView({ block: 'start' })
  }, [page])

  // "/" jumps to the search and N adds an entry, from anywhere on the page (not while typing, or in a dialog or menu)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.repeat) return
      const target = event.target as HTMLElement
      if (target.closest('input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]')) return
      if (document.querySelector('[role=dialog],[role=alertdialog],[role=menu]')) return
      if (event.key === '/' && searchRef.current) {
        event.preventDefault()
        searchRef.current.focus()
      } else if (event.key === 'n' || event.key === 'N') {
        event.preventDefault()
        setEditing({ entry: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const trimmed = query.trim()
  const key = `${trimmed}|${supplier ?? ''}|${archived}#${reload}`

  useEffect(() => {
    const controller = new AbortController()
    const snapshot = { key, filters: { q: trimmed, supplier, archived } }
    const timer = setTimeout(async () => {
      try {
        const { rows, capped } = await scanCatalogue(kind, snapshot.filters, controller.signal, (rows) => {
          if (!controller.signal.aborted) setScan({ ...snapshot, rows, done: false, capped: false })
        })
        if (controller.signal.aborted) return
        const done = { ...snapshot, rows, done: true, capped }
        setScan(done)
        setSettled(done)
      } catch (error) {
        if (!controller.signal.aborted) setScan({ ...snapshot, rows: [], done: true, capped: false, error: (error as Error).message })
      }
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [kind, key, trimmed, supplier, archived])

  /** changes some URL filters at once (an empty value clears one) and goes back to page one */
  function setFilter(changes: Record<string, string | undefined>) {
    const next = new URLSearchParams(filters)
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value)
      else next.delete(name)
    }
    setFilters(next)
    setPage(1)
  }

  // while the next search or page loads, the last complete result stays on screen (only the first load shows a
  // skeleton); everything below describes what is shown, so a stale result never borrows the new query's wording
  const current = scan?.key === key ? scan : null
  const covered = !!current && (current.done || (price === 'all' && current.rows.length >= (page + 1) * CATALOGUE_PAGE_SIZE))
  const view = covered ? current : settled ?? (current?.rows.length ? current : null)
  const refreshing = !!view && (view !== current || !view.done)
  const all = view?.rows ?? []
  const pricedRows = kind === 'products' ? all.filter(isPriced) : []
  const pricedCount = pricedRows.length
  const faceted = !!(category || unit)
  const rows = price === 'priced'
    ? pricedRows.filter((entry) => (!category || entry.category === category) && (!unit || entry.unit === unit))
    : price === 'unpriced' ? all.filter((entry) => !isPriced(entry)) : all
  // what tells same-named products apart is worked out over the whole result, so a tag never changes between pages
  const tags = kind === 'products' ? discriminators(rows) : new Map<string, Tag>()
  const items = kind === 'products' ? collapse(rows, tags) : rows.map((entry) => ({ key: entry.id, entries: [entry] }))
  const pages = paginate(items)
  const lastPage = Math.max(1, pages.length)
  const shownPage = view?.done ? Math.min(page, lastPage) : page
  const span = pages[shownPage - 1]
  const pageItems = span ? items.slice(span.from, span.to) : []
  const pageRows = pageItems.flatMap((it) => it.entries)
  // a brand-new catalogue: the empty state explains it, and the search has nothing to search yet
  const blank = !!view?.done && !all.length && !view.filters.q && !view.filters.supplier && !view.filters.archived
  // nothing to search in (an empty catalogue or an empty Archived view)
  const noSearch = !!view?.done && !all.length && !view.filters.q && !trimmed
  const supplierName = (location.state as { supplierName?: string } | null)?.supplierName
    ?? all.find((entry) => entry.supplier_id === supplier)?.supplier ?? undefined

  // price coverage and what each supplier on this page sells, one supplier at a time so a long list never floods the API
  const coverageKey = kind === 'suppliers'
    ? pageRows.filter((e) => !e.archived_at && (e.product_count ?? 0) > 0 && (e.product_count ?? 0) <= COVERAGE_LIMIT).map((e) => e.id).join(',')
    : ''
  useEffect(() => {
    if (!coverageKey) return
    const controller = new AbortController()
    void (async () => {
      for (const id of coverageKey.split(',')) {
        try {
          const { rows } = await scanCatalogue('products', { q: '', supplier: id, archived: false }, controller.signal)
          if (controller.signal.aborted) return
          const priced = rows.filter(isPriced)
          const latest = priced.reduce<string | undefined>((newest, entry) => (entry.valid_from && (!newest || entry.valid_from > newest) ? entry.valid_from : newest), undefined)
          const counts = new Map<string, number>()
          for (const entry of rows) if (entry.category) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
          const categories = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).slice(0, 3).map(([name]) => name)
          setCoverage((known) => ({ ...known, [id]: { priced: priced.length, latest, categories } }))
        } catch {
          if (controller.signal.aborted) return
        }
      }
    })()
    return () => controller.abort()
  }, [coverageKey, reload])

  async function changeArchive(entry: CatalogueEntry, action: 'archive' | 'restore') {
    if (busy) return
    setBusy(true)
    try {
      await writeCatalogue(kind, { id: entry.id, action })
      toast(action === 'archive' ? `Archived ${entry.name}` : `Restored ${entry.name}`)
      setConfirm(null)
      setReload((n) => n + 1)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  // the results heading is the count ("1.311 products", "17 priced products"), exact once every page is read; until
  // then it names what is listed
  const noun = title.toLowerCase()
  const q = view?.filters.q
  const n = rows.length
  const counted = (word: string) => `${word} ${n === 1 && !view?.capped ? item : noun}`
  const countWords = q ? `${n === 1 && !view?.capped ? 'match' : 'matches'} for “${q}”`
    : view?.filters.archived ? counted('archived')
    : price === 'priced' ? counted('priced')
    : price === 'unpriced' ? `${n === 1 ? item : noun} not priced`
    : n === 1 ? item : noun
  const loadingHeading = q ? `${view?.filters.archived ? 'Archived matches' : 'Matches'} for “${q}”` : view?.filters.archived ? `Archived ${noun}` : title
  const countText = view?.done ? `${int(n)}${view.capped ? '+' : ''}` : ''
  const paginated = !!view && (view.done ? lastPage > 1 : rows.length >= CATALOGUE_PAGE_SIZE)
  const nonePriced = kind === 'products' && !!view?.done && all.length > 0 && pricedCount === 0
  // the price filter only when it can tell something apart (or is already set, so it can be cleared)
  const showPriceFilter = kind === 'products' && !!view?.done && (price !== 'all' || (pricedCount > 0 && pricedCount < all.length))
  const withCounts = !!view?.done && !view.capped
  const priceOptions = [
    { key: 'priced' as const, label: 'Priced', count: withCounts ? pricedCount : undefined },
    { key: 'unpriced' as const, label: 'Not priced', count: withCounts ? all.length - pricedCount : undefined },
  ]
  // how much of the page in view can be quoted from, beside its range
  const pagePriced = pageRows.filter(isPriced).length
  const pageCoverage = kind === 'products' && price === 'all' && paginated && pageRows.length > 0
    ? (pagePriced ? `${int(pagePriced)} priced on this page` : 'None priced on this page') : ''
  // the priced view's filters, each only once there is something to choose between (or it is set, to clear it)
  const facets = price === 'priced' && view?.done ? [
    { noun: 'category', all: 'All categories', value: category, options: facetOptions(pricedRows, (e) => e.category), onChange: (v?: string) => setFilter({ category: v }) },
    { noun: 'unit', all: 'All units', value: unit, options: facetOptions(pricedRows, (e) => e.unit), onChange: (v?: string) => setFilter({ unit: v }) },
    { noun: 'supplier', all: 'All suppliers', value: supplier, options: facetOptions(pricedRows, (e) => e.supplier_id, (e) => e.supplier), onChange: (v?: string) => setFilter({ supplier: v }) },
  ].filter((f) => f.value || f.options.length > 1) : []
  const supplierFacet = facets.some((f) => f.noun === 'supplier')
  const pager = (withTotal?: boolean) => span && (
    <Pager page={shownPage} first={span.first} last={span.last} total={n} done={!!view?.done} capped={!!view?.capped} lastPage={lastPage} withTotal={withTotal} onPage={goToPage} />
  )
  const addLabel = `Add ${item}`

  return (
    <PageFrame>
      <PageHeader
        title={title}
        subtitle={SUBTITLE[kind]}
        // an empty catalogue keeps its one Add button in the empty state; it moves up here once there are entries
        aside={!blank && <Button variant="primary" size="lg" icon="add" onClick={() => setEditing({ entry: null })} aria-label={addLabel} aria-keyshortcuts="n" title={`${addLabel} (N)`} className="max-sm:px-4"><span>Add<span className="max-sm:hidden"> {item}</span></span></Button>}
      />

      {/* one toolbar: search and Active / Archived on the left, the price filter on the right */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* an empty list has nothing to search, so the field steps out and the chips lead the row */}
        {!noSearch && (
          <div className="relative w-full sm:w-72">
            <Icon name="search" size={20} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-600" />
            <input
              ref={searchRef}
              type="search"
              aria-label={`Search ${noun}`}
              aria-keyshortcuts="/"
              placeholder={`Search ${noun}`}
              value={query}
              maxLength={200}
              onChange={(event) => { setQuery(event.target.value); setPage(1) }}
              className={clsx(inputCls, 'peer pr-10 pl-11')}
            />
            {!query && <kbd aria-hidden className={clsx(kbdCls, 'pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 peer-focus:hidden [@media(hover:none)]:hidden')}>/</kbd>}
          </div>
        )}
        <Chips
          label="Catalogue status"
          value={archived ? 'archived' : 'active'}
          onChange={(k) => setFilter({ view: k === 'archived' ? 'archived' : undefined })}
          options={[{ key: 'active', label: 'Active' }, { key: 'archived', label: 'Archived' }]}
        />
        {/* in the priced view the supplier filter is one of the menus above the rows */}
        {supplier && !supplierFacet && (
          <button type="button" onClick={() => setFilter({ supplier: undefined })} aria-label={`Clear supplier filter: ${supplierName ?? 'one supplier'}`} className="inline-flex h-10 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-slate-900 px-3.5 text-sm font-semibold text-white hover:bg-slate-800">
            <span className="truncate">{supplierName ?? 'One supplier'}</span><Icon name="close" size={18} className="shrink-0" />
          </button>
        )}
        {showPriceFilter && <PriceFilters value={price} onChange={(k) => setFilter({ price: k === 'all' ? undefined : k, category: undefined, unit: undefined })} options={priceOptions} />}
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {view?.done && !current?.error ? `${countText} ${countWords}${nonePriced ? ', none priced yet' : ''}` : ''}
      </p>

      {!view && !current?.error && <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-lg" /></div>}
      {current?.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-rose-50 p-4 text-sm font-medium text-rose-800 ring-1 ring-rose-200 ring-inset">
          <Icon name="error" size={20} />{current.error}
          <Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {view && !current?.error && (all.length ? (
        <section ref={sectionRef} aria-labelledby="catalogue-rows" aria-busy={refreshing} className="mb-8 scroll-mt-16">
          {/* the count, the range with its arrows and the page's price coverage stay under the app header while the
              rows scroll; the priced view's filters sit at its end */}
          <div className="sticky top-16 z-20 -mx-2 mb-1 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 bg-white px-2 py-1 sm:-mx-3 sm:px-3">
            <h2 id="catalogue-rows" ref={headingRef} tabIndex={-1} className="min-w-0 rounded-sm font-heading text-base font-bold break-words text-slate-900">
              {countText ? <><span className="num">{countText}</span> {countWords}</> : loadingHeading}
            </h2>
            {paginated && <nav aria-label="Catalogue pages, top" className="-ml-1">{pager()}</nav>}
            {pageCoverage && (
              <span className="inline-flex items-center gap-x-1.5 text-sm text-slate-600">
                {pageCoverage}
                {/* a page of unpriced rows points straight at the ones that can be quoted from */}
                {!pagePriced && pricedCount > 0 && <><span aria-hidden>·</span><MetaLink onClick={() => setFilter({ price: 'priced', category: undefined, unit: undefined })}>Show {withCounts ? `the ${int(pricedCount)} ` : ''}priced</MetaLink></>}
              </span>
            )}
            {facets.length > 0 && (
              <div role="group" aria-label="Filter priced products" className="ml-auto flex flex-wrap gap-2">
                {facets.map((f) => <FacetMenu key={f.noun} {...f} />)}
              </div>
            )}
          </div>
          {pageItems.length ? (
            <CatalogueRows kind={kind} items={pageItems} tags={tags} coverage={coverage}
              onEdit={(entry, focus) => setEditing({ entry, focus })}
              onArchive={(entry) => setConfirm({ entry, action: 'archive' })}
              onRestore={(entry) => setConfirm({ entry, action: 'restore' })} />
          ) : view.done ? (
            faceted ? (
              <EmptyState compact icon="search_off" title="No priced products match" text="Choose another category or unit.">
                <Button onClick={() => setFilter({ category: undefined, unit: undefined })}>Clear filters</Button>
              </EmptyState>
            ) : (
              <EmptyState compact icon="search_off"
                title={price === 'priced' ? `No priced ${noun} here` : `Every ${item} here is priced`}
                text={price === 'priced' ? 'Add a unit price to a product and it shows up here.' : undefined}>
                <Button onClick={() => setFilter({ price: undefined })}>Show all {noun}</Button>
              </EmptyState>
            )
          ) : <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-lg" /></div>}
          {paginated && (
            <nav aria-label="Catalogue pages, bottom" className="mt-3 -mr-2 flex flex-wrap items-center justify-end gap-3 text-sm text-slate-600">
              {view.capped && shownPage === lastPage && <span className="mr-auto">Only the first {int(CATALOGUE_SCAN_PAGES * CATALOGUE_PAGE_SIZE)} are listed. Search to narrow the list.</span>}
              {pager(true)}
            </nav>
          )}
        </section>
      ) : view.done ? (
        <EmptyState
          icon={view.filters.q || view.filters.supplier ? 'search_off' : icon}
          title={view.filters.q || view.filters.supplier ? 'No matching entries' : `No ${view.filters.archived ? 'archived ' : ''}${noun} yet`}
          text={view.filters.q ? 'Try a different search, or clear it to see everything.'
            : view.filters.supplier ? `This supplier has no ${view.filters.archived ? 'archived ' : ''}${noun} yet.`
            : view.filters.archived ? `Archived ${noun} land here, and you can restore them any time.`
            : EMPTY_TEXT[kind]}
          // the keyboard path to the one Add button, as the other empty states give theirs
          hint={blank ? <span className="inline-flex items-center gap-1.5 [@media(pointer:coarse)]:hidden">or press <Kbd>N</Kbd></span> : undefined}
        >
          {view.filters.q ? <Button size="lg" onClick={() => { setQuery(''); setPage(1) }}>Clear search</Button>
            // the page's one Add button while the catalogue is empty (the header leaves it out)
            : blank && <Button variant="primary" size="lg" icon="add" onClick={() => setEditing({ entry: null })} aria-keyshortcuts="n">{addLabel}</Button>}
        </EmptyState>
      ) : <div role="status" aria-label="Loading catalogue"><Skeleton className="h-40 rounded-lg" /></div>)}

      {editing !== undefined && (
        <CatalogueEditor kind={kind} entry={editing.entry} focus={editing.focus}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            if (editing.entry === null) { setFilter({ view: undefined }); setQuery('') }
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
