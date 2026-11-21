import { Link, useParams } from 'react-router-dom'
import { Button, Icon, Menu, Meter } from '../components/ui'
import { EmptyNote, Page } from '../components/Page'
import { EmptyFolder } from '../components/EmptyFolder'
import { DropOverlay, useDropImport } from '../components/DropImport'
import { ListGrid } from '../components/ListCard'
import { FolderGrid, MoreMenu, toneTile } from '../components/FolderCard'
import { money, plural, usageTone } from '../lib/format'
import { pickAndImport } from '../lib/import'
import { folderPath, SORT_LABEL, useModel, useStore, type SortKey } from '../lib/store'
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
      <Page className="mx-auto w-full max-w-7xl px-4 pt-8 sm:px-6">
        <EmptyNote icon="folder_off" title="Folder not found" text="It may have been deleted permanently." />
        <div className="mt-4 text-center"><Link to="/" className="text-xs font-semibold text-brand-600 hover:underline">Back to All Projects</Link></div>
      </Page>
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

  const pct = f.cap ? (f.total / f.cap) * 100 : 0
  const tone = f.total === 0 ? 'ok' : usageTone(pct)

  return (
    <Page className="mx-auto w-full max-w-7xl px-4 pt-5 pb-16 sm:px-6">
      {f.trashedAt && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
          <span className="flex items-center gap-2"><Icon name="delete" size={16} />This folder is in the Trash.</span>
          <button type="button" className="font-semibold hover:underline" onClick={() => useStore.getState().patchFolder(f.id, { trashedAt: undefined })}>Restore</button>
        </div>
      )}
      <div className="flex flex-col justify-between gap-3 pb-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
            <Link to="/" className="transition-colors hover:text-slate-900">Home</Link>
            <Icon name="chevron_right" size={12} />
            <Link to="/" className="transition-colors hover:text-slate-900">Workspace</Link>
            <Icon name="chevron_right" size={12} />
            {ancestors.map((folder) => (
              <span key={folder.id} className="flex min-w-0 items-center gap-1.5">
                <Link to={`/folder/${folder.id}`} className="truncate hover:text-brand-600">{folder.name}</Link>
                <Icon name="chevron_right" size={12} />
              </span>
            ))}
            <span className="truncate font-medium text-slate-900">{f.name}</span>
          </nav>
          <div className="flex items-center gap-3">
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${toneTile[f.tone] ?? toneTile.slate}`}><Icon name={f.icon} size={20} /></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-bold tracking-tight text-slate-900">{f.name}</h1>
                <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{plural(lists.length, 'List', 'Lists')}</span>
              </div>
              <p className="truncate text-xs text-slate-500">{f.description}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" icon="file_upload" iconClass="text-brand-600" onClick={() => pickAndImport(f.id)}>Import</Button>
          <Button size="lg" icon="create_new_folder" onClick={() => openDialog({ kind: 'new-folder', parent: f.id })}>New subfolder</Button>
          <Button size="lg" icon="add_box" iconClass="text-amber-500" onClick={() => openDialog({ kind: 'blank-list', folderId: f.id })}>New List</Button>
          <Button variant="primary" size="lg" icon="tab_group" disabled={!lists.length} onClick={() => openLists(lists.map((l) => l.id))}>
            Open All<span className="ml-1 rounded bg-white/20 px-1.5 text-[11px] font-normal">{lists.length}</span>
          </Button>
          <Menu
            label="Sort lists"
            width="w-48"
            items={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ label: SORT_LABEL[k], checked: sort === k, onSelect: () => setSort(k) }))}
            trigger={(p) => (
              <button {...p} type="button" className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100">
                <Icon name="sort" size={18} className="text-slate-500" />
                <span className="hidden sm:inline">{SORT_LABEL[sort]}</span>
              </button>
            )}
          />
          <MoreMenu items={folderMenu(f)} label={`Options for ${f.name}`} />
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-xs">
        <div>
          <div className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Total</div>
          <div className="font-mono text-sm font-bold text-slate-900">{money(f.total)}</div>
        </div>
        <div className="flex min-w-48 flex-1 items-center gap-3">
          {f.cap ? <Meter value={pct} tone={tone} /> : <span className="flex-1 text-xs text-slate-400">No cap set</span>}
          <span className="shrink-0 font-mono text-xs text-slate-500">of {money(f.cap)}</span>
        </div>
        <div className="text-xs text-slate-500">
          <span className="font-mono font-semibold text-slate-700">{f.positions.toLocaleString('en-US')}</span> positions · <span className="font-mono font-semibold text-slate-700">{f.priced.toLocaleString('en-US')}</span> priced
        </div>
      </div>

      {subfolders.length > 0 && (
        <section aria-labelledby="subfolders-h" className="mb-6">
          <h2 id="subfolders-h" className="mb-3 font-heading text-sm font-bold text-slate-900">Subfolders</h2>
          <FolderGrid folders={subfolders} />
        </section>
      )}

      {lists.length > 0 && (
        <section aria-label="Lists">
          <ListGrid lists={lists} tone={f.tone} />
        </section>
      )}

      <DropOverlay show={dragging} name={f.name} />
    </Page>
  )
}

