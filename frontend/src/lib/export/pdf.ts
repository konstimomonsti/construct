/**
 * PDF writer (pdf-lib, standard fonts) that reproduces the five printout families found in ../data:
 *   A_anfrage  (LV_*.pdf)            B_kurz_langtext (Leistungsverzeichnis.pdf)
 *   C_angebot  (Angebot AN24-0305)   D_lv_ausdruck   (LV-Ausdruck-[PROJEKT_004].pdf)
 *   E_courier  (Leistungsverzeichnis_leer.pdf)
 * Measurements come from docs/pdf-templates/*.txt (x / baseline-y in pt, y measured from the top edge).
 * Page furniture and the per-position styled lines of PDF sources come from public/data/layout/<id>.json.
 */
import { documentList, PDF_LIST_ATTACHMENT } from '../list-file'
import type { PDFFont, PDFPage } from 'pdf-lib'
import type { ListDoc, Position } from '../types'
import type { LayoutFile, LayoutLine } from './types'
import { type Cat, type CatTree, catSum, deNum, deQty, foldText, gp, round2, walk } from './util'

export type TemplateId = 'A_anfrage' | 'B_kurz_langtext' | 'C_angebot' | 'D_lv_ausdruck' | 'E_courier'

type FontKey = 'r' | 'b' | 'i' | 'bi' | 'cr' | 'cb'
type RGB = [number, number, number]
interface TextOp { k: 't'; x: number; y: number; t: string; f: FontKey; s: number; c?: RGB; right?: boolean }
interface RectOp { k: 'r'; x: number; y: number; w: number; h: number; fill?: RGB; stroke?: RGB; lw?: number }
interface LineOp { k: 'l'; x1: number; y1: number; x2: number; y2: number; lw: number; c?: RGB }
type Op = TextOp | RectOp | LineOp

interface Row {
  /** baseline distance from the previous row (ignored for the first row of a page) */
  gap: number
  ops: (y: number) => Op[]
  /** may a page break happen directly before this row? */
  brk: boolean
  /** a break before this row happens between positions (draw Übertrag) */
  between?: boolean
  /** minimum space the row needs below its baseline */
  after?: number
  /** force a new page and place this row at this baseline */
  newPage?: number
}

export interface PdfOpts {
  doc: ListDoc
  positions: Position[]
  tree: CatTree
  longTexts: boolean
  prices: boolean
  template: TemplateId
  layout?: LayoutFile | null
  now: Date
}

const PAGE_W = 595.28
const PAGE_H = 841.89
const BLACK: RGB = [0, 0, 0]
const GREY: RGB = [0.3, 0.3, 0.3]

