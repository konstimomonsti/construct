export const CATALOGUES = {
  products: { title: 'Products', item: 'product', icon: 'inventory_2' },
  suppliers: { title: 'Suppliers', item: 'supplier', icon: 'local_shipping' },
  subcontractors: { title: 'Subcontractors', item: 'subcontractor', icon: 'engineering' },
} as const

export type CatalogueKind = keyof typeof CATALOGUES

/** rows per catalogue page; matches PAGE_SIZE in backend/catalogues.py */
export const CATALOGUE_PAGE_SIZE = 50

/**
 * how many API pages one listing reads at most. The API pages but never totals, so the screen reads every page of a
 * result to count it exactly and to filter it by price; past this many rows the count reads "5.000+"
 */
export const CATALOGUE_SCAN_PAGES = 100

/** the units products are usually priced in, offered by the editor's unit picker; any other unit can still be typed */
export const CATALOGUE_UNITS = ['m', 'm²', 'm³', 'Stk', 'St', 'h', 'kg', 't', 'psch', 'lfm'] as const

export type CatalogueEntry = {
  id: string
  name: string
  archived_at: string | null
  category?: string
  description?: string
  sku?: string | null
  unit?: string | null
  supplier?: string | null
  supplier_id?: string | null
  supplier_archived_at?: string | null
  review_status?: 'approved' | 'pending'
  unit_price?: string | null
  currency?: string | null
  valid_from?: string | null
  price_basis?: 'supplier_quote' | 'tender_offer' | null
  product_count?: number
  trade?: string
  contact_name?: string | null
  email?: string | null
  phone?: string | null
  billing_address?: string | null
}

export type CatalogueListing = { rows: CatalogueEntry[]; has_more: boolean }
export type CatalogueFilters = { q: string; supplier: string | null; archived: boolean }

export type ProductOptions = {
  categories: { name: string }[]
  suppliers: { id: string; name: string }[]
}

export const isPriced = (entry: CatalogueEntry) => entry.unit_price != null && !!entry.currency

export async function requestCatalogue<T>(kind: CatalogueKind, params = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/catalogues/${kind}${params}`, { cache: 'no-store', ...init })
  if (!response.ok) {
    const message = await response.json().catch(() => null)
    throw new Error(message?.error || 'The catalogue request could not be completed.')
  }
  return response.json()
}

/** one price of an activity: ours when `subcontractor` is null, otherwise the offer of that subcontractor */
export type ActivityPrice = {
  unit_price: string
  currency: string | null
  valid_from: string
  valid_until: string | null
  source_note: string | null
  subcontractor_id: string | null
  subcontractor: string | null
}

/** an activity (installation, removal, disposal, planning, site costs...) of the tender catalogue, with its valid prices */
export type ActivityEntry = {
  code: string
  name: string
  unit: string | null
  kind: 'activity' | 'supply'
  prices: ActivityPrice[]
}

/** the API reads at most this many position codes per request; matches MAX_ACTIVITY_CODES in backend/catalogues.py */
const ACTIVITY_CODES_PER_REQUEST = 100

/** the valid prices of the activities whose tender position code is in `codes`; codes without a price are left out */
export async function requestActivities(codes: readonly string[]): Promise<ActivityEntry[]> {
  const chunks: string[][] = []
  for (let i = 0; i < codes.length; i += ACTIVITY_CODES_PER_REQUEST) chunks.push(codes.slice(i, i + ACTIVITY_CODES_PER_REQUEST))
  const pages = await Promise.all(chunks.map(async (chunk) => {
    const response = await fetch(`/api/catalogues/activities?codes=${encodeURIComponent(chunk.join(','))}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('The activity prices could not be read.')
    return (await response.json()) as { rows: ActivityEntry[] }
  }))
  return pages.flatMap((page) => page.rows)
}

export const writeCatalogue = (kind: CatalogueKind, fields: Record<string, unknown>) =>
  requestCatalogue<{ id: string }>(kind, '', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  })

