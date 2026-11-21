import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Icon, toast } from '../components/ui'
import { Dock } from '../components/Dock'
import { EmptyFolder } from '../components/EmptyFolder'
import { DropOverlay, useDropImport } from '../components/DropImport'
import { ListGrid } from '../components/ListCard'
import { FolderGrid } from '../components/FolderCard'
import { Chips, EmptyState, PageFrame, PageHeader, PillLink, RowMenu, Section, SortMenu, Summary, ToolButton, heroStatus } from '../components/Kit'
import { budgetStatus, int, money, moneyWhole, needsAttention, plural } from '../lib/format'
import { pickAndImport } from '../lib/import'
import { counts, folderDescription, folderPath, SORT_LABEL, useModel, useStore, type SortKey } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'

export function FolderPage() {
  const { folderId = '' } = useParams()
  const { folders } = useModel()
  const sort = useStore((s) => s.sort)
  const setSort = useStore((s) => s.setSort)
  const openDialog = useUi((s) => s.openDialog)
  const { openLists, folderMenu } = useActions()
  const [view, setView] = useState<'all' | 'attention'>('all')
  const [selectMode, setSelectMode] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const f = folders.find((x) => x.id === folderId)
  const dragging = useDropImport(folderId, !!f && !f.trashedAt)
  const subfolders = folders.filter((item) => item.parentId === folderId && !item.trashedAt)
  const ancestors = folderPath(folders, folderId).slice(0, -1)
  const allLists = f?.listMetas ?? []
  const lists = allLists.filter((l) => view === 'all' || needsAttention(l.total, l.cap)).sort((x, y) => {
    switch (sort) {
      case 'cost-desc': return y.total - x.total
      case 'cost-asc': return x.total - y.total
      case 'name': return x.title.localeCompare(y.title, 'de')
      case 'items': return y.positionsCount - x.positionsCount
    }
  })

  if (!f) {
    return (
      <PageFrame>
        <EmptyState icon="folder_off" title="Project not found" text="It may have been deleted permanently.">
          <PillLink to="/" icon="arrow_back">Go to All Projects</PillLink>
        </EmptyState>
      </PageFrame>
    )
  }

  const empty = allLists.length === 0 && subfolders.length === 0
  if (empty && !f.trashedAt) {
    return (
      <>
        <EmptyFolder folder={f} ancestors={ancestors} dragging={dragging} />
        <DropOverlay show={dragging} name={f.name} />
      </>
    )
  }

  const crumbs = [{ label: 'All Projects', to: '/' }, ...ancestors.map((x) => ({ label: x.name, to: `/folder/${x.id}` }))]
  const nested = ancestors.length > 0
  const toPrice = f.positions - f.priced
  const flaggedLists = allLists.filter((l) => needsAttention(l.total, l.cap)).length
  const counted = allLists.filter((l) => counts(l) && l.total > 0)
  const status = heroStatus(f, counted.map((l) => ({ tone: budgetStatus(l.total, l.cap).tone })), ['list', 'lists'])
  // list caps are set independently; say when they promise more than the project cap allows
  const listCaps = allLists.filter(counts).reduce((x, l) => x + (l.cap || 0), 0)
  const capNote = f.cap > 0 && listCaps > f.cap ? `List caps add up to ${moneyWhole(listCaps)}, ${moneyWhole(listCaps - f.cap)} over the project cap.` : undefined
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
  const menu = [
    ...(allLists.length > 1 ? [{ label: `Open all ${allLists.length} lists in tabs`, icon: 'tab_group', onSelect: () => openLists(allLists.map((l) => l.id)) }] : []),
    { label: 'New sub-project', icon: 'create_new_folder', onSelect: () => openDialog({ kind: 'new-folder', parent: f.id }) },
    'sep' as const,
    ...folderMenu(f).filter((it) => it === 'sep' || it.label !== 'Open'),
  ]

  return (
    <PageFrame>
      {f.trashedAt && (
        <div role="status" className="mb-6 flex items-center justify-between gap-3 rounded-2xl bg-amber-50 px-5 py-3 text-sm text-amber-900">
          <span className="flex items-center gap-2"><Icon name="delete" size={18} />This {nested ? 'sub-project' : 'project'} is in the Trash.</span>
          <Button size="sm" variant="ghost" onClick={() => useStore.getState().patchFolder(f.id, { trashedAt: undefined })}>Restore</Button>
        </div>
      )}
      <PageHeader
        crumbs={crumbs}
        title={f.name}
        subtitle={folderDescription(f) || undefined}
        aside={<RowMenu items={menu} label={`More actions for ${f.name}`} />}
      />

      <Summary
        label={nested ? 'Sub-project total' : 'Project total'}
        amount={money(f.total)}
        total={f.total}
        cap={f.cap}
        status={status}
        note={capNote}
        onEditCap={() => openDialog({ kind: 'edit-cap', target: 'folder', id: f.id })}
        meta={
          f.positions ? (
            <span className="num">
              {plural(f.positions, 'position', 'positions')}
              {toPrice > 0 && <> · <strong className="font-semibold text-slate-900">{int(toPrice)}</strong> still to price</>}
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button variant="primary" size="lg" icon="upload" onClick={() => pickAndImport(f.id)}>Import files</Button>
            <Button size="lg" icon="add" onClick={() => openDialog({ kind: 'blank-list', folderId: f.id })}>New list</Button>
          </>
        }
      />

      {subfolders.length > 0 && (
        <Section title="Sub-projects" count={subfolders.length}>
          <FolderGrid folders={subfolders} />
        </Section>
      )}

      {allLists.length > 0 && (
        <Section
          title="Lists"
          count={lists.length}
          focusable
          tools={
            <>
              {allLists.length > 3 && <SortMenu value={sort} options={SORT_LABEL} onChange={(k: SortKey) => setSort(k)} noun="lists" />}
              <ToolButton icon={selectMode ? 'close' : 'checklist'} active={selectMode} aria-pressed={selectMode} onClick={() => (selectMode ? done() : setSelectMode(true))}>
                {selectMode ? 'Cancel' : 'Select'}
              </ToolButton>
            </>
          }
        >
          {((allLists.length > 3 && flaggedLists > 0) || view !== 'all') && (
            <div className="mb-3">
              <Chips
                label="Filter lists"
                value={view}
                onChange={setView}
                options={[
                  { key: 'all', label: 'All' },
                  { key: 'attention', label: 'Needs attention', count: flaggedLists },
                ]}
              />
            </div>
          )}
          <p className="sr-only" aria-live="polite">{view === 'attention' ? `Showing ${plural(lists.length, 'list', 'lists')} near cap` : ''}</p>
          {lists.length ? (
            <ListGrid lists={lists} tone={f.tone} selectMode={selectMode} selected={sel} onToggle={toggle} />
          ) : (
            <EmptyState icon="check_circle" title="Nothing needs attention" text="Every list is below 75% of its cap." />
          )}
        </Section>
      )}

      <Dock
        open={selectMode}
        count={sel.size}
        noun="list"
        onOpen={() => {
          openLists([...sel])
          done()
        }}
        onDelete={() => {
          const ids = [...sel]
          ids.forEach((id) => useStore.getState().patchList(id, { trashedAt: new Date().toISOString() }))
          toast(`Moved ${plural(ids.length, 'list', 'lists')} to Trash`, 'ok', {
            label: 'Undo',
            run: () => ids.forEach((id) => useStore.getState().patchList(id, { trashedAt: undefined })),
          })
          done()
        }}
        onDone={done}
      />

      <DropOverlay show={dragging} name={f.name} />
    </PageFrame>
  )
}

