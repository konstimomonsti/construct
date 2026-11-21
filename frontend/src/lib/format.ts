/**
 * Numbers follow the German convention (1.794.611,45 €) because every list is a German
 * GAEB tender; the interface copy stays English. Change LOCALE to switch everywhere.
 */
export const LOCALE = 'de-DE'
const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
const full = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qtyFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 3 })
const intFmt = new Intl.NumberFormat(LOCALE)
const oneDecimal = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export const CURRENCY = '€'
const NBSP = '\u00a0'

/** 15.996,00 € (positions, lists) */
export const money = (v: number) => `${v < 0 ? '−' : ''}${full.format(Math.abs(v))}${NBSP}${CURRENCY}`

/** 1.794.611 € (no cents) for project / workspace totals and caps */
export const moneyWhole = (v: number) => `${v < 0 ? '−' : ''}${whole.format(Math.abs(Math.round(v)))}${NBSP}${CURRENCY}`

/** 5.700,00 (no currency sign, for input fields) */
export const amount = (v: number) => full.format(v)

/** 3.052 */
export const int = (v: number) => intFmt.format(v)

/**
 * Parse what someone typed into a number field. Accepts German (5.700,50) and
 * plain (5700.50) input; a dot followed by exactly three digits is a thousands separator.
 */
export function parseNumber(raw: string): number | null {
  const t = raw.trim().replace(/[\s€\u00a0]/g, '')
  if (!t) return null
  let n: number
  if (t.includes(',')) n = Number(t.replace(/\./g, '').replace(',', '.'))
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) n = Number(t.replace(/\./g, ''))
  else n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** €318.4k / €1.00M / €0 */
export function moneyCompact(v: number): string {
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  const f = (n: number, d: number) => n.toFixed(d).replace('.', ',')
  if (a >= 1_000_000) return `${sign}${f(a / 1_000_000, 2)}${NBSP}Mio.${NBSP}${CURRENCY}`
  if (a >= 1000) return `${sign}${f(a / 1000, 1)}${NBSP}Tsd.${NBSP}${CURRENCY}`
  if (a === 0) return `0${NBSP}${CURRENCY}`
  return `${sign}${a.toFixed(0)}${NBSP}${CURRENCY}`
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

/** status in words so budget state never relies on colour alone */
export function budgetStatus(total: number, cap: number): { tone: 'ok' | 'caution' | 'warn' | 'over' | 'none'; word: string; pct: number } {
  if (!cap) return { tone: 'none', word: 'No cap', pct: 0 }
  const pct = (total / cap) * 100
  const tone = usageTone(pct)
  const word = tone === 'over' ? 'Over cap' : pct === 100 ? 'At cap' : tone === 'warn' ? 'Almost at cap' : tone === 'caution' ? 'Near cap' : 'On track'
  /* caution / warn / over all count as "needs attention" (see needsAttention) */
  return { tone, word, pct }
}

export const plural = (n: number, one: string, many: string) => `${intFmt.format(n)} ${n === 1 ? one : many}`

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

/** one rule for every screen: anything at 75 % of its cap or more needs attention */
export const needsAttention = (total: number, cap: number) => {
  const t = budgetStatus(total, cap).tone
  return t === 'caution' || t === 'warn' || t === 'over'
}

/** GAEB exchange phase from a file name or format string (D84, X86 …) */
const PHASES: Record<string, string> = {
  '81': 'Bill of quantities', '82': 'Cost estimate', '83': 'Tender request', '84': 'Bid', '85': 'Alternative bid', '86': 'Award',
}
export function gaebPhase(...sources: (string | undefined)[]): { code: string; name: string; n: number } | null {
  for (const s of sources) {
    const m = s?.match(/\b([DPX])(8[1-6])\b/i) ?? s?.match(/\.([DPX])(8[1-6])$/i)
    if (m) return { code: `${m[1].toUpperCase()}${m[2]}`, name: PHASES[m[2]], n: Number(m[2]) }
  }
  return null
}

/** keep German compound fragments like "Baustelleneinrichtung und -räumung" from breaking at the hyphen */
export const nbHyphen = (s: string) => s.replace(/(\s)-(\p{L})/gu, '$1\u2011$2')
