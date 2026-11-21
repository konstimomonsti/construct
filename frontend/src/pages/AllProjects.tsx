import { useMemo, useState } from 'react'
import { Button, toast } from '../components/ui'
import { Link } from 'react-router-dom'
import { Chips, EmptyState, PageFrame, PageHeader, RowMenu, Section, SortMenu, Summary, ToolButton } from '../components/Kit'
import { FolderGrid } from '../components/FolderCard'
import { Dock } from '../components/Dock'
import { SORT_LABEL, portfolioBudget, useModel, useStore, type FolderView, type SortKey } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'
import { moneyWhole, needsAttention, plural } from '../lib/format'

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
  title, subtitle, filter, emptyTitle, emptyText, emptyIcon, withOpenAll,
}: {
  title: string
  subtitle?: string
  crumb?: string
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
  const [view, setView] = useState<'all' | 'attention'>('all')

  const scoped = useMemo(() => all.filter((f) => !f.trashedAt && filter(f)), [all, filter])
  const flagged = scoped.filter((f) => needsAttention(f.total, f.cap))
  const folders = useMemo(
    () => sortFolders(view === 'attention' ? scoped.filter((f) => needsAttention(f.total, f.cap)) : scoped, sort),
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

  const budget = portfolioBudget(all)
  const listCount = scoped.reduce((x, f) => x + f.listMetas.length, 0)
  const newProject = () => openDialog({ kind: 'new-folder' })

  return (
    <PageFrame>
      <PageHeader
        title={title}
        subtitle={subtitle ?? (scoped.length ? `${plural(scoped.length, 'project', 'projects')} · ${plural(listCount, 'list', 'lists')}` : undefined)}
        aside={withOpenAll && scoped.length > 0 && openAllIds.length > 0 ? (
          <RowMenu label="More actions" items={[{ label: `Open all ${plural(openAllIds.length, 'list', 'lists')} in tabs`, icon: 'tab_group', onSelect: () => openLists(openAllIds) }]} />
        ) : undefined}
      />

      {withOpenAll && scoped.length > 0 && (
        <Summary
          label="Total across projects"
          amount={moneyWhole(budget.total)}
          total={budget.total}
          cap={budget.cap}
          capLabel="in project caps"
          statusWord={flagged.length && !needsAttention(budget.total, budget.cap) ? 'On track overall' : undefined}
          meta={
            flagged.length ? (
              <button type="button" onClick={() => setView('attention')} className="rounded font-medium text-slate-900 underline decoration-slate-500 underline-offset-4 hover:decoration-slate-800">
                {plural(flagged.length, 'project', 'projects')} near {flagged.length === 1 ? 'its' : 'their'} cap
              </button>
            ) : (
              'No project is near its cap'
            )
          }
          actions={
            <>
              <Button variant="primary" size="lg" icon="add" onClick={newProject}>New project</Button>
              <Button size="lg" icon="upload" onClick={() => openDialog({ kind: 'folder-target', action: 'import' })}>Upload files</Button>
            </>
          }
        />
      )}

      {scoped.length ? (
        <Section
          title="Projects"
          count={folders.length}
          tools={
            <>
              <SortMenu value={sort} options={SORT_LABEL} onChange={(k: SortKey) => setSort(k)} noun="projects" />
              <ToolButton icon={selectMode ? 'close' : 'checklist'} active={selectMode} aria-pressed={selectMode} onClick={() => (selectMode ? done() : setSelectMode(true))}>
                {selectMode ? 'Cancel' : 'Select'}
              </ToolButton>
            </>
          }
        >
          {(flagged.length > 0 || view === 'attention') && (
            <div className="mb-3 px-1">
              <Chips
                label="Filter projects"
                value={view}
                onChange={setView}
                options={[
                  { key: 'all', label: 'All' },
                  { key: 'attention', label: 'Needs attention', count: flagged.length },
                ]}
              />
            </div>
          )}
          {selectMode && (
            <div className="mb-2 flex justify-end px-1">
              <button type="button" className="h-10 rounded-full px-3 text-sm font-semibold text-brand-700 hover:bg-brand-50" onClick={() => setSel(sel.size === folders.length ? new Set() : new Set(folders.map((f) => f.id)))}>
                {sel.size === folders.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
          )}
          {folders.length ? (
            <FolderGrid folders={folders} selectMode={selectMode} selected={sel} onToggle={toggle} />
          ) : (
            <EmptyState icon="check_circle" title="Nothing needs attention" text="Every project is below 75% of its cap." />
          )}
        </Section>
      ) : (
        <EmptyState icon={emptyIcon} title={emptyTitle} text={emptyText}>
          {withOpenAll ? (
            <Button variant="primary" size="lg" icon="add" onClick={newProject}>New project</Button>
          ) : (
            <Link to="/" className="inline-flex h-10 items-center rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-900 hover:bg-slate-200">Go to All Projects</Link>
          )}
        </EmptyState>
      )}

      <Dock
        open={selectMode}
        count={sel.size}
        noun="project"
        moveItems={[
          {
            label: 'Move to Archive',
            icon: 'archive',
            onSelect: () => {
              sel.forEach((id) => useStore.getState().patchFolder(id, { archived: true }))
              toast(`Archived ${plural(sel.size, 'project', 'projects')}`)
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
          toast(`Moved ${plural(chosen.length, 'project', 'projects')} to Trash`, 'ok', {
            label: 'Undo',
            run: () => chosen.forEach((f) => useStore.getState().patchFolder(f.id, { trashedAt: undefined })),
          })
          done()
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
