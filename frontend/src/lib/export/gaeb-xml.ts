/**
 * GAEB DA XML writer (3.2 and 2004-07/3.1) and in-place patcher.
 *
 * Generation mirrors the notation found in ../data/tenders/8209.003_Leistungsverzeichnis_leer.X83 (3.2, compact)
 * and ../data/tenders/501-24-01_GAEB-XML_sas.x83 (2004, indented). Patching works on the original text
 * (string splicing, no re-serialisation) so every untouched byte stays identical.
 */
import type { ListDoc, Position } from '../types'
import {
  type Cat, type OzMask, buildCats, diffList, inferMask, normOz, rnoPart, xmlEsc,
} from './util'

export type XmlVariant = '3.2' | '2004'
export type XmlPhase = '83' | '84' | '86'

interface GenOpts {
  doc: ListDoc
  positions: Position[]
  tree?: Parameters<typeof buildCats>[1]
  variant: XmlVariant
  longTexts: boolean
  prices: boolean
  phase?: XmlPhase
  now: Date
  mask?: OzMask
}

/* ------------------------------------------------------------------ */
/* rich text                                                           */
/* ------------------------------------------------------------------ */

interface TextStyle {
  p: string
  span: string
}
const STYLE32_DETAIL: TextStyle = {
  p: ' style="margin-top:0pt;margin-bottom:0pt;width:284pt;font-size:10pt;"',
  span: ' style="font-family:Arial;font-size:10pt;"',
}
const STYLE32_OUTLINE: TextStyle = {
  p: ' style="width:481pt;margin-top:0pt;margin-bottom:0pt;font-size:10pt;"',
  span: ' style="font-family:Arial;font-size:10pt;"',
}
const NOSTYLE: TextStyle = { p: '', span: '' }

function ptags(text: string, st: TextStyle): string {
  return text
    .split('\n')
    .map((l) => (l.trim() === '' ? `<p${st.p}/>` : `<p${st.p}><span${st.span}>${xmlEsc(l)}</span></p>`))
    .join('')
}

function fmtQty(q: number): string {
  return q.toFixed(3)
}
function fmtUp(u: number): string {
  const r = Math.round(u * 10000) / 10000
  return Math.abs(r * 100 - Math.round(r * 100)) < 1e-9 ? r.toFixed(2) : String(r)
}
const fmtIt = (q: number, u: number) => (Math.round((q * u + Number.EPSILON) * 100) / 100).toFixed(2)

/* ------------------------------------------------------------------ */
/* generator                                                           */
/* ------------------------------------------------------------------ */

function itemXml(p: Position, rno: string, id: string, o: { variant: XmlVariant; longTexts: boolean; prices: boolean; priced: boolean }): string {
  const st3 = o.variant === '3.2'
  const detail = st3 ? STYLE32_DETAIL : NOSTYLE
  const outline = st3 ? STYLE32_OUTLINE : NOSTYLE
  let x = `<Item ID="${id}" RNoPart="${xmlEsc(rno)}">`
  if (p.lumpSum) x += '<LumpSumItem>Yes</LumpSumItem>'
  x += `<Qty>${fmtQty(p.qty)}</Qty><QU>${xmlEsc(p.unit)}</QU>`
  if (o.priced && o.prices && p.up != null) x += `<UP>${fmtUp(p.up)}</UP><IT>${fmtIt(p.qty, p.up)}</IT>`
  x += '<Description><CompleteText>'
  if (o.longTexts && p.long) x += `<DetailTxt><Text>${ptags(p.long, detail)}</Text></DetailTxt>`
  x += `<OutlineText><OutlTxt><TextOutlTxt>${ptags(p.short, outline)}</TextOutlTxt></OutlTxt></OutlineText>`
  x += '</CompleteText></Description></Item>'
  return x
}

function pretty(xml: string): string {
  // indent element boundaries with two spaces (DA XML 2004 sample style); text-only elements stay inline
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? []
  let out = ''
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('<?') || t.startsWith('<!')) {
      out += t + '\n'
    } else if (t.startsWith('</')) {
      depth--
      out += '  '.repeat(depth) + t + '\n'
    } else if (t.startsWith('<')) {
      const selfClose = t.endsWith('/>')
      // inline simple <a>text</a>
      if (!selfClose && tokens[i + 1] && !tokens[i + 1].startsWith('<') && tokens[i + 2]?.startsWith('</')) {
        out += '  '.repeat(depth) + t + tokens[i + 1] + tokens[i + 2] + '\n'
        i += 2
      } else {
        out += '  '.repeat(depth) + t + '\n'
        if (!selfClose) depth++
      }
    } else {
      out += '  '.repeat(depth) + t.trim() + '\n'
    }
  }
  return out
}

