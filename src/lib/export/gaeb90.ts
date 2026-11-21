/**
 * GAEB 90 (D83 / D84 / D86) writer and in-place patcher.
 * 80-column fixed records: cols 1-2 record type, cols 3-74 content, cols 75-80 running line counter.
 * Layout mirrors ../data/8209.003_Leistungsverzeichnis_leer.D83, ../data/[ORT_024] LV24069.D86 and
 * ../data/Angebot AN24-0305.D84 (cp437 / cp1252 like the originals).
 */
import type { ListDoc, Position } from '../types'
import { type OzMask, buildCats, deDate, diffList, foldText, gp, inferMask, maskString, round2, walk } from './util'

/* ------------------------------------------------------------------ */
/* code pages (mirror of decodeGaeb90 in gaeb.ts)                      */
/* ------------------------------------------------------------------ */

const DOS_MAP: Record<string, number> = {
  ä: 0x84, ü: 0x81, ö: 0x94, ß: 0xe1, Ä: 0x8e, Ü: 0x9a, Ö: 0x99, '°': 0xf8, '²': 0xfd, '³': 0xfc, µ: 0xe6, '±': 0xf1,
  é: 0x82, à: 0x85, è: 0x8a, ç: 0x87, '½': 0xab, '¼': 0xac, Σ: 0xe4, '·': 0xf9,
  â: 0x83, å: 0x86, ê: 0x88, ë: 0x89, ï: 0x8b, î: 0x8c, ì: 0x8d, Å: 0x8f, É: 0x90, æ: 0x91, Æ: 0x92, ô: 0x93, ò: 0x95, û: 0x96, ù: 0x97, ÿ: 0x98,
  '¢': 0x9b, '£': 0x9c, '¥': 0x9d, á: 0xa0, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ª: 0xa6, º: 0xa7, '¿': 0xa8, '¬': 0xaa, '¡': 0xad, '«': 0xae, '»': 0xaf,
  '÷': 0xf6, '≈': 0xf7,
}
const WIN_EXTRA: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 }

export function isDosEncoding(bytes: Uint8Array): boolean {
  let dos = 0
  let win = 0
  for (const b of bytes) {
    if (b === 0x84 || b === 0x81 || b === 0x94 || b === 0xe1 || b === 0x8e || b === 0x9a || b === 0x99) dos++
    if (b === 0xe4 || b === 0xfc || b === 0xf6 || b === 0xdf || b === 0xc4 || b === 0xdc || b === 0xd6) win++
  }
  return win < dos
}

const keepDos = (ch: string) => ch.charCodeAt(0) < 128 || ch in DOS_MAP
const keepWin = (ch: string) => ch.charCodeAt(0) < 256 || ch in WIN_EXTRA

/** unicode string → byte string (1 char = 1 byte) in the target code page */
export function toByteString(s: string, dos: boolean): string {
  const f = foldText(s, dos ? keepDos : keepWin)
  let o = ''
  for (const ch of f) {
    const c = ch.charCodeAt(0)
    if (dos) o += c < 128 ? ch : String.fromCharCode(DOS_MAP[ch] ?? 0x3f)
    else o += c < 256 ? ch : String.fromCharCode(WIN_EXTRA[ch] ?? 0x3f)
  }
  return o
}

/** what a string looks like after a roundtrip through the DOS code page */
export function dosFold(s: string): string {
  const inv: Record<number, string> = {}
  for (const [k, v] of Object.entries(DOS_MAP)) inv[v] = k
  let o = ''
  for (const ch of toByteString(s, true)) o += ch.charCodeAt(0) < 128 ? ch : (inv[ch.charCodeAt(0)] ?? '?')
  return o
}

export function latin1ToBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b
}
export function bytesToLatin1(b: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH))
  return s
}

/* ------------------------------------------------------------------ */
/* record helpers                                                      */
/* ------------------------------------------------------------------ */

type Phase = '83' | '84' | '86'

function put(buf: string[], col: number, s: string) {
  for (let i = 0; i < s.length && col + i < buf.length; i++) buf[col + i] = s[i]
}
const blank = () => new Array<string>(74).fill(' ')
const rec = (type: string, content = '') => (type + content).padEnd(74, ' ').slice(0, 74)
const digits = (n: number, w: number) => String(Math.max(0, Math.round(n))).padStart(w, '0').slice(-w)

