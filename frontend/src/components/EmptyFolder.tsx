import { Button } from './ui'
import { EmptyState, PageFrame, PageHeader, PaletteKey, RowMenu } from './Kit'
import { folderDescription, type FolderView } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useActions } from '../lib/actions'

/** one clear next step: drop or import files; a blank list is the only alternative */
export function EmptyFolder({ folder: f, ancestors, dragging, onImport }: {
  folder: FolderView; ancestors: FolderView[]; dragging: boolean; onImport: () => void
}) {
  const openDialog = useUi((s) => s.openDialog)
  const { folderMenu } = useActions()
  const crumbs = [{ label: 'All Projects', to: '/' }, ...ancestors.map((x) => ({ label: x.name, to: `/folder/${x.id}` }))]
  const menu = [
    { label: 'New sub-project', icon: 'create_new_folder', onSelect: () => openDialog({ kind: 'new-folder', parent: f.id }) },
    'sep' as const,
    ...folderMenu(f).filter((it) => it === 'sep' || it.label !== 'Open'),
  ]

  return (
    <PageFrame>
      <PageHeader
        crumbs={crumbs}
        title={f.name}
        subtitle={folderDescription(f) || "No lists yet"}
        aside={<RowMenu items={menu} label={`More actions for ${f.name}`} />}
      />

      <EmptyState
        active={dragging}
        icon="upload_file"
          title="Add your first list"
          text={
            <>
              <span className="[@media(pointer:coarse)]:hidden">Drop tender files or price sheets anywhere on this page, or choose them from your computer.</span>
              <span className="hidden [@media(pointer:coarse)]:inline">Choose tender files or price sheets from your device.</span>
            </>
          }
          hint={
            <>
              {/* the same two terms as the instruction above, so it's clear where an Excel price sheet belongs */}
              <span className="block">Tender files: GAEB, PDF or Word</span>
              <span className="block">Price sheets: Excel, CSV, TSV or JSON</span>
              <span className="mt-2 flex items-center justify-center gap-1.5 [@media(pointer:coarse)]:hidden">or press <PaletteKey /> to search everything</span>
            </>
          }
        >
          <Button variant="primary" size="lg" icon="upload" onClick={onImport}>Import files</Button>
          <Button size="lg" icon="add" onClick={() => openDialog({ kind: 'blank-list', folderId: f.id })}>New list</Button>
        </EmptyState>
    </PageFrame>
  )
}
