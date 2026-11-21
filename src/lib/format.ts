const full = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qtyFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })

export const CURRENCY = '€'

/** €15,996.00 */
export const money = (v: number) => `${v < 0 ? '-' : ''}${CURRENCY}${full.format(Math.abs(v))}`

/** €318.4k / €1.00M / €0k */
export function moneyCompact(v: number): string {
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (a >= 1_000_000) return `${sign}${CURRENCY}${(a / 1_000_000).toFixed(2)}M`
  if (a >= 1000) return `${sign}${CURRENCY}${(a / 1000).toFixed(a >= 100_000 ? 1 : 1)}k`
  if (a === 0) return `${CURRENCY}0k`
  return `${sign}${CURRENCY}${a.toFixed(0)}`
}

export const qty = (v: number) => qtyFmt.format(v)

export const pct = (v: number) => `${Math.round(v)}%`

/** next "nice" cap above value (1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 steps) */
export function niceCap(v: number): number {
  if (v <= 0) return 0
  const target = v * 1.12
  const mag = 10 ** Math.floor(Math.log10(target))
  for (const s of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (s * mag >= target) return s * mag
  return 10 * mag
}

/** budget tone thresholds used by meters + alerts */
export function usageTone(p: number): 'ok' | 'caution' | 'warn' | 'over' {
  if (p > 100) return 'over'
  if (p >= 90) return 'warn'
  if (p >= 75) return 'caution'
  return 'ok'
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function relativeDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString('de-DE')
}