function levelKey(parts: string[], mask: OzMask, levelPad: '0' | ' ', isItem = false): string {
  let s = ''
  const lv = isItem ? parts.slice(0, -1) : parts
  for (let i = 0; i < mask.levels.length; i++) {
    const len = mask.levels[i]
    const part = lv[i]
    if (part === undefined) s += ' '.repeat(len)
    else if (levelPad === ' ') s += part.padStart(len, ' ').slice(-len)
    else s += (/^\d+$/.test(part) ? part.padStart(len, '0') : part.padEnd(len, ' ')).slice(0, len)
  }
  if (isItem) s += parts[parts.length - 1].padStart(mask.item, ' ').slice(-mask.item)
  return s.padEnd(9, ' ').slice(0, 9)
}

/** the file's OZ mask → normalized dotted OZ (same rule as formatOz in gaeb.ts) */
function normKey(raw: string, mask: string): string {
  const parts: string[] = []
  let i = 0
  const groups = mask.match(/(.)\1*/g) ?? []
  for (const g of groups) {
    const seg = raw.slice(i, i + g.length)
    i += g.length
    if (g[0] === 'I') continue
    const t = seg.trim()
    if (t) parts.push(t.replace(/^0+(?=\d)/, ''))
  }
  return parts.join('.')
}

function maskToObj(mask: string): OzMask {
  const groups = mask.replace(/I$/, '').match(/(.)\1*/g) ?? []
  const levels: number[] = []
  let item = 4
  for (const g of groups) {
    if (g[0] === 'P') item = g.length
    else levels.push(g.length)
  }
  return { levels, item, index: /I$/.test(mask) }
}

function shortDate(d: string): string {
  const full = deDate(d) // dd.mm.yyyy
  return full.slice(0, 6) + full.slice(8)
}

const LEVEL_LABELS = ['Titel', 'Bereich', 'Abschnitt', 'Unterabschnitt', 'Ebene 5', 'Ebene 6', 'Ebene 7', 'Ebene 8']

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (para.length <= width) {
      out.push(para)
      continue
    }
    let line = ''
    for (const word of para.split(' ')) {
      const add = line ? line + ' ' + word : word
      if (add.length > width && line) {
        out.push(line)
        line = word
      } else line = add
      while (line.length > width) {
        out.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    out.push(line)
  }
  return out
}

interface PriceStyle {
  /** 10 digit EP with 2 decimals (ORT_024 / StBALV) vs 11 digit with 3 decimals (Angebot) */
  wide: boolean
}
const needsWide = (positions: Position[]) => positions.some((p) => p.up != null && Math.abs(p.up * 100 - Math.round(p.up * 100)) > 1e-6)

function rec23(key: string, p: Position, style: PriceStyle): string {
  const b = blank()
  put(b, 0, '23' + key)
  const g = digits(gp(p) * 100, 12)
  const q = digits(p.qty * 1000, 11)
  if (style.wide) {
    put(b, 12, digits((p.up ?? 0) * 1000, 11))
    put(b, 24, g)
    put(b, 37, q)
  } else {
    put(b, 12, digits((p.up ?? 0) * 100, 10))
    put(b, 24, g)
    put(b, 37, q)
  }
  return b.join('')
}

function textRecords(p: Position, dos: boolean, longTexts: boolean): string[] {
  const out: string[] = []
  for (const l of wrap(toByteString(p.short, dos).replace(/\s*\n\s*/g, ' '), 70)) out.push(rec('25', l))
  if (longTexts && p.long) {
    for (const para of toByteString(p.long, dos).split('\n')) {
      if (!para.trim()) out.push(rec('26', ''))
      else for (const l of wrap(para, 69)) out.push(rec('26', '   ' + l))
    }
  }
  return out
}

function rec21(key: string, p: Position, dos: boolean): string {
  const b = blank()
  put(b, 0, '21' + key)
  put(b, 11, 'NNN')
  put(b, 23, digits(p.qty * 1000, 11))
  put(b, 34, toByteString(p.unit, dos).slice(0, 4))
  return b.join('')
}

/* ------------------------------------------------------------------ */
/* generator                                                           */
/* ------------------------------------------------------------------ */

