import { decodeGaeb90, parseCsv, parseGaeb90, parseGaebXml, type ParsedList } from './gaeb'
import { estimatePct, expectedMs, recordDuration } from './import-progress'
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

export type ImportProgressPatch = { phase: 'uploading' | 'reading' | 'building'; pct: number }
type OnProgress = (patch: ImportProgressPatch) => void

interface ServerAnswer { ok: boolean; text: () => Promise<string> }

/** POST with real upload progress; rejects on network errors like fetch does */
function postWithProgress(url: string, file: File, onUploaded: () => void, onUpload: (fraction: number) => void): Promise<ServerAnswer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onUpload(e.loaded / e.total) }
    xhr.upload.onload = onUploaded
    xhr.onerror = () => reject(new TypeError('Network error'))
    xhr.onabort = () => reject(new TypeError('Network error'))
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, text: async () => xhr.responseText })
    xhr.send(file)
  })
}

async function parseTenderDocument(file: File, kind: 'pdf' | 'xlsx', onProgress?: OnProgress): Promise<ParsedList | undefined> {
  const url = `/api/workspace/parse?filename=${encodeURIComponent(file.name)}`
  const started = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined
  const startReading = () => {
    if (!onProgress || timer) return
    const since = Date.now()
    const expected = expectedMs(file.size)
    onProgress({ phase: 'reading', pct: 20 })
    timer = setInterval(() => {
      onProgress({ phase: 'reading', pct: 20 + 75 * estimatePct(Date.now() - since, expected) })
    }, 200)
  }
  let response: ServerAnswer
  try {
    if (onProgress) {
      onProgress({ phase: 'uploading', pct: 0 })
      response = await postWithProgress(url, file, startReading, (f) => onProgress({ phase: 'uploading', pct: 20 * f }))
    } else {
      response = await fetch(url, { method: 'POST', body: file })
    }
  } catch (error) {
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
export async function parseListFile(file: File, { supportingPdf = false, onProgress }: { supportingPdf?: boolean; onProgress?: OnProgress } = {}): Promise<ParsedList | undefined> {
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
  if (ext === 'xls') return parseTenderDocument(file, 'xlsx', onProgress)
  if (ext === 'xlsx') return (await import('./import-documents')).readExcel(file)
  if (ext === 'pdf' || ext === 'docx') {
    const { readPdfPayload, readWordPayload } = await import('./import-documents')
    const payload = supportingPdf ? await readPdfPayload(file).catch(() => undefined)
      : ext === 'pdf' ? await readPdfPayload(file) : await readWordPayload(file)
    return payload ? parseListJson(payload, ext, ext === 'pdf' ? 'PDF' : 'Word')
      : ext === 'pdf' && !supportingPdf ? parseTenderDocument(file, 'pdf', onProgress) : undefined
  }
  throw new Error('Unsupported file type.')
}
