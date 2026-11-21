import { Link, useParams } from 'react-router-dom'
import { Button, Icon } from '../components/ui'
import { EmptyFolder } from '../components/EmptyFolder'
import { DropOverlay, useDropImport } from '../components/DropImport'
import { ListGrid } from '../components/ListCard'
import { FolderGrid } from '../components/FolderCard'
import { EmptyState, PageFrame, PageHeader, RowMenu, Section, SortMenu, Summary } from '../components/Kit'
import { int, moneyWhole, needsAttention, plural } from '../lib/format'
import { pickAndImport } from '../lib/import'
import { folderDescription, folderPath, SORT_LABEL, useModel, useStore, type SortKey } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'

export function FolderPage() {
  const { folderId = '' } = useParams()
  const { folders } = useModel()
  const sort = useStore((s) => s.sort)
  const setSort = useStore((s) => s.setSort)
  const openDialog = useUi((s) => s.openDialog)
  const { openLists, folderMenu } = useActions()
  const f = folders.find((x) => x.id === folderId)
  const dragging = useDropImport(folderId, !!f && !f.trashedAt)
  const subfolders = folders.filter((item) => item.parentId === folderId && !item.trashedAt)
  const ancestors = folderPath(folders, folderId).slice(0, -1)
  const lists = [...(f?.listMetas ?? [])].sort((x, y) => {
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
          <Link to="/" className="inline-flex h-10 items-center rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-900 hover:bg-slate-200">Go to All Projects</Link>
        </EmptyState>
      </PageFrame>
    )
  }

  const empty = lists.length === 0 && subfolders.length === 0
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
  const flaggedLists = lists.filter((l) => needsAttention(l.total, l.cap)).length
  const menu = [
    ...(lists.length > 1 ? [{ label: `Open all ${lists.length} lists in tabs`, icon: 'tab_group', onSelect: () => openLists(lists.map((l) => l.id)) }] : []),
    { label: 'New folder inside', icon: 'create_new_folder', onSelect: () => openDialog({ kind: 'new-folder', parent: f.id }) },
    { label: 'Import CSV / JSON', icon: 'table_view', onSelect: () => pickAndImport(f.id, undefined, '.csv,.tsv,.json') },
    'sep' as const,
    ...folderMenu(f).filter((it) => it === 'sep' || it.label !== 'Open'),
  ]

  return (
    <PageFrame>
      {f.trashedAt && (
        <div role="status" className="mb-6 flex items-center justify-between gap-3 rounded-2xl bg-amber-50 px-5 py-3 text-sm text-amber-900">
          <span className="flex items-center gap-2"><Icon name="delete" size={18} />This {nested ? 'folder' : 'project'} is in the Trash.</span>
          <Button size="sm" variant="ghost" onClick={() => useStore.getState().patchFolder(f.id, { trashedAt: undefined })}>Restore</Button>
        </div>
      )}
      <PageHeader
        crumbs={crumbs}
        title={f.name}
        subtitle={folderDescription(f) || undefined}
        icon={f.icon}
        tone={f.tone}
        aside={<RowMenu items={menu} label={`More actions for ${f.name}`} />}
      />

      <Summary
        label={nested ? 'Folder total' : 'Project total'}
        amount={moneyWhole(f.total)}
        total={f.total}
        cap={f.cap}
        statusWord={flaggedLists && !needsAttention(f.total, f.cap) ? 'On track overall' : undefined}
        meta={
          f.positions || flaggedLists ? (
            <span className="num">
              {plural(f.positions, 'position', 'positions')}
              {toPrice > 0 ? <> · <strong className="font-semibold text-slate-900">{int(toPrice)}</strong> still to price</> : ', all priced'}
              {flaggedLists > 0 && <> · {plural(flaggedLists, 'list', 'lists')} near {flaggedLists === 1 ? 'its' : 'their'} cap</>}
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
        <Section title="Folders" count={subfolders.length}>
          <FolderGrid folders={subfolders} />
        </Section>
      )}

      {lists.length > 0 && (
        <Section
          title="Lists"
          count={lists.length}
          tools={
            <SortMenu value={sort} options={SORT_LABEL} onChange={(k: SortKey) => setSort(k)} noun="lists" />
          }
        >
          <ListGrid lists={lists} tone={f.tone} />
        </Section>
      )}

      <DropOverlay show={dragging} name={f.name} />
    </PageFrame>
  )
}

