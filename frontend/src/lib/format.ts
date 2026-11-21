/** European (German) number formatting throughout the UI: 1.234,56 € · 66 % · 21.11.2026 */
export const LOCALE = 'de-DE'
const NBSP = '\u00a0'
const full = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qtyFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 3 })
const oneDecimal = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const twoDecimals = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })

export const CURRENCY = '€'

/** 15.996,00 € */
export const money = (v: number) => `${v < 0 ? '-' : ''}${full.format(Math.abs(v))}${NBSP}${CURRENCY}`

/** 318,4 T€ / 1,00 Mio. € / 0 € */
export function moneyCompact(v: number): string {
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (a >= 1_000_000) return `${sign}${twoDecimals.format(a / 1_000_000)}${NBSP}Mio.${NBSP}${CURRENCY}`
  if (a >= 1000) return `${sign}${oneDecimal.format(a / 1000)}${NBSP}T${CURRENCY}`
  if (a === 0) return `0${NBSP}${CURRENCY}`
  return `${sign}${whole.format(a)}${NBSP}${CURRENCY}`
}

export const qty = (v: number) => qtyFmt.format(v)

/** 1.234 */
export const count = (v: number) => whole.format(v)

/** 66 % */
export const pct = (v: number) => `${whole.format(Math.round(v))}${NBSP}%`

/** 94,3 % */
export const pct1 = (v: number) => `${oneDecimal.format(v)}${NBSP}%`

/** Plain decimal for editable inputs, without grouping: 1234,5 */
export const inputNumber = (v: number) => String(Math.round(v * 1000) / 1000).replace('.', ',')

/**
 * Reads European and plain input: "1.234,56", "1234,56", "12,5", "1.234" (thousands) and "12.5".
 * Returns NaN for empty or unreadable text.
 */
export function parseNumber(text: string): number {
  const t = text.trim().replace(/[\s\u00a0\u202f€]/g, '')
  if (t === '') return NaN
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'))
  if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ''))
  return Number(t)
}

/** next "nice" cap above value (1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 steps) */
export function niceCap(v: number): number {
  if (v <= 0) return 0
  const target = v * 1.12
  const mag = 10 ** Math.floor(Math.log10(target))
  for (const s of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (s * mag >= target) return s * mag
  return 10 * mag
}

/** Default for projects and lists that have no pre-priced estimate. */
export const fixedBudget = (initialTotal: number): number => niceCap(initialTotal) || 50_000

/** budget tone thresholds used by meters + alerts */
export function usageTone(p: number): 'ok' | 'caution' | 'warn' | 'over' {
  if (p > 100) return 'over'
  if (p >= 90) return 'warn'
  if (p >= 75) return 'caution'
  return 'ok'
}

export const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`

export function relativeDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString(LOCALE)
}
