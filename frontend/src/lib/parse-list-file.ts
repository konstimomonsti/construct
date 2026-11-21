import { decodeGaeb90, parseCsv, parseGaeb90, parseGaebXml, sourceNumber, type ParsedList } from './gaeb'
import type { ListDoc, Position } from './types'

const cellText = (value: unknown) => value == null ? '' : String(value).trim()

function normalizeJson(raw: unknown, preserveSourceCells: boolean): Position[] {
  const arr = Array.isArray(raw) ? raw : (raw as { positions?: unknown })?.positions
  if (!Array.isArray(arr) || arr.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Expected an array of list positions.')
  return arr.map((r: Record<string, unknown>, i) => {
    const sourceCells = {
      code: 'oz' in r ? cellText(r.oz) : undefined,
      quantity: cellText(r.qty), unit: cellText(r.unit), unitPrice: cellText(r.up),
      amount: cellText(r.line_amount), row: i + 1,
    }
    const qty = sourceNumber(sourceCells.quantity)
    const up = sourceNumber(sourceCells.unitPrice)
    return {
      id: String(r.id ?? `p${i}`),
      oz: String(r.oz ?? i + 1),
      short: String(r.short ?? r.kurztext ?? r.name ?? '(ohne Kurztext)'),
      long: r.long ? String(r.long) : undefined,
      qty: Number.isFinite(qty) ? qty : 1,
      unit: sourceCells.unit || 'St',
      up: Number.isFinite(up) ? up : null,
      category: String(r.category ?? 'Import'),
      group: r.group ? String(r.group) : undefined,
      lumpSum: r.lumpSum ? true : undefined,
      path: Array.isArray(r.path) && r.path.every((part) => part && typeof part.oz === 'string' && typeof part.label === 'string')
        ? r.path : undefined,
      srcRef: r.srcRef ? String(r.srcRef) : undefined,
      ...(preserveSourceCells ? { sourceCells } : {}),
    }
  })
}

function isCategoryTree(value: unknown): value is ListDoc['tree'] {
  if (!Array.isArray(value)) return false
  return value.every((node) => node && typeof node.oz === 'string' && typeof node.label === 'string'
    && Number.isInteger(node.depth) && isCategoryTree(node.children))
}

function parseListJson(text: string, kind: 'json' | 'pdf' | 'docx' | 'xlsx', format: string, preserveSourceCells = true): ParsedList {
  const raw = JSON.parse(text)
  const positions = normalizeJson(raw, preserveSourceCells)
  return {
    format,
    currency: typeof raw?.currency === 'string' ? raw.currency : 'EUR',
    title: typeof raw?.title === 'string' ? raw.title : undefined,
    positions,
    tree: isCategoryTree(raw?.tree) && positions.every((p) => p.path?.length) ? raw.tree : undefined,
    source: { kind },
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.filter((value: unknown) => typeof value === 'string') : undefined,
  }
}

async function parseTenderDocument(file: File, kind: 'pdf' | 'docx' | 'xlsx'): Promise<ParsedList | undefined> {
  const response = await fetch(`/api/workspace/parse?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file,
  }).catch((error: unknown) => {
    if (kind !== 'xlsx') return null // Preserve document attachment in offline workspaces.
    throw error
  })
  if (!response) return undefined
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(typeof error?.error === 'string' ? error.error : 'The tender could not be read.')
  }
  const parsed = parseListJson(await response.text(), kind, kind === 'pdf' ? 'PDF' : kind === 'docx' ? 'Word' : 'Excel', false)
  if (!parsed.positions.length) {
    if (kind !== 'xlsx') return undefined // Keep ordinary documents attachable as supporting files.
    throw new Error(parsed.warnings?.[0] ?? 'The workbook contains no readable tender positions.')
  }
  return parsed
}

/** Parse the same supported list files for the picker and drag-and-drop. Plain documents can be attached. */
export async function parseListFile(file: File): Promise<ParsedList | undefined> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (/^[xd]8\d$/.test(ext)) {
    const parsed = ext.startsWith('x')
      ? parseGaebXml(await file.text())
      : parseGaeb90(decodeGaeb90(new Uint8Array(await file.arrayBuffer())))
    if (!parsed.positions.length && !parsed.tree?.length && !parsed.title) throw new Error('No list found.')
    return parsed
  }
  if (ext === 'csv' || ext === 'tsv') return parseCsv(await file.text())
  if (ext === 'json') return parseListJson(await file.text(), 'json', 'JSON')
  if (ext === 'xls') return parseTenderDocument(file, 'xlsx')
  if (ext === 'xlsx') return (await import('./import-documents')).readExcel(file)
  if (ext === 'pdf' || ext === 'docx') {
    const { readPdfPayload, readWordPayload } = await import('./import-documents')
    const payload = ext === 'pdf' ? await readPdfPayload(file) : await readWordPayload(file)
    return payload ? parseListJson(payload, ext, ext === 'pdf' ? 'PDF' : 'Word')
      : parseTenderDocument(file, ext)
  }
  throw new Error('Unsupported file type.')
}
