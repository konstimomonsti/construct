import type { ParsedList } from './gaeb'
import { loadList } from './data'
import { positionTotal } from './money'
import { flatTree, treeFromPaths } from './cat'
import type { DocMeta, ListDoc, Position } from './types'
import { selectModel, useStore } from './store'
import { removeDocuments, saveDocument } from './documents'
import { toast } from '../components/ui'

export const ACCEPT = '.x80,.x81,.x82,.x83,.x84,.x85,.x86,.x87,.x88,.x89,.d80,.d81,.d82,.d83,.d84,.d85,.d86,.d87,.d88,.d89,.csv,.tsv,.xlsx,.json,.docx,.pdf'

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

/** Existing sample exports can be byte-identical to the original document. */
async function readSampleDocument(file: File): Promise<ParsedList | undefined> {
  const candidates = useStore.getState().base?.lists.filter((list) => list.file && list.fileName.toLowerCase() === file.name.toLowerCase()) ?? []
  if (!candidates.length) return
  const bytes = new Uint8Array(await file.arrayBuffer())
  for (const candidate of candidates) {
    const response = await fetch(`${import.meta.env.BASE_URL}${candidate.file}`)
    if (!response.ok) continue
    const original = new Uint8Array(await response.arrayBuffer())
    if (bytes.length === original.length && bytes.every((byte, index) => byte === original[index])) return loadList(candidate.id)
  }
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
  const documents: File[] = []
  for (const f of files) {
    const name = f.name
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    try {
      let parsed: ParsedList
      if (/^x8\d$/.test(ext)) parsed = g.parseGaebXml(await f.text())
      else if (/^d8\d$/.test(ext)) parsed = g.parseGaeb90(g.decodeGaeb90(new Uint8Array(await f.arrayBuffer())))
      else if (ext === 'csv' || ext === 'tsv') parsed = g.parseCsv(await f.text())
      else if (ext === 'json') parsed = parseListJson(await f.text(), 'json', 'JSON')
      else if (ext === 'xlsx') parsed = await (await import('./import-documents')).readExcel(f)
      else if (ext === 'pdf' || ext === 'docx') {
        const { readPdfPayload, readWordPayload } = await import('./import-documents')
        const payload = ext === 'pdf' ? await readPdfPayload(f) : await readWordPayload(f)
        const itemList = payload ? parseListJson(payload, ext, ext === 'pdf' ? 'PDF' : 'Word') : await readSampleDocument(f)
        if (!itemList) {
          documents.push(f)
          continue
        }
        parsed = itemList
      } else {
        throw new Error('Unsupported file type.')
      }
      if (!parsed.positions.length && /^([xd])8\d$/.test(ext) && !parsed.tree?.length && !parsed.title) throw new Error('No list found.')
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
  for (const file of documents) {
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
        const pdf = /\.pdf$/i.test(file.name)
        const list = makeListDoc(folderId, name, file.name, [], { format: pdf ? 'PDF' : 'Word', source: { kind: pdf ? 'pdf' : 'docx' } })
        await addFile(file, list.id, true, list)
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
