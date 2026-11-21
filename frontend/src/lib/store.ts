import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import type { DocMeta, FolderMeta, Library, ListDoc, ListMeta, Position } from './types'
import { fixedBudget } from './format'
import { positionTotal } from './money'
import { removeDocuments } from './documents'
import { withoutLegacyImports } from './legacy'

export type SortKey = 'cost-desc' | 'cost-asc' | 'name' | 'items'
export const SORT_LABEL: Record<SortKey, string> = {
  'cost-desc': 'Cost (High to Low)',
  'cost-asc': 'Cost (Low to High)',
  name: 'Name (A–Z)',
  items: 'Line items',
}

interface FolderPatch {
  parentId?: string | null
  name?: string
  description?: string
  archived?: boolean
  trashedAt?: string
  cap?: number | null
}
interface ListPatch {
  title?: string
  trashedAt?: string
  cap?: number | null
  folderId?: string
  reviewedFindings?: string[]
}
export interface ListEdits {
  qty: Record<string, number>
  up: Record<string, number | null>
  removed: string[]
  added: Position[]
  /** per-position text, unit, and position-number overrides */
  patch: Record<string, Partial<Pick<Position, 'short' | 'long' | 'unit' | 'oz'>>>
  /** position id → target category OZ (renumbered by resolveList) */
  moves: Record<string, string>
  categories: { added: { oz: string; label: string; parentOz: string | null }[]; renamed: Record<string, string> }
}
interface Stats {
  total: number
  pricedCount: number
  positionsCount: number
}

/** what the shared workspace held at the last exchange (see sync.ts) */
export interface SyncBase {
  revision: number
  hashes: Record<string, Record<string, string>>
}

interface State {
  base: Library | null
  sync: SyncBase | null
  userFolders: FolderMeta[]
  userLists: ListDoc[]
  userDocuments: DocMeta[]
  documentLinks: Record<string, string>
  documentFolders: Record<string, string>
  folderPatch: Record<string, FolderPatch>
  listPatch: Record<string, ListPatch>
  edits: Record<string, ListEdits>
  stats: Record<string, Stats>
  openTabs: string[]
  view: 'grid' | 'list'
  sort: SortKey
  sidebarCollapsed: boolean

  setBase: (l: Library) => void
  setView: (v: 'grid' | 'list') => void
  setSort: (s: SortKey) => void
  toggleSidebar: () => void
  createFolder: (name: string, description?: string, parentId?: string) => string
  patchFolder: (id: string, p: FolderPatch) => void
  moveFolder: (id: string, parentId: string | null) => boolean
  patchList: (id: string, p: ListPatch) => void
  restoreFolder: (id: string) => void
  purgeFolder: (id: string) => void
  addList: (doc: ListDoc) => void
  addImportedFile: (doc: DocMeta, list?: ListDoc) => boolean
  linkDocument: (id: string, listId: string) => void
  moveDocument: (id: string, folderId: string) => void
  openTab: (id: string) => void
  openTabs_: (ids: string[]) => void
  closeTab: (id: string) => void
  setQty: (listId: string, pid: string, q: number) => void
  setUp: (listId: string, pid: string, up: number | null) => void
  removePositions: (listId: string, pids: string[]) => void
  restorePositions: (listId: string, pids: string[]) => void
  patchPosition: (listId: string, pid: string, p: ListEdits['patch'][string]) => void
  /** drop every user change (qty/price/text/move) of one position */
  resetPosition: (listId: string, pid: string) => void
  movePositions: (listId: string, pids: string[], targetOz: string) => void
  unmovePositions: (listId: string, pids: string[]) => void
  addCategory: (listId: string, oz: string, label: string, parentOz: string | null) => void
  removeCategory: (listId: string, oz: string) => void
  renameCategory: (listId: string, oz: string, label: string) => void
  /** replace all edits of a list (undo snapshots) */
  setEdits: (listId: string, e: ListEdits | undefined) => void
  deleteList: (id: string) => void
  addPosition: (listId: string, p: Position) => void
  recordStats: (listId: string, s: Stats) => void
}