export function generateGaebXml(o: GenOpts): string {
  const phase = o.phase ?? '83'
  const priced = phase !== '83'
  // Imported table categories can use synthetic numbers. Derive the XML hierarchy from the
  // position numbers so a category label never changes an exported OZ.
  const positions = o.positions.map((position) => {
    const prefix = position.oz.split('.').slice(0, -1)
    const leaf = position.path?.at(-1)
    if (!leaf || normOz(leaf.oz) === normOz(prefix.join('.'))) return position
    return { ...position, path: prefix.map((part, index) => ({
      oz: prefix.slice(0, index + 1).join('.'),
      label: position.path?.[index]?.label ?? part,
    })) }
  })
  const tree = buildCats(positions, o.tree)
  const mask = o.mask ?? inferMask(o.doc, o.positions)
  const nlev = mask.levels.length
  let n = 1
  const nid = () => `id${n++}`
  const part = (oz: string, depth: number, isItem = false) => {
    const s = oz.split('.')[depth - 1] ?? oz
    return rnoPart(s, !isItem && depth <= nlev ? mask.levels[depth - 1] ?? s.length : mask.item)
  }
  const io = { variant: o.variant, longTexts: o.longTexts, prices: o.prices, priced }
  const lblStyle = o.variant === '3.2' ? STYLE32_OUTLINE : NOSTYLE
  const ctgy = (c: Cat): string => {
    let x = `<BoQCtgy ID="${nid()}" RNoPart="${xmlEsc(part(c.oz, c.depth))}"><LblTx>${ptags(c.label || ' ', lblStyle)}</LblTx><BoQBody>`
    for (const k of c.cats) x += ctgy(k)
    if (c.items.length) x += '<Itemlist>' + c.items.map((p) => itemXml(p, part(p.oz, p.oz.split('.').length, true), nid(), io)).join('') + '</Itemlist>'
    return x + '</BoQBody></BoQCtgy>'
  }
  const roots = tree.roots
  let body = ''
  if (tree.rootItems.length) body += '<Itemlist>' + tree.rootItems.map((p) => itemXml(p, part(p.oz, 1, true), nid(), io)).join('') + '</Itemlist>'
  for (const c of roots) body += ctgy(c)

  const ns = o.variant === '3.2' ? `http://www.gaeb.de/GAEB_DA_XML/DA${phase}/3.2` : 'http://www.gaeb.de/GAEB_DA_XML/200407'
  const iso = o.now.toISOString()
  const date = iso.slice(0, 10)
  const time = iso.slice(11, 19)
  const cur = o.doc.currency || 'EUR'
  const prj = xmlEsc(o.doc.project ?? '')
  const lblPrj = xmlEsc(o.doc.projectLabel ?? o.doc.project ?? '')
  const lblBoq = xmlEsc(o.doc.title || o.doc.projectLabel || '')
  const bkdn =
    mask.levels
      .map((l, i) => `<BoQBkdn><Type>BoQLevel</Type>${o.variant === '3.2' ? `<LblBoQBkdn>${['Titel', 'Bereich', 'Abschnitt', 'Unterabschnitt'][i] ?? 'Ebene'}</LblBoQBkdn>` : ''}<Length>${l}</Length><Num>Yes</Num></BoQBkdn>`)
      .join('') +
    `<BoQBkdn><Type>Item</Type><Length>${mask.item}</Length><Num>Yes</Num></BoQBkdn>` +
    (mask.index ? '<BoQBkdn><Type>Index</Type><Length>1</Length><Num>No</Num></BoQBkdn>' : '')
  let xml =
    `<GAEB xmlns="${ns}"><GAEBInfo><Version>${o.variant === '3.2' ? '3.2' : '3.1'}</Version><VersDate>${o.variant === '3.2' ? '2013-10' : '2009-12'}</VersDate>` +
    `<Date>${date}</Date><Time>${time}</Time><ProgSystem>BillBuild</ProgSystem><ProgName>BillBuild</ProgName></GAEBInfo>` +
    `<PrjInfo><NamePrj>${prj}</NamePrj><LblPrj>${lblPrj}</LblPrj><Cur>${xmlEsc(cur)}</Cur><CurLbl>Euro</CurLbl></PrjInfo>` +
    `<Award><DP>${phase}</DP><AwardInfo><Cur>${xmlEsc(cur)}</Cur><CurLbl>Euro</CurLbl></AwardInfo>` +
    `<BoQ ID="${nid()}"><BoQInfo><Name>${xmlEsc(String(o.doc.project ?? '01').slice(0, 20) || '01')}</Name><LblBoQ>${lblBoq}</LblBoQ>` +
    (o.variant === '2004' ? `<Date>${xmlEsc(date)}</Date>` : '') +
    `<OutlCompl>AllTxt</OutlCompl>${bkdn}</BoQInfo><BoQBody>${body}</BoQBody></BoQ></Award></GAEB>`
  xml = o.variant === '2004' ? pretty(xml) : xml
  return `<?xml version='1.0' encoding='UTF-8'?>\n` + xml + (o.variant === '2004' ? '' : '')
}

