/**
 * Reads a subcontractor's reply (X84 / Excel / CSV …) against the positions of a package.
 * Pure: the file is parsed by `parseListFile`, matching happens here.
 */
import { normOz, round2 } from './export/util'
import type { Position } from './types'

export type OfferMatch = {
  /** Σ qty × unit price over the matched, priced positions (EUR) */
  amount: number
  /** package positions found in the offer with a price */
  matched: number
  /** ids of our package positions the offer did not price */
  missing: string[]
  /** priced offer positions that are not in the package */
  extra: number
}

type Priced = Pick<Position, 'oz' | 'qty' | 'up'>

/**
 * Matches by normalized OZ. The offer's quantity wins when it has one, else ours. A position the offer lacks, or
 * lists without a unit price, counts as missing.
 */
export function matchOffer(pkgPositions: readonly Pick<Position, 'id' | 'oz' | 'qty'>[], offer: { positions: readonly Priced[] }): OfferMatch {
  const byOz = new Map<string, Priced>()
  for (const p of offer.positions) {
    if (p.up == null) continue
    const key = normOz(p.oz.trim())
    if (!byOz.has(key)) byOz.set(key, p)
  }
  let amount = 0
  let matched = 0
  const missing: string[] = []
  const used = new Set<string>()
  for (const p of pkgPositions) {
    const key = normOz(p.oz.trim())
    const hit = byOz.get(key)
    if (!hit || hit.up == null) {
      missing.push(p.id)
      continue
    }
    used.add(key)
    matched++
    const qty = Number.isFinite(hit.qty) && hit.qty > 0 ? hit.qty : p.qty
    amount += qty * hit.up
  }
  return { amount: round2(amount), matched, missing, extra: [...byOz.keys()].filter((k) => !used.has(k)).length }
}

/** how many of the given positions an offer file has (priced or not), to preselect the best package */
export function ozOverlap(pkgPositions: readonly Pick<Position, 'oz'>[], offer: { positions: readonly Pick<Position, 'oz'>[] }): number {
  const keys = new Set(offer.positions.map((p) => normOz(p.oz.trim())))
  return pkgPositions.filter((p) => keys.has(normOz(p.oz.trim()))).length
}
