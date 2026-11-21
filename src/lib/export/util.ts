import type { CategoryNode, ListDoc, Position, SourceInfo } from '../types'

/* ------------------------------------------------------------------ */
/* numbers                                                             */
/* ------------------------------------------------------------------ */

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** German number: 1.234,56 (fixed decimals) */
export function deNum(n: number, dec = 2): string {
  const neg = n < 0
  const s = Math.abs(n).toFixed(dec)
  const [i, f] = s.split('.')
  return (neg ? '-' : '') + group(i) + (f ? ',' + f : '')
}

/** German number with decimals only when needed (max 3): 70 / 1.300 / 6,25 */
export function deQty(n: number): string {
  const s = String(Math.round(n * 1000) / 1000)
  const [i, f] = s.split('.')
  return group(i) + (f ? ',' + f : '')
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
export const gp = (p: { qty: number; up: number | null }) => round2((p.up ?? 0) * p.qty)

/* ------------------------------------------------------------------ */
/* text                                                                */
/* ------------------------------------------------------------------ */

export const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (para.length <= width) {
      out.push(para)
      continue
    }
    let line = ''
    for (const word of para.split(/(?<=\s)/)) {
      if ((line + word).trimEnd().length > width && line) {
        out.push(line.trimEnd())
        line = ''
      }
      let w = word
      while (w.length > width) {
        out.push(w.slice(0, width))
        w = w.slice(width)
      }
      line += w
    }
    out.push(line.trimEnd())
  }
  return out
}

/** best-effort folding for fonts / code pages that lack a glyph */
const FOLD: Record<string, string> = {
  '–': '-', '—': '-', '‐': '-', '‑': '-', '−': '-', '„': '"', '“': '"', '”': '"', '‚': "'", '‘': "'", '’': "'", '…': '...',
  '•': '*', '·': '.', '€': 'EUR', ' ': ' ', ' ': ' ', ' ': ' ', '≥': '>=', '≤': '<=', '×': 'x', '→': '->', '←': '<-',
  '₂': '2', '₃': '3', '⁰': '0', '¹': '1', '⁴': '4', 'ž': 'z', 'š': 's', 'č': 'c', 'ć': 'c', 'ł': 'l', 'ő': 'o', 'ű': 'u', 'Ø': 'O', '⌀': 'O',
}
export function foldText(s: string, keep: (ch: string) => boolean): string {
  let o = ''
  for (const ch of s) {
    if (ch === '\t') o += ' '
    else if (keep(ch)) o += ch
    else {
      const f = FOLD[ch]
      if (f !== undefined) o += [...f].map((c) => (keep(c) ? c : '?')).join('')
      else {
        const d = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
        o += d && [...d].every(keep) ? d : '?'
      }
    }
  }
  return o
}

/* ------------------------------------------------------------------ */
/* OZ handling                                                         */
/* ------------------------------------------------------------------ */

export const normOz = (oz: string) => oz.split('.').map((s) => s.replace(/^0+(?=\d)/, '')).join('.')

export interface OzMask {
  levels: number[]
  item: number
  index: boolean
}

export function inferMask(doc: ListDoc, positions: Position[], hint?: SourceInfo['ozMask']): OzMask {
  const srcMask = hint ?? doc.source?.ozMask
  if (srcMask && srcMask.levels && srcMask.item) return srcMask
  let depth = 1
  for (const p of positions) depth = Math.max(depth, p.oz.split('.').length)
  const nlev = depth - 1
  const lens = Array.from({ length: depth }, () => 1)
  for (const p of positions) p.oz.split('.').forEach((s, i) => { lens[i] = Math.max(lens[i], s.length) })
  const total = () => lens.reduce((a, b) => a + b, 0)
  // expand to the customary widths (item 4, levels 2) while the 8 mask chars allow it
  while (total() < 8 && lens[nlev] < 4) lens[nlev]++
  for (let i = 0; i < nlev; i++) while (total() < 8 && lens[i] < 2) lens[i]++
  return { levels: lens.slice(0, nlev), item: lens[nlev], index: true }
}

export const maskString = (m: OzMask): string =>
  m.levels.map((l, i) => String(Math.min(i + 1, 9)).repeat(l)).join('') + 'P'.repeat(m.item) + (m.index ? 'I' : '')

/** XML RNoPart for one OZ part */
export function rnoPart(part: string, len: number): string {
  return /^\d+$/.test(part) ? part.padStart(len, '0') : part
}

/* ------------------------------------------------------------------ */
/* category tree                                                       */
/* ------------------------------------------------------------------ */

export interface Cat {
  oz: string
  label: string
  depth: number
  cats: Cat[]
  items: Position[]
}
export interface CatTree {
  roots: Cat[]
  /** positions that have no category at all */
  rootItems: Position[]
}

function chainOf(p: Position): { oz: string; label: string }[] {
  if (p.path && p.path.length) return p.path.map((c) => ({ oz: c.oz, label: c.label }))
  const parts = p.oz.split('.')
  const chain: { oz: string; label: string }[] = []
  for (let i = 1; i < parts.length; i++) {
    const label = i === parts.length - 1 ? p.category : i === 1 && p.group ? p.group : ''
    chain.push({ oz: parts.slice(0, i).join('.'), label })
  }
  return chain
}

