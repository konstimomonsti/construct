import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Icon, Menu, toast } from '../components/ui'
import { Page, EmptyNote } from '../components/Page'
import { FolderGrid } from '../components/FolderCard'
import { Dock } from '../components/Dock'
import { SORT_LABEL, useModel, useStore, type FolderView, type SortKey } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'
import { plural } from '../lib/format'

export function sortFolders(folders: FolderView[], sort: SortKey): FolderView[] {
  const a = [...folders]
  switch (sort) {
    case 'cost-desc': return a.sort((x, y) => y.total - x.total || y.positions - x.positions)
    case 'cost-asc': return a.sort((x, y) => x.total - y.total)
    case 'name': return a.sort((x, y) => x.name.localeCompare(y.name, 'de'))
    case 'items': return a.sort((x, y) => y.positions - x.positions)
  }
}

export function FolderCollection({
  title, filter, crumb, emptyTitle, emptyText, emptyIcon, withOpenAll,
}: {
  title: string
  crumb: string
  filter: (f: FolderView) => boolean
  emptyTitle: string
  emptyText: string
  emptyIcon: string
  withOpenAll?: boolean
}) {
  const { folders: all } = useModel()
  const sort = useStore((s) => s.sort)
  const setSort = useStore((s) => s.setSort)
  const openDialog = useUi((s) => s.openDialog)
  const { openLists } = useActions()
  const [selectMode, setSelectMode] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const folders = useMemo(() => sortFolders(all.filter((f) => !f.trashedAt && filter(f)), sort), [all, sort, filter])
  const listsOf = (ids: Iterable<string>) => {
    const set = new Set(ids)
    return folders.filter((f) => set.has(f.id)).flatMap((f) => f.listMetas.map((l) => l.id))
  }
  const openAllIds = useMemo(() => folders.filter((f) => !f.archived).flatMap((f) => f.listMetas.map((l) => l.id)), [folders])

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const done = () => {
    setSelectMode(false)
    setSel(new Set())
  }

  return (
    <Page className="mx-auto w-full max-w-7xl px-4 pt-6 pb-28 sm:px-6">
      <div className="flex flex-col justify-between gap-3 pb-4 lg:flex-row lg:items-center">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="mb-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-slate-500">
            <Link to="/" className="transition-colors hover:text-slate-900">Home</Link>
            <Icon name="chevron_right" size={12} />
            <Link to="/" className="transition-colors hover:text-slate-900">Workspace</Link>
            <Icon name="chevron_right" size={12} />
            <span className="truncate font-medium text-slate-900">{crumb}</span>
          </nav>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
            <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              {plural(folders.length, 'Folder', 'Folders')}
            </span>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <Button size="lg" icon="create_new_folder" iconClass="text-brand-600" onClick={() => openDialog({ kind: 'new-folder' })}>
            New Folder
          </Button>
          {withOpenAll && (
            <Button variant="primary" size="lg" icon="tab_group" onClick={() => openLists(openAllIds)} disabled={!openAllIds.length}>
              Open All
              <span className="ml-1 rounded bg-white/20 px-1.5 text-[11px] font-normal">{openAllIds.length}</span>
            </Button>
          )}
          <div className="mx-1 h-4 w-px bg-slate-200" />
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Icon name="sort" size={18} />
            <Menu
              label="Sort folders"
              width="w-48"
              items={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ label: SORT_LABEL[k], checked: sort === k, onSelect: () => setSort(k) }))}
              trigger={(p) => (
                <button {...p} type="button" className="flex items-center gap-1 font-medium text-slate-900 transition-colors hover:text-brand-600">
                  <span>{SORT_LABEL[sort]}</span>
                  <Icon name="expand_more" size={15} />
                </button>
              )}
            />
          </div>
          <div className="mx-1 h-4 w-px bg-slate-200" />
          <button
            type="button"
            aria-pressed={selectMode}
            onClick={() => (selectMode ? done() : setSelectMode(true))}
            className={
              selectMode
                ? 'flex h-7 items-center gap-1.5 rounded-md border border-brand-600/30 bg-brand-50 px-2.5 text-xs font-semibold text-brand-700 transition-all hover:bg-brand-100'
                : 'flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 text-xs font-medium text-slate-500 transition-all hover:bg-white hover:text-slate-900'
            }
          >
            <Icon name={selectMode ? 'check' : 'checklist'} size={15} />
            {selectMode ? (sel.size ? `${sel.size} Selected` : 'Done') : 'Select'}
          </button>
          {selectMode && (
            <button
              type="button"
              className="text-xs font-medium text-brand-600 hover:underline"
              onClick={() => setSel(sel.size === folders.length ? new Set() : new Set(folders.map((f) => f.id)))}
            >
              {sel.size === folders.length ? 'Deselect All' : 'Select All'}
            </button>
          )}
        </div>
      </div>

      {folders.length ? (
        <FolderGrid folders={folders} selectMode={selectMode} selected={sel} onToggle={toggle} />
      ) : (
        <EmptyNote icon={emptyIcon} title={emptyTitle} text={emptyText} />
      )}

      <Dock
        open={selectMode}
        count={sel.size}
        noun="folder"
        moveItems={[
          {
            label: 'Move to Archive',
            icon: 'archive',
            onSelect: () => {
              sel.forEach((id) => useStore.getState().patchFolder(id, { archived: true }))
              toast(`Archived ${plural(sel.size, 'folder', 'folders')}`)
              done()
            },
          },
          {
            label: 'Share with Team',
            icon: 'group_add',
            onSelect: () => {
              sel.forEach((id) => useStore.getState().patchFolder(id, { shared: true }))
              toast(`Shared ${plural(sel.size, 'folder', 'folders')} with team`)
              done()
            },
          },
        ]}
        onOpen={() => {
          openLists(listsOf(sel))
          done()
        }}
        onDelete={() => {
          const chosen = folders.filter((f) => sel.has(f.id))
          chosen.forEach((f) => useStore.getState().patchFolder(f.id, { trashedAt: new Date().toISOString() }))
          toast(`Moved ${plural(chosen.length, 'folder', 'folders')} to Trash`, 'ok', {
            label: 'Undo',
            run: () => chosen.forEach((f) => useStore.getState().patchFolder(f.id, { trashedAt: undefined })),
          })
          done()
        }}
        onDone={done}
      />
    </Page>
  )
}

const notArchived = (f: FolderView) => !f.archived
export function AllProjects() {
  return (
    <FolderCollection
      title="All Projects"
      crumb="All Projects"
      filter={notArchived}
      withOpenAll
      emptyIcon="folder_off"
      emptyTitle="No folders yet"
      emptyText="Create a folder to start organising your item lists."
    />
  )
}
