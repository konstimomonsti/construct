/**
 * Export orchestrator. Heavy writers are lazily imported so the main bundle stays lean.
 * Fidelity ladder: same format + unedited → original bytes; same format + edited → patch of the original;
 * otherwise → regenerate in the notation of the target format.
 */
import type { ListDoc, Position } from '../types'
import type { ExportMode, ExportRequest, ExportResult, FormatId, FormatInfo, LayoutFile } from './types'
import { baseName, buildCats, diffList, extOf } from './util'

export type { ExportRequest, ExportResult, FormatId, FormatInfo } from './types'

export const FORMATS: FormatInfo[] = [
  { id: 'csv', label: 'Table (CSV)', ext: 'csv', mime: 'text/csv', icon: 'table_view', desc: 'Semicolon separated, decimal comma, UTF-8' },
  { id: 'xlsx', label: 'Excel (.xlsx)', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', icon: 'grid_on', desc: 'Formulas, subtotals, category sheet' },
  { id: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf', icon: 'picture_as_pdf', desc: 'Printout in the original layout' },
  { id: 'x83', label: 'GAEB DA XML 3.2 (.X83)', ext: 'X83', mime: 'application/xml', icon: 'code', desc: 'Tender BoQ, DA XML 3.2', tender: true },
  { id: 'x83-2004', label: 'GAEB DA XML 2004 (.x83)', ext: 'x83', mime: 'application/xml', icon: 'code', desc: 'Tender BoQ, DA XML 2004-07 / 3.1', tender: true },
  { id: 'd83', label: 'GAEB 90 (.D83)', ext: 'D83', mime: 'application/octet-stream', icon: 'description', desc: 'Tender BoQ, fixed 80-column records', tender: true },
  { id: 'd84', label: 'GAEB 90 Angebot (.D84)', ext: 'D84', mime: 'application/octet-stream', icon: 'request_quote', desc: 'Offer with unit prices', priced: true },
  { id: 'd86', label: 'GAEB 90 Auftrag (.D86)', ext: 'D86', mime: 'application/octet-stream', icon: 'assignment_turned_in', desc: 'Award with unit prices', priced: true },
  { id: 'docx', label: 'Word (.docx)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', icon: 'article', desc: 'Headings per category, one line per position' },
  { id: 'json', label: 'JSON', ext: 'json', mime: 'application/json', icon: 'data_object', desc: 'The resolved list as data' },
]
export const formatInfo = (id: FormatId) => FORMATS.find((f) => f.id === id)!

export type SourceKind = 'gaeb-xml' | 'gaeb90' | 'pdf' | 'docx' | 'csv' | 'json' | 'blank' | 'other'

export function sourceKindOf(doc: ListDoc): SourceKind {
  if (doc.source?.kind) return doc.source.kind
  const e = extOf(doc.fileName ?? '').toLowerCase()
  if (e === 'x83') return 'gaeb-xml'
  if (/^d\d\d$/.test(e)) return 'gaeb90'
  if (e === 'pdf') return 'pdf'
  if (e === 'docx') return 'docx'
  if (e === 'csv') return 'csv'
  if (e === 'json') return 'json'
  return 'other'
}

/** the export format that equals the list's own source format */
export function ownFormat(doc: ListDoc): FormatId | null {
  const k = sourceKindOf(doc)
  if (k === 'gaeb-xml') {
    const v = `${doc.source?.version ?? ''} ${doc.format ?? ''}`
    return /2004|3\.1|3\.0/.test(v) && !/3\.2/.test(v) ? 'x83-2004' : 'x83'
  }
  if (k === 'gaeb90') {
    const e = extOf(doc.fileName ?? '').toLowerCase()
    return e === 'd83' || e === 'd84' || e === 'd86' ? e : null
  }
  if (k === 'pdf') return 'pdf'
  if (k === 'docx') return 'docx'
  if (k === 'csv') return 'csv'
  if (k === 'json') return 'json'
  return null
}

export function isEdited(doc: ListDoc, positions: Position[]): boolean {
  return diffList(doc, positions).any
}

export function fidelityNote(doc: ListDoc, format: FormatId, edited: boolean): string {
  const own = ownFormat(doc)
  if (own === format && !edited && doc.file) return 'Byte-identical to the original file'
  if (own === format && (format.startsWith('x83') || format.startsWith('d8'))) return 'Original patched in place, untouched records stay byte-identical'
  if (format === 'pdf') return own === 'pdf' ? 'Regenerated in original layout' : 'Regenerated in the printout layout of this list'
  if (format.startsWith('x83') || format.startsWith('d8')) return 'Regenerated in original layout'
  return 'Generated from the current list'
}

export function exportFileName(doc: ListDoc, format: FormatId, edited: boolean): string {
  const info = formatInfo(format)
  const own = ownFormat(doc)
  const base = baseName(doc.fileName || doc.title || doc.id)
  const ext = own === format && doc.fileName ? extOf(doc.fileName) : info.ext
  const sameAsSource = own === format && !edited
  return `${base}${sameAsSource ? '' : edited ? '-bearbeitet' : ''}.${ext}`
}

export interface ExportInputs extends ExportRequest {}

export async function exportList(req: ExportRequest): Promise<ExportResult> {
  const { doc, format } = req
  const info = formatInfo(format)
  const now = req.now ?? new Date()
  const scope = req.scope ?? 'all'
  const longTexts = req.longTexts ?? true
  const diff = diffList(doc, req.resolved.positions)
  const edited = req.edited ?? diff.any
  let positions = req.resolved.positions
  if (scope === 'selection' && req.selectedIds) {
    const s = new Set(req.selectedIds)
    positions = positions.filter((p) => s.has(p.id))
  } else if (scope === 'categories' && req.categoryOzs?.length) {
    const roots = new Set(req.categoryOzs)
    positions = positions.filter((p) => roots.has((p.path?.[0]?.oz ?? p.oz.split('.')[0]) as string))
  }
  const subset = positions.length !== req.resolved.positions.length || scope !== 'all'
  const tender = !!info.tender
  const prices = info.priced ? true : tender ? false : (req.prices ?? true)
  const mime = info.mime
  const mk = (data: Uint8Array, mode: ExportMode): ExportResult => ({ data, mode, mime, fileName: exportFileName(doc, format, edited || subset) })
  const text = (s: string, mode: ExportMode = 'generated') => mk(new TextEncoder().encode(s), mode)
  const own = ownFormat(doc)
  // price toggle only matters where the format lets the user choose; tender (83) formats are
  // price-free and 84/86 always priced, so a forced value must not block original/patch mode
  const defaults = longTexts && (tender || !!info.priced || (req.prices ?? true))

  /* 1 + 2: original bytes / in-place patch */
  if (own === format && !subset && defaults && req.loadOriginal) {
    const orig = await req.loadOriginal()
    if (orig) {
      if (!edited) return mk(orig, 'original')
      if (format === 'x83' || format === 'x83-2004') {
        const { patchGaebXml } = await import('./gaeb-xml')
        const r = patchGaebXml(new TextDecoder('utf-8').decode(orig), doc, positions, undefined, { prices })
        return text(r.xml, 'patched')
      }
      if (format === 'd83' || format === 'd84' || format === 'd86') {
        const { patchGaeb90 } = await import('./gaeb90')
        return mk(patchGaeb90(orig, doc, positions, { prices }).bytes, 'patched')
      }
    }
  }

  /* 3: generate */
  const tree = buildCats(positions, subset ? undefined : req.resolved.tree)
  const base = { doc, positions, tree, longTexts, prices }
  switch (format) {
    case 'csv': {
      const { toCsvTable } = await import('./table')
      return text(toCsvTable(base))
    }
    case 'json': {
      const { toJson } = await import('./table')
      return text(toJson(base, subset ? tree.roots : req.resolved.tree))
    }
    case 'xlsx': {
      const { toXlsx } = await import('./table')
      return mk(await toXlsx(base), 'generated')
    }
    case 'docx': {
      const { toDocx } = await import('./table')
      return mk(await toDocx(base), 'generated')
    }
    case 'x83':
    case 'x83-2004': {
      const { generateGaebXml } = await import('./gaeb-xml')
      return text(generateGaebXml({ doc, positions, tree: subset ? undefined : req.resolved.tree, variant: format === 'x83' ? '3.2' : '2004', longTexts, prices: false, phase: '83', now }))
    }
    case 'd83':
    case 'd84':
    case 'd86': {
      const { generateGaeb90 } = await import('./gaeb90')
      return mk(generateGaeb90({ doc, positions, tree: subset ? undefined : req.resolved.tree, phase: format.slice(1) as '83' | '84' | '86', longTexts, prices, now }), 'generated')
    }
    case 'pdf': {
      if (own === 'pdf' && !edited && !subset && defaults && req.loadOriginal) {
        const o = await req.loadOriginal()
        if (o) return mk(o, 'original')
      }
      const { generatePdf, pickTemplate } = await import('./pdf')
      const template = pickTemplate(doc)
      let layout: LayoutFile | null = null
      if (req.loadLayout) layout = await req.loadLayout()
      const data = await generatePdf({ doc, positions, tree, longTexts, prices, template, layout, now })
      return mk(data, 'generated')
    }
  }
}

/* ------------------------------------------------------------------ */
/* browser helpers                                                     */
/* ------------------------------------------------------------------ */

const baseUrl = (): string => (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'

export function originalLoader(doc: ListDoc): (() => Promise<Uint8Array | null>) | undefined {
  if (!doc.fileName || doc.userCreated) return undefined
  return async () => {
    try {
      const r = await fetch(`${baseUrl()}files/${doc.fileName.split('/').map(encodeURIComponent).join('/')}`)
      const ct = r.headers.get('content-type') ?? ''
      if (!r.ok || ct.includes('text/html')) return null
      return new Uint8Array(await r.arrayBuffer())
    } catch {
      return null
    }
  }
}

export function layoutLoader(doc: ListDoc): () => Promise<LayoutFile | null> {
  return async () => {
    try {
      const r = await fetch(`${baseUrl()}data/layout/${encodeURIComponent(doc.id)}.json`)
      const ct = r.headers.get('content-type') ?? ''
      if (!r.ok || !ct.includes('json')) return null
      return (await r.json()) as LayoutFile
    } catch {
      return null
    }
  }
}

export function downloadResult(res: ExportResult) {
  const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: res.mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = res.fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
