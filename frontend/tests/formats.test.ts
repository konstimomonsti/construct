import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { FORMATS, exportList, type FormatId } from '../src/lib/export/index'
import { normOz } from '../src/lib/export/util'
import { decodeGaeb90, parseGaeb90 } from '../src/lib/gaeb'
import { parseListFile } from '../src/lib/parse-list-file'
import { resolveList } from '../src/lib/resolve'
import type { ListDoc, Position } from '../src/lib/types'

Object.assign(globalThis, { DOMParser })

const positions: Position[] = [
  { id: 'pipe', oz: '01.02.0010', short: 'Müller; "Rohr" & <Anschluss>', long: 'Erste Zeile\nZweite Zeile', qty: 2.125, unit: 'm', up: 12.34,
    category: 'Trinkwasser', path: [{ oz: '01', label: 'Versorgung' }, { oz: '01.02', label: 'Trinkwasser' }] },
  { id: 'valve', oz: '03.01.0020', short: 'Ventil', long: 'Absperrung', qty: 0, unit: 'St', up: 34.56,
    category: 'Armaturen', path: [{ oz: '03', label: 'Einbau' }, { oz: '03.01', label: 'Armaturen' }] },
]

const doc: ListDoc = {
  id: 'format-fixture', folderId: 'test', fileName: 'work.list', title: 'Leitungsbau & Ausbau',
  currency: 'EUR', format: 'Own list', date: '2026-01-01', positions, positionsCount: 2, pricedCount: 2, categories: 2, total: 26.22,
  source: { kind: 'blank' },
}
const now = new Date('2026-01-01T10:00:00Z')
const snapshot = (p: Position) => ({
  code: normOz(p.oz), short: p.short, long: p.long, qty: p.qty, unit: p.unit, up: p.up,
  categories: p.path?.map((c) => c.label),
})
const run = (format: FormatId, options: Partial<Parameters<typeof exportList>[0]> = {}) =>
  exportList({ doc, format, now, resolved: resolveList(doc), ...options })
const asFile = (name: string, data: Uint8Array | string) => new File([typeof data === 'string' ? data : new Uint8Array(data)], name)
const sample = (name: string) => readFile(new URL('../../data/tenders/' + encodeURIComponent(name), import.meta.url))
const fixture = (path: string) => readFile(new URL('../../data/fixtures/' + path, import.meta.url))

for (const format of FORMATS) {
  test(format.id + ' export and import preserve the supported fields', async () => {
    const output = await run(format.id)
    assert.equal(output.mode, 'generated')
    assert.equal(output.mime, format.mime)
    assert.ok(output.fileName.endsWith('.' + format.ext))
    const parsed = await parseListFile(asFile(output.fileName, output.data))
    assert.ok(parsed)
    assert.equal(parsed.positions.length, positions.length)
    const expected = positions.map((p) => snapshot(format.tender ? { ...p, up: null } : p))
    assert.deepEqual(parsed.positions.map(snapshot), expected)

    const subset = await run(format.id, { scope: 'selection', selectedIds: ['pipe'], prices: false, longTexts: false })
    const partial = await parseListFile(asFile(subset.fileName, subset.data))
    assert.ok(partial)
    assert.deepEqual(partial.positions.map(snapshot), [
      snapshot({ ...positions[0], long: undefined, up: format.priced ? positions[0].up : null }),
    ])
    const category = await run(format.id, { scope: 'categories', categoryOzs: ['03'] })
    const categoryList = await parseListFile(asFile(category.fileName, category.data))
    assert.ok(categoryList)
    assert.deepEqual(categoryList.positions.map(snapshot), expected.slice(1))

    const original = { ...doc, ...parsed, fileName: output.fileName }
    const same = await run(format.id, { doc: original, resolved: resolveList(original), loadOriginal: async () => output.data })
    assert.equal(same.mode, 'original')
    assert.deepEqual(same.data, output.data)
  })
}

