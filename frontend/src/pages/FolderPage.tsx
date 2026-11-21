import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Icon } from '../components/ui'
import { Dock } from '../components/Dock'
import { EmptyFolder } from '../components/EmptyFolder'
import { DropOverlay, useDropImport } from '../components/DropImport'
import { ListGrid } from '../components/ListCard'
import { FolderGrid } from '../components/FolderCard'
import { EmptyState, PageFrame, PageHeader, PillLink, RowMenu, Section, SortMenu, Summary, ToolButton } from '../components/Kit'
import { int, money, plural } from '../lib/format'
import { pickAndImport, type ImportResult } from '../lib/import'
import { folderDescription, folderPath, SORT_LABEL, useModel, useStore, type SortKey } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'

export function FolderPage() {
  const { folderId = '' } = useParams()
  const navigate = useNavigate()
  const { folders } = useModel()
  const sort = useStore((s) => s.sort)
  const setSort = useStore((s) => s.setSort)
  const openDialog = useUi((s) => s.openDialog)
  const { openLists, folderMenu, deleteLists } = useActions()
  const [selectMode, setSelectMode] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const f = folders.find((x) => x.id === folderId)
  const afterImport = useCallback((result: ImportResult) => {
    if (!result.openListId || window.location.pathname !== `/folder/${folderId}`) return
    useStore.getState().openTab(result.openListId)
    navigate(`/list/${result.openListId}`)
  }, [folderId, navigate])
  const dragging = useDropImport(folderId, !!f && !f.trashedAt, afterImport)
  const importFromPicker = () => pickAndImport(folderId, afterImport)
  const subfolders = folders.filter((item) => item.parentId === folderId && !item.trashedAt)
  const ancestors = folderPath(folders, folderId).slice(0, -1)
  const allLists = f?.listMetas ?? []
  const lists = [...allLists].sort((x, y) => {
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
        <EmptyFolder folder={f} ancestors={ancestors} dragging={dragging} onImport={importFromPicker} />
        <DropOverlay show={dragging} name={f.name} />
      </>
    )
  }

  const crumbs = [{ label: 'All Projects', to: '/' }, ...ancestors.map((x) => ({ label: x.name, to: `/folder/${x.id}` }))]
  const nested = ancestors.length > 0
  const toPrice = f.positions - f.priced
  const partial = f.positions > 0 && toPrice > 0
  const coverage = partial ? `${int(f.priced)} of ${plural(f.positions, 'position', 'positions')} priced` : undefined
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
        <div role="status" className="mb-6 flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-5 py-3 text-sm text-amber-900">
          <span className="flex items-center gap-2"><Icon name="delete" size={18} />This {nested ? 'sub-project' : 'project'} was deleted.</span>
          <Button size="sm" variant="ghost" onClick={() => useStore.getState().patchFolder(f.id, { trashedAt: undefined })}>Restore</Button>
        </div>
      )}
      <PageHeader
        crumbs={crumbs}
        wrap
        title={f.name}
        subtitle={[folderDescription(f), f.positions ? plural(f.positions, 'position', 'positions') : ''].filter(Boolean).join(' · ') || undefined}
        aside={
          <div className="flex items-center gap-2">
            <Button variant="primary" icon="upload" onClick={importFromPicker} aria-label="Import files" className="max-sm:w-10 max-sm:px-0">
              <span className="max-sm:hidden">Import files</span>
            </Button>
            <Button icon="add" onClick={() => openDialog({ kind: 'blank-list', folderId: f.id })} aria-label="New list" className="max-sm:w-10 max-sm:px-0"><span className="max-sm:hidden">New list</span></Button>
            <RowMenu items={menu} label={`More actions for ${f.name}`} />
          </div>
        }
      />

      <Summary
        // with prices missing, the figure is only what is confirmed so far
        label={partial ? 'Confirmed total' : nested ? 'Sub-project total' : 'Project total'}
        amount={money(f.total)}
        sub={coverage}
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
          tools={
            <>
              {allLists.length > 3 && <SortMenu value={sort} options={SORT_LABEL} onChange={(k: SortKey) => setSort(k)} noun="lists" />}
              <ToolButton icon={selectMode ? 'close' : 'checklist'} active={selectMode} aria-pressed={selectMode} onClick={() => (selectMode ? done() : setSelectMode(true))}>
                {selectMode ? 'Cancel' : 'Select'}
              </ToolButton>
            </>
          }
        >
          <ListGrid lists={lists} tone={f.tone} selectMode={selectMode} selected={sel} onToggle={toggle} />
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
          deleteLists(allLists.filter((l) => sel.has(l.id)), done)
        }}
        onDone={done}
      />

      <DropOverlay show={dragging} name={f.name} />
    </PageFrame>
  )
}

