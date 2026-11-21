import { clsx } from 'clsx'
import { lazy, Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import { GridSkeleton } from './Page'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { Dialogs } from './Dialogs'
import { Toaster } from './ui'
import { useStore } from '../lib/store'

const CommandPalette = lazy(() => import('./CommandPalette').then((m) => ({ default: m.CommandPalette })))

export function Shell() {
  const collapsed = useStore((s) => s.sidebarCollapsed)
  return (
    <div className="min-h-screen bg-slate-50">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-xs focus:font-semibold focus:shadow-lg">
        Skip to content
      </a>
      <Sidebar />
      <div className={clsx('flex min-h-screen min-w-0 flex-col transition-[padding] duration-200 ease-out-expo', collapsed ? 'lg:pl-16' : 'lg:pl-60')}>
        <Header />
        <main id="main" className="relative flex min-w-0 flex-1 flex-col">
          <Suspense fallback={<div className="mx-auto w-full max-w-7xl px-4 pt-6 sm:px-6" role="status" aria-label="Loading page"><GridSkeleton /></div>}>
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