test('CSV and TSV read quoted delimiters, German decimals, newlines and nested categories', async () => {
  for (const [ext, sep] of [['csv', ';'], ['csv', ','], ['tsv', '\t']]) {
    const input = [
      ['OZ', 'Kurztext', 'Menge', 'ME', 'EP', 'Kategorie', 'Langtext'].join(sep),
      ['01.10', '"Quoted ""description""' + sep + ' delimiter"', '"1.234,500"', 'm', '"22,50"', 'Werk › Elektro', '"Zeile 1\nZeile 2"'].join(sep),
    ].join('\r\n')
    const parsed = await parseListFile(asFile('original.' + ext, input))
    assert.ok(parsed)
    assert.deepEqual(parsed.positions.map(snapshot), [{
      code: '1.10', short: 'Quoted "description"' + sep + ' delimiter', qty: 1234.5,
      unit: 'm', up: 22.5, categories: ['Werk', 'Elektro'], long: 'Zeile 1\nZeile 2',
    }])
    if (ext === 'tsv') {
      const original = { ...doc, ...parsed, fileName: 'original.tsv' }
      const output = await run('csv', { doc: original, resolved: resolveList(original), loadOriginal: async () => new TextEncoder().encode(input) })
      assert.equal(output.mode, 'generated')
      assert.equal(output.fileName, 'original.csv')
      assert.match(new TextDecoder().decode(output.data), /^OZ;Kurztext;/)
    }
  }
})

test('Excel imports an ordinary workbook and preserves a zero numeric price', async () => {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Cover').addRow(['BOM'])
  const sheet = workbook.addWorksheet('Items')
  sheet.addRows([
    ['Position', 'Description', 'Quantity', 'Unit', 'Unit price (EUR)', 'Category'],
    ['0010', 'Unpriced by supplier', 1.75, 'm', 0, 'Works'],
    ['0020', 'Uncalculated by supplier', { formula: '5*2' }, 'm', 1, 'Works'],
  ])
  const parsed = await parseListFile(asFile('ordinary.xlsx', new Uint8Array(await workbook.xlsx.writeBuffer())))
  assert.ok(parsed)
  assert.equal(parsed.positions[0].qty, 1.75)
  assert.equal(parsed.positions[0].up, 0)
  assert.equal(parsed.positions[1].sourceCells?.quantity, '=5*2')
})

test('plain PDF and Word files are available as attachments', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage().drawText('Specification only')
  assert.equal(await parseListFile(asFile('spec.pdf', await pdf.save())), undefined)
  assert.equal(await parseListFile(asFile('spec.docx', await sample('LV-Positionen.docx'))), undefined)
})

test('invalid list files reject with no parsed positions', async () => {
  for (const [name, bytes] of [
    ['bad.csv', 'Kurztext;Menge\n"Incomplete;1'],
    ['bad.tsv', 'not\ta\tlist'],
    ['bad.json', '{"positions":[null]}'],
    ['bad.xlsx', 'not a workbook'],
    ['bad.docx', 'not a Word file'],
    ['bad.pdf', 'not a PDF'],
    ['bad.X83', '<other/>'],
    ['bad.D83', 'not a fixed-width list'],
    ['bad.txt', 'unsupported'],
  ]) await assert.rejects(parseListFile(asFile(name, bytes)), name)
})

test('public DA XML and GAEB 90 examples agree on positions and quantities', async () => {
  const xml = await parseListFile(asFile('SPGK.X83', await fixture('dbinfrago/spgk/SPGK.X83')))
  const legacy = await parseListFile(asFile('SPGK.D83', await fixture('dbinfrago/spgk/SPGK.D83')))
  assert.ok(xml && legacy)
  assert.equal(xml.positions.length, 12)
  assert.deepEqual(legacy.positions.map((p) => [normOz(p.oz), p.qty, p.unit]), xml.positions.map((p) => [normOz(p.oz), p.qty, p.unit]))
})

test('X84 and X86 imports convert to X83 and omit bid prices', async () => {
  for (const path of ['bvbs/Pruefdatei_GAEB_DA_XML_3.2_AVA_84.X84', 'dangl/GAEBXML_DE.X86']) {
    const bytes = await fixture(path)
    const fileName = path.split('/').at(-1)!
    const parsed = await parseListFile(asFile(fileName, bytes))
    assert.ok(parsed && parsed.positions.some((p) => p.up != null))
    const original = { ...doc, ...parsed, fileName }
    const output = await run('x83', { doc: original, resolved: resolveList(original), loadOriginal: async () => bytes })
    assert.equal(output.mode, 'generated')
    assert.ok(output.fileName.endsWith('.X83'))
    const tender = await parseListFile(asFile(output.fileName, output.data))
    assert.ok(tender)
    assert.equal(tender.phase, 'X83')
    assert.equal(tender.positions.length, parsed.positions.length)
    assert.ok(tender.positions.every((p) => p.up === null))
  }
})

test('GAEB 90 keeps zero-quantity unit prices and tenths of a cent on edit', async () => {
  for (const format of ['d84', 'd86'] as const) {
    const file = await run(format)
    const original = { ...doc, ...parseGaeb90(decodeGaeb90(file.data)), fileName: file.fileName }
    const edited = await run(format, { doc: original, resolved: resolveList(original, { up: { p1: 36.789 } }), loadOriginal: async () => file.data })
    assert.equal(edited.mode, 'patched')
    const result = await parseListFile(asFile(edited.fileName, edited.data))
    assert.equal(result?.positions[1].qty, 0)
    assert.equal(result.positions[1].up, 36.789)
    assert.equal(result.positions[0].up, 12.34)
  }
})