/**
 * every row of a listing, read a few pages at a time; `onRows` sees the rows read so far, so the first page shows
 * while the rest load. `capped` means there were more rows than CATALOGUE_SCAN_PAGES pages hold.
 */
export async function scanCatalogue(
  kind: CatalogueKind,
  filters: CatalogueFilters,
  signal: AbortSignal,
  onRows?: (rows: CatalogueEntry[]) => void,
): Promise<{ rows: CatalogueEntry[]; capped: boolean }> {
  const fetchPage = (page: number) => {
    const params = new URLSearchParams({ q: filters.q, page: String(page) })
    if (filters.supplier) params.set('supplier', filters.supplier)
    if (filters.archived) params.set('view', 'archived')
    return requestCatalogue<CatalogueListing>(kind, `?${params}`, { signal })
  }
  const rows: CatalogueEntry[] = []
  let next = 1
  let more = true
  while (more && next <= CATALOGUE_SCAN_PAGES) {
    // the first page on its own so it shows quickly, then a few at a time
    const batch = next === 1 ? [1] : Array.from({ length: Math.min(6, CATALOGUE_SCAN_PAGES - next + 1) }, (_, i) => next + i)
    const pages = await Promise.all(batch.map(fetchPage))
    for (const page of pages) {
      rows.push(...page.rows)
      more = page.has_more
      if (!more) break
    }
    next += batch.length
    if (more) onRows?.([...rows])
  }
  return { rows, capped: more }
}

/**
 * the form field a server validation message is about (the backend words them "Enter the trade.",
 * "Enter a valid phone of up to 60 characters." and so on), so the message can sit beside that field
 */
export function catalogueErrorField(message: string): string | undefined {
  const text = message.toLowerCase()
  if (text.includes('unit price') || text.includes('currency')) return 'unit_price'
  if (text.includes('effective date') || text.includes('valid from')) return 'valid_from'
  if (text.includes('email')) return 'email'
  if (text.includes('supplier and unit')) return 'unit'
  if (text.includes('supplier')) return 'supplier_id'
  const named = text.match(/^enter (?:the|a valid) ([a-z ]+?)(?: of up to|\.)/)?.[1]
  const fields: Record<string, string> = {
    name: 'name', description: 'description', category: 'category', sku: 'sku', unit: 'unit', trade: 'trade',
    'contact name': 'contact_name', phone: 'phone', 'billing address': 'billing_address',
  }
  return named ? fields[named] : undefined
}

export function formatCataloguePrice(entry: CatalogueEntry) {
  if (entry.unit_price == null || !entry.currency) return '—'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: entry.currency, maximumFractionDigits: 6,
  }).format(Number(entry.unit_price))
}

/** a typed unit price ("14,50" or "14.50", as the API accepts it: no thousands separators), or null when it isn't one */
export function parseCataloguePrice(text: string) {
  const clean = text.trim()
  return /^\d{1,14}(?:[.,]\d{1,6})?$/.test(clean) ? Number(clean.replace(',', '.')) : null
}

/** an amount in a currency the catalogue way (14,50 €), with "/ m²" once there is a unit */
export function catalogueAmount(amount: number | string, currency: string, unit?: string | null) {
  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency, maximumFractionDigits: 6 }).format(Number(amount))
  return unit ? `${money} / ${unit}` : money
}

/** a typed date (21.11.2026) as ISO (2026-11-21), or null when it isn't a real date */
export function isoFromGerman(text: string) {
  const match = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (!match) return null
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
}

/** a price date the German way (25.11.2024, 01.01.2027); the API sends plain ISO dates, read as UTC so they never shift a day */
export const catalogueDate = (iso: string) => new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso))

export function cataloguePriceSource(entry: CatalogueEntry) {
  if (!entry.valid_from) return ''
  return `${catalogueDate(entry.valid_from)} · ${entry.price_basis === 'tender_offer' ? 'Tender offer' : 'Supplier quote'}`
}