const emptyEdits = (): ListEdits => ({ qty: {}, up: {}, removed: [], added: [], patch: {}, moves: {}, categories: { added: [], renamed: {} } })
/** tolerate edits persisted before patch/moves/categories existed */
export const normEdits = (e?: Partial<ListEdits>): ListEdits => {
  const b = emptyEdits()
  return e ? { ...b, ...e, categories: { ...b.categories, ...(e.categories ?? {}) } } : b
}
const norm = normEdits

function deleteLists(s: State, ids: Set<string>) {
  const drop = s.userDocuments.filter((doc) => ids.has(s.documentLinks[doc.id] ?? doc.listId ?? ''))
  const dropIds = new Set(drop.map((doc) => doc.id))
  removeDocuments(drop.filter((doc) => doc.stored).map((doc) => doc.id))
  return {
    userLists: s.userLists.filter((list) => !ids.has(list.id)),
    userDocuments: s.userDocuments.filter((doc) => !dropIds.has(doc.id)),
    documentLinks: Object.fromEntries(Object.entries(s.documentLinks).filter(([doc, list]) => !dropIds.has(doc) && !ids.has(list))),
    documentFolders: Object.fromEntries(Object.entries(s.documentFolders).filter(([doc]) => !dropIds.has(doc))),
    userFolders: s.userFolders.map((folder) => ({ ...folder, lists: folder.lists.filter((id) => !ids.has(id)) })),
    openTabs: s.openTabs.filter((id) => !ids.has(id)),
  }
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      base: null,
      sync: null,
      userFolders: [],
      userLists: [],
      userDocuments: [],
      documentLinks: {},
      documentFolders: {},
      folderPatch: {},
      listPatch: {},
      edits: {},
      stats: {},
      openTabs: [],
      view: 'grid',
      sort: 'cost-desc',
      sidebarCollapsed: false,

      setBase: (base) => set({ base }),
      setView: (view) => set({ view }),
      setSort: (sort) => set({ sort }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      createFolder: (name, description = '', parentId) => {
        const id = `f-${crypto.randomUUID()}`
        set((s) => ({
          userFolders: [
            ...s.userFolders,
            {
              id, parentId, name, description: description || 'Awaiting initial line allocations', icon: 'folder_open',
              tone: 'slate', lists: [], documents: [], createdAt: new Date().toISOString(), userCreated: true,
            },
          ],
        }))
        return id
      },
      patchFolder: (id, p) => set((s) => ({ folderPatch: { ...s.folderPatch, [id]: { ...s.folderPatch[id], ...p } } })),
      moveFolder: (id, parentId) => {
        const { folders } = selectModel(get())
        const source = folders.find((folder) => folder.id === id && !folder.trashedAt)
        if (!source || (source.parentId ?? null) === parentId) return false
        if (parentId !== null) {
          const path = folderPath(folders, parentId)
          if (!path.length || path.some((folder) => folder.id === id || folder.trashedAt)) return false
        }
        get().patchFolder(id, { parentId })
        return true
      },
      patchList: (id, p) => set((s) => ({ listPatch: { ...s.listPatch, [id]: { ...s.listPatch[id], ...p } } })),
      restoreFolder: (id) =>
        set((s) => ({ folderPatch: { ...s.folderPatch, [id]: { ...s.folderPatch[id], trashedAt: undefined, archived: false } } })),
      purgeFolder: (id) =>
        set((s) => {
          const deleted = new Set(s.userLists.filter((l) => (s.listPatch[l.id]?.folderId ?? l.folderId) === id).map((l) => l.id))
          const remaining = deleteLists(s, deleted)
          const folderPatch = { ...s.folderPatch, [id]: { ...s.folderPatch[id], trashedAt: 'purged' } }
          for (const folder of selectModel(s).folders) {
            if (folder.parentId === id) folderPatch[folder.id] = { ...folderPatch[folder.id], parentId: null }
          }
          return {
            ...remaining,
            documentFolders: Object.fromEntries(Object.entries(remaining.documentFolders).filter(([, folder]) => folder !== id)),
            userFolders: remaining.userFolders.filter((f) => f.id !== id),
            folderPatch,
          }
        }),
      addList: (doc) =>
        set((s) => ({
          userLists: [...s.userLists, doc],
          userFolders: s.userFolders.map((f) => (f.id === doc.folderId ? { ...f, lists: [...f.lists, doc.id] } : f)),
        })),
      addImportedFile: (doc, list) => {
        const model = selectModel(get())
        const destination = list ?? model.lists.find((item) => item.id === doc.listId && !item.trashedAt)
        if (!destination || !model.folders.some((folder) => folder.id === destination.folderId && !folder.trashedAt)) return false
        set((s) => ({
          userDocuments: [...s.userDocuments, doc],
          userLists: list ? [...s.userLists, list] : s.userLists,
        }))
        return true
      },
      linkDocument: (id, listId) =>
        set((s) => ({ documentLinks: { ...s.documentLinks, [id]: listId } })),
      moveDocument: (id, folderId) =>
        set((s) => {
          const { documents, lists } = selectModel(s)
          const listId = documents.find((doc) => doc.id === id)?.listId
          const documentFolders = { ...s.documentFolders }
          if (lists.find((list) => list.id === listId)?.folderId === folderId) delete documentFolders[id]
          else documentFolders[id] = folderId
          return { documentFolders }
        }),
      openTab: (id) => set((s) => ({ openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id] })),
      openTabs_: (ids) => set((s) => ({ openTabs: [...new Set([...s.openTabs, ...ids])] })),
      closeTab: (id) => set((s) => ({ openTabs: s.openTabs.filter((t) => t !== id) })),

      setQty: (listId, pid, q) =>
        set((s) => {
          const e = norm(s.edits[listId])
          return { edits: { ...s.edits, [listId]: { ...e, qty: { ...e.qty, [pid]: q } } } }
        }),
      setUp: (listId, pid, up) =>
        set((s) => {
          const e = norm(s.edits[listId])
          return { edits: { ...s.edits, [listId]: { ...e, up: { ...e.up, [pid]: up } } } }
        }),
      removePositions: (listId, pids) =>
        set((s) => {
          const e = norm(s.edits[listId])
          return { edits: { ...s.edits, [listId]: { ...e, removed: [...new Set([...e.removed, ...pids])] } } }
        }),
      restorePositions: (listId, pids) =>
        set((s) => {
          const e = norm(s.edits[listId])
          const drop = new Set(pids)
          return { edits: { ...s.edits, [listId]: { ...e, removed: e.removed.filter((x) => !drop.has(x)) } } }
        }),
      patchPosition: (listId, pid, p) =>
        set((s) => {
          const e = norm(s.edits[listId])
          return { edits: { ...s.edits, [listId]: { ...e, patch: { ...e.patch, [pid]: { ...e.patch[pid], ...p } } } } }
        }),
      resetPosition: (listId, pid) =>
        set((s) => {
          const e = norm(s.edits[listId])
          const { [pid]: _q, ...qty } = e.qty
          const { [pid]: _u, ...up } = e.up
          const { [pid]: _p, ...patch } = e.patch
          const { [pid]: _m, ...moves } = e.moves
          return { edits: { ...s.edits, [listId]: { ...e, qty, up, patch, moves } } }
        }),
      movePositions: (listId, pids, targetOz) =>
        set((s) => {
          const e = norm(s.edits[listId])
          const moves = { ...e.moves }
          const patch = { ...e.patch }
          for (const id of pids) {
            delete moves[id] // re-insert so move order == call order
            moves[id] = targetOz
            if (patch[id]?.oz !== undefined) {
              const { oz: _number, ...otherFields } = patch[id]
              if (Object.keys(otherFields).length) patch[id] = otherFields
              else delete patch[id]
            }
          }
          return { edits: { ...s.edits, [listId]: { ...e, moves, patch } } }
        }),
      unmovePositions: (listId, pids) =>
        set((s) => {
          const e = norm(s.edits[listId])
          const moves = { ...e.moves }
          for (const id of pids) delete moves[id]
          return { edits: { ...s.edits, [listId]: { ...e, moves } } }
        }),
      addCategory: (listId, oz, label, parentOz) =>
        set((s) => {
          const e = norm(s.edits[listId])
          return { edits: { ...s.edits, [listId]: { ...e, categories: { ...e.categories, added: [...e.categories.added, { oz, label, parentOz }] } } } }
        }),
      removeCategory: (listId, oz) =>
        set((s) => {
          const e = norm(s.edits[listId])
          return { edits: { ...s.edits, [listId]: { ...e, categories: { ...e.categories, added: e.categories.added.filter((c) => c.oz !== oz) } } } }
        }),
      renameCategory: (listId, oz, label) =>
        set((s) => {
          const e = norm(s.edits[listId])
          return { edits: { ...s.edits, [listId]: { ...e, categories: { ...e.categories, renamed: { ...e.categories.renamed, [oz]: label } } } } }
        }),
      setEdits: (listId, e) =>
        set((s) => {
          const edits = { ...s.edits }
          if (e) edits[listId] = e
          else delete edits[listId]
          return { edits }
        }),
      deleteList: (id) => set((s) => deleteLists(s, new Set([id]))),
      addPosition: (listId, p) =>
        set((s) => {
          const e = norm(s.edits[listId])
          return { edits: { ...s.edits, [listId]: { ...e, added: [...e.added, p] } } }
        }),
      recordStats: (listId, st) => {
        const cur = get().stats[listId]
        if (cur && cur.total === st.total && cur.pricedCount === st.pricedCount && cur.positionsCount === st.positionsCount) return
        set((s) => ({ stats: { ...s.stats, [listId]: st } }))
      },
    }),
    {
      name: 'vaultbudget:v1',
      version: 3,
      migrate: (persisted: unknown) => {
        const st = (persisted ?? {}) as { edits?: Record<string, Partial<ListEdits>>; folderPatch?: Record<string, FolderPatch & { shared?: boolean }> }
        if (st.edits) st.edits = Object.fromEntries(Object.entries(st.edits).map(([k, v]) => [k, normEdits(v)]))
        return withoutLegacyImports(st as Partial<State>) as never
      },
      partialize: ({ base: _b, ...rest }) => ({
        ...rest,
        // object URLs don't survive reloads
        userFolders: rest.userFolders.map((f) => ({ ...f, documents: f.documents.filter((d) => !d.blobUrl) })),
      }),
    },
  ),
)