export interface Gen90Opts {
  doc: ListDoc
  positions: Position[]
  tree?: Parameters<typeof buildCats>[1]
  phase: Phase
  longTexts: boolean
  prices: boolean
  now?: Date
  mask?: OzMask
  dos?: boolean
}

function addCounters(lines: string[]): string {
  return lines.map((l, i) => l.padEnd(74, ' ').slice(0, 74) + String(i + 1).padStart(6, '0')).join('\r\n') + '\r\n'
}

export function generateGaeb90(o: Gen90Opts): Uint8Array {
  const dos = o.dos ?? true
  const phase = o.phase
  const priced = phase !== '83' && o.prices
  const t = buildCats(o.positions, o.tree)
  const mask = o.mask ?? inferMask(o.doc, o.positions)
  const style: PriceStyle = { wide: needsWide(o.positions) }
  const maskStr = maskString(mask)
  const T = (s: string) => toByteString(s, dos)
  const lines: string[] = []

  const h = blank()
  put(h, 10, phase + (phase === '84' ? 'K' : 'L'))
  put(h, 28, T(o.doc.project ?? '').slice(0, 32))
  put(h, 62, maskStr.padEnd(9).slice(0, 9))
  put(h, 71, '90')
  lines.push('00' + h.join('').slice(2))
  const l1 = blank()
  put(l1, 0, '01' + T(o.doc.title || o.doc.projectLabel || '').slice(0, 40))
  const d = shortDate(o.doc.date ?? '')
  put(l1, 42, d)
  if (phase !== '83') put(l1, 50, d)
  if (phase === '86') put(l1, 63, '0')
  lines.push(l1.join(''))
  lines.push(rec('02', T(o.doc.projectLabel ?? o.doc.project ?? '').slice(0, 72)))
  lines.push(rec('03'))
  if (phase !== '83') lines.push(rec('04'))
  if (phase === '86') lines.push(rec('06', T('4              Löhne         Stoffe        Geräte        Sonstiges')))
  lines.push(rec('08', 'EUR   Euro'))

  let count = 0
  let total = 0
  for (const ev of walk(t)) {
    if (ev.k === 'open') {
      const parts = ev.cat.oz.split('.')
      const key = levelKey(parts, mask, '0')
      const b = blank()
      put(b, 0, '11' + key)
      put(b, 11, 'N')
      put(b, 16, LEVEL_LABELS[ev.cat.depth - 1] ?? 'Ebene')
      lines.push(b.join(''))
      for (const l of wrap(T(ev.cat.label || ' ').replace(/\s+/g, ' '), 40)) lines.push(rec('12', l))
    } else if (ev.k === 'item') {
      const key = levelKey(ev.p.oz.split('.'), mask, '0', true)
      lines.push(rec21(key, ev.p, dos))
      if (priced && ev.p.up != null) lines.push(rec23(key, ev.p, style))
      lines.push(...textRecords(ev.p, dos, o.longTexts))
      count++
      total += gp(ev.p)
    } else {
      const key = levelKey(ev.cat.oz.split('.'), mask, '0')
      lines.push(rec('31', key))
      if (phase !== '83') {
        const b = blank()
        put(b, 0, '32' + key)
        put(b, 12, digits(ev.sum * 100, 12) + '1000000')
        lines.push(b.join(''))
      }
    }
  }
  const b99 = blank()
  put(b99, 0, '99')
  if (phase === '83') {
    put(b99, 19, '1900')
    put(b99, 67, digits(count, 5))
  } else {
    put(b99, 0, '99' + digits(priced ? total * 100 : 0, 12) + '1000000' + '1900' + '000000000000')
    put(b99, 61, digits(count, 11))
  }
  lines.push(b99.join(''))
  return latin1ToBytes(addCounters(lines))
}

/* ------------------------------------------------------------------ */
/* patcher                                                             */
/* ------------------------------------------------------------------ */

interface Block {
  n: number
  start: number
  end: number
  key: string
  oz: string
}

interface Scan90 {
  lines: string[]
  eol: string
  tailEol: boolean
  phase: string
  mask: string
  blocks: Block[]
  /** normalized cat oz → open/close line index */
  cats: Map<string, { open: number; close: number; close32: number; depth: number }>
  levelPad: '0' | ' '
  wide: boolean
  idx99: number
}

