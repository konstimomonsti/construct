import { clsx } from 'clsx'
import { lazy, Suspense, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { GridSkeleton } from './Page'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { Dialogs } from './Dialogs'
import { Toaster } from './ui'
import { useStore } from '../lib/store'

const CommandPalette = lazy(() => import('./CommandPalette').then((m) => ({ default: m.CommandPalette })))

/** j / k walk the rows of the page (projects, lists, catalogue entries, positions); Enter opens the focused one */
function useRowKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'j' && e.key !== 'k') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return
      if (document.querySelector('[role=dialog],[role=menu]')) return
      const rows = [...document.querySelectorAll<HTMLElement>('main [data-nav], main [data-open-detail]')].filter((el) => el.offsetParent)
      if (!rows.length) return
      e.preventDefault()
      const at = rows.indexOf(document.activeElement as HTMLElement)
      const next = at < 0 ? (e.key === 'j' ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + (e.key === 'j' ? 1 : -1)))
      rows[next].focus()
      rows[next].scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function Shell() {
  const collapsed = useStore((s) => s.sidebarCollapsed)
  useRowKeys()
  return (
    <div className="min-h-screen bg-white">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-lg">
        Skip to content
      </a>
      <Sidebar />
      <div data-shell-main className={clsx('flex min-h-screen min-w-0 flex-col transition-[padding] duration-200 ease-out-expo', collapsed ? 'lg:pl-[72px]' : 'lg:pl-60')}>
        <Header />
        <main id="main" className="relative flex min-w-0 flex-1 flex-col">
          <Suspense fallback={<div className="mx-auto w-full max-w-[1120px] px-4 pt-8 sm:px-8" role="status" aria-label="Loading page"><GridSkeleton /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
      <Dialogs />
      <Toaster />
    </div>
  )
}
