import { decodeGaeb90, parseCsv, parseGaeb90, parseGaebXml, type ParsedList } from './gaeb'
import { estimatePct, expectedMs, recordDuration } from './import-progress'
import { serverReachable } from './server'
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

export type ImportProgressPatch = { phase: 'reading' | 'building'; pct: number }
type OnProgress = (patch: ImportProgressPatch) => void

async function parseTenderDocument(file: File, kind: 'pdf' | 'xlsx', onProgress?: OnProgress, signal?: AbortSignal): Promise<ParsedList | undefined> {
  const url = `/api/workspace/parse?filename=${encodeURIComponent(file.name)}`
  const started = Date.now()
  // Plain fetch, not XMLHttpRequest: XHR only reports the answer once the whole body is sent, so an early error
  // (a 502 from the dev proxy, a 413) left the import hanging. Uploading is quick next to the server's parse, so the
  // percentage is estimated from the start and never passes 95 % before the server answers.
  let timer: ReturnType<typeof setInterval> | undefined
  if (onProgress) {
    const expected = expectedMs(file.size)
    onProgress({ phase: 'reading', pct: 0 })
    timer = setInterval(() => onProgress({ phase: 'reading', pct: 95 * estimatePct(Date.now() - started, expected) }), 200)
  }
  let response: Response
  try {
    // a missing backend would otherwise leave the upload hanging (see lib/server.ts)
    if (!await serverReachable(signal)) throw new TypeError('The server that reads tender files is not reachable.')
    response = await fetch(url, { method: 'POST', body: file, signal })
  } catch (error) {
    if (signal?.aborted) throw error // cancelled: don't fall back to attaching the PDF
    if (kind === 'pdf') return undefined // Preserve document attachment in offline workspaces.
    throw error
  } finally {
    if (timer) clearInterval(timer)
  }
  if (!response.ok) {
    const error = await response.text().then((t) => JSON.parse(t) as { error?: unknown } | null).catch(() => null)
    throw new Error(typeof error?.error === 'string' ? error.error : 'The tender could not be read.')
  }
  onProgress?.({ phase: 'building', pct: 95 })
  const text = await response.text()
  recordDuration(file.size, Date.now() - started)
  const parsed = parseListJson(text, kind, kind === 'pdf' ? 'PDF' : 'Excel')
  if (!parsed.positions.length) {
    if (kind === 'pdf') return undefined // Keep ordinary PDFs attachable as supporting documents.
    throw new Error(parsed.warnings?.[0] ?? 'The workbook contains no readable tender positions.')
  }
  return parsed
}

/** Parse the same supported list files for the picker and drag-and-drop. Plain documents can be attached. */
export async function parseListFile(file: File, { supportingPdf = false, onProgress, signal }: { supportingPdf?: boolean; onProgress?: OnProgress; signal?: AbortSignal } = {}): Promise<ParsedList | undefined> {
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
  if (ext === 'xls') return parseTenderDocument(file, 'xlsx', onProgress, signal)
  if (ext === 'xlsx') return (await import('./import-documents')).readExcel(file)
  if (ext === 'pdf' || ext === 'docx') {
    const { readPdfPayload, readWordPayload } = await import('./import-documents')
    const payload = supportingPdf ? await readPdfPayload(file).catch(() => undefined)
      : ext === 'pdf' ? await readPdfPayload(file) : await readWordPayload(file)
    return payload ? parseListJson(payload, ext, ext === 'pdf' ? 'PDF' : 'Word')
      : ext === 'pdf' && !supportingPdf ? parseTenderDocument(file, 'pdf', onProgress, signal) : undefined
  }
  throw new Error('Unsupported file type.')
}
