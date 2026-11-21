import { decodeGaeb90, parseCsv, parseGaeb90, parseGaebXml, type ParsedList } from './gaeb'
import type { ListDoc, Position } from './types'

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
    up: r.up == null || r.up === '' || !Number.isFinite(Number(r.up)) ? null : Number(r.up),
    category: String(r.category ?? 'Import'),
    group: r.group ? String(r.group) : undefined,
    lumpSum: r.lumpSum ? true : undefined,
    path: Array.isArray(r.path) && r.path.every((part) => part && typeof part.oz === 'string' && typeof part.label === 'string')
      ? r.path : undefined,
    srcRef: r.srcRef ? String(r.srcRef) : undefined,
  }))
}

function isCategoryTree(value: unknown): value is ListDoc['tree'] {
  if (!Array.isArray(value)) return false
  return value.every((node) => node && typeof node.oz === 'string' && typeof node.label === 'string'
    && Number.isInteger(node.depth) && isCategoryTree(node.children))
}

function parseListJson(text: string, kind: 'json' | 'pdf' | 'docx', format: string): ParsedList {
  const raw = JSON.parse(text)
  const positions = normalizeJson(raw)
  return {
    format,
    currency: typeof raw?.currency === 'string' ? raw.currency : 'EUR',
    title: typeof raw?.title === 'string' ? raw.title : undefined,
    positions,
    tree: isCategoryTree(raw?.tree) && positions.every((p) => p.path?.length) ? raw.tree : undefined,
    source: { kind },
  }
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
  if (ext === 'xlsx') return (await import('./import-documents')).readExcel(file)
  if (ext === 'pdf' || ext === 'docx') {
    const { readPdfPayload, readWordPayload } = await import('./import-documents')
    const payload = ext === 'pdf' ? await readPdfPayload(file) : await readWordPayload(file)
    return payload ? parseListJson(payload, ext, ext === 'pdf' ? 'PDF' : 'Word') : undefined
  }
  throw new Error('Unsupported file type.')
}
