import { parseNumber } from './format'

export type BidPosition = {
  key: string; id: string; text: string | null; quantity: string; unit: string | null; can_change_quantity: boolean
}
export type Opportunity = {
  position: string; quantity: string; title: string; rule_id: string; finding_id: string; ai_reviewed: boolean
}
export type QuantityConflict = {
  position: string; quantity: string; unit: string
  written: { quantity: string; quote: string }[]
}
export type PricingTender = {
  input_hash: string; currency: string; assessment_layers: number[]; positions: BidPosition[]; opportunities: Opportunity[]
  quantity_conflicts?: QuantityConflict[]
}
export type Rates = { cost: string; standard: string; floor: string; ceiling: string }
export type Market = { id: number; threshold: string; chance: string }
export type Change = { position: string; quantity: string; share: string; other: string; rule?: string }
export type Strategy = {
  bid_total: string | null; expected_profit: string; win_probability: string
  worst_awarded_profit: string | null; base_profit: string; optimality_gap_bound: string | null; rates: Record<string, string>
}
export type PricingResult = {
  currency: string
  quantity_conflicts?: QuantityConflict[]
  strategies: Record<'standard' | 'price_only' | 'quantity_aware', Strategy>
}
const PERCENT = 10_000

function number(raw: string, name: string, places: number): number {
  const parsed = parseNumber(raw)
  if (parsed == null || parsed < 0 || Number(parsed.toFixed(places)) !== parsed) {
    throw new Error(`${name} needs a nonnegative number with up to ${places} decimal places.`)
  }
  return parsed
}

function chance(raw: string, name: string) {
  const value = number(raw, name, 2)
  if (value > 100) throw new Error(`${name} must be between 0% and 100%.`)
  return Math.round(value * 100)
}

export function bidAssumptions(tender: PricingTender, rates: Record<string, Rates>, markets: Market[],
  changes: Change[], correction: string) {
  const prices = Object.fromEntries(tender.positions.map(({key}) => {
    const rate = rates[key]
    const cost = number(rate.cost, `${key} unit cost`, 2)
    const standard = number(rate.standard, `${key} standard rate`, 2)
    const floor = rate.floor.trim() ? number(rate.floor, `${key} lower rate`, 2) : standard
    const ceiling = rate.ceiling.trim() ? number(rate.ceiling, `${key} higher rate`, 2) : standard
    if (!(cost <= floor && floor <= standard && standard <= ceiling)) {
      throw new Error(`Position ${key} needs unit cost ≤ lower rate ≤ standard ≤ higher rate.`)
    }
    return [key, { unit_cost: cost, standard_rate: standard, min_rate: floor, max_rate: ceiling }]
  }))
  const correctionChance = changes.length ? chance(correction, 'Quantity correction chance') : 0
  const blocked = new Set(tender.quantity_conflicts?.map(({position}) => position))
  const adjustments = Object.fromEntries(changes.map((change) => {
    if (blocked.has(change.position)) throw new Error(`Confirm the written quantity for ${change.position} before adding a quantity change.`)
    const share = chance(change.share, `${change.position} share at bid rate`)
    const quantity = number(change.quantity, `${change.position} extra quantity`, 6)
    if (!quantity) throw new Error(`Enter a positive extra quantity for ${change.position}.`)
    return [change.position, {
      ...(change.rule ? { finding_rule: change.rule } : { extra_quantity: quantity }),
      quoted_rate_share: (share / PERCENT).toFixed(4),
      ...(share < PERCENT ? { other_unit_rate: number(change.other, `${change.position} other settlement rate`, 2) } : {}),
    }]
  }))
  const marketWeights = markets.map(({ chance: raw }, i) => chance(raw, `Market ${i + 1} probability`))
  if (marketWeights.some((weight) => weight === 0) || marketWeights.reduce((a, b) => a + b, 0) !== PERCENT) {
    throw new Error('Enter positive market probabilities that add up to 100%.')
  }
  const scenarios = markets.flatMap(({ threshold }, i) => {
    const winning_bid_ceiling = number(threshold, `Market ${i + 1} estimated competing bid`, 2)
    const weight = marketWeights[i]
    return [
      { name: `Market ${i + 1} · as tendered`, weight: weight * (PERCENT - correctionChance), changes: {} },
      { name: `Market ${i + 1} · corrected quantities`, weight: weight * correctionChance, changes: adjustments },
    ].filter((s) => s.weight > 0).map(({ weight: joint, ...scenario }) => ({
      ...scenario, probability: (joint / (PERCENT * PERCENT)).toFixed(8), winning_bid_ceiling,
    }))
  })
  return { input_hash: tender.input_hash, assumptions: { currency: tender.currency, prices, scenarios } }
}

export async function bidPricing<T>(list: string, payload?: ReturnType<typeof bidAssumptions>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/workspace/bid-pricing?id=${encodeURIComponent(list)}`, {
    ...(payload && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), signal,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Bid simulator unavailable. Try again.')
  return data as T
}