/* ------------------------------------------------------------------ */
/* original scanner                                                    */
/* ------------------------------------------------------------------ */

interface ItemSpan {
  start: number
  end: number
  id: string
  rno: string
  /** index in document order (matches Position.id "p<n>") */
  n: number
  ctgy: string
}
interface CtgySpan {
  oz: string
  rno: string
  label: string
  /** index just before the ctgy's own </BoQBody> */
  bodyEnd: number
  /** index of </Itemlist> (inside this ctgy), -1 if none */
  itemlistEnd: number
  depth: number
}
export interface XmlScan {
  items: ItemSpan[]
  ctgys: Map<string, CtgySpan>
  rootBodyEnd: number
  rootItemlistEnd: number
  itemLen: number
  levelLens: number[]
  phase: string
  ns: string
  maxId: number
  idPrefix: string
  eol: string
}

export function scanXml(xml: string): XmlScan {
  const items: ItemSpan[] = []
  const ctgys = new Map<string, CtgySpan>()
  const stack: { rno: string; label: string; bodyEnd: number; itemlistEnd: number; bodyDepth: number }[] = []
  const re = /<BoQCtgy\b([^>]*?)(\/?)>|<\/BoQCtgy>|<BoQBody\s*\/>|<BoQBody>|<\/BoQBody>|<Itemlist>|<\/Itemlist>|<Item\b([^>]*?)>[\s\S]*?<\/Item>|<LblTx>[\s\S]*?<\/LblTx>/g
  let m: RegExpExecArray | null
  let bodyDepth = 0
  let rootBodyEnd = -1
  let rootItemlistEnd = -1
  let n = 0
  let pendingLabel = false
  const ctgyBodyDepths: number[] = []
  while ((m = re.exec(xml))) {
    const t = m[0]
    if (t.startsWith('<BoQCtgy')) {
      const rno = m[1].match(/RNoPart="([^"]*)"/)?.[1] ?? ''
      stack.push({ rno, label: '', bodyEnd: -1, itemlistEnd: -1, bodyDepth: -1 })
      pendingLabel = true
    } else if (t === '</BoQCtgy>') {
      const c = stack.pop()
      if (c) {
        const oz = [...stack.map((s) => s.rno), c.rno].join('.')
        ctgys.set(oz, { oz, rno: c.rno, label: c.label, bodyEnd: c.bodyEnd, itemlistEnd: c.itemlistEnd, depth: stack.length + 1 })
      }
    } else if (t === '<BoQBody>') {
      bodyDepth++
      if (stack.length) {
        const top = stack[stack.length - 1]
        if (top.bodyDepth < 0) top.bodyDepth = bodyDepth
      }
      ctgyBodyDepths.push(stack.length)
    } else if (t === '</BoQBody>') {
      const owner = ctgyBodyDepths.pop() ?? 0
      if (owner === 0) {
        if (rootBodyEnd < 0) rootBodyEnd = m.index
      } else stack[owner - 1].bodyEnd = m.index
      bodyDepth--
    } else if (t === '<Itemlist>') {
      pendingLabel = false
    } else if (t === '</Itemlist>') {
      const owner = ctgyBodyDepths[ctgyBodyDepths.length - 1] ?? 0
      if (owner === 0) rootItemlistEnd = m.index
      else stack[owner - 1].itemlistEnd = m.index
    } else if (t.startsWith('<Item')) {
      const id = m[2]?.match(/\bID="([^"]*)"/)?.[1] ?? ''
      const rno = m[2]?.match(/RNoPart="([^"]*)"/)?.[1] ?? ''
      items.push({ start: m.index, end: m.index + t.length, id, rno, n: n++, ctgy: stack.map((s) => s.rno).join('.') })
    } else if (t.startsWith('<LblTx>') && pendingLabel && stack.length) {
      stack[stack.length - 1].label = t
      pendingLabel = false
    }
  }
  const ns = xml.match(/<GAEB[^>]*xmlns="([^"]+)"/)?.[1] ?? ''
  const phase = xml.match(/<DP>(\d+)<\/DP>/)?.[1] ?? ns.match(/DA(\d+)/)?.[1] ?? '83'
  let maxId = 0
  let idPrefix = 'id'
  for (const im of xml.matchAll(/\bID="([A-Za-z_]*)(\d+)"/g)) {
    const v = parseInt(im[2], 10)
    if (v >= maxId) {
      maxId = v
      idPrefix = im[1]
    }
  }
  const lens: number[] = []
  let itemLen = 4
  for (const b of xml.matchAll(/<BoQBkdn>([\s\S]*?)<\/BoQBkdn>/g)) {
    const type = b[1].match(/<Type>([^<]+)<\/Type>/)?.[1]
    const len = parseInt(b[1].match(/<Length>(\d+)<\/Length>/)?.[1] ?? '0', 10)
    if (type === 'BoQLevel') lens.push(len)
    else if (type === 'Item') itemLen = len
  }
  return { items, ctgys, rootBodyEnd, rootItemlistEnd, itemLen, levelLens: lens, phase, ns, maxId, idPrefix, eol: xml.includes('\r\n') ? '\r\n' : '\n' }
}

