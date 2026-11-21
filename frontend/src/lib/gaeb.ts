/**
 * GAEB parsers (DA XML 3.x / 2004 and GAEB 90 fixed-width) plus a parser for
 * the "Anfrage" PDF text layout. Pure functions — used by the Node build script
 * (scripts/build-data.ts) and by the in-browser import flow.
 */

export interface Position {
  id: string
  oz: string
  short: string
  long?: string
  qty: number
  unit: string
  /** unit price in EUR, null = not priced yet */
  up: number | null
  category: string
  group?: string
  lumpSum?: boolean
  /** full category chain root→leaf (OZ prefix + label), e.g. [{oz:'1',label:'Bereich 1'},{oz:'1.1',label:'Abschnitt'}] */
  path?: CategoryRef[]
  /** source-specific ids for lossless same-format export (GAEB XML Item ID, GAEB90 first record line no., PDF page) */
  srcRef?: string
}

export interface CategoryRef {
  oz: string
  label: string
}

/** category tree node (ListDoc.tree); positions reference nodes via Position.path */
export interface CategoryNode extends CategoryRef {
  depth: number
  children: CategoryNode[]
}

/** what the exporter needs to know about the source to reproduce its notation */
export interface SourceInfo {
  kind: 'gaeb-xml' | 'gaeb90' | 'pdf' | 'docx' | 'csv' | 'xlsx' | 'json' | 'blank'
  /** e.g. 'DA83 3.2', 'DA83 2004-07', 'D86' */
  version?: string
  /** OZ breakdown lengths root→item, e.g. [2,2,4] (+ index flag) from BoQBkdn / GAEB90 mask '1122PPPPI' */
  ozMask?: { levels: number[]; item: number; index: boolean }
  /** PDF layout family of the original printout (see docs/pdf-templates) */
  pdfTemplate?: 'A_anfrage' | 'B_kurz_langtext' | 'C_angebot' | 'D_lv_ausdruck' | 'E_courier'
  /** header fields used by printouts (project no./label, LV no./label, dates, client, offer no …) */
  header?: Record<string, string>
}

export interface ParsedList {
  format: string
  phase?: string
  project?: string
  projectLabel?: string
  title?: string
  date?: string
  currency: string
  notes?: string
  positions: Position[]
  tree?: CategoryNode[]
  source?: SourceInfo
}

export { newNode, flatTree } from './cat'
import { newNode, treeFromPaths } from './cat'

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** XML rich text (p/span/br) → plain text with line breaks */
export function richToText(xml: string): string {
  const t = xml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*\/>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(t)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m?.[1]
}

function firstLine(text: string, max = 110): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line
}

const clipLong = (s: string | undefined, max = 4000) =>
  s && s.length > max ? s.slice(0, max).trimEnd() + ' …' : s

/* ------------------------------------------------------------------ */
/* GAEB DA XML                                                         */
/* ------------------------------------------------------------------ */

