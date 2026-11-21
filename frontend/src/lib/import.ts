import type { ParsedList } from './gaeb'
import { positionTotal } from './money'
import { flatTree, treeFromPaths } from './cat'
import type { DocMeta, ListDoc, Position } from './types'
import { selectModel, useStore } from './store'
import { removeDocuments, saveDocument } from './documents'
import { toast } from '../components/ui'

export const ACCEPT = '.x81,.x82,.x83,.x84,.x86,.d81,.d83,.d84,.d86,.csv,.tsv,.json,.pdf'

const uid = () => crypto.randomUUID()
const fileStem = (name: string) => name.replace(/\.[^.]+$/, '')
const slug = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'liste'

export function makeListDoc(
  folderId: string,
  title: string,
  fileName: string,
  positions: Position[],
  extra: Partial<ParsedList> = {},
): ListDoc {
  const cats = new Set(positions.map((p) => p.category))
  const hasPaths = positions.length > 0 && positions.every((p) => p.path?.length)
  const tree = extra.tree ?? (hasPaths ? treeFromPaths(positions) : flatTree(positions))
  return {
    id: `u-${slug(title)}-${uid()}`,
    folderId,
    fileName,
    title,
    format: extra.format ?? 'Eigene Liste',
    phase: extra.phase,
    project: extra.project,
    projectLabel: extra.projectLabel,
    date: extra.date ?? new Date().toLocaleDateString('de-DE'),
    currency: extra.currency ?? 'EUR',
    positionsCount: positions.length,
    pricedCount: positions.filter((p) => (p.up ?? 0) > 0).length,
    total: Math.round(positions.reduce((s, p) => s + positionTotal(p), 0) * 100) / 100,
    categories: cats.size,
    userCreated: true,
    notes: extra.notes,
    positions,
    tree,
    source: extra.source ?? { kind: 'blank' },
  }
}

function normalizeJson(raw: unknown): Position[] {
  const arr = Array.isArray(raw) ? raw : (raw as { positions?: unknown })?.positions
  if (!Array.isArray(arr)) throw new Error('JSON enthält kein "positions"-Array')
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
    path: Array.isArray(r.path) ? (r.path as { oz: string; label: string }[]) : undefined,
    srcRef: r.srcRef ? String(r.srcRef) : undefined,
  }))
}

export interface ImportResult {
  lists: string[]
  positions: number
  docs: number
  failed: string[]
}

async function addFile(file: File, listId: string, original: boolean, list?: ListDoc) {
  const doc: DocMeta = {
    id: `d-${uid()}`,
    name: file.name,
    file: '',
    pages: 0,
    excerpt: `${(file.size / 1024).toFixed(0)} KB`,
    listId,
    stored: true,
    original,
  }
  await saveDocument(doc.id, file)
  if (!useStore.getState().addImportedFile(doc, list)) {
    removeDocuments([doc.id])
    throw new Error('The destination folder or list is unavailable.')
  }
}

export async function importFiles(files: File[], folderId: string, activeListId?: string): Promise<ImportResult> {
  const g = await import('./gaeb')
  const res: ImportResult = { lists: [], positions: 0, docs: 0, failed: [] }
  const pdfFiles: File[] = []
  for (const f of files) {
    const name = f.name
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (ext === 'pdf') {
      pdfFiles.push(f)
      continue
    }
    try {
      let parsed: ParsedList
      if (/^x8\d$/.test(ext)) parsed = g.parseGaebXml(await f.text())
      else if (/^d8\d$/.test(ext)) parsed = g.parseGaeb90(g.decodeGaeb90(new Uint8Array(await f.arrayBuffer())))
      else if (ext === 'csv' || ext === 'tsv') parsed = g.parseCsv(await f.text())
      else if (ext === 'json') {
        const raw = JSON.parse(await f.text())
        const positions = normalizeJson(raw)
        parsed = { format: 'JSON', currency: raw?.currency ?? 'EUR', title: raw?.title, positions, tree: Array.isArray(raw?.tree) && positions.every((p) => p.path?.length) ? raw.tree : undefined, source: { kind: 'json' } }
      } else {
        throw new Error('Unsupported file type.')
      }
      if (!parsed.positions.length) throw new Error('No positions found.')
      const list = makeListDoc(folderId, parsed.title || fileStem(name), name, parsed.positions, parsed)
      await addFile(f, list.id, true, list)
      res.lists.push(list.id)
      res.positions += list.positions.length
    } catch (err) {
      console.warn(`import failed: ${name}`, err)
      res.failed.push(name)
    }
  }

  const importedListIds = [...res.lists]
  for (const file of pdfFiles) {
    try {
      const lists = selectModel(useStore.getState()).lists.filter((list) => list.folderId === folderId && !list.trashedAt)
      const name = fileStem(file.name)
      const matching = lists.filter((list) => fileStem(list.fileName).toLowerCase() === name.toLowerCase())
      const selected = lists.find((list) => list.id === activeListId)
        ?? (matching.length === 1 ? matching[0] : undefined)
        ?? (importedListIds.length === 1 ? lists.find((list) => list.id === importedListIds[0]) : undefined)
      if (selected) {
        await addFile(file, selected.id, false)
      } else {
        const list = makeListDoc(folderId, name, file.name, [])
        await addFile(file, list.id, false, list)
        res.lists.push(list.id)
      }
      res.docs++
    } catch (err) {
      console.warn(`import failed: ${file.name}`, err)
      res.failed.push(file.name)
    }
  }
  const parts: string[] = []
  if (res.lists.length) parts.push(`${res.lists.length} ${res.lists.length === 1 ? 'list' : 'lists'} (${res.positions.toLocaleString('en-US')} positions)`)
  if (res.docs) parts.push(`${res.docs} ${res.docs === 1 ? 'document' : 'documents'}`)
  if (parts.length) toast(`Imported ${parts.join(' + ')}`)
  if (res.failed.length) toast(`Could not read: ${res.failed.join(', ')}`, 'error')
  return res
}

/** open the native file picker and import into a folder */
export function pickAndImport(folderId: string, onDone?: (r: ImportResult) => void, accept = ACCEPT, activeListId?: string) {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = accept
  input.hidden = true
  input.oncancel = () => input.remove()
  input.onchange = async () => {
    const files = [...(input.files ?? [])]
    input.remove()
    if (!files.length) return
    const r = await importFiles(files, folderId, activeListId)
    onDone?.(r)
  }
  document.body.appendChild(input)
  input.click()
}