/* ------------------------------------------------------------------ */
/* patcher                                                             */
/* ------------------------------------------------------------------ */

interface Splice {
  start: number
  end: number
  text: string
  seq: number
}

function setTag(item: string, tag: string, value: string): string {
  const re = new RegExp(`(<${tag}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${tag}>)`)
  return re.test(item) ? item.replace(re, (_m, a, _b, c) => a + value + c) : item
}

function replaceInner(item: string, tag: string, inner: string): string {
  return setTag(item, tag, inner)
}

/** preserve decimals of the original number */
function sameDecimals(orig: string | undefined, value: number, min = 3): string {
  const d = orig && orig.includes('.') ? orig.split('.')[1].length : min
  return value.toFixed(Math.max(d, 0))
}

function patchItem(item: string, now: Position, orig: Position | undefined, scan: XmlScan, indentStyle: boolean): string {
  let x = item
  const styled = scan.ns.includes('/3.2')
  const priced = scan.phase !== '83'
  if (!orig || Math.abs(orig.qty - now.qty) > 1e-9) {
    const cur = x.match(/<Qty>([^<]*)<\/Qty>/)?.[1]
    if (cur !== undefined) x = setTag(x, 'Qty', sameDecimals(cur, now.qty))
    else x = x.replace(/(<QU>)/, `<Qty>${fmtQty(now.qty)}</Qty>$1`)
  }
  if (priced && (!orig || (orig.up ?? null) !== (now.up ?? null))) {
    if (now.up == null) {
      x = x.replace(/<UP>[^<]*<\/UP>/, '').replace(/<IT>[^<]*<\/IT>/, '')
    } else if (/<UP>/.test(x)) {
      x = setTag(x, 'UP', fmtUp(now.up))
      x = /<IT>/.test(x) ? setTag(x, 'IT', fmtIt(now.qty, now.up)) : x.replace('</UP>', `</UP><IT>${fmtIt(now.qty, now.up)}</IT>`)
    } else {
      x = x.replace('</QU>', `</QU><UP>${fmtUp(now.up)}</UP><IT>${fmtIt(now.qty, now.up)}</IT>`)
    }
  } else if (priced && orig && /<IT>/.test(x) && now.up != null && Math.abs(orig.qty - now.qty) > 1e-9) {
    x = setTag(x, 'IT', fmtIt(now.qty, now.up))
  }
  if (!orig || orig.unit !== now.unit) {
    x = setTag(x, 'QU', xmlEsc(now.unit))
  }
  if (!orig || orig.short !== now.short) {
    const st = styled ? STYLE32_OUTLINE : NOSTYLE
    if (/<TextOutlTxt[^>]*>/.test(x)) x = replaceInner(x, 'TextOutlTxt', ptags(now.short, st))
    else if (/<CompleteText>/.test(x))
      x = x.replace('</CompleteText>', `<OutlineText><OutlTxt><TextOutlTxt>${ptags(now.short, st)}</TextOutlTxt></OutlTxt></OutlineText></CompleteText>`)
  }
  if (!orig || (orig.long ?? '') !== (now.long ?? '')) {
    const st = styled ? STYLE32_DETAIL : NOSTYLE
    if (now.long) {
      if (/<DetailTxt>[\s\S]*?<Text>/.test(x)) x = x.replace(/(<DetailTxt>[\s\S]*?<Text[^>]*>)[\s\S]*?(<\/Text>)/, (_m, a, c) => a + ptags(now.long!, st) + c)
      else x = x.replace('<CompleteText>', `<CompleteText><DetailTxt><Text>${ptags(now.long, st)}</Text></DetailTxt>`)
    } else if (orig?.long) {
      x = x.replace(/<DetailTxt>[\s\S]*?<\/DetailTxt>/, '')
    }
  }
  void indentStyle
  return x
}

