import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import type { FolderMeta, Library, ListDoc, ListMeta, Position } from './types'
import { niceCap } from './format'
import { positionTotal } from './money'

export type SortKey = 'cost-desc' | 'cost-asc' | 'name' | 'items'
export const SORT_LABEL: Record<SortKey, string> = {
  'cost-desc': 'Cost (High to Low)',
  'cost-asc': 'Cost (Low to High)',
  name: 'Name (A–Z)',
  items: 'Line items',
}

interface FolderPatch {
  name?: string
  description?: string
  archived?: boolean
  shared?: boolean
  trashedAt?: string
  cap?: number | null
}
interface ListPatch {
  title?: string
  trashedAt?: string
  cap?: number | null
  folderId?: string
}
export interface ListEdits {
  qty: Record<string, number>
  up: Record<string, number | null>
  removed: string[]
  added: Position[]
  /** per-position text/unit overrides */
  patch: Record<string, Partial<Pick<Position, 'short' | 'long' | 'unit'>>>
  /** position id → target category OZ (renumbered by resolveList) */
  moves: Record<string, string>
  categories: { added: { oz: string; label: string; parentOz: string | null }[]; renamed: Record<string, string> }
}
interface Stats {
  total: number
  pricedCount: number
  positionsCount: number
}

interface State {
  base: Library | null
  userFolders: FolderMeta[]
  userLists: ListDoc[]
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
  createFolder: (name: string, description?: string, parentHint?: string) => string
  patchFolder: (id: string, p: FolderPatch) => void
  patchList: (id: string, p: ListPatch) => void
  restoreFolder: (id: string) => void
  purgeFolder: (id: string) => void
  addList: (doc: ListDoc) => void
  addDocument: (folderId: string, doc: FolderMeta['documents'][number]) => void
  openTab: (id: string) => void
  openTabs_: (ids: string[]) => void
  closeTab: (id: string) => void
  setQty: (listId: string, pid: string, q: number) => void
  setUp: (listId: string, pid: string, up: number | null) => void
  removePositions: (listId: string, pids: string[]) => void
  restorePositions: (listId: string, pids: string[]) => void
  patchPosition: (listId: string, pid: string, p: Partial<Pick<Position, 'short' | 'long' | 'unit'>>) => void
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

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      base: null,
      userFolders: [],
      userLists: [],
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

      createFolder: (name, description = '') => {
        const id = `f-${Date.now().toString(36)}`
        set((s) => ({
          userFolders: [
            ...s.userFolders,
            {
              id, name, description: description || 'Awaiting initial line allocations', icon: 'folder_open',
              tone: 'slate', lists: [], documents: [], createdAt: new Date().toISOString(), userCreated: true,
            },
          ],
        }))
        return id
      },
      patchFolder: (id, p) => set((s) => ({ folderPatch: { ...s.folderPatch, [id]: { ...s.folderPatch[id], ...p } } })),
      patchList: (id, p) => set((s) => ({ listPatch: { ...s.listPatch, [id]: { ...s.listPatch[id], ...p } } })),
      restoreFolder: (id) =>
        set((s) => ({ folderPatch: { ...s.folderPatch, [id]: { ...s.folderPatch[id], trashedAt: undefined, archived: false } } })),
      purgeFolder: (id) =>
        set((s) => ({
          userFolders: s.userFolders.filter((f) => f.id !== id),
          userLists: s.userLists.filter((l) => l.folderId !== id),
          folderPatch: { ...s.folderPatch, [id]: { ...s.folderPatch[id], trashedAt: 'purged' } },
        })),
      addList: (doc) =>
        set((s) => ({
          userLists: [...s.userLists, doc],
          userFolders: s.userFolders.map((f) => (f.id === doc.folderId ? { ...f, lists: [...f.lists, doc.id] } : f)),
        })),
      addDocument: (folderId, doc) =>
        set((s) => ({
          userFolders: s.userFolders.map((f) => (f.id === folderId ? { ...f, documents: [...f.documents, doc] } : f)),
        })),
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
          for (const id of pids) {
            delete moves[id] // re-insert so move order == call order
            moves[id] = targetOz
          }
          return { edits: { ...s.edits, [listId]: { ...e, moves } } }
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
      deleteList: (id) =>
        set((s) => ({
          userLists: s.userLists.filter((l) => l.id !== id),
          userFolders: s.userFolders.map((f) => ({ ...f, lists: f.lists.filter((x) => x !== id) })),
          openTabs: s.openTabs.filter((t) => t !== id),
        })),
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
      version: 2,
      migrate: (persisted: unknown) => {
        const st = (persisted ?? {}) as { edits?: Record<string, Partial<ListEdits>> }
        if (st.edits) st.edits = Object.fromEntries(Object.entries(st.edits).map(([k, v]) => [k, normEdits(v)]))
        return st as never
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
  shared: boolean
  trashedAt?: string
  total: number
  cap: number
  capIsCustom: boolean
  positions: number
  priced: number
  listMetas: ListView[]
}

export interface ListView extends ListMeta {
  baseTotal: number
  cap: number
  capIsCustom: boolean
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
    const cap = patch.cap ?? niceCap(m.total)
    return {
      ...m,
      title: patch.title ?? m.title,
      folderId: patch.folderId ?? m.folderId,
      total,
      pricedCount: st?.pricedCount ?? m.pricedCount,
      positionsCount: st?.positionsCount ?? m.positionsCount,
      baseTotal: m.total,
      cap,
      capIsCustom: patch.cap != null,
      trashedAt: patch.trashedAt,
    }
  })
}

function buildFolders(s: State, lists: ListView[]): FolderView[] {
  const byId = new Map(lists.map((l) => [l.id, l]))
  const all = [...(s.base?.folders ?? []), ...s.userFolders]
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
      const baseTotal = ordered.reduce((a, l) => a + l.baseTotal, 0)
      return {
        ...f,
        name: patch.name ?? f.name,
        description: patch.description ?? f.description,
        archived: !!patch.archived,
        shared: !!patch.shared,
        trashedAt: patch.trashedAt,
        total,
        cap: patch.cap ?? (niceCap(baseTotal) || (f.userCreated ? 50_000 : 0)),
        capIsCustom: patch.cap != null,
        positions: ordered.reduce((a, l) => a + l.positionsCount, 0),
        priced: ordered.reduce((a, l) => a + l.pricedCount, 0),
        listMetas: ordered,
      }
    })
    .filter((f) => f.trashedAt !== 'purged')
}

/** memoised derived model (recomputed only when inputs change) */
let memoKey: unknown[] = []
let memoVal: { folders: FolderView[]; lists: ListView[] } = { folders: [], lists: [] }
export function selectModel(s: State) {
  const key = [s.base, s.userFolders, s.userLists, s.folderPatch, s.listPatch, s.stats]
  if (key.every((k, i) => k === memoKey[i])) return memoVal
  const lists = buildLists(s)
  memoVal = { lists, folders: buildFolders(s, lists) }
  memoKey = key
  return memoVal
}

export const useModel = () => useStore(useShallow(selectModel))

export function useWorkspaceBudget() {
  const { folders } = useModel()
  const live = folders.filter((f) => !f.trashedAt)
  const total = live.reduce((a, f) => a + f.total, 0)
  const cap = live.reduce((a, f) => a + f.cap, 0)
  return { total, cap, pct: cap ? (total / cap) * 100 : 0 }
}
