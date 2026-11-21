import { useMemo, useState, type ReactNode } from 'react'
import { Button, toast } from '../components/ui'
import { Chips, EmptyState, PageFrame, PageHeader, PaletteKey, PillLink, RowMenu, Section, SortMenu, ToolButton } from '../components/Kit'
import { FolderGrid } from '../components/FolderCard'
import { Dock } from '../components/Dock'
import { ProjectCrane } from '../components/project/ProjectCrane'
import { SORT_LABEL, useModel, useStore, type FolderView, type SortKey } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'
import { plural } from '../lib/format'

type View = 'all' | 'unpriced'
/** read from confirmed position counts: a saved zero price is still a price, and a project without positions isn't unpriced */
const isUnpriced = (f: FolderView) => f.positions > 0 && f.priced === 0
const VIEWS: Record<View, (f: FolderView) => boolean> = {
  all: () => true,
  unpriced: isUnpriced,
}

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
  title, subtitle, filter, emptyTitle, emptyText, emptyIcon, withOpenAll, archive,
}: {
  title: string
  subtitle?: ReactNode
  crumb?: string
  filter: (f: FolderView) => boolean
  emptyTitle: string
  emptyText: ReactNode
  emptyIcon: string
  withOpenAll?: boolean
  /** this collection is the Archive, so the dock restores instead of archiving */
  archive?: boolean
}) {
  const { folders: all } = useModel()
  const sort = useStore((s) => s.sort)
  const setSort = useStore((s) => s.setSort)
  const openDialog = useUi((s) => s.openDialog)
  const { openLists, deleteFolders } = useActions()
  const [selectMode, setSelectMode] = useState(false)
  const [introDismissed, setIntroDismissed] = useState(() => localStorage.getItem('billbuild:intro-dismissed') === '1')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View>('all')

  const scoped = useMemo(() => all.filter((f) => !f.trashedAt && filter(f)), [all, filter])
  const unpriced = scoped.filter(isUnpriced)
  const folders = useMemo(
    () => sortFolders(scoped.filter(VIEWS[view]), sort),
    [scoped, sort, view],
  )
  const listsOf = (ids: Iterable<string>) => {
    const set = new Set(ids)
    return folders.filter((f) => set.has(f.id)).flatMap((f) => f.listMetas.map((l) => l.id))
  }
  const openAllIds = useMemo(() => all.filter((f) => !f.archived && !f.trashedAt).flatMap((f) => f.listMetas.map((l) => l.id)), [all])

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

  const listCount = scoped.reduce((x, f) => x + f.listMetas.length, 0)
  const newProject = () => openDialog({ kind: 'new-folder' })
  const showFilters = view !== 'all'
    || (scoped.length > 3 && unpriced.length > 0)

  return (
    <PageFrame>
      <PageHeader
        title={title}
        subtitle={scoped.length ? subtitle ?? (withOpenAll ? undefined : `${plural(scoped.length, 'project', 'projects')} · ${plural(listCount, 'list', 'lists')}`) : undefined}
        aside={withOpenAll && scoped.length > 0 ? (
          <div className="flex items-center gap-2">
            <Button variant="primary" icon="upload" onClick={() => openDialog({ kind: 'folder-target', action: 'import' })} aria-label="Import files" className="max-sm:w-10 max-sm:px-0">
              <span className="max-sm:hidden">Import files</span>
            </Button>
            <Button icon="add" onClick={newProject} aria-label="New project" className="max-sm:w-10 max-sm:px-0"><span className="max-sm:hidden">New project</span></Button>
            {openAllIds.length > 0 && <RowMenu label="More actions" items={[{ label: `Open all ${plural(openAllIds.length, 'list', 'lists')} in tabs`, icon: 'tab_group', onSelect: () => openLists(openAllIds) }]} />}
          </div>
        ) : undefined}
      />

      {withOpenAll && !introDismissed && <div className="mb-6 max-w-2xl rounded-lg bg-brand-50 p-5 text-sm text-slate-800">
        <button type="button" className="float-right text-xs text-slate-600 underline" onClick={() => { localStorage.setItem('billbuild:intro-dismissed', '1'); setIntroDismissed(true) }}>Dismiss</button>
        <h2 className="text-lg font-semibold text-slate-900">Check a tender before you price it</h2>
        <p className="mt-1">Upload a tender (GAEB, PDF, Excel). BillBuild checks it for errors, missing work and change-order risk before you price it.</p>
        <Button className="mt-4" variant="primary" icon="upload" onClick={() => scoped.length ? openDialog({ kind: 'folder-target', action: 'import' }) : newProject()}>
          Import a tender
        </Button>
        {!scoped.length && <p className="mt-2 text-xs text-slate-600">Create a project first, then add the tender to it.</p>}
      </div>}

      {withOpenAll && scoped.length > 0 && <ProjectCrane />}

      {scoped.length ? (
        <Section
          title="Projects"
          count={withOpenAll ? undefined : folders.length}
          filters={showFilters && (
            <Chips
              label="Filter projects"
              value={view}
              onChange={setView}
              options={[
                { key: 'all', label: 'All' },
                ...(unpriced.length ? [{ key: 'unpriced' as const, label: 'Not priced', count: unpriced.length }] : []),
              ]}
            />
          )}
          tools={
            <>
              {scoped.length > 3 && <SortMenu value={sort} options={SORT_LABEL} onChange={(k: SortKey) => setSort(k)} noun="projects" />}
              <ToolButton icon={selectMode ? 'close' : 'checklist'} active={selectMode} aria-pressed={selectMode} onClick={() => (selectMode ? done() : setSelectMode(true))}>
                {selectMode ? 'Cancel' : 'Select'}
              </ToolButton>
            </>
          }
        >
          <p className="sr-only" aria-live="polite">
            {view === 'all' ? '' : `Showing ${plural(folders.length, 'project', 'projects')} not priced`}
          </p>
          {selectMode && (
            <div className="mb-2 flex justify-end">
              <button type="button" className="h-10 rounded-md px-3 text-sm font-semibold text-brand-700 hover:bg-brand-50" onClick={() => setSel(sel.size === folders.length ? new Set() : new Set(folders.map((f) => f.id)))}>
                {sel.size === folders.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
          )}
          {folders.length ? (
            <FolderGrid folders={folders} selectMode={selectMode} selected={sel} onToggle={toggle} />
          ) : (
            <EmptyState compact icon="check_circle" title="Every project is priced" />
          )}
        </Section>
      ) : (
        <EmptyState icon={emptyIcon} title={emptyTitle} text={emptyText} hint={withOpenAll ? undefined : <span className="inline-flex flex-wrap items-center justify-center gap-1.5">or press <PaletteKey /> to jump to a project</span>}>
          {withOpenAll ? (
            <Button variant="primary" size="lg" icon="add" onClick={newProject}>New project</Button>
          ) : (
            <PillLink to="/" icon="arrow_back">Go to All Projects</PillLink>
          )}
        </EmptyState>
      )}

      <Dock
        open={selectMode}
        count={sel.size}
        noun="project"
        moveItems={[
          {
            label: archive ? 'Restore from Archive' : 'Move to Archive',
            icon: archive ? 'unarchive' : 'archive',
            onSelect: () => {
              const ids = [...sel]
              const set = (archived: boolean) => ids.forEach((id) => useStore.getState().patchFolder(id, { archived }))
              set(!archive)
              toast(`${archive ? 'Restored' : 'Archived'} ${plural(ids.length, 'project', 'projects')}`, 'ok', { label: 'Undo', run: () => set(!!archive) })
              done()
            },
          },
        ]}
        onOpen={() => {
          openLists(listsOf(sel))
          done()
        }}
        onDelete={() => {
          deleteFolders(folders.filter((f) => sel.has(f.id)), done)
        }}
        onDone={done}
      />
    </PageFrame>
  )
}

const notArchived = (f: FolderView) => !f.archived && !f.parentId
export function AllProjects() {
  return (
    <FolderCollection
      title="All Projects"
      crumb="All Projects"
      filter={notArchived}
      withOpenAll
      emptyIcon="folder_off"
      emptyTitle="No projects yet"
      emptyText="Create a project, then upload GAEB, CSV or PDF lists into it."
    />
  )
}
