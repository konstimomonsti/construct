// npm test [-- pdf] — export verification (requires Poppler)
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseGaeb90, parseGaebXml, decodeGaeb90 } from '../src/lib/gaeb.ts'
import { resolveList } from '../src/lib/resolve.ts'
import { exportList, type FormatId } from '../src/lib/export/index.ts'
import { dosFold } from '../src/lib/export/gaeb90.ts'
import { normOz } from '../src/lib/export/util.ts'
import type { LayoutFile } from '../src/lib/export/types.ts'
import type { ListDoc } from '../src/lib/types.ts'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const lists = readdirSync(join(root, 'public/data/lists')).map((f) => JSON.parse(readFileSync(join(root, 'public/data/lists', f), 'utf8')) as ListDoc)
const gaeb = lists.filter((d) => /\.(x83|d83|d84|d86)$/i.test(d.fileName))
const ws = (t: string) => t.replace(/\s+/g, ' ').trim()
const orig = (d: ListDoc) => async () => new Uint8Array(readFileSync(join(root, '../data/tenders', d.fileName)))
const layout = (d: ListDoc) => async () => {
  try {
    return JSON.parse(readFileSync(join(root, 'public/data/layout', d.id + '.json'), 'utf8')) as LayoutFile
  } catch {
    return null
  }
}
let bad = 0
const ok = (c: boolean, m: string) => {
  if (!c) {
    bad++
    console.log('  FAIL', m)
  }
}
const run = (d: ListDoc, format: FormatId, edits?: Parameters<typeof resolveList>[1], extra = {}) =>
  exportList({ doc: d, resolved: resolveList(d, edits), format, loadOriginal: orig(d), loadLayout: layout(d), now: new Date('2026-01-01T10:00:00Z'), ...extra })
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