test('XML conversion preserves a position code outside its UI category', async () => {
  const original = { ...doc, positions: [{ ...positions[0], oz: 'TE.L0.9' }] }
  for (const format of ['x83', 'x83-2004'] as const) {
    const output = await run(format, { doc: original, resolved: resolveList(original) })
    const list = await parseListFile(asFile(output.fileName, output.data))
    assert.equal(normOz(list!.positions[0].oz), 'TE.L0.9')
    assert.equal(list!.positions[0].short, positions[0].short)
  }
})

test('GAEB 90 preserves signed figures and rejects values that overflow fixed-width records', async () => {
  const negative = { ...doc, positions: [{ ...positions[0], qty: -2, up: -12.345 }] }
  const output = await run('d86', { doc: negative, resolved: resolveList(negative) })
  const list = await parseListFile(asFile(output.fileName, output.data))
  assert.equal(list?.positions[0].qty, -2)
  assert.equal(list.positions[0].up, -12.345)

  const overflow = { ...negative, positions: [{ ...negative.positions[0], qty: 100_000_000 }] }
  await assert.rejects(run('d83', { doc: overflow, resolved: resolveList(overflow) }), /GAEB 90 field width/)
})

test('tabular imports preserve blank and invalid cells, written amounts, and source rows', async () => {
  for (const [ext, sep] of [['csv', ';'], ['tsv', '\t']]) {
    const input = [
      ['OZ', 'Kurztext', 'Menge', 'ME', 'EP', 'GP'].join(sep),
      ['01.10', '"Zeile 1\r\nZeile 2"', '', '', '', ''].join(sep),
      '',
      ['01.20', 'Weitere Leistung', 'aus Aufmaß', 'm', '10,00', '32,50'].join(sep),
    ].join('\r\n')
    const parsed = await parseListFile(asFile('risk.' + ext, input))
    assert.ok(parsed)
    assert.equal(parsed.positions[0].qty, 1)
    assert.equal(parsed.positions[0].unit, 'St')
    assert.equal(parsed.positions[0].sourceCells?.quantity, '')
    assert.equal(parsed.positions[0].sourceCells?.unit, '')
    assert.equal(parsed.positions[0].sourceCells?.row, 2)
    assert.equal(parsed.positions[1].sourceCells?.quantity, 'aus Aufmaß')
    assert.equal(parsed.positions[1].sourceCells?.amount, '32,50')
    assert.equal(parsed.positions[1].sourceCells?.row, 5)
  }
})

test('Excel imports every readable visible sheet and preserves distinct worksheet row locators', async () => {
  const workbook = new ExcelJS.Workbook()
  for (const name of ['Elektro', 'Trockenbau', 'Vorlage']) {
    const sheet = workbook.addWorksheet(name, { state: name === 'Vorlage' ? 'hidden' : 'visible' })
    sheet.addRow(['OZ', 'Kurztext', 'Menge', 'ME', 'EP', 'GP'])
    sheet.getRow(5).values = ['0010', name, name === 'Elektro' ? 2 : null, 'm', 10, 25]
  }
  const parsed = await parseListFile(asFile('multi.xlsx', new Uint8Array(await workbook.xlsx.writeBuffer())))
  assert.ok(parsed)
  assert.deepEqual(parsed.positions.map((p) => [p.id, p.oz, p.path?.[0].label, p.sourceCells?.row]), [
    ['S1-p0', '0010', 'Elektro', 5], ['S2-p0', '0010', 'Trockenbau', 5],
  ])
  assert.equal(parsed.positions[1].sourceCells?.quantity, '')
  assert.equal(parsed.positions[0].sourceCells?.amount, '25')
})

test('ordinary Word files use the tender preview and keep its source position IDs', async (context) => {
  const content = await sample('LV-Positionen.docx')
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, '/api/workspace/parse?filename=LV-Positionen.docx')
    return Response.json({
      title: 'Word tender', positions: [{ id: 'source-word-position', oz: '01.0010', short: 'Position', qty: 0, unit: '' }],
    })
  })
  const result = await parseListFile(asFile('LV-Positionen.docx', content))
  assert.equal(result?.source?.kind, 'docx')
  assert.equal(result?.positions[0].id, 'source-word-position')
  assert.equal(result?.positions[0].sourceCells, undefined)
})
