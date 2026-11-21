import { Link, useParams } from 'react-router-dom'
import { Button, Icon } from '../components/ui'
import { EmptyFolder } from '../components/EmptyFolder'
import { DropOverlay, useDropImport } from '../components/DropImport'
import { ListGrid } from '../components/ListCard'
import { FolderGrid } from '../components/FolderCard'
import { EmptyState, PageFrame, PageHeader, Row, RowList, RowMenu, Section, SortMenu, Summary } from '../components/Kit'
import { int, moneyWhole, needsAttention, plural } from '../lib/format'
import { docUrl } from '../lib/data'
import { pickAndImport } from '../lib/import'
import { folderDescription, folderPath, SORT_LABEL, useModel, useStore, type ListView, type SortKey } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'
import type { DocMeta } from '../lib/types'

export function FolderPage() {
  const { folderId = '' } = useParams()
  const { folders, lists: allLists } = useModel()
  const sort = useStore((s) => s.sort)
  const setSort = useStore((s) => s.setSort)
  const openDialog = useUi((s) => s.openDialog)
  const { openLists, folderMenu } = useActions()
  const f = folders.find((x) => x.id === folderId)
  const dragging = useDropImport(folderId, !!f && !f.trashedAt)
  const docs = (f?.documents ?? []).filter((d) => !d.original)
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

  const empty = lists.length === 0 && (f.documents ?? []).length === 0 && subfolders.length === 0
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
  const listCaps = lists.reduce((x, l) => x + (l.cap || 0), 0)
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
        onSetCap={() => openDialog({ kind: 'cap', target: 'folder', id: f.id })}
        statusWord={flaggedLists && !needsAttention(f.total, f.cap) ? 'On track overall' : undefined}
        meta={
          f.positions || flaggedLists ? (
            <span className="num">
              {plural(f.positions, 'position', 'positions')}
              {toPrice > 0 ? <> · <strong className="font-semibold text-slate-900">{int(toPrice)}</strong> still to price</> : ', all priced'}
              {flaggedLists > 0 && <> · {plural(flaggedLists, 'list', 'lists')} near {flaggedLists === 1 ? 'its' : 'their'} cap</>}
              {f.cap > 0 && listCaps > f.cap && (
                <span className="mt-1.5 flex items-center gap-1.5 font-medium text-amber-800">
                  <Icon name="error" size={16} fill />List caps add up to {moneyWhole(listCaps)}, more than the {nested ? 'folder' : 'project'} cap
                </span>
              )}
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button variant="primary" size="lg" icon="upload" onClick={() => pickAndImport(f.id)}>Upload files</Button>
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

      {docs.length > 0 && (
        <Section title="Documents" count={docs.length}>
          <RowList>
            {docs.map((d) => (
              <DocRow key={d.id} doc={d} list={allLists.find((item) => item.id === d.listId)} />
            ))}
          </RowList>
        </Section>
      )}
      <DropOverlay show={dragging} name={f.name} />
    </PageFrame>
  )
}

function DocRow({ doc, list }: { doc: DocMeta; list?: ListView }) {
  const openDialog = useUi((s) => s.openDialog)
  const open = () => openDialog({ kind: 'doc', doc })
  const url = docUrl(doc)
  const pdf = /\.pdf$/i.test(doc.name)
  const actions = [
    { label: 'Open document', icon: 'visibility', onSelect: open },
    ...(url && pdf ? [{ label: 'Open in new tab', icon: 'open_in_new', onSelect: () => window.open(url, '_blank', 'noopener') }] : []),
    { label: 'Move to…', icon: 'drive_file_move', onSelect: () => openDialog({ kind: 'folder-target', action: 'move-document', docId: doc.id }) },
    ...(!doc.original ? [{ label: 'Change linked list…', icon: 'link', onSelect: () => openDialog({ kind: 'link-document', doc }) }] : []),
  ]
  const kind = pdf ? 'PDF' : (doc.name.split('.').pop() ?? 'File').toUpperCase()
  return (
    <Row
      dataRow="doc"
      onOpen={open}
      label={`Open ${doc.name}`}
      icon={pdf ? 'description' : 'draft'}
      tone="slate"
      title={doc.name}
      subtitle={[kind, doc.pages ? plural(doc.pages, 'page', 'pages') : null].filter(Boolean).join(' · ')}
      meta={list ? <span className="text-sm text-slate-600">Linked to <span className="font-medium text-slate-800">{list.title}</span></span> : <span className="text-sm text-slate-600">Not linked</span>}
      menu={<RowMenu label={`Options for ${doc.name}`} items={actions} />}
    />
  )
}
