import { parseTable, type ParsedList } from './gaeb'
import { DOCX_LIST_NAMESPACE, DOCX_LIST_PART, PDF_LIST_ATTACHMENT } from './list-file'

export async function readExcel(file: File): Promise<ParsedList> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await file.arrayBuffer())
  for (const sheet of workbook.worksheets) {
    let header: string[] | undefined
    let categoryColumn = -1
    let title: string | undefined
    const rows: string[][] = []
    sheet.eachRow((row, number) => {
      const values = Array.from({ length: row.cellCount }, (_, idx) => row.getCell(idx + 1).text)
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
        rows.push(values)
      }
    })
    if (header) return { ...parseTable(header, rows, 'xlsx'), title }
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