function scan90(text: string): Scan90 {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const tailEol = text.endsWith(eol)
  const lines = text.split(eol)
  if (tailEol) lines.pop()
  let mask = '1122PPPPI'
  let phase = '83'
  let levelPad: '0' | ' ' = '0'
  let wide = false
  let idx99 = -1
  const blocks: Block[] = []
  const byOz = new Map<string, Block>()
  const cats = new Map<string, { open: number; close: number; close32: number; depth: number }>()
  const openStack: string[] = []
  let cur: Block | null = null
  const boundary = new Set(['21', '11', '20', '31', '32', '99', '00'])
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const r = l.slice(0, 2)
    if (cur && (boundary.has(r) || (r === '23' && l.slice(2, 11) !== cur.key))) {
      cur.end = i
      cur = null
    }
    if (r === '00') {
      const m = l.match(/(\d{2})([LKA])\s/)
      if (m) phase = m[1]
      const mk = l.slice(62, 71).trim()
      if (/^[1-9P]+I?$/.test(mk)) mask = mk
    } else if (r === '11') {
      const oz = normKey(l.slice(2, 11), mask)
      cats.set(oz, { open: i, close: -1, close32: -1, depth: oz.split('.').length })
      openStack.push(oz)
    } else if (r === '31') {
      const oz = normKey(l.slice(2, 11), mask)
      const c = cats.get(oz)
      if (c) c.close = i
    } else if (r === '32') {
      const oz = normKey(l.slice(2, 11), mask)
      const c = cats.get(oz)
      if (c) c.close32 = i
    } else if (r === '21' || r === '23') {
      const key = l.slice(2, 11)
      const oz = normKey(key, mask)
      if (r === '21') {
        if (blocks.length === 0 && key[0] === ' ') levelPad = ' '
        cur = { n: blocks.length, start: i, end: lines.length, key, oz }
        blocks.push(cur)
        byOz.set(oz, cur)
      } else {
        let b = byOz.get(oz)
        if (!b) {
          b = { n: blocks.length, start: i, end: lines.length, key, oz }
          blocks.push(b)
          byOz.set(oz, b)
        }
        cur = b
        if (/^\d{11}$/.test(l.slice(12, 23)) && l[23] === ' ') wide = true
      }
    } else if (r === '99') idx99 = i
  }
  if (cur) cur.end = idx99 >= 0 ? idx99 : lines.length
  return { lines, eol, tailEol, phase, mask, blocks, cats, levelPad, wide, idx99 }
}

interface PatchOpts {
  longTexts?: boolean
  prices?: boolean
  dos: boolean
}

export interface Patch90Result {
  bytes: Uint8Array
  changed: boolean
}

