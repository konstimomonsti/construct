/** Emit paired clean and planted inputs for the real workspace picker and risk worker. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'

const out = process.argv[2]
if (!out) throw new Error('Supply an output directory.')
await mkdir(out, { recursive: true })

const header = ['OZ', 'Kurztext', 'Menge', 'ME', 'EP', 'GP', 'Kategorie']
type Row = [string, string, number | string | null, string, number, number, string]
const clean: Row[] = [
  ['01.10', 'Zementestrich schwimmend, 65 mm', 10, 'm²', 12, 120, 'Boden'],
  ['01.20', 'Randdämmstreifen aus Mineralwolle', 30, 'm', 2, 60, 'Boden'],
  ['01.30', 'Trittschalldämmung unter Estrich, 30 mm', 10, 'm²', 5, 50, 'Boden'],
  ['01.40', 'Vinyl als Bodenbelag verlegen', 10, 'm²', 10, 100, 'Boden'],
  ['01.50', 'Sockelleisten aus Holz montieren', 30, 'm', 2, 60, 'Boden'],
  ['02.10', 'Leerrohre für Signaltechnik liefern', 5, 'm', 10, 50, 'Elektro'],
]
const changeLast = (patch: Partial<Row>) => [...clean.slice(0, -1), Object.assign([...clean.at(-1)!], patch) as Row]
const cases = [
  { name: 'clean', rows: clean, expect: '', target: '' },
  { name: 'quantity-blank', rows: changeLast({ 2: null }), expect: 'L1.QTY.MISSING', target: '02.10' },
  { name: 'quantity-invalid', rows: changeLast({ 2: 'laut Aufmaß' }), expect: 'L1.QTY.MISSING', target: '02.10' },
  { name: 'quantity-zero', rows: changeLast({ 2: 0, 5: 0 }), expect: 'L1.QTY.ZERO', target: '02.10' },
  { name: 'position-blank', rows: changeLast({ 0: '' }), expect: 'L1.CODE.MISSING', target: null },
  { name: 'unit-blank', rows: changeLast({ 3: '' }), expect: 'L1.UNIT.MISSING', target: '02.10' },
  { name: 'written-amount', rows: changeLast({ 5: 85 }), expect: 'L1.ARITH.LINE_AMOUNT', target: '02.10' },
  { name: 'edge-insulation', rows: clean.filter(([code]) => code !== '01.20'),
    expect: 'L2.*_NEEDS_EDGE_INSULATION', target: '01.10', dependency: true },
]

for (const example of cases) {
  for (const format of ['csv', 'tsv', 'xlsx', 'json']) {
    const filename = `${example.name}.${format}`
    const path = join(out, filename)
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Positionen')
      sheet.addRows([header, ...example.rows])
      await workbook.xlsx.writeFile(path)
    } else if (format === 'json') {
      const positions = example.rows.map(([oz, short, qty, unit, up, line_amount, category]) =>
        ({ oz, short, qty, unit, up, line_amount, category, path: [{ oz: category === 'Boden' ? '01' : '02', label: category }] }))
      await writeFile(path, JSON.stringify({ positions }))
    } else {
      const delimiter = format === 'tsv' ? '\t' : ';'
      await writeFile(path, [header, ...example.rows].map((row) => row.join(delimiter)).join('\r\n'))
    }
    const control = !example.expect
    const type = example.dependency ? 'dependency' : 'line'
    await writeFile(path + '.labels.json', JSON.stringify({
      schema: 'construct-eval-labels/1', file: filename, backend: format, suite: 'catalogue', baseline: `clean.${format}`,
      labels: [{
        control, layers: [example.dependency ? 2 : 1], expect: control ? [] : [example.expect], match: type,
        target: example.dependency ? { trigger_codes: [example.target] } : { line_codes: [example.target] },
      }],
    }))
  }
}