/** builds the category tree (labels from tree/path, else from position.category/group) */
export function buildCats(positions: Position[], tree?: CategoryNode[]): CatTree {
  const roots: Cat[] = []
  const map = new Map<string, Cat>()
  const ensure = (oz: string, label: string): Cat => {
    let c = map.get(oz)
    if (c) {
      if (!c.label && label) c.label = label
      return c
    }
    const parts = oz.split('.')
    c = { oz, label, depth: parts.length, cats: [], items: [] }
    map.set(oz, c)
    if (parts.length === 1) roots.push(c)
    else ensure(parts.slice(0, -1).join('.'), '').cats.push(c)
    return c
  }
  const seed = (nodes: CategoryNode[]) => {
    for (const n of nodes) {
      ensure(n.oz, n.label)
      if (n.children?.length) seed(n.children)
    }
  }
  if (tree?.length) seed(tree)
  const rootItems: Position[] = []
  for (const p of positions) {
    const chain = chainOf(p)
    if (!chain.length) {
      rootItems.push(p)
      continue
    }
    let leaf: Cat | undefined
    for (const c of chain) leaf = ensure(c.oz, c.label)
    leaf!.items.push(p)
  }
  return { roots, rootItems }
}

export function catSum(c: Cat): number {
  return round2(c.items.reduce((s, p) => s + gp(p), 0) + c.cats.reduce((s, k) => s + catSum(k), 0))
}
export function catCount(c: Cat): number {
  return c.items.length + c.cats.reduce((s, k) => s + catCount(k), 0)
}
export function pruneEmpty(cats: Cat[]): Cat[] {
  return cats.map((c) => ({ ...c, cats: pruneEmpty(c.cats) })).filter((c) => c.items.length || c.cats.length)
}

/** flattened walk in document order */
export type Ev =
  | { k: 'open'; cat: Cat }
  | { k: 'item'; p: Position; cat?: Cat }
  | { k: 'close'; cat: Cat; sum: number }
export function walk(t: CatTree): Ev[] {
  const out: Ev[] = []
  for (const p of t.rootItems) out.push({ k: 'item', p })
  const rec = (c: Cat) => {
    out.push({ k: 'open', cat: c })
    for (const k of c.cats) rec(k)
    for (const p of c.items) out.push({ k: 'item', p, cat: c })
    out.push({ k: 'close', cat: c, sum: catSum(c) })
  }
  for (const c of t.roots) rec(c)
  return out
}

/* ------------------------------------------------------------------ */
/* diff of the user's list against the parsed original                 */
/* ------------------------------------------------------------------ */

export interface ListDiff {
  removed: Position[]
  added: Position[]
  /** same id, different qty/up/unit/text */
  changed: { orig: Position; now: Position; qty: boolean; up: boolean; text: boolean }[]
  /** same id, different OZ or category */
  moved: { orig: Position; now: Position }[]
  any: boolean
}

export function diffList(doc: ListDoc, positions: Position[]): ListDiff {
  const orig = new Map(doc.positions.map((p) => [p.id, p]))
  const now = new Map(positions.map((p) => [p.id, p]))
  const removed = doc.positions.filter((p) => !now.has(p.id))
  const added = positions.filter((p) => !orig.has(p.id))
  const changed: ListDiff['changed'] = []
  const moved: ListDiff['moved'] = []
  for (const p of positions) {
    const o = orig.get(p.id)
    if (!o) continue
    const qty = Math.abs(o.qty - p.qty) > 1e-9
    const up = (o.up ?? null) !== (p.up ?? null)
    const text = o.short !== p.short || (o.long ?? '') !== (p.long ?? '') || o.unit !== p.unit
    if (qty || up || text) changed.push({ orig: o, now: p, qty, up, text })
    if (o.oz !== p.oz || o.category !== p.category) moved.push({ orig: o, now: p })
  }
  return { removed, added, changed, moved, any: !!(removed.length || added.length || changed.length || moved.length) }
}

/* ------------------------------------------------------------------ */
/* misc                                                                */
/* ------------------------------------------------------------------ */

export function baseName(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i > 0 ? fileName.slice(0, i) : fileName
}
export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i > 0 ? fileName.slice(i + 1) : ''
}

export const enc = new TextEncoder()
export const dec = (b: Uint8Array) => new TextDecoder('utf-8').decode(b)

/** dd.mm.yyyy from an ISO or dd.mm.yy(yy) date */
export function deDate(d?: string, now = new Date()): string {
  if (d) {
    const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`
    const de = d.match(/^(\d{2})\.(\d{2})\.(\d{2})$/)
    if (de) return `${de[1]}.${de[2]}.20${de[3]}`
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(d)) return d
  }
  return `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`
}
export const isoDate = (now: Date) => now.toISOString().slice(0, 10)
