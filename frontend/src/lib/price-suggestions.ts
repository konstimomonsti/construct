import { useEffect, useMemo, useState } from 'react'
import { requestCatalogue, type CatalogueEntry } from './catalogues'
import type { CatalogueReport } from './workspace-catalogue'
import type { Position } from './types'

/**
 * A position has one of three pricing states:
 * - priced: it has a unit price (from the file, typed, or a confirmed suggestion)
 * - pending: no unit price yet, but a matched catalogue product proposes one; it waits for the user to confirm it
 * - unpriced: no unit price and nothing to propose
 * Pending prices never count toward totals until they are confirmed.
 */
export type PriceState = 'priced' | 'pending' | 'unpriced'

export type PriceSuggestion = {
  price: number
  unit: string | null
  product: { id: string; name: string; supplier: string | null }
  basis: CatalogueEntry['price_basis']
  validFrom: string | null
  /** both the catalogue and the position name a unit (and they match); otherwise the user checks the unit first */
  unitKnown: boolean
}

// one request per product for the whole session; the catalogue rarely changes while a list is open
const products = new Map<string, Promise<CatalogueEntry | null>>()
function product(id: string) {
  let hit = products.get(id)
  if (!hit) {
    hit = requestCatalogue<CatalogueEntry>('products', `?id=${encodeURIComponent(id)}`).catch(() => {
      products.delete(id)
      return null
    })
    products.set(id, hit)
  }
  return hit
}

const UNIT_ALIASES: Record<string, string> = { m3: 'm³', m2: 'm²', stk: 'st', stück: 'st', stck: 'st', lfm: 'm', pauschal: 'psch' }
const unitKey = (unit: string | null | undefined) => {
  const u = (unit ?? '').trim().toLowerCase().replace(/\.$/, '')
  return UNIT_ALIASES[u] ?? u
}

/** a catalogue price only fits a position priced in the same unit; no unit on either side is taken as a fit */
const unitsFit = (a: string | null | undefined, b: string | null | undefined) => !unitKey(a) || !unitKey(b) || unitKey(a) === unitKey(b)

export const priceStateOf = (p: Position, pending: ReadonlyMap<string, PriceSuggestion>): PriceState =>
  p.up != null ? 'priced' : pending.has(p.id) ? 'pending' : 'unpriced'

/**
 * unit prices proposed for unpriced positions from the catalogue products they were matched to, minus the ones the
 * user dismissed. Reads products one by one (GET only) and only for positions that still lack a price.
 */
export function usePriceSuggestions(report: CatalogueReport | null, positions: Position[], dismissed: readonly string[] | undefined) {
  const wanted = useMemo(() => {
    const out = new Map<string, { productId: string; unit: string }>()
    if (!report) return out
    for (const p of positions) {
      if (p.up != null) continue
      const match = report.positions[p.id]
      if (match?.state === 'matched' && match.product) out.set(p.id, { productId: match.product.id, unit: p.unit })
    }
    return out
  }, [report, positions])
  const ids = useMemo(() => [...new Set([...wanted.values()].map((w) => w.productId))].sort().join(','), [wanted])
  const [entries, setEntries] = useState<Record<string, CatalogueEntry | null>>({})

  useEffect(() => {
    if (!ids) return
    let live = true
    Promise.all(ids.split(',').map(async (id) => [id, await product(id)] as const)).then((pairs) => {
      if (live) setEntries((prev) => ({ ...prev, ...Object.fromEntries(pairs) }))
    })
    return () => {
      live = false
    }
  }, [ids])

  return useMemo(() => {
    const skip = new Set(dismissed)
    const out = new Map<string, PriceSuggestion>()
    for (const [pid, { productId, unit }] of wanted) {
      if (skip.has(pid)) continue
      const entry = entries[productId]
      const price = entry?.unit_price != null ? Number(entry.unit_price) : NaN
      if (!entry || !Number.isFinite(price) || price < 0 || (entry.currency && entry.currency !== 'EUR')) continue
      if (!unitsFit(entry.unit, unit)) continue
      out.set(pid, {
        price: Math.round(price * 100) / 100,
        unit: entry.unit ?? null,
        product: { id: entry.id, name: entry.name, supplier: entry.supplier ?? null },
        basis: entry.price_basis ?? null,
        validFrom: entry.valid_from ?? null,
        unitKnown: !!unitKey(entry.unit) && !!unitKey(unit),
      })
    }
    return out
  }, [wanted, entries, dismissed])
}
