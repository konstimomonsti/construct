import type { FolderMeta, ListDoc } from './types'

interface LegacyState {
  userFolders?: FolderMeta[]
  userLists?: ListDoc[]
  documentFolders?: Record<string, string>
  listPatch?: Record<string, { folderId?: string; trashedAt?: string }>
  folderPatch?: Record<string, { name?: string; trashedAt?: string }>
}

/**
 * Uploads used to land in an auto-created "Imports" folder. Remove it unless the user still keeps
 * something in it (or renamed it). A folder holding only trashed lists is hidden like a purged one.
 */
export function withoutLegacyImports<T extends LegacyState>(state: T): T {
  const folders = state.userFolders ?? []
  const patches = state.folderPatch ?? {}
  const legacy = folders.filter((folder) =>
    folder.name === 'Imports' &&
    folder.description === 'Uploaded item lists & documents' &&
    (patches[folder.id]?.name ?? 'Imports') === 'Imports' &&
    patches[folder.id]?.trashedAt !== 'purged',
  )
  if (!legacy.length) return state

  const listPatch = state.listPatch ?? {}
  // lists whose current folder is `id` (imported ones, plus any moved in through a patch)
  const listsIn = (id: string) => (state.userLists ?? [])
    .filter((list) => (listPatch[list.id]?.folderId ?? list.folderId) === id)
    .map((list) => list.id)
    .concat(Object.entries(listPatch).filter(([, patch]) => patch.folderId === id).map(([listId]) => listId))
  const docFolders = Object.values(state.documentFolders ?? {})
  const drop = new Set<string>()
  const hide = new Set<string>()
  for (const folder of legacy) {
    const lists = [...new Set(listsIn(folder.id))]
    const inUse = folder.documents.length > 0 ||
      docFolders.includes(folder.id) ||
      folders.some((child) => child.parentId === folder.id) ||
      lists.some((id) => !listPatch[id]?.trashedAt)
    if (inUse) continue
    if (lists.length) hide.add(folder.id)
    else drop.add(folder.id)
  }
  if (!drop.size && !hide.size) return state
  const next = { ...state, userFolders: folders.filter((folder) => !drop.has(folder.id)) }
  if (hide.size) next.folderPatch = { ...patches, ...Object.fromEntries([...hide].map((id) => [id, { ...patches[id], trashedAt: 'purged' }])) }
  return next
}
