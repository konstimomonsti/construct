/**
 * Reads a subcontractor's reply (X84 / Excel / CSV …) against the positions of a package.
 * Pure: the file is parsed by `parseListFile`, matching happens here.
 */
import { normOz, round2 } from './export/util'
import type { Position } from './types'

export type OfferMatch = {
  /** Σ our qty × the offer's unit price over the matched, priced positions (EUR) */
  amount: number
  /** package positions found in the offer with a price */
  matched: number
  /** ids of our package positions the offer did not price */
  missing: string[]
  /** unit price per matched package position id */
  prices: Record<string, number>
  /** matched positions whose quantity in the offer differs from ours (we always price with ours) */
  qtyDiffs: number
  /** priced offer positions that are not in the package */
  extra: number
}

/** PDF tenders number positions "1.1.10." with a trailing dot, GAEB replies write "1.1.10"; both must match */
const ozKey = (oz: string) => normOz(oz.trim().replace(/\.+$/, ''))

type Priced = Pick<Position, 'oz' | 'qty' | 'up'>

/**
 * Matches by normalized OZ. The amount always uses OUR quantity (the client's LV); a different quantity in the
 * offer is only counted in `qtyDiffs`. A position the offer lacks, or
 * lists without a unit price, counts as missing.
 */
export function matchOffer(pkgPositions: readonly Pick<Position, 'id' | 'oz' | 'qty'>[], offer: { positions: readonly Priced[] }): OfferMatch {
  const byOz = new Map<string, Priced>()
  for (const p of offer.positions) {
    if (p.up == null) continue
    const key = ozKey(p.oz)
    if (!byOz.has(key)) byOz.set(key, p)
  }
  let amount = 0
  let matched = 0
  let qtyDiffs = 0
  const missing: string[] = []
  const prices: Record<string, number> = {}
  const used = new Set<string>()
  for (const p of pkgPositions) {
    const key = ozKey(p.oz)
    const hit = byOz.get(key)
    if (!hit || hit.up == null) {
      missing.push(p.id)
      continue
    }
    used.add(key)
    matched++
    prices[p.id] = hit.up
    if (Number.isFinite(hit.qty) && hit.qty > 0 && hit.qty !== p.qty) qtyDiffs++
    amount += p.qty * hit.up
  }
  return { amount: round2(amount), matched, missing, prices, qtyDiffs, extra: [...byOz.keys()].filter((k) => !used.has(k)).length }
}

/** how many of the given positions an offer file has (priced or not), to preselect the best package */
export function ozOverlap(pkgPositions: readonly Pick<Position, 'oz'>[], offer: { positions: readonly Pick<Position, 'oz'>[] }): number {
  const keys = new Set(offer.positions.map((p) => ozKey(p.oz)))
  return pkgPositions.filter((p) => keys.has(ozKey(p.oz))).length
}
