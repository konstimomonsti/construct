/** CSV, Excel, Word and JSON writers (everything that is not a GAEB / PDF notation) */
import type { ListDoc, Position } from '../types'
import { type Cat, type CatTree, buildCats, catCount, catSum, deDate, deNum, gp, round2, walk } from './util'

export interface TableOpts {
  doc: ListDoc
  positions: Position[]
  tree: CatTree
  longTexts: boolean
  prices: boolean
}

/** category label chain per position id, e.g. "Malerarbeiten › WÄNDE" */
export function categoryPaths(tree: CatTree): Map<string, string> {
  const out = new Map<string, string>()
  const stack: string[] = []
  for (const ev of walk(tree)) {
    if (ev.k === 'open') stack.push(ev.cat.label || ev.cat.oz)
    else if (ev.k === 'close') stack.pop()
    else out.set(ev.p.id, stack.join(' › '))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

const csvEsc = (s: string) => (/[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const csvNum = (n: number, dec: number) => n.toFixed(dec).replace('.', ',')

export function toCsvTable(o: TableOpts): string {
  const paths = categoryPaths(o.tree)
  const head = ['OZ', 'Kurztext', 'Menge', 'ME', ...(o.prices ? ['EP', 'GP'] : []), 'Kategorie', ...(o.longTexts ? ['Langtext'] : [])]
  const rows = o.positions.map((p) =>
    [
      csvEsc(p.oz),
      csvEsc(p.short),
      csvNum(p.qty, 3),
      csvEsc(p.unit),
      ...(o.prices ? [p.up == null ? '' : csvNum(p.up, 2), csvNum(gp(p), 2)] : []),
      csvEsc(paths.get(p.id) ?? p.category),
      ...(o.longTexts ? [csvEsc(p.long ?? '')] : []),
    ].join(';'),
  )
  return '﻿' + [head.join(';'), ...rows].join('\r\n') + '\r\n'
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

export function toJson(o: TableOpts, resolvedTree: unknown): string {
  const positions = o.positions.map((p) => {
    const q = { ...p }
    if (!o.longTexts) delete q.long
    if (!o.prices) q.up = null
    return q
  })
  const total = round2(positions.reduce((s, p) => s + gp(p), 0))
  return JSON.stringify({ ...o.doc, positions, tree: resolvedTree, positionsCount: positions.length, total: o.prices ? total : 0 }, null, 2)
}

/* ------------------------------------------------------------------ */
/* Excel                                                               */
/* ------------------------------------------------------------------ */

const colName = (i: number) => String.fromCharCode(65 + i)

export async function toXlsx(o: TableOpts): Promise<Uint8Array> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'VaultBudget'
  wb.created = new Date()
  const ws = wb.addWorksheet('LV', { views: [{ state: 'frozen', ySplit: 5 }] })

  const cols: { key: string; header: string; width: number }[] = [
    { key: 'oz', header: 'OZ', width: 14 },
    { key: 'short', header: 'Kurztext', width: 48 },
    ...(o.longTexts ? [{ key: 'long', header: 'Langtext', width: 70 }] : []),
    { key: 'qty', header: 'Menge', width: 12 },
    { key: 'unit', header: 'ME', width: 7 },
    ...(o.prices ? [{ key: 'up', header: 'EP (EUR)', width: 14 }, { key: 'gp', header: 'GP (EUR)', width: 16 }] : []),
    { key: 'cat', header: 'Kategorie', width: 36 },
  ]
  const idx = (k: string) => cols.findIndex((c) => c.key === k)
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }))

  ws.getCell('A1').value = o.doc.projectLabel ? `${o.doc.project ?? ''} ${o.doc.projectLabel}`.trim() : (o.doc.project ?? o.doc.title)
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('A2').value = o.doc.title
  ws.getCell('A2').font = { bold: true, size: 11 }
  ws.getCell('A3').value = `Datum: ${deDate(o.doc.date)}`
  const hr = ws.getRow(5)
  cols.forEach((c, i) => (hr.getCell(i + 1).value = c.header))
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
  hr.alignment = { vertical: 'middle' }
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: cols.length } }

  const paths = categoryPaths(o.tree)
  const qtyI = idx('qty') + 1
  const upI = idx('up') + 1
  const gpI = idx('gp') + 1
  const qL = colName(qtyI - 1)
  const uL = upI ? colName(upI - 1) : ''
  const gL = gpI ? colName(gpI - 1) : ''
  let row = 6
  const first = row
  // category rows with SUBTOTAL formulas over their range
  const emit = (cats: Cat[], rootItems: Position[]) => {
    const item = (p: Position) => {
      const r = ws.getRow(row)
      r.getCell(1).value = p.oz
      r.getCell(idx('short') + 1).value = p.short
      if (o.longTexts) {
        const c = r.getCell(idx('long') + 1)
        c.value = p.long ?? ''
        c.alignment = { wrapText: true, vertical: 'top' }
      }
      r.getCell(qtyI).value = p.qty
      r.getCell(qtyI).numFmt = '#,##0.000'
      r.getCell(idx('unit') + 1).value = p.unit
      if (o.prices) {
        if (p.up != null) r.getCell(upI).value = p.up
        r.getCell(upI).numFmt = '#,##0.00 "€"'
        r.getCell(gpI).value = { formula: `${qL}${row}*${uL}${row}`, result: gp(p) }
        r.getCell(gpI).numFmt = '#,##0.00 "€"'
      }
      r.getCell(idx('cat') + 1).value = paths.get(p.id) ?? p.category
      r.getCell(1).alignment = { vertical: 'top' }
      row++
    }
    for (const p of rootItems) item(p)
    const rec = (c: Cat) => {
      const r = ws.getRow(row)
      const catRow = row
      r.getCell(1).value = c.oz
      r.getCell(2).value = c.label
      r.getCell(2).alignment = { indent: (c.depth - 1) * 2 }
      r.font = { bold: true }
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.depth === 1 ? 'FFDDEBF7' : 'FFF2F2F2' } }
      row++
      for (const k of c.cats) rec(k)
      for (const p of c.items) item(p)
      if (o.prices) {
        const rr = ws.getRow(catRow)
        rr.getCell(gpI).value = { formula: `SUBTOTAL(9,${gL}${catRow + 1}:${gL}${Math.max(row - 1, catRow + 1)})`, result: catSum(c) }
        rr.getCell(gpI).numFmt = '#,##0.00 "€"'
      }
    }
    for (const c of cats) rec(c)
  }
  emit(o.tree.roots, o.tree.rootItems)
  const last = row - 1
  if (o.prices) {
    row++
    const r = ws.getRow(row)
    r.getCell(2).value = 'Summe LV (netto)'
    r.getCell(gpI).value = { formula: `SUBTOTAL(9,${gL}${first}:${gL}${last})`, result: round2(o.positions.reduce((s, p) => s + gp(p), 0)) }
    r.getCell(gpI).numFmt = '#,##0.00 "€"'
    r.font = { bold: true }
    r.border = { top: { style: 'thin' }, bottom: { style: 'double' } }
  }

  const ks = wb.addWorksheet('Kategorien', { views: [{ state: 'frozen', ySplit: 1 }] })
  ks.columns = [
    { header: 'OZ', key: 'oz', width: 14 },
    { header: 'Kategorie', key: 'label', width: 54 },
    { header: 'Positionen', key: 'n', width: 12 },
    ...(o.prices ? [{ header: 'Summe (EUR)', key: 'sum', width: 18 }] : []),
  ]
  ks.getRow(1).font = { bold: true }
  const walkCats = (cs: Cat[]) => {
    for (const c of cs) {
      const r = ks.addRow({ oz: c.oz, label: c.label, n: catCount(c), sum: o.prices ? catSum(c) : undefined })
      r.getCell(2).alignment = { indent: (c.depth - 1) * 2 }
      if (c.depth === 1) r.font = { bold: true }
      if (o.prices) r.getCell(4).numFmt = '#,##0.00 "€"'
      walkCats(c.cats)
    }
  }
  walkCats(o.tree.roots)
  const buf = await wb.xlsx.writeBuffer()
  return new Uint8Array(buf as ArrayBuffer)
}

