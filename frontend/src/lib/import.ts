import type { ParsedList } from './gaeb'
import { positionTotal } from './money'
import { flatTree, treeFromPaths } from './cat'
import type { DocMeta, ListDoc, Position } from './types'
import { useStore } from './store'
import { useUi } from './ui-store'
import { toast } from '../components/ui'

export const ACCEPT = '.x81,.x82,.x83,.x84,.x86,.d81,.d83,.d84,.d86,.csv,.json,.pdf'

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
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

export async function importFiles(files: File[], folderId: string): Promise<ImportResult> {
  const g = await import('./gaeb')
  const res: ImportResult = { lists: [], positions: 0, docs: 0, failed: [] }
  for (const f of files) {
    const name = f.name
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const base = name.replace(/\.[^.]+$/, '')
    try {
      if (ext === 'pdf') {
        const doc: DocMeta = {
          id: `d-${uid()}`,
          name,
          file: '',
          pages: 0,
          excerpt: `${(f.size / 1024).toFixed(0)} KB · upload (this session only)`,
          blobUrl: URL.createObjectURL(f),
        }
        useUi.getState().addSessionDoc(folderId, doc)
        res.docs++
        continue
      }
      let parsed: ParsedList
      if (/^x8\d$/.test(ext)) parsed = g.parseGaebXml(await f.text())
      else if (/^d8\d$/.test(ext)) parsed = g.parseGaeb90(g.decodeGaeb90(new Uint8Array(await f.arrayBuffer())))
      else if (ext === 'csv' || ext === 'tsv') parsed = g.parseCsv(await f.text())
      else if (ext === 'json') {
        const raw = JSON.parse(await f.text())
        const positions = normalizeJson(raw)
        parsed = { format: 'JSON', currency: raw?.currency ?? 'EUR', title: raw?.title, positions, tree: Array.isArray(raw?.tree) && positions.every((p) => p.path?.length) ? raw.tree : undefined, source: { kind: 'json' } }
      } else {
        res.failed.push(name)
        continue
      }
      if (!parsed.positions.length) {
        res.failed.push(name)
        continue
      }
      const doc = makeListDoc(folderId, parsed.title || base, name, parsed.positions, parsed)
      useStore.getState().addList(doc)
      res.lists.push(doc.id)
      res.positions += doc.positions.length
    } catch (err) {
      console.warn(`import failed: ${name}`, err)
      res.failed.push(name)
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
export function pickAndImport(folderId: string | (() => string), onDone?: (r: ImportResult) => void, accept = ACCEPT) {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = accept
  input.hidden = true
  input.onchange = async () => {
    const files = [...(input.files ?? [])]
    input.remove()
    if (!files.length) return
    const id = typeof folderId === 'function' ? folderId() : folderId
    const r = await importFiles(files, id)
    onDone?.(r)
  }
  document.body.appendChild(input)
  input.click()
}

/** folder used by "Upload File" on pages that aren't a folder */
export function inboxFolderId(): string {
  const st = useStore.getState()
  const found = st.userFolders.find((f) => f.name === 'Imports')
  return found ? found.id : st.createFolder('Imports', 'Uploaded item lists & documents')
}
