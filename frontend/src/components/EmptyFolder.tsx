import { clsx } from 'clsx'
import { Button, Icon } from './ui'
import { PageFrame, PageHeader, RowMenu } from './Kit'
import { pickAndImport } from '../lib/import'
import { folderDescription, type FolderView } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'

/** one clear next step: drop or import files; a blank list is the only alternative */
export function EmptyFolder({ folder: f, ancestors, dragging }: { folder: FolderView; ancestors: FolderView[]; dragging: boolean }) {
  const openDialog = useUi((s) => s.openDialog)
  const { folderMenu } = useActions()
  const pick = () => pickAndImport(f.id)
  const crumbs = [{ label: 'All Projects', to: '/' }, ...ancestors.map((x) => ({ label: x.name, to: `/folder/${x.id}` }))]
  const menu = [
    { label: 'New folder inside', icon: 'create_new_folder', onSelect: () => openDialog({ kind: 'new-folder', parent: f.id }) },
    'sep' as const,
    ...folderMenu(f).filter((it) => it === 'sep' || it.label !== 'Open'),
  ]

  return (
    <PageFrame>
      <PageHeader
        crumbs={crumbs}
        title={f.name}
        subtitle={folderDescription(f) || 'No lists yet'}
        icon={f.icon || 'folder'}
        tone={f.tone}
        aside={<RowMenu items={menu} label={`More actions for ${f.name}`} />}
      />

      <div
        className={clsx(
          'flex flex-col items-center rounded-3xl border-2 border-dashed px-6 py-14 text-center transition-colors sm:py-20',
          dragging ? 'border-brand-600 bg-brand-50' : 'border-transparent',
        )}
      >
        <span className="mb-4 flex size-14 items-center justify-center rounded-full bg-slate-100 text-slate-600">
          <Icon name="upload_file" size={28} />
        </span>
        <h2 className="font-heading text-lg font-bold tracking-tight text-balance text-slate-900">Add your first list</h2>
        <p className="mt-2 max-w-md text-[15px] leading-relaxed text-balance text-slate-600">
          Drop tender files or price sheets anywhere on this page, or choose them from your computer.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          <Button variant="primary" size="lg" icon="upload" onClick={pick}>Import files</Button>
          <Button size="lg" icon="add" onClick={() => openDialog({ kind: 'blank-list', folderId: f.id })}>Start a blank list</Button>
        </div>
        <p className="mt-6 text-sm text-balance text-slate-600">Supports GAEB, CSV, TSV, Excel, JSON, Word and PDF</p>
      </div>
    </PageFrame>
  )
}
