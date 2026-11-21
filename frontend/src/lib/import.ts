import type { ParsedList } from './gaeb'
import { loadList } from './data'
import { positionTotal } from './money'
import { flatTree, treeFromPaths } from './cat'
import type { DocMeta, ListDoc, Position } from './types'
import { selectModel, useStore } from './store'
import { removeDocuments, saveDocument } from './documents'
import { toast } from '../components/ui'

export const ACCEPT = '.x80,.x81,.x82,.x83,.x84,.x85,.x86,.x87,.x88,.x89,.d80,.d81,.d82,.d83,.d84,.d85,.d86,.d87,.d88,.d89,.csv,.tsv,.xls,.xlsx,.json,.docx,.pdf'

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
  const { parseListFile } = await import('./parse-list-file')
  const res: ImportResult = { lists: [], positions: 0, docs: 0, failed: [] }
  const documents: File[] = []
  const importErrors: string[] = []
  const offerFiles = new Set([
    ...files.map((file) => file.name),
    ...selectModel(useStore.getState()).lists
      .filter((list) => list.folderId === folderId && !list.trashedAt)
      .map((list) => list.fileName),
  ].filter((name) => /\.d84$/i.test(name)).map((name) => fileStem(name).toLowerCase()))
  for (const f of files) {
    const name = f.name
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    try {
      if (ext === 'pdf' && offerFiles.has(fileStem(name).toLowerCase())) {
        documents.push(f)
        continue
      }
      const parsed = await parseListFile(f) ?? await readSampleDocument(f)
      if (!parsed) {
        documents.push(f)
        continue
      }
      const list = makeListDoc(folderId, parsed.title || fileStem(name), name, parsed.positions, parsed)
      await addFile(f, list.id, true, list)
      if (parsed.warnings?.length) toast(`${name}: ${parsed.warnings[0]}`)
      res.lists.push(list.id)
      res.positions += list.positions.length
    } catch (err) {
      console.warn(`import failed: ${name}`, err)
      res.failed.push(name)
      if (err instanceof Error) importErrors.push(`${name}: ${err.message}`)
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
  if (res.lists.length) parts.push(`${res.lists.length} ${res.lists.length === 1 ? 'list' : 'lists'} (${res.positions.toLocaleString('de-DE')} positions)`)
  if (res.docs) parts.push(`${res.docs} ${res.docs === 1 ? 'document' : 'documents'}`)
  if (parts.length) toast(`Imported ${parts.join(' + ')}`, 'ok', files.length === 1 && res.lists.length === 1
    ? { label: 'Open list', run: () => window.location.assign(`/list/${res.lists[0]}`) }
    : undefined)
  if (res.failed.length) toast(importErrors[0] ?? `Could not read: ${res.failed.join(', ')}`, 'error')
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
