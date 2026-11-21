import { useNavigate } from 'react-router-dom'
import type { MenuItem } from '../components/ui'
import { toast } from '../components/ui'
import type { FolderView, ListView } from './store'
import { useStore } from './store'
import { useUi } from './ui-store'

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

  const trashFolder = (f: Pick<FolderView, 'id' | 'name'>, goHome = false) => {
    useStore.getState().patchFolder(f.id, { trashedAt: new Date().toISOString() })
    if (goHome) navigate('/')
    toast(`Moved "${f.name}" to Trash`, 'ok', {
      label: 'Undo',
      run: () => useStore.getState().patchFolder(f.id, { trashedAt: undefined }),
    })
  }

  const trashList = (l: Pick<ListView, 'id' | 'title'>) => {
    useStore.getState().patchList(l.id, { trashedAt: new Date().toISOString() })
    toast(`Moved "${l.title}" to Trash`, 'ok', {
      label: 'Undo',
      run: () => useStore.getState().patchList(l.id, { trashedAt: undefined }),
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
    { label: 'Move to Trash', icon: 'delete', danger: true, onSelect: () => trashFolder(f) },
  ]

  const listMenu = (l: ListView): (MenuItem | 'sep')[] => [
    { label: 'Open', icon: 'description', onSelect: () => navigate(`/list/${l.id}`) },
    { label: 'Open in new tab bar', icon: 'tab', onSelect: () => useStore.getState().openTab(l.id) },
    { label: 'Rename', icon: 'edit', onSelect: () => openDialog({ kind: 'rename-list', id: l.id }) },
    { label: 'Move…', icon: 'drive_file_move', onSelect: () => openDialog({ kind: 'folder-target', action: 'move-list', listId: l.id }) },
    { label: 'Edit budget cap…', icon: 'savings', onSelect: () => openDialog({ kind: 'edit-cap', target: 'list', id: l.id }) },
    'sep',
    { label: 'Move to Trash', icon: 'delete', danger: true, onSelect: () => trashList(l) },
  ]

  return { navigate, trashFolder, trashList, openLists, folderMenu, listMenu }
}
