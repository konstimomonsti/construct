import { lazy, useEffect, useState } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { MotionConfig } from 'motion/react'
import { Shell } from './components/Shell'
import { GridSkeleton, Page, Skeleton } from './components/Page'
const AllProjects = lazy(() => import('./pages/AllProjects').then((m) => ({ default: m.AllProjects })))
const ActiveBudgets = lazy(() => import('./pages/ActiveBudgets').then((m) => ({ default: m.ActiveBudgets })))
const Archived = lazy(() => import('./pages/Collections').then((m) => ({ default: m.Archived })))
const Trash = lazy(() => import('./pages/Trash').then((m) => ({ default: m.Trash })))
const FolderPage = lazy(() => import('./pages/FolderPage').then((m) => ({ default: m.FolderPage })))
const ListPage = lazy(() => import('./pages/ListPage').then((m) => ({ default: m.ListPage })))
import { loadLibrary } from './lib/data'
import { useStore } from './lib/store'
import { startSync } from './lib/sync'

function NotFound() {
  return (
    <Page className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 py-24 text-center">
      <p className="text-sm font-medium text-slate-600">Error 404</p>
      <h1 className="mt-1 font-heading text-[28px] font-bold tracking-tight text-slate-900">Page not found</h1>
      <p className="mt-2 text-[15px] text-slate-600">This page doesn’t exist or was moved.</p>
      <Link to="/" className="mt-6 inline-flex h-10 items-center rounded-full bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700">
        Back to All Projects
      </Link>
    </Page>
  )
}

function Boot() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-8 sm:px-8" role="status" aria-label="Loading library">
      <Skeleton className="mb-6 h-8 w-64" />
      <GridSkeleton />
    </div>
  )
}

export default function App() {
  const base = useStore((s) => s.base)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadLibrary().catch((e: Error) => setError(e.message))
    startSync()
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route
              path="/"
              element={error ? <Page className="p-10 text-center text-sm text-rose-600">Could not load data: {error}</Page> : base ? <AllProjects /> : <Boot />}
            />
            {base ? (
              <>
                <Route path="/active" element={<ActiveBudgets />} />
                <Route path="/archived" element={<Archived />} />
                <Route path="/trash" element={<Trash />} />
                <Route path="/folder/:folderId" element={<FolderPage />} />
                <Route path="/list/:listId" element={<ListPage />} />
                <Route path="*" element={<NotFound />} />
              </>
            ) : (
              <Route path="*" element={<Boot />} />
            )}
          </Route>
        </Routes>
      </BrowserRouter>
    </MotionConfig>
  )
}