/* ------------------------------------------------------------------ */
/* Derived selectors                                                   */
/* ------------------------------------------------------------------ */

export interface FolderView extends FolderMeta {
  archived: boolean
  trashedAt?: string
  total: number
  cap: number
  positions: number
  priced: number
  listMetas: ListView[]
}

export interface ListView extends ListMeta {
  cap: number
  trashedAt?: string
}

export function applyEdits(doc: ListDoc, e?: ListEdits): Position[] {
  if (!e) return doc.positions
  const removed = new Set(e.removed)
  return [...doc.positions, ...e.added]
    .filter((p) => !removed.has(p.id))
    .map((p) => {
      const q = e.qty[p.id]
      const up = p.id in e.up ? e.up[p.id] : p.up
      return q === undefined && up === p.up ? p : { ...p, qty: q ?? p.qty, up }
    })
}

export const statsOf = (positions: Position[]) => ({
  total: Math.round(positions.reduce((s, p) => s + positionTotal(p), 0) * 100) / 100,
  pricedCount: positions.filter((p) => (p.up ?? 0) > 0).length,
  positionsCount: positions.length,
})

function buildLists(s: State): ListView[] {
  const metas: ListMeta[] = [...(s.base?.lists ?? []), ...s.userLists.map(({ positions: _p, notes: _n, ...m }) => m)]
  return metas.map((m) => {
    const patch = s.listPatch[m.id] ?? {}
    const st = s.stats[m.id]
    const total = st?.total ?? m.total
    const cap = patch.cap ?? fixedBudget(m.total)
    return {
      ...m,
      title: patch.title ?? m.title,
      folderId: patch.folderId ?? m.folderId,
      total,
      pricedCount: st?.pricedCount ?? m.pricedCount,
      positionsCount: st?.positionsCount ?? m.positionsCount,
      cap,
      trashedAt: patch.trashedAt,
    }
  })
}