export interface PatchResult {
  xml: string
  changed: boolean
}

/** patches the original GAEB XML text so that it reflects `positions` (the user's current list) */
export function patchGaebXml(original: string, doc: ListDoc, positions: Position[], tree?: Parameters<typeof buildCats>[1], opts: { prices?: boolean } = {}): PatchResult {
  const diff = diffList(doc, positions)
  if (!diff.any) return { xml: original, changed: false }
  const scan = scanXml(original)
  const origById = new Map(doc.positions.map((p) => [p.id, p]))
  const spanOf = (p: Position): ItemSpan | undefined => {
    if (p.srcRef) {
      const s = scan.items.find((i) => i.id === p.srcRef)
      if (s) return s
    }
    const n = /^p(\d+)$/.exec(p.id)
    return n ? scan.items[parseInt(n[1], 10)] : undefined
  }
  const splices: Splice[] = []
  let seq = 0
  const indented = /\n\s+<Item\b/.test(original)
  const styled = scan.ns.includes('/3.2')
  void styled
  const eol = scan.eol
  const nlev = scan.levelLens.length
  const mask: OzMask = { levels: scan.levelLens, item: scan.itemLen, index: true }
  const partOf = (oz: string, depth: number, isItem = false) => {
    const s = oz.split('.')[depth - 1] ?? oz
    return rnoPart(s, !isItem && depth <= nlev ? scan.levelLens[depth - 1] ?? s.length : scan.itemLen)
  }
  const ozKeyOf = (oz: string) => oz.split('.').map((s, i) => partOf(oz, i + 1) + (s ? '' : '')).join('.')
  void mask

  // 1. removals
  for (const p of diff.removed) {
    const s = spanOf(p)
    if (!s) continue
    let start = s.start
    // swallow the indentation / line break in front of an item in pretty printed files
    if (indented) {
      const lead = /\n[ \t]*$/.exec(original.slice(Math.max(0, start - 200), start))
      if (lead) start -= lead[0].length
    }
    splices.push({ start, end: s.end, text: '', seq: seq++ })
  }
  const removedIds = new Set(diff.removed.map((p) => p.id))

  // 2. in-place edits (not moved)
  const movedIds = new Set(diff.moved.map((m) => m.now.id))
  for (const c of diff.changed) {
    if (removedIds.has(c.now.id)) continue
    const s = spanOf(c.now)
    if (!s) continue
    const itemText = original.slice(s.start, s.end)
    const patched = patchItem(itemText, c.now, c.orig, scan, indented)
    if (movedIds.has(c.now.id)) continue
    if (patched !== itemText) splices.push({ start: s.start, end: s.end, text: patched, seq: seq++ })
  }

  // 3. moves + additions → insertion into category itemlists
  type Ins = { p: Position; xml: string }
  const toInsert: Ins[] = []
  let nextId = scan.maxId + 1
  const newId = () => `${scan.idPrefix || 'id'}${nextId++}`
  const io = { variant: (styled ? '3.2' : '2004') as XmlVariant, longTexts: true, prices: opts.prices !== false, priced: scan.phase !== '83' }
  for (const m of diff.moved) {
    if (removedIds.has(m.now.id)) continue
    const s = spanOf(m.now)
    if (!s) continue
    const itemText = original.slice(s.start, s.end)
    const base = patchItem(itemText, m.now, m.orig, scan, indented)
    const rno = partOf(m.now.oz, m.now.oz.split('.').length, true)
    let start = s.start
    if (indented) {
      const lead = /\n[ \t]*$/.exec(original.slice(Math.max(0, start - 200), start))
      if (lead) start -= lead[0].length
    }
    splices.push({ start, end: s.end, text: '', seq: seq++ })
    toInsert.push({ p: m.now, xml: base.replace(/RNoPart="[^"]*"/, `RNoPart="${xmlEsc(rno)}"`) })
  }
  for (const p of diff.added) {
    const rno = partOf(p.oz, p.oz.split('.').length, true)
    toInsert.push({ p, xml: itemXml(p, rno, newId(), io) })
  }
  if (toInsert.length) {
    // group by target category oz (as RNoPart chain)
    const byCat = new Map<string, Ins[]>()
    for (const ins of toInsert) {
      const parts = ins.p.oz.split('.')
      const catKey = parts.slice(0, -1).map((_s, i) => partOf(ins.p.oz, i + 1)).join('.')
      const arr = byCat.get(catKey) ?? []
      arr.push(ins)
      byCat.set(catKey, arr)
    }
    const labelOf = (catKey: string, ins: Position): string => {
      const depth = catKey.split('.').length
      const pathLbl = ins.path?.find((c) => c.oz.split('.').length === depth)?.label
      return pathLbl ?? (depth === ins.oz.split('.').length - 1 ? ins.category : '') ?? ''
    }
    const nl = indented ? eol : ''
    for (const [catKey, list] of byCat) {
      const xmls = list.map((i) => i.xml).join('')
      const existing = catKey === '' ? undefined : scan.ctgys.get(catKey)
      if (catKey === '') {
        if (scan.rootItemlistEnd >= 0) splices.push({ start: scan.rootItemlistEnd, end: scan.rootItemlistEnd, text: xmls, seq: seq++ })
        else if (scan.rootBodyEnd >= 0) splices.push({ start: scan.rootBodyEnd, end: scan.rootBodyEnd, text: `<Itemlist>${xmls}</Itemlist>`, seq: seq++ })
      } else if (existing && existing.itemlistEnd >= 0) {
        splices.push({ start: existing.itemlistEnd, end: existing.itemlistEnd, text: xmls + nl, seq: seq++ })
      } else if (existing && existing.bodyEnd >= 0) {
        splices.push({ start: existing.bodyEnd, end: existing.bodyEnd, text: `<Itemlist>${xmls}</Itemlist>`, seq: seq++ })
      } else {
        // create the missing category chain below the deepest existing ancestor
        const segs = catKey.split('.')
        let k = segs.length - 1
        let parentKey = ''
        while (k > 0) {
          const key = segs.slice(0, k).join('.')
          if (scan.ctgys.has(key)) {
            parentKey = key
            break
          }
          k--
        }
        const first = list[0].p
        let nested = `<Itemlist>${xmls}</Itemlist>`
        for (let d = segs.length; d > k; d--) {
          const key = segs.slice(0, d).join('.')
          const lbl = labelOf(key, first) || ' '
          nested = `<BoQCtgy ID="${newId()}" RNoPart="${xmlEsc(segs[d - 1])}"><LblTx>${ptags(lbl, styled ? STYLE32_OUTLINE : NOSTYLE)}</LblTx><BoQBody>${nested}</BoQBody></BoQCtgy>`
        }
        const parent = parentKey ? scan.ctgys.get(parentKey) : undefined
        const at = parent ? parent.bodyEnd : scan.rootBodyEnd
        splices.push({ start: at, end: at, text: nested, seq: seq++ })
      }
    }
  }
  void ozKeyOf
  void tree
  void origById
  void buildCats

  splices.sort((a, b) => b.start - a.start || b.seq - a.seq)
  let out = original
  // overlapping guard: skip a splice fully inside an already applied removal
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end)
  return { xml: out, changed: out !== original }
}

export function sniffXml(bytes: Uint8Array): { ns: string; phase: string; variant: XmlVariant } {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 600))
  const ns = head.match(/xmlns="([^"]+)"/)?.[1] ?? ''
  const phase = head.match(/DA(\d+)/)?.[1] ?? '83'
  return { ns, phase, variant: ns.includes('200407') || !ns.includes('/3.2') ? '2004' : '3.2' }
}