export function patchGaeb90(original: Uint8Array, doc: ListDoc, positions: Position[], opts: Partial<PatchOpts> = {}): Patch90Result {
  const diff = diffList(doc, positions)
  if (!diff.any) return { bytes: original, changed: false }
  const dos = opts.dos ?? isDosEncoding(original)
  const text = bytesToLatin1(original)
  const sc = scan90(text)
  const maskObj = maskToObj(sc.mask)
  const priced = sc.phase !== '83'
  const style: PriceStyle = { wide: sc.wide }
  const blockOf = (p: Position): Block | undefined => {
    const m = /^p(\d+)$/.exec(p.id)
    const byIdx = m ? sc.blocks[parseInt(m[1], 10)] : undefined
    return byIdx
  }
  const removeIdx = new Set<number>()
  const replace = new Map<number, string>()
  const insertBefore = new Map<number, string[]>()
  const addInsert = (idx: number, ls: string[]) => insertBefore.set(idx, [...(insertBefore.get(idx) ?? []), ...ls])
  const touchedCats = new Set<string>()
  const touch = (oz: string) => {
    const parts = oz.split('.')
    for (let i = 1; i < parts.length; i++) touchedCats.add(parts.slice(0, i).join('.'))
  }

  const modifiedBlock = (b: Block, now: Position, orig: Position): string[] => {
    const ls = sc.lines.slice(b.start, b.end)
    let out = [...ls]
    const i21 = out.findIndex((l) => l.startsWith('21'))
    const qtyChanged = Math.abs(orig.qty - now.qty) > 1e-9
    const upChanged = (orig.up ?? null) !== (now.up ?? null)
    if (i21 >= 0 && qtyChanged) out[i21] = out[i21].slice(0, 23) + digits(now.qty * 1000, 11) + out[i21].slice(34)
    if (i21 >= 0 && orig.unit !== now.unit) out[i21] = out[i21].slice(0, 34) + toByteString(now.unit, dos).slice(0, 4).padEnd(4, ' ') + out[i21].slice(38)
    if (priced && (qtyChanged || upChanged)) {
      const i23 = out.findIndex((l) => l.startsWith('23'))
      const key = b.key
      if (now.up == null) {
        if (i23 >= 0) out.splice(i23, 1)
      } else if (i23 >= 0) {
        const line = out[i23]
        const wide = /^\d{11}$/.test(line.slice(12, 23)) && line[23] === ' '
        const hasQty = /^\d{11}$/.test(line.slice(37, 48))
        let nl = rec23(key, now, { wide })
        if (!hasQty) nl = nl.slice(0, 37) + ' '.repeat(11) + nl.slice(48)
        out[i23] = nl.padEnd(74, ' ').slice(0, 74) + line.slice(74)
      } else {
        const at = i21 >= 0 ? i21 + 1 : 0
        out.splice(at, 0, rec23(key, now, style))
      }
    }
    if (orig.short !== now.short || (orig.long ?? '') !== (now.long ?? '')) {
      out = out.filter((l) => !(l.startsWith('25') || l.startsWith('26')))
      let at = 0
      out.forEach((l, i) => {
        if (/^(21|23|30)/.test(l)) at = i + 1
      })
      out.splice(at, 0, ...textRecords(now, dos, true))
    }
    return out
  }

  // removals
  for (const p of diff.removed) {
    const b = blockOf(p)
    if (!b) continue
    for (let i = b.start; i < b.end; i++) removeIdx.add(i)
    touch(p.oz)
  }
  const removedIds = new Set(diff.removed.map((p) => p.id))
  const movedIds = new Set(diff.moved.map((m) => m.now.id))
  // in-place edits
  for (const c of diff.changed) {
    if (removedIds.has(c.now.id) || movedIds.has(c.now.id)) continue
    const b = blockOf(c.now)
    if (!b) continue
    const nb = modifiedBlock(b, c.now, c.orig)
    for (let i = b.start; i < b.end; i++) removeIdx.add(i)
    insertBefore.set(b.start, [...(insertBefore.get(b.start) ?? []), ...nb])
    touch(c.now.oz)
  }

  // moves and additions: generate / re-key and insert at end of target category
  type Ins = { oz: string; lines: string[]; p: Position }
  const ins: Ins[] = []
  for (const m of diff.moved) {
    if (removedIds.has(m.now.id)) continue
    const b = blockOf(m.now)
    if (!b) continue
    const nb = modifiedBlock(b, m.now, m.orig)
    const key = levelKey(m.now.oz.split('.'), maskObj, sc.levelPad, true)
    const re = nb.map((l) => (l.startsWith('21') || l.startsWith('23') ? l.slice(0, 2) + key + l.slice(11) : l))
    for (let i = b.start; i < b.end; i++) removeIdx.add(i)
    touch(m.orig.oz)
    touch(m.now.oz)
    ins.push({ oz: m.now.oz, lines: re, p: m.now })
  }
  for (const p of diff.added) {
    const key = levelKey(p.oz.split('.'), maskObj, sc.levelPad, true)
    const ls = [rec21(key, p, dos)]
    if (priced && p.up != null && opts.prices !== false) ls.push(rec23(key, p, style))
    ls.push(...textRecords(p, dos, true))
    touch(p.oz)
    ins.push({ oz: p.oz, lines: ls, p })
  }
  const endOfBody = sc.idx99 >= 0 ? sc.idx99 : sc.lines.length
  const newCatLines = new Map<string, string[]>() // parent close idx → lines (grouped by cat chain)
  const createdBy = new Map<string, string[]>()
  const created = new Set<string>()
  for (const x of ins) {
    const parts = x.oz.split('.')
    const catOz = parts.slice(0, -1).join('.')
    const cat = sc.cats.get(catOz)
    if (cat && cat.close >= 0) {
      addInsert(cat.close, x.lines)
      continue
    }
    // create missing category chain
    let k = parts.length - 1
    while (k > 0 && !sc.cats.has(parts.slice(0, k).join('.'))) k--
    const parent = k > 0 ? sc.cats.get(parts.slice(0, k).join('.')) : undefined
    const at = parent && parent.close >= 0 ? parent.close : endOfBody
    const bucket = `${at}`
    const out = newCatLines.get(bucket) ?? []
    for (let d = k + 1; d <= parts.length - 1; d++) {
      const oz = parts.slice(0, d).join('.')
      if (created.has(oz)) continue
      created.add(oz)
      createdBy.set(bucket, [...(createdBy.get(bucket) ?? []), oz])
      const key = levelKey(parts.slice(0, d), maskObj, sc.levelPad)
      const b = blank()
      put(b, 0, '11' + key)
      put(b, 11, 'N')
      put(b, 16, LEVEL_LABELS[d - 1] ?? 'Ebene')
      out.push(b.join(''))
      const lbl = x.p.path?.find((c) => c.oz === oz)?.label ?? (d === parts.length - 1 ? x.p.category : '')
      for (const l of wrap(toByteString(lbl || ' ', dos).replace(/\s+/g, ' '), 40)) out.push(rec('12', l))
    }
    out.push(...x.lines)
    newCatLines.set(bucket, out)
  }
  // closers for the created categories are appended after their items
  for (const [bucket, out] of newCatLines) {
    const closers: string[] = []
    for (const oz of [...(createdBy.get(bucket) ?? [])].reverse()) {
      const key = levelKey(oz.split('.'), maskObj, sc.levelPad)
      closers.push(rec('31', key))
      if (priced) {
        const b = blank()
        put(b, 0, '32' + key)
        put(b, 12, '0'.repeat(12) + '1000000')
        closers.push(b.join(''))
      }
    }
    addInsert(parseInt(bucket, 10), [...out, ...closers])
  }

  // assemble
  let lines: string[] = []
  for (let i = 0; i <= sc.lines.length; i++) {
    const ins2 = insertBefore.get(i)
    if (ins2) lines.push(...ins2)
    if (i < sc.lines.length && !removeIdx.has(i)) lines.push(replace.get(i) ?? sc.lines[i])
  }

  // category sums (32 records) of touched categories
  if (priced) {
    const sums = new Map<string, number>()
    for (const p of positions) {
      const parts = p.oz.split('.')
      for (let k = 1; k < parts.length; k++) {
        const oz = parts.slice(0, k).join('.')
        sums.set(oz, round2((sums.get(oz) ?? 0) + gp(p)))
      }
    }
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('32')) continue
      const oz = normKey(lines[i].slice(2, 11), sc.mask)
      if (!touchedCats.has(oz) && !created.has(oz)) continue
      lines[i] = lines[i].slice(0, 12) + digits((sums.get(oz) ?? 0) * 100, 12) + lines[i].slice(24)
    }
  }
  // 99 record: counts + grand total
  const i99 = lines.findIndex((l) => l.startsWith('99'))
  if (i99 >= 0) {
    let l = lines[i99].padEnd(80, ' ')
    const oldCount = sc.blocks.length
    const newCount = positions.length
    // right aligned count field ending at column 74
    for (const w of [11, 5]) {
      const seg = l.slice(74 - w, 74)
      if (/^\d+$/.test(seg) && parseInt(seg, 10) === oldCount) {
        l = l.slice(0, 74 - w) + String(newCount).padStart(w, '0') + l.slice(74)
        break
      }
    }
    if (priced && /^[1-9]\d{0,11}$/.test(l.slice(2, 14).replace(/^0+(?=\d)/, ''))) {
      const tot = positions.reduce((s, p) => s + gp(p), 0)
      l = l.slice(0, 2) + digits(tot * 100, 12) + l.slice(14)
    }
    lines[i99] = l
  }
  // renumber
  lines = lines.map((l, i) => l.padEnd(74, ' ').slice(0, 74) + String(i + 1).padStart(6, '0'))
  const outText = lines.join(sc.eol) + (sc.tailEol ? sc.eol : '')
  return { bytes: latin1ToBytes(outText), changed: true }
}