function buildDocuments(s: State): (DocMeta & { originalFolderId?: string })[] {
  const documents = (s.base?.folders ?? []).concat(s.userFolders).flatMap((folder) =>
    folder.documents.map((doc) => ({ ...doc, originalFolderId: folder.id })),
  )
  const listedFiles = new Set(documents.map((doc) => doc.file))
  const originals: DocMeta[] = (s.base?.lists ?? []).flatMap((list) => list.file && !listedFiles.has(list.file)
    ? [{ id: `source-${list.id}`, name: list.fileName, file: list.file, pages: list.pages ?? 0, excerpt: '', listId: list.id, original: true }]
    : [])
  return [...documents, ...originals, ...s.userDocuments].map((doc) => ({
    ...doc, listId: s.documentLinks[doc.id] ?? doc.listId,
  }))
}

function buildFolders(s: State, lists: ListView[], documents: ReturnType<typeof buildDocuments>): FolderView[] {
  const byId = new Map(lists.map((l) => [l.id, l]))
  const all = [...(s.base?.folders ?? []), ...s.userFolders]
  const originalTotals = new Map<string, number>()
  // imported lists set the budget of the folder they arrived in, like the sample lists do
  for (const list of [...(s.base?.lists ?? []), ...s.userLists]) {
    originalTotals.set(list.folderId, (originalTotals.get(list.folderId) ?? 0) + list.total)
  }
  const documentsByFolder = new Map<string, DocMeta[]>()
  for (const doc of documents) {
    const list = doc.listId ? byId.get(doc.listId) : undefined
    const folderId = s.documentFolders[doc.id] ?? list?.folderId ?? doc.originalFolderId
    if (!folderId || list?.trashedAt) continue
    const group = documentsByFolder.get(folderId) ?? []
    group.push(doc)
    documentsByFolder.set(folderId, group)
  }
  return all
    .map((f) => {
      const patch = s.folderPatch[f.id] ?? {}
      // lists can be moved between folders via listPatch.folderId
      const listMetas = lists.filter((l) => l.folderId === f.id && !l.trashedAt)
      const ordered = [
        ...f.lists.map((id) => byId.get(id)).filter((l): l is ListView => !!l && l.folderId === f.id && !l.trashedAt),
        ...listMetas.filter((l) => !f.lists.includes(l.id)),
      ]
      const total = ordered.reduce((a, l) => a + l.total, 0)
      return {
        ...f,
        documents: documentsByFolder.get(f.id) ?? [],
        parentId: patch.parentId === null ? undefined : patch.parentId ?? f.parentId,
        name: patch.name ?? f.name,
        description: patch.description ?? f.description,
        archived: !!patch.archived,
        trashedAt: patch.trashedAt,
        total,
        cap: patch.cap ?? fixedBudget(originalTotals.get(f.id) ?? 0),
        positions: ordered.reduce((a, l) => a + l.positionsCount, 0),
        priced: ordered.reduce((a, l) => a + l.pricedCount, 0),
        listMetas: ordered,
      }
    })
    .filter((f) => f.trashedAt !== 'purged')
}

