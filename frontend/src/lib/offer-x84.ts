/**
 * The offer for the client (X84), computed in one place so the screen total, the list total and the exported file
 * agree. Pure; the file itself comes from `exportList` (format `x84`).
 *
 * Price of a position, first that exists: its own unit price, the chosen subcontractor's unit price for it, a safe
 * catalogue suggestion. Quantity is always the LV's. Nothing is applied here: `applyPlan` only says what a click
 * would write.
 */
import { offerOf, type SubcontractPackage } from './subcontract'
import { round2 } from './export/util'
import type { Position } from './types'

/** a safe catalogue suggestion per position id (pending confirmation) */
export type SureMap = ReadonlyMap<string, number>
/** all catalogue suggestions: the sure ones feed the offer, the others only need an AI check */
export type Suggestions = ReadonlyMap<string, { price: number; unitKnown?: boolean }>

export type Tally = {
  amount: number
  /** positions with their own unit price */
  priced: number
  /** positions priced by the chosen subcontractor (price not applied yet) */
  sub: number
  /** positions with a sure catalogue price (not applied yet) */
  sure: number
  /** positions with an unsure catalogue suggestion only */
  ai: number
  /** positions without any price */
  none: number
}

const emptyTally = (): Tally => ({ amount: 0, priced: 0, sub: 0, sure: 0, ai: 0, none: 0 })

export type ChosenGroup = {
  pkg: SubcontractPackage
  subId: string
  /** Σ of the subcontractor's price × LV quantity (legacy offers: their `amount`) */
  amount: number
  /** the offer has neither an `amount` nor `prices` */
  noAmount: boolean
  /** old offer: an `amount` but no per-position prices */
  legacy: boolean
  /** positions the offer does not cover, priced with our own prices */
  own: Tally
}
export type OpenGroup = { pkg: SubcontractPackage; own: Tally }
export type SectionGroup = { label: string; own: Tally; count: number }

export type ApplyItem = { id: string; price: number; source: 'sub' | 'db' }

export type OfferModel = {
  chosen: ChosenGroup[]
  open: OpenGroup[]
  sections: SectionGroup[]
  total: number
  /** prices a click on "Apply" would write: only positions without an own price */
  apply: ApplyItem[]
  /** positions that only have an unsure suggestion */
  aiCount: number
  /** positions that would be exported without a price */
  unpriced: number
  /** chosen packages whose offer has an amount but no per-position prices */
  legacyCount: number
  /** chosen packages whose offer has nothing yet */
  noAmountCount: number
}

const subPrices = (pkg: SubcontractPackage): Record<string, number> => (pkg.chosenId ? offerOf(pkg, pkg.chosenId).prices ?? {} : {})

/** adds one position: own price, else subcontractor price, else sure suggestion, else open */
function tally(t: Tally, p: Position, sub: Record<string, number>, s: Suggestions): void {
  const sp = sub[p.id]
  const sg = s.get(p.id)
  if (p.up != null) {
    t.priced++
    t.amount += p.up * p.qty
  } else if (sp != null) {
    t.sub++
    t.amount += sp * p.qty
  } else if (sg?.unitKnown) {
    t.sure++
    t.amount += sg.price * p.qty
  } else if (sg) t.ai++
  else t.none++
}

export function offerModel(positions: readonly Position[], packages: readonly SubcontractPackage[], suggestions: Suggestions): OfferModel {
  const byId = new Map(positions.map((p) => [p.id, p]))
  const packaged = new Set(packages.flatMap((p) => p.positionIds))
  const apply: ApplyItem[] = []
  let legacyCount = 0
  let noAmountCount = 0

  const chosen: ChosenGroup[] = []
  const open: OpenGroup[] = []
  for (const pkg of packages) {
    const members = pkg.positionIds.map((id) => byId.get(id)).filter((p): p is Position => !!p)
    if (!pkg.chosenId) {
      const own = emptyTally()
      for (const p of members) tally(own, p, {}, suggestions)
      open.push({ pkg, own })
      continue
    }
    const offer = offerOf(pkg, pkg.chosenId)
    const prices = offer.prices
    const own = emptyTally()
    let amount = 0
    if (prices) {
      // per-position prices: every position resolves like anywhere else, the subcontractor part is shown apart
      for (const p of members) {
        if (p.up == null && prices[p.id] != null) amount += prices[p.id] * p.qty
        else tally(own, p, {}, suggestions)
      }
    } else {
      // old offer: its amount counts as before, the positions it did not price are our own items
      amount = offer.amount ?? 0
      for (const id of offer.missing ?? []) {
        const p = byId.get(id)
        if (p) tally(own, p, {}, suggestions)
      }
    }
    const noAmount = offer.amount == null && !prices
    const legacy = !prices && offer.amount != null
    if (legacy) legacyCount++
    if (noAmount) noAmountCount++
    chosen.push({ pkg, subId: pkg.chosenId, amount, noAmount, legacy, own })
  }

  const sections = new Map<string, SectionGroup>()
  for (const p of positions) {
    if (packaged.has(p.id)) continue
    const top = p.path?.[0]
    const key = top?.oz ?? ''
    const group = sections.get(key) ?? { label: top ? `${top.oz} ${top.label}`.trim() : 'Other positions', own: emptyTally(), count: 0 }
    tally(group.own, p, {}, suggestions)
    group.count++
    sections.set(key, group)
  }

  const sub: Record<string, number> = {}
  for (const pkg of packages) Object.assign(sub, subPrices(pkg))
  for (const p of positions) {
    if (p.up != null) continue
    if (sub[p.id] != null) apply.push({ id: p.id, price: sub[p.id], source: 'sub' })
    else if (suggestions.get(p.id)?.unitKnown) apply.push({ id: p.id, price: suggestions.get(p.id)!.price, source: 'db' })
  }

  const tallies = [...chosen.map((c) => c.own), ...open.map((o) => o.own), ...[...sections.values()].map((g) => g.own)]
  const total = round2(chosen.reduce((s, c) => s + c.amount, 0) + tallies.reduce((s, t) => s + t.amount, 0))
  const aiCount = tallies.reduce((s, t) => s + t.ai, 0)
  return {
    chosen,
    open,
    sections: [...sections.values()],
    total,
    apply,
    aiCount,
    unpriced: offerPositions(positions, packages, suggestions).filter((p) => p.up == null).length,
    legacyCount,
    noAmountCount,
  }
}

/** the positions as the X84 carries them: the same price rule as the total, so file and screen agree */
export function offerPositions(positions: readonly Position[], packages: readonly SubcontractPackage[], suggestions: Suggestions): Position[] {
  const sub: Record<string, number> = {}
  for (const pkg of packages) Object.assign(sub, subPrices(pkg))
  return positions.map((p) => {
    if (p.up != null) return p
    const up = sub[p.id] ?? (suggestions.get(p.id)?.unitKnown ? suggestions.get(p.id)!.price : null)
    return up == null ? p : { ...p, up }
  })
}
