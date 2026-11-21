import { useNavigate } from 'react-router-dom'
import type { MenuItem } from '../components/ui'
import { toast } from '../components/ui'
import type { FolderView, ListView } from './store'
import { useStore } from './store'
import { useUi } from './ui-store'
import { plural } from './format'

export function unitIcon(unit: string): string {
  const u = unit.trim().toLowerCase()
  if (u === 'psch' || u === 'pauschal') return 'construction'
  if (u === 'm') return 'straighten'
  if (u === 'm2' || u === 'm²') return 'square_foot'
  if (u === 'm3' || u === 'm³') return 'deployed_code'
  if (['st', 'stck', 'stk', 'stück'].includes(u)) return 'category'
  if (u === 'h' || u === 'std') return 'schedule'
  if (u === 't' || u === 'kg') return 'scale'
  if (['mt', 'wo', 'd'].includes(u)) return 'calendar_month'
  return 'description'
}

/** shared folder / list actions used by cards, rows and toolbars */
export function useActions() {
  const navigate = useNavigate()
  const openDialog = useUi((s) => s.openDialog)

  /** no Trash: deleting is permanent and shared with the whole team, so it always asks first */
  const deleteFolders = (fs: Pick<FolderView, 'id' | 'name'>[], after?: () => void) => {
    if (!fs.length) return
    const one = fs.length === 1
    openDialog({
      kind: 'confirm',
      title: one ? `Delete "${fs[0].name}"?` : `Delete ${plural(fs.length, 'project', 'projects')}?`,
      body: `${one ? 'The project and its lists' : 'These projects and their lists'} will be deleted for everyone in the workspace. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      run: () => {
        fs.forEach((f) => useStore.getState().purgeFolder(f.id))
        after?.()
        toast(one ? `Deleted "${fs[0].name}"` : `Deleted ${plural(fs.length, 'project', 'projects')}`)
      },
    })
  }

  const deleteLists = (ls: Pick<ListView, 'id' | 'title'>[], after?: () => void) => {
    if (!ls.length) return
    const one = ls.length === 1
    openDialog({
      kind: 'confirm',
      title: one ? `Delete "${ls[0].title}"?` : `Delete ${plural(ls.length, 'list', 'lists')}?`,
      body: `${one ? 'The list and its edits' : 'These lists and their edits'} will be deleted for everyone in the workspace. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      run: () => {
        ls.forEach((l) => {
          useStore.getState().patchList(l.id, { trashedAt: 'purged' })
          useStore.getState().closeTab(l.id)
        })
        after?.()
        toast(one ? `Deleted "${ls[0].title}"` : `Deleted ${plural(ls.length, 'list', 'lists')}`)
      },
    })
  }

  const openLists = (ids: string[]) => {
    if (!ids.length) {
      toast('No lists to open', 'info')
      return
    }
    useStore.getState().openTabs_(ids)
    navigate(`/list/${ids[0]}`)
  }

  const folderMenu = (f: FolderView): (MenuItem | 'sep')[] => [
    { label: 'Open', icon: 'folder_open', onSelect: () => navigate(`/folder/${f.id}`) },
    { label: 'Rename', icon: 'edit', onSelect: () => openDialog({ kind: 'rename-folder', id: f.id }) },
    { label: 'Move…', icon: 'drive_file_move', onSelect: () => openDialog({ kind: 'folder-target', action: 'move-folder', folderId: f.id }) },
    { label: 'Edit budget cap…', icon: 'savings', onSelect: () => openDialog({ kind: 'edit-cap', target: 'folder', id: f.id }) },
    {
      label: f.archived ? 'Restore from Archive' : 'Archive',
      icon: f.archived ? 'unarchive' : 'archive',
      onSelect: () => {
        const was = !!f.archived
        useStore.getState().patchFolder(f.id, { archived: !was })
        toast(was ? `Restored "${f.name}" from Archive` : `Archived "${f.name}"`, 'ok', {
          label: 'Undo',
          run: () => useStore.getState().patchFolder(f.id, { archived: was }),
        })
      },
    },
    'sep',
    { label: 'Delete…', icon: 'delete', danger: true, onSelect: () => deleteFolders([f]) },
  ]

  const listMenu = (l: ListView): (MenuItem | 'sep')[] => [
    { label: 'Open', icon: 'description', onSelect: () => navigate(`/list/${l.id}`) },
    { label: 'Open in new tab bar', icon: 'tab', onSelect: () => useStore.getState().openTab(l.id) },
    { label: 'Rename', icon: 'edit', onSelect: () => openDialog({ kind: 'rename-list', id: l.id }) },
    { label: 'Move…', icon: 'drive_file_move', onSelect: () => openDialog({ kind: 'folder-target', action: 'move-list', listId: l.id }) },
    { label: 'Edit budget cap…', icon: 'savings', onSelect: () => openDialog({ kind: 'edit-cap', target: 'list', id: l.id }) },
    'sep',
    { label: 'Delete…', icon: 'delete', danger: true, onSelect: () => deleteLists([l]) },
  ]

  return { navigate, deleteFolders, deleteLists, openLists, folderMenu, listMenu }
}
