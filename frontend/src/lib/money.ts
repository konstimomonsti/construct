import type { CategoryRef } from './gaeb'

type AmountInput = {
  qty: number
  up: number | null
  lumpSum?: boolean
  quantityMissing?: boolean
  totalRule?: 'unit_price_only' | 'conditional'
  path?: CategoryRef[]
}

function decimal(value: number): [bigint, number] {
  const [mantissa, exponent = '0'] = String(value).split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  return [BigInt(whole + fraction), fraction.length - Number(exponent)]
}

function roundCents(value: bigint, scale: number): bigint {
  if (scale <= 2) return value * 10n ** BigInt(2 - scale)
  const divisor = 10n ** BigInt(scale - 2)
  const magnitude = value < 0n ? -value : value
  const cents = (magnitude + divisor / 2n) / divisor
  return value < 0n ? -cents : cents
}

export function round2(value: number): number {
  if (!Number.isFinite(value)) return value
  return Number(roundCents(...decimal(value))) / 100
}

function positionCents(position: AmountInput): bigint {
  const quantity = position.lumpSum ? 1 : position.quantityMissing ? null : position.qty
  if (position.up == null || quantity == null || !Number.isFinite(position.up) || !Number.isFinite(quantity)) return 0n
  const [rate, rateScale] = decimal(position.up)
  const [qty, qtyScale] = decimal(quantity)
  return roundCents(rate * qty, rateScale + qtyScale)
}

/** Position amounts retain their sign. Rollups include firm items only. */
export const positionTotal = (position: AmountInput) => Number(positionCents(position)) / 100
export const isExcludedPosition = (position: AmountInput) => Boolean(position.totalRule || position.path?.some(({ gaebSectionScope }) =>
  gaebSectionScope?.NotAppl === 'Yes'
  || (gaebSectionScope?.Accepted !== 'Yes' && /^0*[1-9]\d*$/.test(gaebSectionScope?.ALNBSerNo ?? '')),
))
export const includedPositionTotal = (position: AmountInput) => isExcludedPosition(position) ? 0 : positionTotal(position)
export const sumPositionTotals = (positions: readonly AmountInput[]) =>
  Number(positions.reduce((sum, position) => sum + (isExcludedPosition(position) ? 0n : positionCents(position)), 0n)) / 100
