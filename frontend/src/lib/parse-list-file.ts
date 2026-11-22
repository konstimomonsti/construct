import { decodeGaeb90, parseCsv, parseGaeb90, parseGaebXml, type ParsedList } from './gaeb'
import type { ListDoc, Position } from './types'

import { parseLineType } from './line-type'

function normalizeJson(raw: unknown): Position[] {
  const arr = Array.isArray(raw) ? raw : (raw as { positions?: unknown })?.positions
  if (!Array.isArray(arr) || arr.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Expected an array of list positions.')
  return arr.map((r: Record<string, unknown>, i) => ({
    id: String(r.id ?? `p${i}`),
    oz: String(r.oz ?? i + 1),
    short: String(r.short ?? r.kurztext ?? r.name ?? '(ohne Kurztext)'),
    long: r.long ? String(r.long) : undefined,
    qty: Number.isFinite(Number(r.qty)) ? Number(r.qty) : 1,
    unit: String(r.unit ?? 'St'),
    lineType: parseLineType(r.lineType),
    up: r.up == null || r.up === '' || !Number.isFinite(Number(r.up)) ? null : Number(r.up),
    category: String(r.category ?? 'Import'),
    group: r.group ? String(r.group) : undefined,
    lumpSum: r.lumpSum ? true : undefined,
    quantityMissing: r.quantityMissing === true || undefined,
    totalRule: r.totalRule === 'unit_price_only' || r.totalRule === 'conditional' ? r.totalRule : undefined,
    path: Array.isArray(r.path) && r.path.every((part) => part && typeof part.oz === 'string' && typeof part.label === 'string')
      ? r.path : undefined,
    srcRef: r.srcRef ? String(r.srcRef) : undefined,
    positionKey: typeof r.positionKey === 'string' && r.positionKey ? r.positionKey : undefined,
  }))
}

function isCategoryTree(value: unknown): value is ListDoc['tree'] {
  if (!Array.isArray(value)) return false
  return value.every((node) => node && typeof node.oz === 'string' && typeof node.label === 'string'
    && Number.isInteger(node.depth) && isCategoryTree(node.children))
}

function parseListJson(text: string, kind: 'json' | 'pdf' | 'docx' | 'xlsx', format: string): ParsedList {
  const raw = JSON.parse(text)
  const positions = normalizeJson(raw)
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

async function parseTenderDocument(file: File, kind: 'pdf' | 'xlsx'): Promise<ParsedList | undefined> {
  const response = await fetch(`/api/workspace/parse?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file,
  }).catch((error: unknown) => {
    if (kind === 'pdf') return null // Preserve document attachment in offline workspaces.
    throw error
  })
  if (!response) return undefined
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(typeof error?.error === 'string' ? error.error : 'The tender could not be read.')
  }
  const parsed = parseListJson(await response.text(), kind, kind === 'pdf' ? 'PDF' : 'Excel')
  if (!parsed.positions.length) {
    if (kind === 'pdf') return undefined // Keep ordinary PDFs attachable as supporting documents.
    throw new Error(parsed.warnings?.[0] ?? 'The workbook contains no readable tender positions.')
  }
  return parsed
}

/** Parse the same supported list files for the picker and drag-and-drop. Plain documents can be attached. */
export async function parseListFile(file: File, { supportingPdf = false } = {}): Promise<ParsedList | undefined> {
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
    const payload = supportingPdf ? await readPdfPayload(file).catch(() => undefined)
      : ext === 'pdf' ? await readPdfPayload(file) : await readWordPayload(file)
    return payload ? parseListJson(payload, ext, ext === 'pdf' ? 'PDF' : 'Word')
      : ext === 'pdf' && !supportingPdf ? parseTenderDocument(file, 'pdf') : undefined
  }
  throw new Error('Unsupported file type.')
}