async function main() {
  const only = process.argv[2]
  if (only !== 'pdf') {
    /* 1 byte identical */
    console.log('== 1. same format, unedited => original bytes')
    let n1 = 0
    for (const d of gaeb) {
      const fmt = ({ x83: d.format.includes('3.2') ? 'x83' : 'x83-2004', d83: 'd83', d84: 'd84', d86: 'd86' } as Record<string, FormatId>)[d.fileName.split('.').pop()!.toLowerCase()]
      const r = await run(d, fmt)
      const same = eq(r.data, await orig(d)()) && r.mode === 'original'
      ok(same, `${d.fileName} (${fmt}) not identical`)
      if (same) n1++
    }
    console.log(`   ${n1}/${gaeb.length} byte-identical`)

    /* 2 cross format */
    console.log('== 2. cross-format regenerate + parse back')
    let nx = 0
    let nxBad = 0
    const parser = (id: FormatId, data: Uint8Array) => (id.startsWith('x83') ? parseGaebXml(new TextDecoder().decode(data)) : parseGaeb90(decodeGaeb90(data)))
    for (const d of gaeb) {
      for (const f of ['x83', 'x83-2004', 'd83', 'd84', 'd86'] as FormatId[]) {
        const own = d.fileName.split('.').pop()!.toLowerCase()
        const r = await run(d, f, undefined, { edited: true }) // force regeneration path by disabling original (loadOriginal undefined below)
        void own
        const g = await exportList({ doc: d, resolved: resolveList(d), format: f, longTexts: true, scope: 'selection', selectedIds: d.positions.map((p) => p.id), now: new Date() })
        void r
        const p = parser(f, g.data)
        let m = 0
        const ref = resolveList(d).positions
        ref.forEach((a, i) => {
          const b = p.positions[i]
          if (!b) return m++
          if (/[A-Za-z]/.test(a.oz)) return
          const dos = f.startsWith('d')
          const sa = dos ? ws(dosFold(a.short)) : ws(a.short)
          const upBad = (f === 'd84' || f === 'd86') && a.up != null && a.qty > 0 && Math.abs(a.up - (b.up ?? -1)) > 0.006
          if (normOz(a.oz) !== normOz(b.oz) || sa !== ws(b.short) || Math.abs(a.qty - b.qty) > 1e-6 || (dos ? dosFold(a.unit) : a.unit) !== b.unit || upBad) m++
        })
        if (p.positions.length !== ref.length) m += 1000
        nx++
        if (m) {
          nxBad++
          console.log('  FAIL', d.fileName, '->', f, 'mismatches', m)
        }
      }
    }
    bad += nxBad
    console.log(`   ${nx - nxBad}/${nx} (list x format) roundtrips equal (positions, OZ, short, qty, unit, UP for 84/86)`)

    // well-formed xml
    const { DOMParser } = await import('@xmldom/xmldom')
    let wf = 0
    for (const d of gaeb) for (const f of ['x83', 'x83-2004'] as FormatId[]) {
      const g = await exportList({ doc: d, resolved: resolveList(d), format: f, scope: 'selection', selectedIds: d.positions.map((p) => p.id) })
      const errs: string[] = []
      new DOMParser({ onError: (_l: string, m: string) => errs.push(m) }).parseFromString(new TextDecoder().decode(g.data), 'text/xml')
      ok(errs.length === 0, `xml not well-formed ${d.fileName} ${f}: ${errs[0]}`)
      if (!errs.length) wf++
    }
    console.log(`   ${wf} generated XML files well-formed`)

    /* 3 edited patch */
    console.log('== 3. edited same-format patch')
    for (const name of ['GAEB-[PROJEKT_004].X83', '[ORT_024] LV24069.D86', 'StBALV23040.D86', '8209.003_Leistungsverzeichnis_leer.D83']) {
      const d = gaeb.find((x) => x.fileName === name)!
      const fmt = ({ x83: 'x83', d83: 'd83', d84: 'd84', d86: 'd86' } as Record<string, FormatId>)[name.split('.').pop()!.toLowerCase()]
      const [a, b, c, e] = d.positions
      const added = { ...d.positions[3], id: 'new1', oz: d.positions[3].oz, short: 'Neue Position Test', long: 'Zeile eins\nZeile zwei', qty: 7, up: 12.5, srcRef: undefined }
      const edits = { qty: { [a.id]: 42 }, up: { [b.id]: 99.99 }, removed: [c.id], added: [added] as never, patch: { [e.id]: { short: 'Geänderter Kurztext' } } }
      const r = await run(d, fmt, edits)
      ok(r.mode === 'patched', `${name} not patched (${r.mode})`)
      const p = fmt.startsWith('x') ? parseGaebXml(new TextDecoder().decode(r.data)) : parseGaeb90(decodeGaeb90(r.data))
      const find = (oz: string) => p.positions.find((x) => normOz(x.oz) === normOz(oz))
      const pa = find(a.oz)
      const pb = find(b.oz)
      ok(!!pa && pa.qty === 42, `${name} qty edit`)
      if (fmt !== 'x83' && fmt !== 'd83') ok(!!pb && Math.abs((pb.up ?? 0) - 99.99) < 0.006, `${name} up edit (${pb?.up})`)
      ok(!find(c.oz) || find(c.oz)!.short !== c.short, `${name} removed still present`)
      ok(p.positions.some((x) => x.short === 'Neue Position Test'), `${name} added missing`)
      ok(p.positions.some((x) => x.short === 'Geänderter Kurztext'), `${name} text patch missing`)
      // untouched positions equal
      const touched = new Set([a.id, b.id, c.id, e.id])
      let diffs = 0
      d.positions.forEach((q) => {
        if (touched.has(q.id)) return
        const x = p.positions.find((y) => normOz(y.oz) === normOz(q.oz) && y.short === q.short)
        if (!x || x.qty !== q.qty || x.unit !== q.unit) diffs++
      })
      ok(diffs === 0, `${name} untouched positions changed: ${diffs}`)
      // byte-level: diff of untouched records/items
      const o = await orig(d)()
      const ol = fmt.startsWith('x') ? new TextDecoder().decode(o).split(/(?=<Item )/) : Buffer.from(o).toString('latin1').split('\r\n')
      const nl = fmt.startsWith('x') ? new TextDecoder().decode(r.data).split(/(?=<Item )/) : Buffer.from(r.data).toString('latin1').split('\r\n')
      const set = new Set(nl.map((l) => (fmt.startsWith('x') ? l : l.slice(0, 74))))
      const lost = ol.filter((l) => !set.has(fmt.startsWith('x') ? l : l.slice(0, 74))).length
      console.log(`   ${name}: patched ok; original ${fmt.startsWith('x') ? 'chunks' : 'records'} not carried over unchanged: ${lost} of ${ol.length}`)
    }
  }

  /* 4 PDF */
  console.log('== 4. PDF')
  mkdirSync(join(root, 'tests/export-shots'), { recursive: true })
  const tmp = join(root, 'tests/export-shots')
  const picks: [string, string][] = [
    ['lv-03-malerarbeiten-pdf', 'A'],
    ['angebot-an24-0305-d84', 'C'],
    ['gaeb-projekt-004-x83', 'D'],
    ['8209-003-leistungsverzeichnis-leer-x83', 'B'],
    ['nummer-001-leer-x83', 'E'],
  ]
  for (const [id, tag] of picks) {
    const d = lists.find((x) => x.id === id)!
    const edits = d.fileName.endsWith('.pdf') ? { qty: { [d.positions[0].id]: d.positions[0].qty } } : undefined
    // regenerate (never the original bytes)
    const r = await exportList({ doc: d, resolved: resolveList(d, edits), format: 'pdf', loadOriginal: undefined, loadLayout: layout(d), edited: true, now: new Date('2026-04-21T10:00:00Z') })
    const out = join(tmp, `${tag}-${id}.pdf`)
    writeFileSync(out, r.data)
    // pdftotext check: every OZ and qty in order
    const txt = execFileSync('pdftotext', ['-raw', out, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    let pos = 0
    let missing = 0
    const deq = (q: number) => q.toFixed(3).replace('.', ',')
    for (const p of d.positions) {
      const ozs = [p.oz, p.oz + '.', p.oz.split('.').map((s) => s.padStart(2, '0')).join('.')]
      let at = -1
      for (const z of ozs) {
        const i = txt.indexOf(z, pos)
        if (i >= 0 && (at < 0 || i < at)) at = i
      }
      if (at < 0) {
        missing++
        continue
      }
      pos = at
    }
    // qty presence (any number format)
    let qtyMiss = 0
    for (const p of d.positions) {
      const forms = [deq(p.qty), String(Math.round(p.qty * 1000) / 1000).replace('.', ','), Math.round(p.qty).toLocaleString('de-DE')]
      if (!forms.some((f) => txt.includes(f))) qtyMiss++
    }
    const pages = (txt.match(/\f/g) ?? []).length
    console.log(`   ${tag} ${id}: ${d.positions.length} positions, pages ${pages}, OZ missing/out-of-order ${missing}, qty missing ${qtyMiss}`)
    ok(missing === 0, `${id} OZ missing ${missing}`)
  }
  // X: xlsx + docx
  if (only !== 'pdf') {
    console.log('== 5. xlsx / docx')
    const ExcelJS = (await import('exceljs')).default
    const { unzipSync, strFromU8 } = await import('fflate')
    const { DOMParser } = await import('@xmldom/xmldom')
    for (const id of ['lv-03-malerarbeiten-pdf', 'gaeb-projekt-004-x83', 'angebot-an24-0305-d84']) {
      const d = lists.find((x) => x.id === id)!
      const x = await run(d, 'xlsx')
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(x.data as never)
      const ws1 = wb.getWorksheet('LV')!
      let formulas = 0
      ws1.eachRow((row) => row.eachCell((c) => { if (c.formula || (c.value && typeof c.value === 'object' && 'formula' in c.value)) formulas++ }))
      console.log(`   xlsx ${id}: sheets ${wb.worksheets.map((s) => s.name).join('+')}, LV rows ${ws1.rowCount}, formulas ${formulas}, frozen ${JSON.stringify(ws1.views[0]?.ySplit)}`)
      ok(formulas >= d.positions.length, `xlsx formulas ${formulas}`)
      const w = await run(d, 'docx')
      const z = unzipSync(w.data)
      const xml = strFromU8(z['word/document.xml'])
      const errs: string[] = []
      new DOMParser({ onError: (_l: string, m: string) => errs.push(m) }).parseFromString(xml, 'text/xml')
      const paras = (xml.match(/<w:p>/g) ?? []).length
      console.log(`   docx ${id}: files ${Object.keys(z).length}, paragraphs ${paras}, well-formed ${errs.length === 0}`)
      ok(errs.length === 0 && paras > d.positions.length, 'docx')
      const c = await run(d, 'csv')
      console.log(`   csv ${id}: ${new TextDecoder().decode(c.data).split('\r\n').length - 2} rows, ${c.fileName}`)
    }
  }
  console.log(bad ? `\n${bad} FAILURES` : '\nALL OK')
  process.exit(bad ? 1 : 0)
}
main()