/** memoised derived model (recomputed only when inputs change) */
let memoKey: unknown[] = []
let memoVal: { folders: FolderView[]; lists: ListView[]; documents: DocMeta[] } = { folders: [], lists: [], documents: [] }
export function selectModel(s: State) {
  const key = [s.base, s.userFolders, s.userLists, s.userDocuments, s.documentLinks, s.documentFolders, s.folderPatch, s.listPatch, s.stats]
  if (key.every((k, i) => k === memoKey[i])) return memoVal
  const lists = buildLists(s)
  const documents = buildDocuments(s)
  memoVal = { lists, documents, folders: buildFolders(s, lists, documents) }
  memoKey = key
  return memoVal
}

export const useModel = () => useStore(useShallow(selectModel))

export function folderPath(folders: FolderView[], id: string): FolderView[] {
  const path: FolderView[] = []
  let folder = folders.find((entry) => entry.id === id)
  while (folder && !path.includes(folder)) {
    path.unshift(folder)
    const parentId = folder.parentId
    folder = folders.find((entry) => entry.id === parentId)
  }
  return path
}

export function useWorkspaceBudget() {
  const { folders } = useModel()
  const live = folders.filter((f) => !f.trashedAt)
  const total = live.reduce((a, f) => a + f.total, 0)
  const cap = live.reduce((a, f) => a + f.cap, 0)
  return { total, cap, pct: cap ? (total / cap) * 100 : 0 }
}
