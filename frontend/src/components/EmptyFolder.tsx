import { clsx } from 'clsx'
import { Link } from 'react-router-dom'
import { Icon, Menu } from './ui'
import { Page } from './Page'
import { pickAndImport } from '../lib/import'
import type { FolderView } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'

export function EmptyFolder({ folder: f, ancestors, dragging }: { folder: FolderView; ancestors: FolderView[]; dragging: boolean }) {
  const openDialog = useUi((s) => s.openDialog)
  const { trashFolder } = useActions()
  const pick = (accept?: string) => pickAndImport(f.id, undefined, accept)

  return (
    <Page className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pb-12 sm:px-8">
      <div className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="Breadcrumbs" className="flex min-w-0 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 py-1.5 text-xs text-slate-500 shadow-sm">
            <Link to="/" className="flex items-center gap-1 font-medium transition-colors hover:text-brand-600">
              <Icon name="source" size={15} className="text-slate-400" />
              All Projects
            </Link>
            <Icon name="chevron_right" size={12} className="text-slate-300" />
            <Link to="/" className="font-medium transition-colors hover:text-brand-600">Workspace</Link>
            <Icon name="chevron_right" size={12} className="text-slate-300" />
            {ancestors.map((folder) => (
              <span key={folder.id} className="flex min-w-0 items-center gap-1.5">
                <Link to={`/folder/${folder.id}`} className="truncate hover:text-brand-600">{folder.name}</Link>
                <Icon name="chevron_right" size={12} className="text-slate-300" />
              </span>
            ))}
            <span className="flex min-w-0 items-center gap-1.5 font-semibold text-slate-900">
              <Icon name="folder" size={16} className="text-amber-500" />
              <span className="truncate">{f.name}</span>
              <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">Empty</span>
            </span>
          </nav>
          <Menu
            label="Upload files"
            align="start"
            width="w-52"
            items={[
              { label: 'GAEB item lists', icon: 'construction', onSelect: () => pick('.x81,.x82,.x83,.x84,.x86,.d81,.d83,.d84,.d86') },
              { label: 'CSV / JSON spreadsheets', icon: 'table_view', onSelect: () => pick('.csv,.json') },
              { label: 'PDF documents', icon: 'receipt_long', onSelect: () => pick('.pdf') },
            ]}
            trigger={(p) => (
              <button {...p} type="button" className="flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-medium text-white shadow-sm transition-colors hover:bg-brand-700">
                <Icon name="file_upload" size={16} />
                <span>+ Upload Files</span>
                <Icon name="expand_more" size={14} />
              </button>
            )}
          />
          <button type="button" onClick={() => openDialog({ kind: 'new-folder', parent: f.id })} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50">
            <Icon name="create_new_folder" size={16} className="text-brand-600" />
            <span>+ Create Subfolder</span>
          </button>
        </div>
        <div className="flex items-center self-start rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm sm:self-center">
          <button type="button" title="Rename folder" onClick={() => openDialog({ kind: 'rename-folder', id: f.id })} className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100">
            <Icon name="edit" size={15} className="text-slate-400" />
            <span>Rename</span>
          </button>
          <div className="mx-0.5 h-4 w-px bg-slate-200" />
          <button type="button" title="Delete folder" onClick={() => trashFolder(f, true)} className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-rose-50 hover:text-rose-600">
            <Icon name="delete_outline" size={15} className="text-rose-500" />
            <span>Delete</span>
          </button>
        </div>
      </div>

      <div className="flex min-h-[460px] flex-1 flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-8 shadow-sm lg:p-12">
        <div className="flex w-full max-w-xl flex-col items-center text-center">
          <div className="mb-5 flex size-16 items-center justify-center rounded-2xl border border-brand-100/80 bg-brand-50 text-brand-600 shadow-sm">
            <Icon name="folder_open" size={34} />
          </div>
          <h1 className="mb-2 text-xl font-bold tracking-tight text-slate-900">This folder is currently empty</h1>
          <p className="mb-8 max-w-md text-sm leading-relaxed text-slate-500">
            Drag and drop GAEB tender files, price sheets or CSV ledgers directly here, or start with a blank list.
          </p>
          <div
            onClick={() => pick()}
            className={clsx(
              'group w-full cursor-pointer rounded-xl border-2 border-dashed p-8 transition-all duration-200',
              dragging ? 'border-brand-400 bg-brand-50/50' : 'border-slate-200 bg-slate-50/70 hover:border-brand-400 hover:bg-brand-50/20',
            )}
          >
            <div className="flex flex-col items-center justify-center gap-3">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  pick()
                }}
                className="flex h-10 items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 text-xs font-medium text-white shadow-sm transition-all hover:bg-brand-700 active:scale-[0.98]"
              >
                <Icon name="cloud_upload" size={18} />
                <span>Import Item Lists &amp; CSVs</span>
              </button>
              <div className="mt-1 space-y-1">
                <p className="text-xs font-medium text-slate-600">or drop files anywhere into this window</p>
                <p className="text-[11px] text-slate-400">Supports GAEB .X81–.X86 / .D81–.D86, .CSV, .JSON and .PDF</p>
              </div>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            <span className="mr-1 text-xs font-medium text-slate-400">Quick actions:</span>
            <button type="button" onClick={() => openDialog({ kind: 'blank-list', folderId: f.id })} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50">
              <Icon name="add_box" size={15} className="text-amber-500" />
              <span>Create Blank List</span>
            </button>
            <button type="button" onClick={() => openDialog({ kind: 'new-folder', parent: f.id })} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50">
              <Icon name="create_new_folder" size={15} className="text-brand-500" />
              <span>Add Nested Subfolder</span>
            </button>
          </div>
        </div>
      </div>
    </Page>
  )
}
