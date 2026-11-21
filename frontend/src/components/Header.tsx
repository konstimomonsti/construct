import { useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import { Icon, kbdCls, Menu, toast } from './ui'
import { useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { clearDocuments } from '../lib/documents'
import { useTheme } from '../lib/theme'
import { MOD_KEY } from '../lib/keys'

export function Header() {
  const setPalette = useUi((s) => s.setPalette)
  const setMobile = useUi((s) => s.setMobileNav)
  const openDialog = useUi((s) => s.openDialog)
  const navigate = useNavigate()
  const [theme, setTheme] = useTheme()

  return (
    <header className="sticky top-0 z-30 bg-white">
      {/* same column as the page content, so the search lines up with the page title */}
      <div className="mx-auto flex h-16 w-full max-w-[1120px] items-center justify-between gap-3 px-4 sm:px-8">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setMobile(true)}
          className="-ml-1 flex size-10 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 lg:hidden"
        >
          <Icon name="menu" size={22} />
        </button>
        <button
          type="button"
          aria-label="Search projects, lists, positions"
          aria-haspopup="dialog"
          onClick={() => setPalette(true)}
          className="group flex h-11 w-full max-w-[440px] min-w-0 items-center gap-2.5 rounded-md bg-slate-100 px-4 text-left text-[15px] text-slate-600 transition-colors hover:bg-slate-200/70"
        >
          <Icon name="search" size={20} className="text-slate-600" />
          <span className="flex-1 truncate"><span className="sm:hidden">Search</span><span className="max-sm:hidden">Search projects, lists, positions</span></span>
          <kbd className={clsx(kbdCls, 'max-sm:hidden')}>{MOD_KEY === '⌘' ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          className="flex size-10 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          <Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} size={20} />
        </button>
        <Menu
          label="Account"
          width="w-56"
          items={[
            { label: 'Acme Workspace', icon: 'corporate_fare', onSelect: () => navigate('/') },
            { label: 'Search (Cmd+K)', icon: 'search', onSelect: () => setPalette(true) },
            'sep',
            {
              label: 'Reload shared workspace',
              icon: 'restart_alt',
              danger: true,
              onSelect: () =>
                openDialog({
                  kind: 'confirm',
                  title: 'Reload the shared workspace?',
                  body: 'This clears the copy stored in this browser, including open tabs and any edits not yet synced, then downloads the shared workspace again. Nothing is deleted for your team.',
                  confirmLabel: 'Reload workspace',
                  danger: true,
                  run: () => {
                    void clearDocuments().then(() => {
                      useStore.persist.clearStorage()
                      window.location.assign('/')
                    }).catch(() => toast('Could not clear stored documents.', 'error'))
                  },
                }),
            },
          ]}
          trigger={(p) => (
            <button
              {...p}
              type="button"
              aria-label="AC, account menu"
              className="flex size-10 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-700 transition-colors hover:bg-brand-100"
            >
              AC
            </button>
          )}
        />
      </div>
      </div>
    </header>
  )
}
