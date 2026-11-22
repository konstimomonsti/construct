import { useEffect, useMemo, useState } from 'react'
import { requestActivities, requestCatalogue, type ActivityEntry, type CatalogueEntry } from './catalogues'
import type { CatalogueReport } from './workspace-catalogue'
import type { Position } from './types'

/**
 * A position has one of three pricing states:
 * - priced: it has a unit price (from the file, typed, or a confirmed suggestion)
 * - pending: no unit price yet, but a matched catalogue product, or the activity catalogue (our own price or a
 *   subcontractor's offer for the same tender position), proposes one; it waits for the user to confirm it
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
  /** what the price comes from; a missing kind is a product */
  kind?: 'product' | 'activity'
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

/** the name of a tender position without the numbered Muster-LV suffix, case, punctuation and spacing */
const activityName = (text: string | null | undefined) =>
  (text ?? '').replace(/\s*(?:MLV-FSB)?_?\d{6,}.*$/s, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * the price the activity catalogue proposes for a position: the cheapest valid EUR price, our own or a subcontractor's.
 * The activity must carry the position's tender code (the caller looks it up by it) and its name, and the units must fit.
 */
export function activitySuggestion(p: Position, entry: ActivityEntry | null | undefined): PriceSuggestion | null {
  if (!entry || !activityName(p.short) || activityName(p.short) !== activityName(entry.name) || !unitsFit(entry.unit, p.unit)) return null
  let best: { price: number; from: ActivityEntry['prices'][number] } | null = null
  for (const from of entry.prices) {
    const price = Number(from.unit_price)
    if (!Number.isFinite(price) || price < 0 || (from.currency && from.currency !== 'EUR')) continue
    // the cheapest wins; at the same price our own is kept over an offer
    if (!best || price < best.price || (price === best.price && !from.subcontractor && best.from.subcontractor)) best = { price, from }
  }
  if (!best) return null
  return {
    price: Math.round(best.price * 100) / 100,
    unit: entry.unit ?? null,
    product: { id: entry.code, name: entry.name, supplier: best.from.subcontractor ?? 'Own price' },
    basis: null,
    validFrom: best.from.valid_from,
    unitKnown: !!unitKey(entry.unit) && !!unitKey(p.unit),
    kind: 'activity',
  }
}

// one request per position code for the whole session, like the products; a code with no price is remembered as null
const activities = new Map<string, Promise<ActivityEntry | null>>()
function activitiesFor(codes: string[]) {
  const missing = codes.filter((code) => !activities.has(code))
  if (missing.length) {
    const batch = requestActivities(missing).then((rows) => new Map(rows.map((row) => [row.code, row] as const)))
    for (const code of missing) {
      const hit = batch.then((found) => found.get(code) ?? null)
      hit.catch(() => activities.delete(code))
      activities.set(code, hit)
    }
  }
  return Promise.all(codes.map(async (code) => [code, await activities.get(code)!.catch(() => null)] as const))
}

export const priceStateOf = (p: Position, pending: ReadonlyMap<string, PriceSuggestion>): PriceState =>
  p.up != null ? 'priced' : pending.has(p.id) ? 'pending' : 'unpriced'

export type PricingFilter = 'unpriced' | 'pending' | 'zero' | 'edited'

export function matchesPricingFilter(
  filter: PricingFilter, position: Position, pending: ReadonlyMap<string, PriceSuggestion>, edited: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case 'unpriced':
    case 'pending':
      return priceStateOf(position, pending) === filter
    case 'zero':
      return position.up != null && position.qty === 0
    case 'edited':
      return edited.has(position.id)
  }
}

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
  // positions the product catalogue did not price are looked up as activities by their tender position code
  const activityCodes = useMemo(
    () => [...new Set(positions.filter((p) => p.up == null && p.oz && !wanted.has(p.id)).map((p) => p.oz))].sort(),
    [positions, wanted],
  )
  const activityKey = activityCodes.join(',')
  const [activityEntries, setActivityEntries] = useState<Record<string, ActivityEntry | null>>({})

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

  useEffect(() => {
    if (!activityKey) return
    let live = true
    activitiesFor(activityKey.split(',')).then((pairs) => {
      if (live) setActivityEntries((prev) => ({ ...prev, ...Object.fromEntries(pairs) }))
    })
    return () => {
      live = false
    }
  }, [activityKey])

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
    for (const p of positions) {
      if (p.up != null || out.has(p.id) || wanted.has(p.id) || skip.has(p.id)) continue
      const suggestion = activitySuggestion(p, activityEntries[p.oz])
      if (suggestion) out.set(p.id, suggestion)
    }
    return out
  }, [wanted, entries, positions, activityEntries, dismissed])
}
