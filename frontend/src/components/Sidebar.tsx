import { clsx } from 'clsx'
import { NavLink, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from './ui'
import { useModel, useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useMedia } from '../lib/hooks'

/** the first group is the work itself; catalogues are reference data, so they sit apart under their own name */
const NAV_GROUPS = [
  { label: 'Projects', links: [
    { to: '/', label: 'All Projects', icon: 'source', end: true },
    { to: '/active', label: 'Active Budgets', icon: 'account_balance_wallet', end: false },
    { to: '/archived', label: 'Archived', icon: 'archive', end: false },
    { to: '/trash', label: 'Trash', icon: 'delete', end: false },
  ] },
  { label: 'Catalogues', links: [
    { to: '/catalogues/products', label: 'Products', icon: 'package_2', end: true },
    { to: '/catalogues/suppliers', label: 'Suppliers', icon: 'local_shipping', end: true },
    { to: '/catalogues/subcontractors', label: 'Subcontractors', icon: 'engineering', end: true },
  ] },
]

export function Sidebar() {
  const collapsedPref = useStore((s) => s.sidebarCollapsed)
  const toggle = useStore((s) => s.toggleSidebar)
  const mobileOpen = useUi((s) => s.mobileNav)
  const setMobile = useUi((s) => s.setMobileNav)
  const isLg = useMedia('(min-width: 1024px)')
  const { pathname } = useLocation()
  const { folders, lists } = useModel()
  const trashed = folders.filter((f) => f.trashedAt).length + lists.filter((l) => l.trashedAt && l.trashedAt !== 'purged').length
  const rail = collapsedPref && isLg
  // project and list pages live under All Projects, so it stays lit as their parent
  const nested = /^\/(folder|list)\//.test(pathname)

  useEffect(() => setMobile(false), [pathname, setMobile])
  // mobile drawer: Esc closes it, focus moves in on open and back to the menu button on close
  useEffect(() => {
    if (!mobileOpen || isLg) return
    const opener = document.activeElement as HTMLElement | null
    document.querySelector<HTMLElement>('aside[aria-label=Sidebar] nav a')?.focus()
    const main = document.querySelector<HTMLElement>('[data-shell-main]')
    if (main) main.inert = true
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobile(false)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (main) main.inert = false
      opener?.focus?.()
    }
  }, [mobileOpen, isLg, setMobile])

  const body = (
    <aside
      aria-label="Sidebar"
      inert={!isLg && !mobileOpen}
      className={clsx(
        'fixed top-0 left-0 z-50 flex h-full w-60 flex-col justify-between border-r border-slate-200/70 bg-slate-50 transition-[transform,width] duration-200 ease-out-expo select-none',
        rail && 'lg:w-[72px]',
        mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      )}
    >
      <div className="flex min-h-0 flex-col">
        <div className={clsx('flex h-16 shrink-0 items-center', rail ? 'justify-center px-2' : 'justify-between pr-3 pl-5')}>
          <div className="flex items-center gap-2.5">
            <img
              src="/billbuild-logo-transparent.png"
              width={32}
              height={32}
              alt={rail ? 'BillBuild' : ''}
              className="size-8 shrink-0 rounded-md"
            />
            {!rail && <span className="display text-[17px] text-slate-900">BillBuild</span>}
          </div>
          {!rail && (
            <button
              type="button"
              aria-label={isLg ? 'Collapse sidebar' : 'Close navigation'}
              title={isLg ? 'Collapse sidebar' : 'Close navigation'}
              onClick={() => (isLg ? toggle() : setMobile(false))}
              className="flex size-9 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-900"
            >
              <Icon name={isLg ? 'dock_to_left' : 'close'} size={20} />
            </button>
          )}
        </div>

        <div className="mt-2 min-h-0 space-y-5 overflow-y-auto px-3 pb-3">
          {NAV_GROUPS.map(({ label, links }, gi) => (
            <nav key={label} aria-label={label} className="space-y-1">
              {gi > 0 && (rail
                ? <div aria-hidden className="mx-3 mb-3 border-t border-slate-300" />
                : <h2 className="px-4 pt-1 pb-1.5 text-[13px] font-semibold text-slate-500">{label}</h2>)}
              {links.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  title={n.label}
                  aria-current={nested && n.to === '/' ? 'location' : undefined}
                  className={({ isActive }) =>
                    clsx(
                      'relative flex h-11 items-center gap-3 rounded-md text-[15px] transition-colors',
                      rail ? 'justify-center px-0' : 'px-4',
                      isActive
                        ? 'bg-slate-200/70 font-semibold text-slate-900 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-600'
                        : nested && n.to === '/'
                          ? 'font-semibold text-slate-900 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-600 hover:bg-slate-200/50'
                          : 'font-medium text-slate-700 hover:bg-slate-200/50 hover:text-slate-900',
                    )
                  }
                >
                  {({ isActive: active }) => {
                    const isActive = active || (nested && n.to === '/')
                    return (
                    <>
                      <Icon name={n.icon} size={20} fill={isActive} className={isActive ? 'text-brand-700' : 'text-slate-500'} />
                      {!rail && <span className="flex-1">{n.label}</span>}
                      {!rail && n.to === '/trash' && trashed > 0 && <span className="num text-sm font-medium text-slate-600">{trashed}</span>}
                    </>
                    )
                  }}
                </NavLink>
              ))}
            </nav>
          ))}
        </div>
      </div>

      {rail && (
        <div className="shrink-0 p-3">
          <button
            type="button"
            onClick={toggle}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="flex h-11 w-full items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/50 hover:text-slate-900"
          >
            <Icon name="dock_to_right" size={20} />
          </button>
        </div>
      )}
    </aside>
  )

  return (
    <>
      <AnimatePresence>
        {mobileOpen && !isLg && (
          <motion.div
            key="scrim"
            className="fixed inset-0 z-40 bg-[var(--scrim)] lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setMobile(false)}
          />
        )}
      </AnimatePresence>
      {body}
    </>
  )
}
