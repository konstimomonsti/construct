import { clsx } from 'clsx'
import { Button } from './ui'
import { EmptyState, PageFrame, PageHeader, RowMenu } from './Kit'
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
          'rounded-3xl border-2 border-dashed px-5 transition-colors sm:px-8',
          dragging ? 'border-brand-600 bg-brand-50' : 'border-slate-300',
        )}
      >
        <EmptyState
          icon="upload_file"
          title="Add your first list"
          text={
            <>
              <span className="[@media(pointer:coarse)]:hidden">Drop GAEB or price files anywhere on this page, or choose them from your computer.</span>
              <span className="hidden [@media(pointer:coarse)]:inline">Choose tender files or price sheets from your device.</span>
            </>
          }
          hint="Supports GAEB, CSV, TSV, Excel, JSON, Word and PDF. GAEB keeps OZ, Titel and Langtext."
        >
          <Button variant="primary" size="lg" icon="upload" onClick={pick}>Import files</Button>
          <Button size="lg" icon="add" onClick={() => openDialog({ kind: 'blank-list', folderId: f.id })}>Start a blank list</Button>
        </EmptyState>
      </div>
    </PageFrame>
  )
}