export function parseGaebXml(xml: string): ParsedList {
  const ns = xml.match(/<GAEB[^>]*xmlns="([^"]+)"/)?.[1] ?? ''
  const da = xml.match(/<DP>(\d+)<\/DP>/)?.[1] ?? ns.match(/DA(\d+)/)?.[1]
  const version = xml.match(/<Version>([^<]+)<\/Version>/)?.[1]
  const prjInfo = tag(xml, 'PrjInfo') ?? ''
  const boqInfo = tag(xml, 'BoQInfo') ?? ''
  const out: ParsedList = {
    format: `GAEB DA XML${version ? ' ' + version : ''}`,
    phase: da ? `X${da}` : undefined,
    project: decodeEntities(tag(prjInfo, 'NamePrj') ?? '').trim() || undefined,
    projectLabel: decodeEntities(tag(prjInfo, 'LblPrj') ?? '').trim() || undefined,
    title: decodeEntities(tag(boqInfo, 'LblBoQ') ?? '').trim() || undefined,
    date: tag(xml, 'Date')?.trim(),
    currency: (tag(prjInfo, 'Cur')?.trim() || 'EUR').replace(/^EURO$/i, 'EUR'),
    positions: [],
  }

  const tree: CategoryNode[] = []
  out.tree = tree
  const bk = [...xml.matchAll(/<BoQBkdn>([\s\S]*?)<\/BoQBkdn>/g)].map((m) => ({ type: tag(m[1], 'Type'), len: parseInt(tag(m[1], 'Length') ?? '0', 10) }))
  const vm = ns.match(/DA(\d+)\/(\S+)$/)
  const daNo = da ?? vm?.[1]
  const m6 = ns.match(/\/(\d{6})$/)
  const vv = m6 ? m6[1].slice(0, 4) + '-' + m6[1].slice(4) : (vm?.[2] ?? version)
  out.source = {
    kind: 'gaeb-xml',
    version: daNo ? 'DA' + daNo + (vv ? ' ' + vv : '') : undefined,
    ozMask: bk.length
      ? { levels: bk.filter((b) => b.type === 'BoQLevel').map((b) => b.len), item: bk.find((b) => b.type === 'Item')?.len ?? 0, index: bk.some((b) => b.type === 'Index') }
      : undefined,
    header: {},
  }
  // Tokenise the structural tags. Items never nest, categories do.
  const re = /<BoQCtgy\b([^>]*)>|<\/BoQCtgy>|<LblTx>([\s\S]*?)<\/LblTx>|<Item\b([^>]*)>([\s\S]*?)<\/Item>/g
  const stack: { rno: string; label: string; node: CategoryNode }[] = []
  let pendingCtgy = false
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('<BoQCtgy')) {
      const rno = m[1].match(/RNoPart="([^"]*)"/)?.[1] ?? ''
      const chain = [...stack.map((s) => s.rno), rno].filter(Boolean).join('.')
      const node = newNode(chain || String(tree.length + 1), '')
      node.depth = stack.length + 1
      ;(stack.length ? stack[stack.length - 1].node.children : tree).push(node)
      stack.push({ rno, label: '', node })
      pendingCtgy = true
    } else if (m[0] === '</BoQCtgy>') {
      stack.pop()
    } else if (m[2] !== undefined) {
      // first LblTx after a category open is its label
      if (pendingCtgy && stack.length) {
        stack[stack.length - 1].label = richToText(m[2]).replace(/\n+/g, ' ')
        stack[stack.length - 1].node.label = stack[stack.length - 1].label
        pendingCtgy = false
      }
    } else if (m[3] !== undefined) {
      pendingCtgy = false
      const attrs = m[3]
      const body = m[4]
      const rno = attrs.match(/RNoPart="([^"]*)"/)?.[1] ?? ''
      const oz = [...stack.map((s) => s.rno), rno].filter(Boolean).join('.')
      const outline = tag(body, 'OutlineText')
      const detail = tag(body, 'DetailTxt')
      const longText = detail ? richToText(detail) : ''
      const shortText = outline ? richToText(outline).replace(/\n+/g, ' ') : firstLine(longText)
      const qtyRaw = tag(body, 'Qty')
      const upRaw = tag(body, 'UP')
      out.positions.push({
        id: `p${n++}`,
        oz,
        short: shortText || '(ohne Kurztext)',
        long: clipLong(longText && longText !== shortText ? longText : undefined),
        qty: qtyRaw ? parseFloat(qtyRaw) || 0 : 0,
        unit: decodeEntities(tag(body, 'QU') ?? '').trim(),
        up: upRaw ? parseFloat(upRaw) : null,
        category: stack[stack.length - 1]?.label || 'Allgemein',
        group: stack[0]?.label,
        lumpSum: /<LumpSumItem>Yes<\/LumpSumItem>/.test(body) || undefined,
        path: stack.map((s) => ({ oz: s.node.oz, label: s.label })),
        srcRef: attrs.match(/\bID="([^"]*)"/)?.[1],
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* GAEB 90 (D81–D86)                                                   */
/* ------------------------------------------------------------------ */

/** cp437 (DOS) vs cp1252 heuristic on raw bytes */
export function decodeGaeb90(bytes: Uint8Array): string {
  let dos = 0
  let win = 0
  for (const b of bytes) {
    if (b === 0x84 || b === 0x81 || b === 0x94 || b === 0xe1 || b === 0x8e || b === 0x9a || b === 0x99) dos++
    if (b === 0xe4 || b === 0xfc || b === 0xf6 || b === 0xdf || b === 0xc4 || b === 0xdc || b === 0xd6) win++
  }
  if (win >= dos) return new TextDecoder('windows-1252').decode(bytes)
  const map: Record<number, string> = {
    0x84: 'ä', 0x81: 'ü', 0x94: 'ö', 0xe1: 'ß', 0x8e: 'Ä', 0x9a: 'Ü', 0x99: 'Ö',
    0xf8: '°', 0xfd: '²', 0xfc: '³', 0xe6: 'µ', 0xf1: '±', 0x82: 'é', 0x85: 'à',
    0x8a: 'è', 0x87: 'ç', 0xab: '½', 0xac: '¼', 0xe4: 'Σ', 0xf9: '·', 0xfa: '·',
  }
  let s = ''
  for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : (map[b] ?? '?')
  return s
}

/** OZ mask like "1122PPPPI": digits = category level ids, P = position, I = index */
function formatOz(raw: string, mask: string): string {
  const parts: string[] = []
  let i = 0
  const groups = mask.match(/(.)\1*/g) ?? []
  for (const g of groups) {
    const seg = raw.slice(i, i + g.length)
    i += g.length
    if (g[0] === 'I') continue
    const t = seg.trim()
    if (t) parts.push(t.replace(/^0+(?=\d)/, '') )
  }
  return parts.join('.')
}

export function parseGaeb90(text: string): ParsedList {
  const lines = text.split(/\r?\n/)
  let mask = '1122PPPPI'
  let phase: string | undefined
  const out: ParsedList = { format: 'GAEB 90', currency: 'EUR', positions: [] }
  type Cat = { oz: string; label: string; depth: number; node: CategoryNode }
  const cats: Cat[] = []
  const tree: CategoryNode[] = []
  let current: (Position & { _long: string[]; _short: string[] }) | null = null
  const all: (Position & { _long: string[]; _short: string[] })[] = []
  const byOz = new Map<string, Position & { _long: string[]; _short: string[] }>()
  let n = 0
  let lastCat: Cat | null = null

  const content = (l: string) => l.slice(2, 74).replace(/\s+$/, '')

  for (const l of lines) {
    const rec = l.slice(0, 2)
    switch (rec) {
      case '00': {
        const m = l.match(/(\d{2})([LKA])\s/)
        if (m) phase = `D${m[1]}`
        const mk = l.slice(62, 71).trim()
        if (/^[1-9P]+I?$/.test(mk)) mask = mk
        const prj = l.slice(28, 60).trim()
        if (prj) out.project = prj
        break
      }
      case '01': {
        const c = content(l)
        out.title = c.slice(0, 40).trim() || out.title
        // record 01 packs LV date + offer date as dd.mm.yy without separator
        const d = c.slice(40).match(/(\d{2}\.\d{2}\.\d{2})/)
        if (d) out.date = d[1]
        break
      }
      case '02': {
        const p = content(l).trim()
        if (p) out.projectLabel = p
        break
      }
      case '08': {
        const cur = content(l).slice(0, 4).trim()
        if (cur) out.currency = cur.toUpperCase().replace(/^EURO$/, 'EUR')
        break
      }
      case '11': {
        const ozRaw = l.slice(2, 11)
        const oz = formatOz(ozRaw, mask)
        const depth = oz.split('.').length
        while (cats.length && cats[cats.length - 1].depth >= depth) cats.pop()
        const node = newNode(oz, '')
        node.depth = depth
        ;(cats.length ? cats[cats.length - 1].node.children : tree).push(node)
        lastCat = { oz, label: '', depth, node }
        cats.push(lastCat)
        current = null
        break
      }
      case '12': {
        if (lastCat) {
          lastCat.label = (lastCat.label + ' ' + content(l).trim()).trim()
          lastCat.node.label = lastCat.label
        }
        break
      }
      case '21': {
        const oz = formatOz(l.slice(2, 11), mask)
        const qty = parseInt(l.slice(23, 34).trim() || '0', 10) / 1000
        const unit = l.slice(34, 38).trim()
        current = {
          id: `p${n++}`,
          oz,
          short: '',
          qty: Number.isFinite(qty) ? qty : 0,
          unit,
          up: null,
          category: cats[cats.length - 1]?.label || 'Allgemein',
          group: cats[0]?.label,
          lumpSum: unit.toLowerCase() === 'psch' || undefined,
          path: cats.map((c) => ({ oz: c.oz, label: c.label })),
          srcRef: l.slice(74, 80).trim() || undefined,
          _long: [],
          _short: [],
        }
        all.push(current)
        byOz.set(oz, current)
        lastCat = null
        break
      }
      case '23': {
        const oz = formatOz(l.slice(2, 11), mask)
        let p = byOz.get(oz)
        if (!p) {
          // price-only file (e.g. D84 without positions) → create stub
          p = {
            id: `p${n++}`, oz, short: '', qty: 0, unit: '', up: null,
            category: cats[cats.length - 1]?.label || 'Allgemein', group: cats[0]?.label,
            path: cats.map((c) => ({ oz: c.oz, label: c.label })),
            srcRef: l.slice(74, 80).trim() || undefined,
            _long: [], _short: [],
          }
          all.push(p)
          byOz.set(oz, p)
        }
        const nums = l.slice(11, 74).trim().split(/\s+/).filter((x) => /^\d+$/.test(x))
        if (nums.length >= 2) {
          const ep = parseInt(nums[0], 10)
          const gp = parseInt(nums[1], 10) / 100
          if (nums[2] && !p.qty) p.qty = parseInt(nums[2], 10) / 1000
          const c100 = ep / 100
          const c1000 = ep / 1000
          const q = p.qty || 1
          p.up = Math.abs(c1000 * q - gp) < Math.abs(c100 * q - gp) ? c1000 : c100
        }
        current = p
        break
      }
      case '25':
        if (current) current._short.push(content(l).trim())
        break
      case '26':
        if (current) current._long.push(content(l).trim())
        break
      default:
        break
    }
  }
  out.phase = phase
  out.tree = tree
  const groups = mask.match(/(.)\1*/g) ?? []
  out.source = {
    kind: 'gaeb90',
    version: phase,
    ozMask: {
      levels: groups.filter((g) => /\d/.test(g[0])).map((g) => g.length),
      item: groups.find((g) => g[0] === 'P')?.length ?? 0,
      index: groups.some((g) => g[0] === 'I'),
    },
    header: {},
  }
  out.format = phase ? `GAEB 90 · ${phase}` : 'GAEB 90'
  out.positions = all.map(({ _long, _short, ...p }) => {
    const longText = _long.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    const short = _short.join(' ').replace(/\s+/g, ' ').trim() || firstLine(longText)
    return { ...p, short: short || '', long: clipLong(longText || undefined) }
  })
  return out
}

/* ------------------------------------------------------------------ */
/* "Anfrage" PDF text (pdftotext -raw)                                 */
/* ------------------------------------------------------------------ */

const NOISE =
  /^(Übertrag:?|Seite:|Druckdatum|\[FIRMA|\[BILD|\[EMAIL|\[ADRESSE|Tel\.|Anfrage$|Projekt:|LV:|OZ Leistungs|in EUR|Summe\b|Ordnungszahl|Zuzüglich|in Höhe von|\(Ort\)|Das LV besteht|\.{5,}|\d{2} \[FIRMA|\[PERSON_\d+\] Geberit)/

/** choose the short text among the first body lines when the OZ line carries none */
function pickHead(body: string[]): string {
  const cands = body.slice(0, 4)
  if (!cands.length) return ''
  const bad = (l: string) => /^[a-zäöüß),;.]/.test(l) || l.split(')').length > l.split('(').length
  const rep = cands.findIndex((l, i) => l.length > 3 && body.indexOf(l, i + 1) > i)
  if (rep >= 0 && !bad(cands[rep])) return cands[rep]
  const good = cands.findIndex((l) => !bad(l))
  return cands[good >= 0 ? good : 0]
}

export function parseLvPdfText(raw: string): ParsedList {
  const lines = raw.replace(/\f/g, '\n').split(/\r?\n/).map((l) => l.trim())
  const out: ParsedList = { format: 'PDF · Leistungsverzeichnis', currency: 'EUR', positions: [] }
  const prj = lines.find((l) => l.startsWith('Projekt:'))
  if (prj) {
    const m = prj.match(/^Projekt:\s+(\S+)\s+(.*)$/)
    if (m) {
      out.project = m[1]
      out.projectLabel = m[2].trim()
    }
  }
  const lv = lines.find((l) => l.startsWith('LV:'))
  if (lv) {
    const rest = lv.replace(/^LV:\s*/, '').trim()
    const m = rest.match(/^(\S+)\s+(.+)$/)
    out.title = m ? m[2].trim() : /^\d+$/.test(rest) ? undefined : rest
  }
  const d = lines.find((l) => l.startsWith('Druckdatum'))?.match(/(\d{1,2}\.\d{1,2}\.\d{4})/)
  if (d) out.date = d[1]
  if (/^Anfrage$/m.test(raw)) out.phase = 'Anfrage'

  const OZ = /^((?:\d+\.{1,2})+\d*\.?|\.\d+)(?:\s+(.*))?$/
  const QTY = /^(\d{1,3}(?:\.\d{3})*,\d+)\s+(\S+)\s+(\.{3,}|\d{1,3}(?:\.\d{3})*,\d{2})(?:\s+(.*))?$/
  const de = (s: string) => parseFloat(s.replace(/\./g, '').replace(',', '.'))

  type Block = { oz: string; head: string; body: string[] }
  const blocks: Block[] = []
  const notes: string[] = []
  let cur: Block | null = null
  const cats = new Map<number, CategoryNode>()
  const tree: CategoryNode[] = []
  out.tree = tree
  out.source = { kind: 'pdf', header: {} }
  let n = 0

  const flush = (qtyLine?: RegExpMatchArray) => {
    if (!cur) return
    const depth = cur.oz.split('.').filter(Boolean).length
    if (qtyLine) {
      const head = cur.head || pickHead(cur.body)
      const body = cur.body.filter((l) => l !== head)
      const longText = body.join('\n').trim()
      const priced = qtyLine[3] && !qtyLine[3].startsWith('.') ? de(qtyLine[3]) : null
      const unit = qtyLine[2]
      // nearest category label at a shallower depth
      let category = 'Allgemein'
      let group: string | undefined
      const path: CategoryRef[] = []
      for (let k = 1; k < depth; k++) {
        const c = cats.get(k)
        if (c) path.push({ oz: c.oz, label: c.label })
      }
      if (path.length) {
        category = path[path.length - 1].label
        group = path[0].label
      }
      out.positions.push({
        id: `p${n++}`,
        oz: cur.oz.replace(/\.$/, ''),
        short: head || firstLine(longText) || '(ohne Kurztext)',
        long: clipLong(longText || undefined),
        qty: de(qtyLine[1]),
        unit,
        up: priced,
        category,
        group,
        lumpSum: /^psch$/i.test(unit) || undefined,
        path,
        srcRef: cur.oz.replace(/\.$/, ''),
      })
    } else {
      // no quantity → category header
      const node = newNode(cur.oz.replace(/\.$/, ''), cur.head || cur.body[0] || '')
      node.depth = depth
      let parent: CategoryNode | undefined
      for (let k = depth - 1; k >= 1 && !parent; k--) parent = cats.get(k)
      ;(parent ? parent.children : tree).push(node)
      cats.set(depth, node)
      for (const k of [...cats.keys()]) if (k > depth) cats.delete(k)
    }
    blocks.push(cur)
    cur = null
  }

  let started = false
  for (const l of lines) {
    if (!l || NOISE.test(l)) continue
    const oz = l.match(OZ)
    if (oz && !/^\d+,\d/.test(l)) {
      if (cur) flush()
      cur = { oz: oz[1].replace(/^\./, '').replace(/\.\./g, '.'), head: (oz[2] ?? '').trim(), body: [] }
      started = true
      continue
    }
    const q = l.match(QTY)
    if (q && cur) {
      flush(q)
      continue
    }
    if (!started) notes.push(l)
    else if (cur) cur.body.push(l)
  }
  if (cur) flush()
  // positions without any category (or a list whose "categories" collide with position numbers) → one synthetic category
  const orphans = out.positions.filter((p) => !p.path?.length)
  if (orphans.length) {
    if (orphans.length === out.positions.length) tree.length = 0
    const gen = newNode('0', 'Allgemein')
    tree.unshift(gen)
    for (const p of orphans) p.path = [{ oz: '0', label: 'Allgemein' }]
  }
  if (out.source) {
    const lvRest = lv?.replace(/^LV:\s*/, '').trim()
    const lm = lvRest?.match(/^(\S+)\s+(.+)$/)
    out.source.header = {
      ...(out.project ? { project: out.project } : {}),
      ...(out.projectLabel ? { projectLabel: out.projectLabel } : {}),
      ...(lm ? { lv: lm[1], lvLabel: lm[2].trim() } : lvRest ? { lvLabel: lvRest } : {}),
      ...(d ? { printDate: d[1] } : {}),
    }
  }
  if (!out.title) out.title = out.positions[0]?.category
  if (notes.length) out.notes = clipLong(notes.join('\n'), 6000)
  return out
}

/* ------------------------------------------------------------------ */
/* CSV import (simple, header-driven)                                  */
/* ------------------------------------------------------------------ */

export function parseCsv(text: string): ParsedList {
  const firstLine = text.split(/\r?\n/, 1)[0]
  const delimiters = firstLine.replace(/"(?:[^"]|"")*"/g, '')
  const delim = ['\t', ';', ','].sort((a, b) => delimiters.split(b).length - delimiters.split(a).length)[0]
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const finishRow = () => {
    row.push(cell)
    if (row.some((value) => value.trim())) rows.push(row)
    row = []
    cell = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (c === delim && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((c === '\n' || c === '\r') && !quoted) {
      finishRow()
      if (c === '\r' && text[i + 1] === '\n') i++
    } else cell += c
  }
  if (quoted) throw new Error('Unclosed quoted field.')
  finishRow()
  const [header = [], ...items] = rows
  return parseTable(header, items, 'csv')
}

export function parseTable(header: string[], rows: string[][], kind: 'csv' | 'xlsx'): ParsedList {
  const normalized = header.map((h) => h.trim().toLowerCase().replace(/\s*\([^)]*\)$/, ''))
  const idx = (...names: string[]) => normalized.findIndex((h) => names.includes(h))
  const iOz = idx('oz', 'pos', 'position', 'position no.', 'sku')
  const iShort = idx('kurztext', 'short', 'description', 'bezeichnung', 'name', 'item')
  const iLong = idx('langtext', 'long', 'long text', 'long description')
  const iQty = idx('menge', 'qty', 'quantity')
  const iUnit = idx('einheit', 'unit', 'me')
  const iUp = idx('ep', 'einheitspreis', 'unit price', 'price')
  const iCat = idx('kategorie', 'category', 'titel')
  if (iShort < 0 && iOz < 0) throw new Error('No item or position column found.')
  const num = (s?: string) => {
    const t = s?.replace(/[^\d,.-]/g, '') ?? ''
    return t.includes(',') && t.lastIndexOf(',') > t.lastIndexOf('.') ? parseFloat(t.replace(/\./g, '').replace(',', '.')) : parseFloat(t.replace(/,/g, ''))
  }
  const categories = new Map<string, CategoryRef>()
  const childCounts = new Map<string, number>()
  const positions = rows.map((r, i): Position => {
    let parent = ''
    const labels = (r[iCat]?.trim() || 'Import').split(/\s*›\s*/).filter(Boolean)
    const path = labels.map((label) => {
      const key = JSON.stringify([parent, label])
      let ref = categories.get(key)
      if (!ref) {
        const ordinal = (childCounts.get(parent) ?? 0) + 1
        childCounts.set(parent, ordinal)
        ref = { oz: parent ? `${parent}.${ordinal}` : String(ordinal), label }
        categories.set(key, ref)
      }
      parent = ref.oz
      return ref
    })
    const qty = num(r[iQty])
    const up = num(r[iUp])
    return {
      id: `p${i}`,
      oz: r[iOz]?.trim() || String(i + 1),
      short: (iShort >= 0 ? r[iShort] : r[0])?.trim() || '(ohne Kurztext)',
      long: r[iLong]?.trim() || undefined,
      qty: Number.isFinite(qty) ? qty : 1,
      unit: r[iUnit]?.trim() || 'St',
      up: Number.isFinite(up) ? up : null,
      category: path.at(-1)?.label ?? 'Import',
      path,
    }
  })
  return { format: kind === 'xlsx' ? 'Excel' : 'CSV', currency: 'EUR', positions, tree: treeFromPaths(positions), source: { kind } }
}

export { positionTotal } from './money'