const WIN_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')
const keepWin = (ch: string) => {
  const c = ch.charCodeAt(0)
  return (c >= 32 && c < 127) || (c >= 0xa0 && c <= 0xff) || WIN_EXTRA.has(ch)
}
const clean = (s: string) => foldText(s, keepWin)

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const dots = (n: number) => '.'.repeat(n)
const dmy = (d: Date) => `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`
const dd = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`

function hdr(doc: ListDoc, key: string, ...fallback: (string | undefined)[]): string {
  const h = doc.source?.header ?? {}
  return h[key] ?? fallback.find((x) => x != null && x !== '') ?? ''
}

interface Ctx {
  o: PdfOpts
  width: (t: string, f: FontKey, s: number) => number
  wrap: (t: string, f: FontKey, s: number, maxW: number) => string[]
  orig: Map<string, Position>
  total: number
}

type Tpl = {
  id: TemplateId
  top1: number
  topN: number
  bottom: number
  /** extra offset of the first row after an Übertrag line on a new page */
  carryTop?: number
  /** baseline offset of the Übertrag line relative to the first body baseline of a page */
  carryAt?: number
  /** fixed baseline of the bottom Übertrag line */
  carryBottomY?: number
  noLong?: boolean
  frame: (ctx: Ctx, page: number, pages: number) => Op[]
  heading: (ctx: Ctx, c: Cat) => Row[]
  item: (ctx: Ctx, p: Position, first: boolean) => Row[]
  sum: (ctx: Ctx, c: Cat, value: number, isLast: boolean) => Row[]
  end: (ctx: Ctx, total: number, count: number) => Row[]
  carryBottom?: (ctx: Ctx, y: number, value: number) => Op[]
  carryTopOps?: (ctx: Ctx, y: number, value: number) => Op[]
  firstPageExtra?: (ctx: Ctx) => Op[]
  intro?: (ctx: Ctx) => Row[]
}

const T = (x: number, y: number, t: string, f: FontKey, s: number, extra: Partial<TextOp> = {}): TextOp => ({ k: 't', x, y, t, f, s, ...extra })
const fill = (x: number, y: number, w: number, h: number, c: RGB): RectOp => ({ k: 'r', x, y, w, h, fill: c })
const hline = (x1: number, y: number, x2: number, lw: number, c: RGB = BLACK): LineOp => ({ k: 'l', x1, y1: y, x2, y2: y, lw, c })

function unitOf(p: Position) {
  return p.unit
}

/** is the text of this position untouched compared to the parsed source? */
function untouched(ctx: Ctx, p: Position): boolean {
  const o = ctx.orig.get(p.id)
  return !!o && o.short === p.short && (o.long ?? '') === (p.long ?? '') && o.oz === p.oz
}

function bodyLines(ctx: Ctx, p: Position, f: FontKey, s: number, maxW: number): string[] {
  if (!ctx.o.longTexts || !p.long) return []
  const out: string[] = []
  for (const l of p.long.split('\n')) out.push(...(l.trim() === '' ? [''] : ctx.wrap(l, f, s, maxW)))
  return out
}

/* ------------------------------------------------------------------ */
/* Template A — Anfrage                                                */
/* ------------------------------------------------------------------ */

const A_RIGHT_EP = 456.4
const A_RIGHT_GP = 535.8

function furnitureOps(fu: NonNullable<LayoutFile['furniture']>, page: number, pages: number, now: Date): Op[] {
  const ops: Op[] = []
  for (const it of fu.items ?? []) {
    const t = it.t.replace('{page}', String(page)).replace('{pages}', String(pages)).replace('{date}', dmy(now))
    const f: FontKey = it.f === 'courier' ? (it.b ? 'cb' : 'cr') : it.b && it.i ? 'bi' : it.b ? 'b' : it.i ? 'i' : 'r'
    const c: RGB | undefined = it.c ? [parseInt(it.c.slice(0, 2), 16) / 255, parseInt(it.c.slice(2, 4), 16) / 255, parseInt(it.c.slice(4, 6), 16) / 255] : undefined
    ops.push(T(it.x, it.y, t, f, it.s, c ? { c } : {}))
  }
  return ops
}

const tplA: Tpl = {
  id: 'A_anfrage',
  top1: 180.4,
  topN: 168.6,
  bottom: 757,
  carryTop: 17.2,
  frame(ctx, page, pages) {
    const o = ctx.o
    const ops: Op[] = [fill(371.3, 19.8, 45.3, 39.7, [0.88, 0.88, 0.88]), hline(57.1, 802.2, 566.4, 0.72)]
    const fu = o.layout?.furniture
    if (fu?.items?.length) {
      ops.push(...furnitureOps(fu, page, pages, o.now))
    } else {
      const project = hdr(o.doc, 'project', o.doc.project)
      const label = hdr(o.doc, 'projectLabel', o.doc.projectLabel, o.doc.title)
      const lv = hdr(o.doc, 'lv')
      const lvLabel = hdr(o.doc, 'lvLabel', o.doc.title)
      ops.push(T(286.6, 73.6, 'Anfrage', 'b', 12))
      ops.push(T(53.9, 97.7, 'Projekt:', 'b', 10), T(124.8, 97.7, project, 'b', 10), T(224.1, 97.7, label, 'b', 10))
      ops.push(T(53.9, 109.6, 'LV:', 'b', 10), T(124.8, 109.6, lv, 'b', 10), T(224.1, 109.6, lvLabel, 'b', 10))
      ops.push(T(53.9, 133.3, 'OZ', 'b', 10), T(124.8, 133.3, 'Leistungsbeschreibung', 'b', 10), T(314.0, 133.3, 'Menge ME', 'b', 10), T(391.1, 133.3, 'Einheitspreis', 'b', 10), T(468.7, 133.3, 'Gesamtbetrag', 'b', 10))
      ops.push(T(420.9, 145.2, 'in EUR', 'b', 10), T(503.2, 145.2, 'in EUR', 'b', 10))
      ops.push(T(420.2, 28.3, '[FIRMA_102]', 'r', 8), T(420.2, 38.2, '[ADRESSE_007] ž[ORT_026]'.replace('ž', '|'), 'r', 8), T(420.2, 48.0, 'Tel.[TELEFON_010] |Fax.[TELEFON_063]', 'r', 8), T(420.2, 57.8, '[EMAIL_009]', 'r', 8))
      ops.push(T(536.0, 812.6, `Seite: ${page}`, 'r', 8), T(55.2, 813.2, `Druckdatum:    ${dmy(o.now)}`, 'r', 8))
    }
    ops.push({ k: 'r', x: 53.9, y: 118.6, w: 481.9, h: 0.5, fill: BLACK }, { k: 'r', x: 53.9, y: 154.4, w: 481.9, h: 0.4, fill: BLACK })
    return ops
  },
  heading(ctx, c) {
    const lay = ctx.o.layout?.positions[c.oz]
    const tok = lay?.tok ?? c.oz + '.'
    const rows: Row[] = []
    if (lay && lay.k === 'c' && lay.lines.length && !(ctx.o.positions.length && false)) {
      lay.lines.forEach((l, i) => {
        const f: FontKey = l.b && l.i ? 'bi' : l.b ? 'b' : l.i ? 'i' : 'r'
        const x = 124.8 + (l.x ?? 0)
        rows.push({
          gap: i === 0 ? 34.7 : (l.g ?? 11.4),
          brk: i === 0,
          between: i === 0,
          ops: (y) => (i === 0 ? [T(53.9, y, tok, 'b', 8)] : []).concat(l.segs ? l.segs.map((sg) => T(124.8 + sg.x, y, sg.t, f, 10)) : [T(x, y, l.t, f, 10)]),
        })
      })
      if (lay.eg) rows[rows.length - 1].after = lay.eg
      return withLastGap(rows, lay.eg ?? 34.7)
    }
    rows.push({ gap: 34.7, brk: true, between: true, ops: (y) => [T(53.9, y, tok, 'b', 8), T(124.8, y, c.label, 'b', 10)] })
    return withLastGap(rows, 34.7)
  },
  item(ctx, p) {
    const o = ctx.o
    const lay = untouched(ctx, p) ? o.layout?.positions[p.oz] : undefined
    const tok = lay?.tok ?? p.oz + '.'
    const rows: Row[] = []
    const pf = (v: number | null) => (v == null ? null : deNum(v, 2))
    const qtyOps = (y: number): Op[] => {
      const ops: Op[] = [T(346.0, y, deNum(p.qty, 3), 'r', 10, { right: true }), T(351.5, y, unitOf(p), 'r', 10)]
      if (o.prices && p.up != null) ops.push(T(A_RIGHT_EP, y, pf(p.up)!, 'r', 10, { right: true }), T(A_RIGHT_GP, y, deNum(gp(p), 2), 'r', 10, { right: true }))
      else ops.push(T(A_RIGHT_EP, y, dots(25), 'r', 10, { right: true }), T(A_RIGHT_GP, y, dots(25), 'r', 10, { right: true }))
      return ops
    }
    if (lay && lay.lines.length) {
      const lines = lay.lines.filter((l) => o.longTexts || l.s)
      let k = 0
      for (const l of lines) {
        const f: FontKey = l.b && l.i ? 'bi' : l.b ? 'b' : l.i ? 'i' : 'r'
        const idx = k++
        const first = idx === 0
        const gapV = first ? 0 : (l.g ?? 11.4)
        const x = 124.8 + (l.x ?? 0)
        rows.push({
          gap: first ? lay.eg ?? 23.1 : gapV,
          brk: first ? true : idx >= 2,
          between: first,
          ops: (y) => (first ? [T(53.9, y, tok, 'b', 8)] : []).concat(l.segs ? l.segs.map((sg) => T(124.8 + sg.x, y, sg.t, f, 10)) : [T(x, y, l.t, f, 10)]),
        })
      }
      if (!rows.length) rows.push({ gap: 23.1, brk: true, between: true, ops: (y) => [T(53.9, y, tok, 'b', 8)] })
      void qtyOps
    } else {
      const shortLines = ctx.wrap(p.short, 'b', 10, 330)
      shortLines.forEach((t, i) =>
        rows.push({ gap: i === 0 ? 23.1 : 11.4, brk: i === 0 ? true : false, between: i === 0, ops: (y) => (i === 0 ? [T(53.9, y, tok, 'b', 8), T(124.8, y, t, 'b', 10)] : [T(124.8, y, t, 'b', 10)]) }),
      )
      const body = bodyLines(ctx, p, 'r', 10, 325)
      let pending = 0
      let bi = 0
      for (const t of body) {
        if (t === '') {
          pending += 11.4
          continue
        }
        const idx = bi++
        rows.push({ gap: (idx === 0 ? 11.6 : 11.4) + pending, brk: idx >= 2, ops: (y) => [T(124.7, y, t, 'r', 10)] })
        pending = 0
      }
    }
    // qty row (kept with the last body lines)
    const qg = lay?.qg ?? 22.8
    rows.push({ gap: qg, brk: false, ops: qtyOps })
    return rows
  },
  sum(ctx, c, v) {
    const o = ctx.o
    const lay = ctx.o.layout?.positions[c.oz]
    const tok = lay?.tok ?? c.oz + '.'
    return [
      {
        gap: 22.8,
        brk: true,
        ops: (y) => {
          const ops: Op[] = [fill(53.9, y - 14.3, 481.9, 0.5, BLACK), T(53.9, y, 'Summe', 'b', 10), T(98.3, y, tok, 'b', 8)]
          if (c.label) ops.push(T(170.1, y, c.label.length > 40 ? c.label.slice(0, 40) : c.label, 'b', 10))
          ops.push(o.prices && v ? T(A_RIGHT_GP, y, deNum(v, 2), 'b', 10, { right: true }) : T(A_RIGHT_GP, y, dots(25), 'b', 10, { right: true }))
          return ops
        },
      },
    ]
  },
  end(ctx, total) {
    const o = ctx.o
    const h = o.doc.source?.header ?? {}
    const lv = h.lv ?? ''
    const lvLabel = h.lvLabel ?? o.doc.title
    const amt = (v: number | null) => (o.prices && v != null ? deNum(v, 2) : dots(25))
    const net = round2(total)
    const vat = round2(net * 0.19)
    return [
      { gap: 34.2, brk: true, ops: (y) => [T(124.8, y, 'Summe', 'b', 10), T(163.6, y, 'LV', 'b', 8), T(224.1, y, `${lv} ${lvLabel}`.trim(), 'b', 10), T(A_RIGHT_GP, y, amt(net), 'b', 10, { right: true })] },
      { gap: 35.2, brk: false, ops: (y) => [T(124.8, y, 'Zuzüglich der gesetzlichen Mehrwertsteuer aus', 'r', 10), T(A_RIGHT_GP - 20, y, amt(null), 'r', 10, { right: true }), T(A_RIGHT_GP, y, 'EUR', 'r', 10, { right: true })] },
      { gap: 11.4, brk: false, ops: (y) => [T(124.8, y, 'in Höhe von 19,00 %', 'r', 10), T(A_RIGHT_GP - 20, y, amt(o.prices ? vat : null), 'r', 10, { right: true }), T(A_RIGHT_GP, y, 'EUR', 'r', 10, { right: true })] },
      { gap: 22.8, brk: false, ops: (y) => [T(A_RIGHT_GP - 20, y, amt(o.prices ? round2(net + vat) : null), 'b', 10, { right: true }), T(A_RIGHT_GP, y, 'EUR', 'b', 10, { right: true })] },
      { gap: 102.6, brk: false, ops: (y) => [T(118.7, y, '(Ort)', 'r', 10), T(234.2, y, '(Datum)', 'r', 10), T(361.0, y, '(rechtsgültige Unterschrift)', 'r', 10)] },
      { gap: 34.2, brk: false, ops: (y) => [T(53.9, y, `Das LV besteht aus den Seiten 1 bis ${ctx.total}`, 'r', 10)] },
    ]
  },
  carryBottom: (ctx, y, v) => [fill(394.1, y - 11, 141.7, 0.5, BLACK), fill(394.1, y + 4, 141.7, 0.5, BLACK), T(394.1, y, 'Übertrag:', 'r', 8), ...(ctx.o.prices && v ? [T(A_RIGHT_GP, y, deNum(v, 2), 'r', 8, { right: true })] : [])],
  carryTopOps: (ctx, y, v) => [fill(394.1, y + 4.3, 141.7, 0.5, BLACK), T(394.1, y, 'Übertrag:', 'r', 8), ...(ctx.o.prices && v ? [T(A_RIGHT_GP, y, deNum(v, 2), 'r', 8, { right: true })] : [])],
}

/** sets the gap of the row *after* this block (kept as `after`) — used by headings so the next row knows its spacing */
function withLastGap(rows: Row[], g: number): Row[] {
  rows[rows.length - 1].after = g
  return rows
}

/* ------------------------------------------------------------------ */
/* Template B — Kurz- und Langtext                                     */
/* ------------------------------------------------------------------ */

const B_BAR: RGB = [0, 0.404, 0.694]
const B_L1: RGB = [0.541, 0.773, 1]
const B_L2: RGB = [0.667, 0.835, 1]
const B_RIGHT_EP = 480.4
const B_RIGHT_GP = 556.9

const tplB: Tpl = {
  id: 'B_kurz_langtext',
  top1: 159.0,
  topN: 159.0,
  bottom: 782,
  frame(ctx, page, pages) {
    const o = ctx.o
    const h = o.doc.source?.header ?? {}
    const project = h.project ?? o.doc.project ?? ''
    const projLabel = h.projectLabel ?? o.doc.projectLabel ?? ''
    const lv = h.lv ?? ''
    const lvLabel = h.lvLabel ?? o.doc.title
    const ops: Op[] = [
      T(197.3, 74.3, 'Leistungsverzeichnis Kurz- und Langtext', 'b', 12),
      T(72.6, 96.5, 'Projekt:', 'b', 10), T(151.9, 96.5, project, 'b', 10), T(245.5, 96.5, projLabel, 'r', 10),
      T(72.6, 109.7, 'LV:', 'b', 10), T(152.0, 109.7, lv, 'b', 10), T(245.6, 109.7, lvLabel, 'r', 10),
      T(556.9, 109.7, `Währung: ${o.doc.currency || 'EUR'}`, 'b', 10, { right: true }),
      fill(70.9, 116.5, 487.7, 18.4, B_BAR),
    ]
    for (const [x, t] of [[72.6, 'Ordnungszahl'], [151.9, 'Leistungsbeschreibung'], [346.5, 'Menge'], [381.6, 'ME'], [417.8, 'Einheitspreis'], [489.7, 'Gesamtbetrag']] as const)
      ops.push(T(x, 128.6, t, 'b', 10, { c: [1, 1, 1] }))
    ops.push(hline(70.9, 799.4, 558.6, 0.72), T(557.2, 808.2, `Seite: ${page} von ${pages}`, 'r', 8, { right: true }))
    return ops
  },
  heading(_ctx, c) {
    const bar = c.depth === 1 ? B_L1 : B_L2
    return [{
      gap: c.depth === 1 ? 28 : 28.1,
      brk: true,
      between: true,
      after: 32,
      ops: (y) => [fill(70.9, y - 10, 487.7, 14, bar), T(72.6, y, c.oz + '.', 'b', 10), T(151.9, y, c.label, 'b', 10)],
    }]
  },
  item(ctx, p) {
    const o = ctx.o
    const rows: Row[] = []
    rows.push({ gap: 32, brk: true, between: true, ops: (y) => [T(72.6, y, p.oz + '.', 'b', 10), ...ctx.wrap(p.short, 'b', 10, 270).slice(0, 1).map((t) => T(152.0, y, t, 'b', 10))] })
    const shortRest = ctx.wrap(p.short, 'b', 10, 270).slice(1)
    shortRest.forEach((t) => rows.push({ gap: 11.05, brk: false, ops: (y) => [T(152.0, y, t, 'b', 10)] }))
    const body = bodyLines(ctx, p, 'r', 10, 276)
    let pending = 0
    let bi = 0
    for (const t of body) {
      if (t === '') {
        pending += 11.05
        continue
      }
      const idx = bi++
      rows.push({ gap: (idx === 0 && !shortRest.length ? 14.3 : 11.05) + pending, brk: idx >= 2, ops: (y) => [T(151.8, y, t, 'r', 10)] })
      pending = 0
    }
    rows.push({
      gap: body.length ? 12.8 : 14.3,
      brk: false,
      ops: (y) => [
        T(378.3, y, deNum(p.qty, 3), 'r', 10, { right: true }), T(381.6, y, unitOf(p), 'r', 10),
        ...(o.prices && p.up != null
          ? [T(B_RIGHT_EP, y, deNum(p.up, 2), 'r', 10, { right: true }), T(B_RIGHT_GP, y, deNum(gp(p), 2), 'r', 10, { right: true })]
          : [T(B_RIGHT_EP, y, dots(22), 'r', 10, { right: true }), T(B_RIGHT_GP, y, dots(22), 'r', 10, { right: true })]),
      ],
    })
    return rows
  },
  sum(ctx, c, v) {
    return [{ gap: 28, brk: true, ops: (y) => [T(151.9, y, `Summe ${c.oz}. ${c.label}`.slice(0, 60), 'b', 10), T(B_RIGHT_GP, y, ctx.o.prices && v ? deNum(v, 2) : dots(22), 'b', 10, { right: true })] }]
  },
  end(ctx, total) {
    return [{ gap: 34, brk: true, ops: (y) => [T(151.9, y, 'Summe LV', 'b', 10), T(B_RIGHT_GP, y, ctx.o.prices ? deNum(round2(total), 2) : dots(22), 'b', 10, { right: true })] }]
  },
}

/* ------------------------------------------------------------------ */
/* Template C — Angebot                                                */
/* ------------------------------------------------------------------ */

/** the original clips long labels at the right hand text edge */
const clip = (ctx: Ctx, t: string, maxW = 413) => {
  let o = t
  while (o.length > 1 && ctx.width(o, 'r', 10) > maxW) o = o.slice(0, -1)
  return o
}

const tplC: Tpl = {
  id: 'C_angebot',
  top1: 365.5,
  topN: 114.5,
  bottom: 770,
  carryTop: 27.7,
  carryBottomY: 783.7,
  noLong: true,
  frame(ctx, page, pages) {
    const o = ctx.o
    const h = o.doc.source?.header ?? {}
    const bv = h.bauvorhaben ?? o.doc.project ?? ''
    const bv2 = h.bauvorhaben2 ?? o.doc.title
    const angebotNr = h.angebotNr ?? ''
    const datum = h.datum ?? dd(o.now)
    const kunde = h.kundenNr ?? ''
    const ops: Op[] = []
    const colHead = (y: number) => {
      ops.push(T(60.7, y + 0.7, 'Pos-Nr.', 'b', 9), T(200.8, y, 'Menge', 'b', 9), T(236.2, y, 'ME', 'b', 9), T(431.2, y, 'EP /', 'b', 9), T(458.8, y, 'EUR', 'b', 9), T(508.2, y, 'GP /', 'b', 9), T(537.5, y, 'EUR', 'b', 9))
    }
    if (page === 1) {
      const firm = h.firm ?? '[FIRMA_110] | [ADRESSE_019] | [ORT_017]'
      ops.push(T(60.7, 83.4, firm, 'r', 9), T(60.7, 100.4, 'Tel. [TELEFON_081] | Fax [TELEFON_040] | [EMAIL_008] | [URL_015]', 'r', 9, { c: [0.5, 0.5, 0.5] }))
      ops.push(hline(60.7, 72.5, 400.8, 0.55, [0.75, 0.75, 0.75]), hline(60.7, 89.5, 400.8, 0.55, [0.75, 0.75, 0.75]), hline(60.7, 106.4, 400.8, 0.55, [0.75, 0.75, 0.75]))
      ops.push(T(60.7, 158.2, firm.replace(/ \| /g, ' | '), 'r', 7), T(60.7, 174.6, '[FIRMA_006]', 'r', 10), T(60.7, 185.6, '[ADRESSE_017]', 'r', 10), T(60.7, 196.7, '[ORT_009]', 'r', 10))
      ops.push({ k: 'r', x: 325.4, y: 188.3 - 0.4, w: 229.5, h: 89.9, stroke: BLACK, lw: 0.72 })
      ops.push(T(403.9, 179.4, 'Angebot', 'b', 18), T(328.6, 201.6, 'Angebot-Nr.:', 'r', 10), T(420.0, 201.6, angebotNr, 'r', 10), T(328.1, 218.9, 'Datum:', 'r', 10), T(420.0, 218.9, datum, 'r', 10))
      ops.push(T(328.6, 236.2, 'Kunden-Nr.:', 'r', 10), T(420.0, 236.2, kunde, 'r', 10), T(328.6, 253.3, 'Seite:', 'r', 10), T(425.4, 253.3, String(page), 'r', 10, { right: true }), T(328.6, 270.6, 'Sachbearbeiter:', 'r', 10))
      ops.push(T(60.5, 304.7, 'Bauvorhaben:', 'b', 10), T(131.3, 304.3, bv, 'r', 10), T(131.3, 315.6, bv2, 'r', 10))
      colHead(346.7)
      for (let k = 0; k < 6; k++) ops.push(hline(60.7, 348.7 + k * 0.12, 556.4, 0.12))
      for (const yy of [789.8, 803.9, 818.0]) ops.push(hline(60.7, yy, 392.3, 0.55, [0.75, 0.75, 0.75]), hline(429.1, yy, 542.4, 0.55, [0.75, 0.75, 0.75]))
      ops.push(fill(0, 0, PAGE_W, 32, [0.88, 0.88, 0.88]), T(2, 19.4, '[BILD_028]', 'r', 9.4, { c: GREY }), fill(414.6, 69, 142.7, 43, [0.88, 0.88, 0.88]), T(417, 95.1, '[BILD_027]', 'r', 12.7, { c: GREY }), T(420, 270.6, '[PERSON_130]', 'r', 10))
      ops.push(T(60.7, 799.9, 'Sparkasse Dillingen', 'r', 8), T(60.7, 814.1, 'VR-Bank Donau-Mindel eG', 'r', 8), T(166.6, 799.9, 'IBAN: DE 26 7225 1520 [TELEFON_019]', 'r', 8), T(166.6, 814.1, 'IBAN: DE 14 7206 9043 [TELEFON_072]', 'r', 8), T(315.8, 799.9, 'BIC: [BIC_001]', 'r', 8), T(315.8, 814.1, 'BIC: [BIC_002]', 'r', 8), T(429.1, 799.9, 'AG Augsburg', 'r', 8), T(429.1, 814.1, '[HRB_003] | Sitz: [ORT_017]', 'r', 8))
    } else {
      ops.push({ k: 'r', x: 61.5, y: 67, w: 493.5, h: 15, stroke: BLACK, lw: 0.7 })
      ops.push(T(129.7, 34.7, h.firm ?? '[FIRMA_110] | [ADRESSE_019] | [ORT_017]', 'r', 8))
      ops.push(T(61.0, 60.8, 'Bauvorhaben:', 'b', 10), T(129.7, 60.5, `${bv} ${bv2}`, 'r', 10))
      ops.push(T(63.6, 76.9, 'Projekt-Nr.: [NUMMER_003]', 'r', 10), T(171.6, 76.9, `Angebot-Nr.: ${angebotNr}`, 'r', 10), T(285.0, 76.9, `Kunden-Nr.: ${kunde}`, 'r', 10), T(393.1, 76.9, `Datum: ${datum}`, 'r', 10), T(504.1, 76.9, 'Seite:', 'r', 10), T(553.6, 76.9, String(page), 'r', 10, { right: true }))
      colHead(96.7)
      for (let k = 0; k < 6; k++) ops.push(hline(60.7, 99.5 + k * 0.12, 556.4, 0.12))
    }
    void pages
    return ops
  },
  heading(_ctx, c) {
    const word = c.depth === 1 ? 'Bereich' : c.depth === 2 ? 'Abschnitt' : 'Unterabschnitt'
    return [{
      gap: c.depth === 1 ? 26 : 15,
      brk: true,
      between: true,
      after: 28,
      ops: (y) => [T(60.7, y, `${word} ${c.oz}.`, 'b', 10), T(159.7, y, c.label, 'b', 10)],
    }]
  },
  item(ctx, p) {
    const o = ctx.o
    const rows: Row[] = []
    const qtyTxt = deNum(p.qty, 3)
    rows.push({
      gap: 27.0,
      brk: true,
      between: true,
      after: 14,
      ops: (y) => [
        T(60.7, y, p.oz, 'r', 10), T(230.3, y, qtyTxt, 'r', 10, { right: true }), T(237.7, y, unitOf(p), 'r', 10),
        ...(o.prices && p.up != null ? [T(478.7, y, deNum(p.up, 2), 'r', 10, { right: true }), T(556.5, y, deNum(gp(p), 2), 'r', 10, { right: true })] : []),
      ],
    })
    const lay = untouched(ctx, p) ? o.layout?.positions[p.oz] : undefined
    const shortSrc = lay?.lines?.filter((l) => l.s).map((l) => l.t)
    const short = shortSrc?.length ? shortSrc : ctx.wrap(p.short, 'r', 10, 290)
    short.forEach((t, i) => rows.push({ gap: i === 0 ? 11.3 : 11.3, brk: false, ops: (y) => [T(158.3, y, t, 'r', 10)] }))
    const body = bodyLines(ctx, p, 'r', 9, 290)
    let pending = 0
    for (const t of body) {
      if (t === '') {
        pending += 10.2
        continue
      }
      rows.push({ gap: 10.2 + pending, brk: true, ops: (y) => [T(158.3, y, t, 'r', 9)] })
      pending = 0
    }
    return rows
  },
  sum(ctx, c, v) {
    const o = ctx.o
    const rule = (y: number) => fill(60.7, y, 495.7, 0.9, BLACK)
    const dbl = (y: number) => [rule(y), rule(y + 1.4)]
    const amt = (y: number, f: FontKey, val: number) => (o.prices ? [T(556.5, y, deNum(val, 2), f, 10, { right: true })] : [])
    const kind = c.depth === 1 ? 'Bereich' : c.depth === 2 ? 'Abschnitt' : 'Unterabschnitt'
    if (c.depth === 1) {
      const rows: Row[] = []
      if (c.cats.length) {
        rows.push({ gap: 24.7, brk: true, ops: (y) => [T(60.7, y, `Zusammenstellung ${kind} ${c.oz}.`, 'b', 10)] })
        c.cats.forEach((k, i) => rows.push({ gap: i === 0 ? 16.9 : 16.9, brk: false, ops: (y) => [T(60.7, y, clip(ctx, `Summe Abschnitt ${k.oz}. ${k.label}`), 'r', 10), ...amt(y, 'r', catSum(k))] }))
        rows.push({ gap: 16.8, brk: false, ops: (y) => [rule(y - 12.2), T(60.7, y, `Summe ${kind} ${c.oz}.`, 'b', 10), ...amt(y, 'b', v), ...dbl(y + 5)] })
      } else {
        rows.push({ gap: 16.1, brk: true, ops: (y) => [rule(y - 12.3), T(60.7, y, `Summe ${kind} ${c.oz}.`, 'b', 10), ...amt(y, 'b', v), ...dbl(y + 5)] })
      }
      return rows
    }
    return [{ gap: 16.1, brk: true, ops: (y) => [rule(y - 12.3), T(60.7, y, `Summe ${kind} ${c.oz}.`, 'b', 10), ...amt(y, 'b', v), ...dbl(y + 5)] }]
  },
  end(ctx, total) {
    const o = ctx.o
    const net = round2(total)
    const vat = round2(net * 0.19)
    const rows: Row[] = [{ gap: 30, brk: true, newPage: 119.3, ops: (y) => [T(60.7, y, 'Gesamtzusammenstellung', 'b', 10)] }]
    let first = true
    for (const c of ctx.o.tree.roots) {
      rows.push({
        gap: first ? 17.1 : 17.2, brk: false,
        ops: (y) => [T(60.7, y, clip(ctx, `Summe ${c.depth === 1 ? 'Bereich' : 'Abschnitt'} ${c.oz}. ${c.label}`), 'r', 10), ...(o.prices ? [T(556.5, y, deNum(catSum(c), 2), 'r', 10, { right: true })] : [])],
      })
      first = false
    }
    rows.push({ gap: 17.1, brk: false, ops: (y) => [fill(60.7, y - 11, 495.7, 0.9, BLACK), T(60.7, y, 'Summe (netto)', 'r', 10), ...(o.prices ? [T(556.5, y, deNum(net, 2), 'r', 10, { right: true })] : [])] })
    rows.push({ gap: 17.3, brk: false, ops: (y) => [T(60.7, y, 'zzgl. Mehrwertsteuer', 'r', 10), T(469.5, y, '19,00 %', 'r', 10, { right: true }), ...(o.prices ? [T(556.5, y, deNum(vat, 2), 'r', 10, { right: true })] : []), fill(60.7, y + 4.7, 495.7, 0.9, BLACK)] })
    rows.push({ gap: 16.9, brk: false, ops: (y) => [T(60.7, y, 'Gesamtsumme:', 'b', 10), ...(o.prices ? [T(556.6, y, deNum(round2(net + vat), 2), 'b', 10, { right: true })] : []), fill(60.7, y + 4.9, 495.7, 0.9, BLACK), fill(60.7, y + 6.4, 495.7, 0.9, BLACK)] })
    rows.push({ gap: 98.8, brk: false, ops: (y) => [T(202.4, y, 'Mit freundlichen Grüßen', 'r', 10)] })
    rows.push({ gap: 22.3, brk: false, ops: (y) => [T(204.7, y, `Datum: ${o.doc.source?.header?.datum ?? dd(o.now)}               Unterschrift: ${'.'.repeat(56)}`, 'r', 10)] })
    return rows
  },
  carryBottom: (ctx, y, v) => [T(478.5, y, 'Übertrag:', 'r', 10, { right: true }), T(556.7, y, ctx.o.prices ? deNum(v, 2) : '', 'r', 10, { right: true })],
  carryTopOps: (ctx, y, v) => [T(479.2, y, 'Übertrag:', 'r', 10, { right: true }), T(556.6, y, ctx.o.prices ? deNum(v, 2) : '', 'r', 10, { right: true })],
}

/* ------------------------------------------------------------------ */
/* Template D — LV-Ausdruck                                            */
/* ------------------------------------------------------------------ */

const D_RIGHT_EP = 453.3
const D_RIGHT_GP = 545.8

const tplD: Tpl = {
  id: 'D_lv_ausdruck',
  top1: 172.8,
  topN: 172.8,
  bottom: 770,
  carryTop: 0,
  carryAt: -23.4,
  carryBottomY: 777.2,
  frame(ctx, page, pages) {
    const o = ctx.o
    const h = o.doc.source?.header ?? {}
    const office = h.office ?? ''
    const projekt = h.projekt ?? o.doc.projectLabel ?? o.doc.project ?? ''
    const bauherr = h.bauherr ?? ''
    const datum = h.datum ?? dd(o.now)
    const dvNr = h.dvNrAg ?? o.doc.project ?? ''
    const ops: Op[] = []
    ops.push(T(109.3, 59.0, office, 'r', 9.7))
    ops.push(hline(56.6, 66.4, 550, 0.24))
    ops.push(T(547.1, 76.6, `Seite  ${page}`, 'r', 9.7, { right: true }), T(59.6, 77.4, 'Projekt:', 'r', 9.7), T(133.2, 77.6, projekt, 'r', 9.7))
    ops.push(T(59.6, 89.4, 'Bauherr:', 'r', 9.7), T(133.2, 89.4, bauherr, 'r', 9.7), T(547.1, 89.4, `Datum  ${datum}`, 'r', 9.7, { right: true }))
    ops.push(T(59.6, 102.1, 'DV-Nr. AG:', 'r', 9.7), T(133.2, 101.4, dvNr, 'r', 9.7))
    ops.push(hline(58.2, 106.1, 550, 0.24), hline(58.2, 132.8, 550, 0.24))
    ops.push(T(60.5, 117.8, 'Pos', 'r', 9.7), T(133.2, 116.5, 'Stl-Nr.', 'r', 9.7), T(269.3, 115.6, 'Menge / Einheit', 'r', 9.7), T(392.1, 115.6, 'Einheitspreis', 'r', 9.7), T(395.2, 126.5, 'in EUR', 'r', 9.7), T(485.0, 115.6, 'Gesamtbetrag', 'r', 9.7), T(485.6, 126.5, 'in EUR', 'r', 9.7))
    ops.push(hline(56.6, 783.1, 550, 0.375), T(59.5, 792.6, 'Alle Einzelbeträge Netto in EUR', 'r', 8.2), T(547.0, 792.8, `${dd(o.now)} - Seite ${page} von ${pages}`, 'b', 8.2, { right: true }))
    return ops
  },
  heading(_ctx, c) {
    return [{ gap: 36.6, brk: true, between: true, after: 36.6, ops: (y) => [T(61.2, y, c.oz, 'b', 9.7), T(124.2, y, c.label, 'b', 9.7)] }]
  },
  item(ctx, p) {
    const o = ctx.o
    const rows: Row[] = []
    const short = ctx.wrap(p.short, 'r', 10, 300)
    const ozTxt = (c: string) => c.split('.').map((s) => s.padStart(2, '0')).join('.')
    short.forEach((t, i) =>
      rows.push({ gap: i === 0 ? 36.4 : 11.4, brk: i === 0, between: i === 0, ops: (y) => [...(i === 0 ? [T(58.4, y - 0.7, ozTxt(p.oz), 'b', 9.7)] : []), T(138.0, y, t, 'r', 10)] }),
    )
    const body = bodyLines(ctx, p, 'r', 10, 300)
    let pending = 0
    let bi = 0
    for (const t of body) {
      if (t === '') {
        pending += 11.4
        continue
      }
      const idx = bi++
      rows.push({ gap: (idx === 0 ? 22.8 : 11.4) + (idx === 0 ? 0 : pending), brk: idx >= 2, ops: (y) => [T(138.0, y, t, 'r', 10)] })
      pending = 0
    }
    rows.push({
      gap: 16.5,
      brk: false,
      ops: (y) => [
        T(317.4, y, deQty(p.qty), 'r', 9.7, { right: true }), T(326.0, y, unitOf(p), 'r', 9.7),
        ...(o.prices && p.up != null
          ? [T(453.3, y, deNum(p.up, 2), 'r', 9.7, { right: true }), T(545.8, y, deNum(gp(p), 2), 'r', 9.7, { right: true })]
          : [T(D_RIGHT_EP, y, dots(20), 'r', 9.7, { right: true }), T(D_RIGHT_GP, y, dots(20), 'r', 9.7, { right: true })]),
      ],
    })
    return rows
  },
  sum(ctx, c, v) {
    return [{ gap: 30, brk: true, ops: (y) => [T(61.2, y, 'Summe', 'b', 9.7), T(104, y, `${c.oz} ${c.label}`.slice(0, 55), 'b', 9.7), T(552.6, y, ctx.o.prices ? deNum(v, 2) : dots(34), 'r', 9.7, { right: true })] }]
  },
  end(ctx, total) {
    const o = ctx.o
    const net = round2(total)
    const vat = round2(net * 0.19)
    const amt = (v: number) => (o.prices ? deNum(v, 2) : dots(34))
    const rows: Row[] = [{ gap: 40, brk: true, ops: (y) => [T(60.5, y, 'Zusammenstellung der Abschnitte', 'b', 12)] }]
    for (const c of o.tree.roots) rows.push({ gap: 22.7, brk: false, ops: (y) => [T(59.5, y, c.oz, 'r', 9.7), T(134.6, y, c.label.slice(0, 55), 'r', 9.7), T(546.8, y, amt(catSum(c)), 'r', 9.7, { right: true })] })
    rows.push({ gap: 25.8, brk: false, ops: (y) => [T(59.5, y, 'Gesamtsumme', 'b', 9.7), T(552.6, y, amt(net), 'r', 9.7, { right: true })] })
    rows.push({ gap: 22.3, brk: false, ops: (y) => [T(438.6, y, 'MWSt. 19,0 %', 'r', 9.7, { right: true }), T(552.6, y, amt(vat), 'r', 9.7, { right: true })] })
    rows.push({ gap: 23, brk: false, ops: (y) => [T(439.2, y, 'Gesamtsumme inkl. MWSt.', 'b', 9.7, { right: true }), T(552.6, y, amt(round2(net + vat)), 'b', 9.7, { right: true })] })
    rows.push({ gap: 98.3, brk: false, ops: (y) => [T(327.5, y, dots(70), 'r', 9.7), T(326.6, y + 10.6, '(Ort und Datum)', 'r', 8.2)] })
    rows.push({ gap: 63.7, brk: false, ops: (y) => [T(327.5, y, dots(70), 'r', 9.7), T(327.5, y + 9.7, '(Stempel und Unterschrift, Anbieter)', 'r', 8.2)] })
    return rows
  },
  carryBottom: (ctx, y, v) => [T(547.1, y, `Übertrag: ${ctx.o.prices ? deNum(v, 2) : dots(18)}`, 'r', 9.7, { right: true })],
  carryTopOps: (ctx, y, v) => [T(547.1, y, `Übertrag: ${ctx.o.prices ? deNum(v, 2) : dots(18)}`, 'r', 9.7, { right: true })],
}

/* ------------------------------------------------------------------ */
/* Template E — Courier                                                */
/* ------------------------------------------------------------------ */

const tplE: Tpl = {
  id: 'E_courier',
  top1: 105,
  topN: 105,
  bottom: 790,
  frame(ctx, page) {
    const o = ctx.o
    const h = o.doc.source?.header ?? {}
    const lvLabel = h.lvLabel ?? o.doc.title
    const ops: Op[] = [
      fill(44.2, 76.5, 507, 19.5, [0.93, 0.93, 0.93]),
      hline(44.2, 800, 550.5, 0.5, [0.6, 0.6, 0.6]),
      T(44.2, 51.0, `LV: ${lvLabel.replace(/\[([A-Z]+), ([A-Z_0-9]+\])/g, '[$1$2')}`, 'r', 7.5),
      T(423.0, 51.0, 'Seite:', 'cr', 7.5), T(550.5, 51.0, String(page), 'cr', 7.5, { right: true }),
      T(423.0, 61.5, 'Datum:', 'cr', 7.5), T(550.5, 61.5, h.datum ?? dd(o.now), 'cr', 7.5, { right: true }),
      T(423.0, 72.0, 'LV-Datum:', 'cr', 7.5), T(550.5, 72.0, h.lvDatum ?? h.datum ?? dd(o.now), 'cr', 7.5, { right: true }),
      T(44.2, 83.5, 'Pos-Nr. (Pos-', 'cb', 7.5), T(44.2, 92.5, 'Nr.)', 'cb', 7.5), T(134.6, 83.5, 'Menge', 'cb', 7.5), T(269.2, 83.5, 'Einheit', 'cb', 7.5),
      T(400.5, 83.5, 'Einheitspreis in', 'cb', 7.5), T(429.8, 92.5, 'EUR', 'cb', 7.5), T(481.5, 83.5, 'Gesamtpreis in', 'cb', 7.5), T(506.2, 92.5, 'EUR', 'cb', 7.5),
    ]
    return ops
  },
  heading(_ctx, c) {
    return [{ gap: 18, brk: true, between: true, ops: (y) => [T(44.2, y, c.oz, 'cb', 7.5), T(120.8, y, c.label, 'cb', 7.5)] }]
  },
  item(ctx, p) {
    const o = ctx.o
    const rows: Row[] = []
    rows.push({
      gap: 18,
      brk: true,
      between: true,
      ops: (y) => [
        T(44.2, y, p.oz, 'cr', 7.5), T(157.1, y, deNum(p.qty, 3), 'cr', 7.5, { right: true }), T(269.2, y, unitOf(p), 'cr', 7.5),
        ...(o.prices && p.up != null ? [T(472.5, y, deNum(p.up, 2), 'cr', 7.5, { right: true }), T(544.5, y, deNum(gp(p), 2), 'cr', 7.5, { right: true })] : []),
      ],
    })
    ctx.wrap(p.short, 'cr', 7.5, 420).forEach((t, i) => rows.push({ gap: i === 0 ? 9 : 9, brk: false, ops: (y) => [T(120.8, y, t, 'cr', 7.5)] }))
    const body = bodyLines(ctx, p, 'cr', 7.5, 420)
    let pending = 0
    for (const t of body) {
      if (t === '') {
        pending += 9
        continue
      }
      rows.push({ gap: 9 + pending, brk: true, ops: (y) => [T(120.8, y, t, 'cr', 7.5)] })
      pending = 0
    }
    return rows
  },
  sum(ctx, c, v) {
    return [{ gap: 18, brk: true, ops: (y) => [T(120.8, y, `Summe ${c.oz} ${c.label}`.slice(0, 60), 'cb', 7.5), ...(ctx.o.prices ? [T(544.5, y, deNum(v, 2), 'cb', 7.5, { right: true })] : [])] }]
  },
  end(ctx, total) {
    return [{ gap: 27, brk: true, ops: (y) => [T(120.8, y, 'Summe LV', 'cb', 7.5), ...(ctx.o.prices ? [T(544.5, y, deNum(round2(total), 2), 'cb', 7.5, { right: true })] : [])] }]
  },
}

const TEMPLATES: Record<TemplateId, Tpl> = {
  A_anfrage: tplA,
  B_kurz_langtext: tplB,
  C_angebot: tplC,
  D_lv_ausdruck: tplD,
  E_courier: tplE,
}

export function pickTemplate(doc: ListDoc, fallback: TemplateId = 'B_kurz_langtext'): TemplateId {
  const t = doc.source?.pdfTemplate
  if (t && t in TEMPLATES) return t
  const fn = doc.fileName ?? ''
  if (/^LV_\d/i.test(fn) && /\.pdf$/i.test(fn)) return 'A_anfrage'
  if (/Angebot/i.test(fn)) return 'C_angebot'
  if (/PROJEKT_004/.test(fn)) return 'D_lv_ausdruck'
  return fallback
}

const NOSHORT = '(ohne Kurztext)'
function fixShort(p: Position): Position {
  if (p.short !== NOSHORT) return p
  const lines = (p.long ?? '').split(/\r?\n/)
  const first = lines.find((l) => l.trim()) ?? ''
  return { ...p, short: first, long: lines.slice(lines.indexOf(first) + 1).join(String.fromCharCode(10)).trim() || undefined }
}
function fixTree(t: CatTree): CatTree {
  const rec = (c: Cat): Cat => ({ ...c, items: c.items.map(fixShort), cats: c.cats.map(rec) })
  return { roots: t.roots.map(rec), rootItems: t.rootItems.map(fixShort) }
}

/* ------------------------------------------------------------------ */
/* layout + render                                                     */
/* ------------------------------------------------------------------ */

export async function generatePdf(opts: PdfOpts): Promise<Uint8Array> {
  let o = opts
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.setTitle(clean(o.doc.title || 'Leistungsverzeichnis'))
  pdf.setCreator('BillBuild')
  pdf.setProducer('BillBuild / pdf-lib')
  const fonts: Record<FontKey, PDFFont> = {
    r: await pdf.embedFont(StandardFonts.Helvetica),
    b: await pdf.embedFont(StandardFonts.HelveticaBold),
    i: await pdf.embedFont(StandardFonts.HelveticaOblique),
    bi: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    cr: await pdf.embedFont(StandardFonts.Courier),
    cb: await pdf.embedFont(StandardFonts.CourierBold),
  }
  const width = (t: string, f: FontKey, s: number) => fonts[f].widthOfTextAtSize(clean(t), s)
  const wrap = (t: string, f: FontKey, s: number, maxW: number): string[] => {
    const text = clean(t).replace(/\s+$/, '')
    if (width(text, f, s) <= maxW) return [text]
    const out: string[] = []
    let line = ''
    for (const word of text.split(/(?<= )/)) {
      const cand = line + word
      if (line && width(cand.trimEnd(), f, s) > maxW) {
        out.push(line.trimEnd())
        line = word
      } else line = cand
      while (width(line.trimEnd(), f, s) > maxW && line.length > 1) {
        let cut = line.length - 1
        while (cut > 1 && width(line.slice(0, cut), f, s) > maxW) cut--
        out.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    if (line.trim()) out.push(line.trimEnd())
    return out
  }
  if (o.prices && !o.positions.some((p) => p.up != null)) o = { ...o, prices: false }
  o = { ...o, positions: o.positions.map(fixShort) }
  o.tree = fixTree(o.tree)
  const tpl = TEMPLATES[o.template]
  if (tpl.noLong) o = { ...o, longTexts: false }
  const ctx: Ctx = { o, width, wrap, orig: new Map(o.doc.positions.map((p) => [p.id, p])), total: 1 }

  /* ---- build the row list ---- */
  const rows: (Row & { carryVal?: number })[] = []
  const catMap = new Map<string, Cat>()
  const collect = (c: Cat) => {
    catMap.set(c.oz, c)
    c.cats.forEach(collect)
  }
  o.tree.roots.forEach(collect)
  if (tpl.intro) rows.push(...tpl.intro(ctx))
  if (o.doc.notes && o.doc.notes.trim()) {
    const lines = o.doc.notes.split('\n').flatMap((l) => (l.trim() === '' ? [''] : wrap(l, 'r', 10, 330)))
    let pending = 0
    let n = 0
    for (const t of lines) {
      if (t === '') {
        pending += 11.4
        continue
      }
      rows.push({ gap: (n++ === 0 ? 0 : 11.4) + pending, brk: n > 2, ops: (y) => [T(124.7, y, t, o.template === 'E_courier' ? 'cr' : 'r', o.template === 'E_courier' ? 7.5 : 10)] })
      pending = 0
    }
  }
  let running = 0
  const rowSum: number[] = []
  const push = (rs: Row[], valueAfter: number) => {
    for (const r of rs) {
      rows.push(r)
      rowSum.push(valueAfter)
    }
  }
  for (const ev of walk(o.tree)) {
    if (ev.k === 'open') push(tpl.heading(ctx, ev.cat), running)
    else if (ev.k === 'item') {
      const before = running
      running = round2(running + gp(ev.p))
      push(tpl.item(ctx, ev.p, false), before)
    } else push(tpl.sum(ctx, ev.cat, ev.sum, false), running)
  }
  const grand = round2(o.positions.reduce((s, p) => s + gp(p), 0))
  push(tpl.end(ctx, grand, o.positions.length), grand)

  /* ---- paginate ---- */
  interface Placed { page: number; y: number; row: Row }
  const placed: Placed[] = []
  const carries: { page: number; yBottom: number; value: number }[] = []
  const topOf = (page: number) => (page === 1 ? tpl.top1 : tpl.topN)
  let page = 1
  let y = 0
  let firstOnPage = true
  let prevBaseline = 0
  let carryNext = false
  rows.forEach((r, idx) => {
    const val = rowSum[idx - (rows.length - rowSum.length)] ?? running
    if (firstOnPage) {
      y = topOf(page)
      if (carryNext && tpl.carryTop) y += tpl.carryTop
      else if (carryNext) y += 0
    } else y = prevBaseline + r.gap
    if (r.newPage !== undefined && !firstOnPage) {
      page++
      firstOnPage = true
      carryNext = false
      y = r.newPage
    } else if (!firstOnPage && y > tpl.bottom && r.brk) {
      // page break before this row
      const between = !!r.between
      if (between && tpl.carryBottom) carries.push({ page, yBottom: tpl.carryBottomY ?? prevBaseline + 15.3, value: val })
      page++
      firstOnPage = true
      carryNext = between && !!tpl.carryTopOps
      y = topOf(page) + (carryNext && tpl.carryTop ? tpl.carryTop : 0)
      if (carryNext) carries.push({ page, yBottom: -(topOf(page) + (tpl.carryAt ?? 0)), value: val })
    }
    if (r.newPage !== undefined) y = r.newPage
    placed.push({ page, y, row: r })
    prevBaseline = y
    firstOnPage = false
    carryNext = false
  })
  const pages = Math.max(1, page)
  ctx.total = pages

  /* ---- render ---- */
  const pdfPages: PDFPage[] = []
  for (let i = 0; i < pages; i++) pdfPages.push(pdf.addPage([PAGE_W, PAGE_H]))
  const draw = (pg: PDFPage, op: Op) => {
    if (op.k === 't') {
      const text = clean(op.t)
      if (!text) return
      const f = fonts[op.f]
      const w = f.widthOfTextAtSize(text, op.s)
      const c = op.c ?? BLACK
      pg.drawText(text, { x: op.right ? op.x - w : op.x, y: PAGE_H - op.y, size: op.s, font: f, color: rgb(c[0], c[1], c[2]) })
    } else if (op.k === 'r') {
      pg.drawRectangle({
        x: op.x, y: PAGE_H - op.y - op.h, width: op.w, height: op.h,
        color: op.fill ? rgb(...op.fill) : undefined,
        borderColor: op.stroke ? rgb(...op.stroke) : undefined,
        borderWidth: op.stroke ? (op.lw ?? 0.5) : 0,
      })
    } else {
      const c = op.c ?? BLACK
      pg.drawLine({ start: { x: op.x1, y: PAGE_H - op.y1 }, end: { x: op.x2, y: PAGE_H - op.y2 }, thickness: op.lw, color: rgb(c[0], c[1], c[2]) })
    }
  }
  for (let i = 0; i < pages; i++) for (const op of tpl.frame(ctx, i + 1, pages)) draw(pdfPages[i], op)
  for (const pl of placed) for (const op of pl.row.ops(pl.y)) draw(pdfPages[pl.page - 1], op)
  for (const c of carries) {
    if (c.yBottom < 0 && tpl.carryTopOps) for (const op of tpl.carryTopOps(ctx, -c.yBottom, c.value)) draw(pdfPages[c.page - 1], op)
    else if (tpl.carryBottom) for (const op of tpl.carryBottom(ctx, c.yBottom, c.value)) draw(pdfPages[c.page - 1], op)
  }
  await pdf.attach(new TextEncoder().encode(documentList(opts)), PDF_LIST_ATTACHMENT, {
    mimeType: 'application/json',
    description: 'BillBuild item list',
  })
  return await pdf.save()
}

export type { LayoutLine }