/* ------------------------------------------------------------------ */
/* Word                                                                */
/* ------------------------------------------------------------------ */

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

function para(text: string, style?: string, extra = '', rpr = ''): string {
  const ppr = style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''
  const run = text === '' ? '' : `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(clean(text))}</w:t></w:r>`
  return `<w:p>${ppr}${run}</w:p>`
}

export async function toDocx(o: TableOpts): Promise<Uint8Array> {
  const { zipSync, strToU8 } = await import('fflate')
  const body: string[] = []
  body.push(para(o.doc.title || 'Leistungsverzeichnis', 'Title'))
  const meta = [o.doc.project, o.doc.projectLabel].filter(Boolean).join(' – ')
  if (meta) body.push(para(meta, undefined, '', '<w:i/>'))
  const item = (p: Position) => {
    body.push(para(`${p.oz} – ${p.short}${p.unit ? ` [${p.unit}]` : ''}`, 'ListParagraph'))
    if (o.longTexts && p.long) for (const l of p.long.split('\n')) body.push(para(l, undefined, '<w:ind w:left="720"/><w:spacing w:after="0"/>', '<w:sz w:val="20"/>'))
    if (o.prices && p.up != null) body.push(para(`${deNum(p.qty, 3)} ${p.unit} × ${deNum(p.up)} € = ${deNum(gp(p))} €`, undefined, '<w:ind w:left="720"/>', '<w:sz w:val="20"/>'))
  }
  for (const p of o.tree.rootItems) item(p)
  const rec = (c: Cat) => {
    body.push(para(c.label ? `${c.oz} ${c.label}` : c.oz, c.depth === 1 ? 'Heading1' : 'Heading2'))
    for (const k of c.cats) rec(k)
    for (const p of c.items) item(p)
    body.push(para(''))
  }
  for (const c of o.tree.roots) rec(c)

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const font = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>'
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Standard"/><w:next w:val="Standard"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:u w:val="single"/><w:sz w:val="28"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Standard"/><w:next w:val="Standard"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Standard"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Standard"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:ind w:left="360"/></w:pPr></w:style></w:styles>`
  const files = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
    'docProps/core.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(o.doc.title)}</dc:title><dc:creator>VaultBudget</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`,
    ),
  }
  return zipSync(files, { level: 6 })
}

export { buildCats }
