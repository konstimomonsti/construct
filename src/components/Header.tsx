import { clsx } from 'clsx'
import { useMatch, useNavigate } from 'react-router-dom'
import { Button, Icon, Menu } from './ui'
import { useStore, useModel } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { inboxFolderId, pickAndImport } from '../lib/import'

export function Header() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const setPalette = useUi((s) => s.setPalette)
  const setMobile = useUi((s) => s.setMobileNav)
  const openDialog = useUi((s) => s.openDialog)
  const navigate = useNavigate()
  const folderMatch = useMatch('/folder/:folderId')
  const listMatch = useMatch('/list/:listId')
  const { lists } = useModel()

  const showToggle = true

  const upload = () => {
    if (folderMatch) return pickAndImport(folderMatch.params.folderId!)
    if (listMatch) {
      const l = lists.find((x) => x.id === listMatch.params.listId)
      return pickAndImport(l?.folderId ?? inboxFolderId(), (r) => r.lists[0] && navigate(`/list/${r.lists[0]}`))
    }
    pickAndImport(inboxFolderId, (r) => {
      if (r.lists.length || r.docs) {
        const st = useStore.getState()
        const f = st.userFolders.find((x) => x.name === 'Imports')
        if (f) navigate(`/folder/${f.id}`)
      }
    })
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur-md sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setMobile(true)}
          className="-ml-1 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 lg:hidden"
        >
          <Icon name="menu" size={20} />
        </button>
        <button type="button" aria-label="Search" onClick={() => setPalette(true)} className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200/60 bg-slate-100/80 text-slate-500 hover:bg-white sm:hidden">
          <Icon name="search" size={18} />
        </button>
        <div className="relative hidden w-full max-w-80 min-w-0 sm:block">
          <Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input
            readOnly
            aria-label="Search folders, lists and positions"
            aria-haspopup="dialog"
            placeholder="Filter folders, lists, positions (Cmd+K)"
            onFocus={(e) => {
              setPalette(true)
              e.currentTarget.blur()
            }}
            onClick={() => setPalette(true)}
            className="h-8 w-full cursor-pointer truncate rounded-lg border border-slate-200/60 bg-slate-100/80 pr-3 pl-9 text-xs text-slate-800 transition-all outline-none placeholder:text-slate-400 hover:bg-white focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500"
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {showToggle && (
          <div role="group" aria-label="View mode" className="hidden items-center rounded-lg border border-slate-200/60 bg-slate-100 p-0.5 sm:flex">
            {(
              [
                ['grid', 'grid_view', 'Grid view'],
                ['list', 'view_list', 'List view'],
              ] as const
            ).map(([k, icon, label]) => (
              <button
                key={k}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={view === k}
                onClick={() => setView(k)}
                className={clsx(
                  'rounded-md px-2 py-1 transition-all',
                  view === k ? 'bg-white text-slate-800 shadow-xs' : 'text-slate-500 hover:text-slate-800',
                )}
              >
                <Icon name={icon} size={16} />
              </button>
            ))}
          </div>
        )}
        {folderMatch ? (
          <>
            <Button size="lg" icon="create_new_folder" aria-label="New Folder" className="hidden sm:inline-flex" onClick={() => openDialog({ kind: 'new-folder' })}>
              <span className="hidden xl:inline">New Folder</span>
            </Button>
            <Button size="lg" icon="upload" aria-label="Upload" className="hidden sm:inline-flex" onClick={upload}>
              <span className="hidden xl:inline">Upload</span>
            </Button>
            <Button variant="primary" size="lg" icon="file_present" aria-label="Import CSV" onClick={() => pickAndImport(folderMatch.params.folderId!, undefined, '.csv,.tsv,.json')}>
              <span className="hidden md:inline">Import CSV</span>
            </Button>
          </>
        ) : (
          <Button variant="primary" size="lg" icon={listMatch ? 'file_present' : 'upload'} aria-label={listMatch ? 'Import CSV' : 'Upload File'} onClick={upload}>
            <span className="hidden md:inline">{listMatch ? 'Import CSV' : 'Upload File'}</span>
          </Button>
        )}
        <Menu
          label="Account"
          width="w-56"
          items={[
            { label: 'Acme Workspace', icon: 'corporate_fare', onSelect: () => navigate('/') },
            { label: 'Search (Cmd+K)', icon: 'search', onSelect: () => setPalette(true) },
            'sep',
            {
              label: 'Reset local changes',
              icon: 'restart_alt',
              danger: true,
              onSelect: () =>
                openDialog({
                  kind: 'confirm',
                  title: 'Reset local changes?',
                  body: 'This clears all edits, imported lists, new folders, caps and open tabs stored in this browser. The original tender data stays untouched.',
                  confirmLabel: 'Reset everything',
                  danger: true,
                  run: () => {
                    useStore.persist.clearStorage()
                    window.location.assign('/')
                  },
                }),
            },
          ]}
          trigger={(p) => (
            <button
              {...p}
              type="button"
              aria-label="Account menu"
              className="ml-1 flex size-8 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200"
            >
              AC
            </button>
          )}
        />
      </div>
    </header>
  )
}
