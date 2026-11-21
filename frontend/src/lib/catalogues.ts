export const CATALOGUES = {
  products: { title: 'Products', item: 'product', icon: 'inventory_2' },
  suppliers: { title: 'Suppliers', item: 'supplier', icon: 'local_shipping' },
  subcontractors: { title: 'Subcontractors', item: 'subcontractor', icon: 'engineering' },
} as const

export type CatalogueKind = keyof typeof CATALOGUES

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
}

export type ProductOptions = {
  categories: { name: string }[]
  suppliers: { id: string; name: string }[]
}

export async function requestCatalogue<T>(kind: CatalogueKind, params = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/catalogues/${kind}${params}`, { cache: 'no-store', ...init })
  if (!response.ok) {
    const message = await response.json().catch(() => null)
    throw new Error(message?.error || 'The catalogue request could not be completed.')
  }
  return response.json()
}

export const writeCatalogue = (kind: CatalogueKind, fields: Record<string, unknown>) =>
  requestCatalogue<{ id: string }>(kind, '', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  })

export function formatCataloguePrice(entry: CatalogueEntry) {
  if (entry.unit_price == null || !entry.currency) return '—'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: entry.currency, maximumFractionDigits: 6,
  }).format(Number(entry.unit_price))
}

export function cataloguePriceSource(entry: CatalogueEntry) {
  if (!entry.valid_from) return ''
  const date = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC' }).format(new Date(entry.valid_from))
  return `${date} · ${entry.price_basis === 'tender_offer' ? 'Tender offer' : 'Supplier quote'}`
}
