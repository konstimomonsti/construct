import { parseTable, type ParsedList, type TableRow } from './gaeb'
import { treeFromPaths } from './cat'
import { DOCX_LIST_NAMESPACE, DOCX_LIST_PART, PDF_LIST_ATTACHMENT } from './list-file'

export async function readExcel(file: File): Promise<ParsedList> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await file.arrayBuffer())
  const tables: { name: string; list: ParsedList }[] = []
  for (const sheet of workbook.worksheets) {
    if (sheet.state !== 'visible') continue
    let header: string[] | undefined
    let categoryColumn = -1
    let title: string | undefined
    const rows: TableRow[] = []
    sheet.eachRow((row, number) => {
      const values = Array.from({ length: row.cellCount }, (_, idx) => {
        const cell = row.getCell(idx + 1)
        return cell.type === ExcelJS.ValueType.Formula && cell.result == null ? `=${cell.formula}` : cell.text
      })
      if (!header) {
        const keys = values.map((value) => value.trim().toLowerCase())
        if (keys.some((key) => /^(kurztext|short|description|bezeichnung|name|item)$/.test(key))
          && keys.some((key) => /^(oz|pos|position|sku|menge|qty|quantity|einheit|unit|me)$/.test(key))) {
          header = values
          categoryColumn = keys.findIndex((key) => /^(kategorie|category)$/.test(key))
          if (sheet.name === 'LV' && number === 5) title = sheet.getCell('A2').text
        }
      } else if (!title || categoryColumn < 0 || values[categoryColumn]?.trim()) {
        // The exported LV sheet has category headings and subtotals without a category path.
        rows.push({ cells: values, row: number, sheet: sheet.name })
      }
    })
    if (header && rows.length) tables.push({ name: sheet.name, list: { ...parseTable(header, rows, 'xlsx'), title } })
  }
  if (tables.length === 1) return tables[0].list
  if (tables.length > 1) {
    const positions = tables.flatMap(({ name, list }, index) => {
      const prefix = `S${index + 1}`
      return list.positions.map((position) => ({
        ...position,
        id: `${prefix}-${position.id}`,
        group: name,
        path: [{ oz: prefix, label: name }, ...(position.path ?? []).map(({ oz, label }) => ({ oz: `${prefix}.${oz}`, label }))],
      }))
    })
    return { format: 'Excel', currency: 'EUR', positions, tree: treeFromPaths(positions), source: { kind: 'xlsx' } }
  }
  throw new Error('No item table found in the workbook.')
}

export async function readPdfPayload(file: File): Promise<string | undefined> {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFString, PDFStream, PDFRawStream, decodePDFRawStream } = await import('pdf-lib')
  const pdf = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true })
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  const files = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)?.lookupMaybe(PDFName.of('Names'), PDFArray)
  if (!files || pdf.isEncrypted) return
  for (let i = 0; i + 1 < files.size(); i += 2) {
    const name = files.lookup(i, PDFString, PDFHexString)
    if (name.decodeText() !== PDF_LIST_ATTACHMENT) continue
    const entry = files.lookup(i + 1, PDFDict)
    const stream = entry.lookupMaybe(PDFName.of('EF'), PDFDict)?.lookupMaybe(PDFName.of('F'), PDFStream)
    if (stream instanceof PDFRawStream) return new TextDecoder().decode(decodePDFRawStream(stream).decode())
  }
}

export async function readWordPayload(file: File): Promise<string | undefined> {
  const { unzipSync, strFromU8 } = await import('fflate')
  const parts = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (part) => part.name === DOCX_LIST_PART || part.name === 'word/document.xml' })
  if (!parts['word/document.xml']) throw new Error('No Word document found.')
  const payload = parts[DOCX_LIST_PART]
  if (payload) {
    const xml = new DOMParser().parseFromString(strFromU8(payload), 'text/xml')
    if (xml.documentElement.namespaceURI === DOCX_LIST_NAMESPACE) return xml.documentElement.textContent ?? undefined
  }
}
