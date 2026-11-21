import { clsx } from 'clsx'
import { NavLink, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from './ui'
import { useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useMedia } from '../lib/hooks'

/** the first group is the work itself; catalogues are reference data, so they sit apart under their own name */
const NAV_GROUPS = [
  { label: 'Projects', links: [
    { to: '/', label: 'All Projects', icon: 'source', end: true },
    { to: '/active', label: 'Active Budgets', icon: 'account_balance_wallet', end: false },
    { to: '/archived', label: 'Archived', icon: 'archive', end: false },
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

  // [ toggles the rail on desktop, like Linear; ignored while typing or with a dialog/menu open
  useEffect(() => {
    if (!isLg) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return
      if (document.querySelector('[role=dialog],[role=menu]')) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isLg, toggle])

  /*
   * Opening and closing only changes the width. Every icon keeps its x (centred on the 72px rail at x=36), and labels
   * clip and fade in place instead of mounting/unmounting, so nothing jumps or reflows inside the sidebar. Labels fade
   * out fast when closing and fade in slightly late when opening, so text is never squeezed while the edge moves.
   */
  const label = clsx('whitespace-nowrap transition-opacity', rail ? 'opacity-0 duration-100' : 'opacity-100 delay-100 duration-200')
  const body = (
    <aside
      aria-label="Sidebar"
      inert={!isLg && !mobileOpen}
      className={clsx(
        'fixed top-0 left-0 z-50 flex h-full w-60 flex-col overflow-hidden border-r border-slate-200/70 bg-slate-50 transition-[transform,width] duration-[260ms] ease-glide select-none',
        rail && 'lg:w-[72px]',
        mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      )}
    >
      <div className="relative h-16 shrink-0 border-b border-slate-200">
        {rail ? (
          <button
            type="button"
            onClick={toggle}
            aria-label="Expand sidebar"
            title="Expand sidebar  ["
            className="group/logo absolute top-3 left-4 flex size-10 items-center justify-center rounded-md hover:bg-slate-200/70 focus-visible:bg-slate-200/70"
          >
            <img src="/billbuild-logo-transparent.png" width={32} height={32} alt="" className="size-8 rounded-md transition-opacity duration-150 group-hover/logo:opacity-0 group-focus-visible/logo:opacity-0" />
            <Icon name="dock_to_right" size={20} className="absolute text-slate-700 opacity-0 transition-opacity duration-150 group-hover/logo:opacity-100 group-focus-visible/logo:opacity-100" />
          </button>
        ) : (
          <span className="absolute top-3 left-4 flex size-10 items-center justify-center">
            <img src="/billbuild-logo-transparent.png" width={32} height={32} alt="" className="size-8 rounded-md" />
          </span>
        )}
        <span aria-hidden={rail} className={clsx('display absolute top-1/2 left-[62px] -translate-y-1/2 text-[17px] text-slate-900', label)}>
          BillBuild
        </span>
        <button
          type="button"
          inert={rail}
          aria-label={isLg ? 'Collapse sidebar' : 'Close navigation'}
          title={isLg ? 'Collapse sidebar  [' : 'Close navigation'}
          onClick={() => (isLg ? toggle() : setMobile(false))}
          className={clsx(
            'absolute top-3.5 right-3 flex size-9 items-center justify-center rounded-md text-slate-500 transition-[color,background-color,opacity] hover:bg-slate-200/70 hover:text-slate-900',
            rail ? 'opacity-0 duration-100' : 'opacity-100 delay-100 duration-200',
          )}
        >
          <Icon name={isLg ? 'dock_to_left' : 'close'} size={20} />
        </button>
      </div>

      <div className="mt-2 min-h-0 space-y-4 overflow-x-hidden overflow-y-auto px-3 pb-3">
        {NAV_GROUPS.map(({ label: group, links }, gi) => (
          <nav key={group} aria-label={group} className="space-y-1">
            {gi > 0 && (
              // the heading and the rail's divider share one fixed-height slot, so the links below never shift
              <div className="relative h-8">
                <h2 className={clsx('absolute bottom-1.5 left-[14px] text-[13px] font-semibold text-slate-500', label)}>{group}</h2>
                <div aria-hidden className={clsx('absolute inset-x-3 top-1/2 border-t border-slate-300 transition-opacity', rail ? 'opacity-100 delay-100 duration-200' : 'opacity-0 duration-100')} />
              </div>
            )}
            {links.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                title={rail ? n.label : undefined}
                aria-current={nested && n.to === '/' ? 'location' : undefined}
                className={({ isActive }) =>
                  clsx(
                    'relative flex h-11 items-center gap-3 overflow-hidden rounded-md pl-[14px] text-[15px] transition-colors',
                    isActive || (nested && n.to === '/')
                      ? clsx('font-semibold text-slate-900 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-600', isActive ? 'bg-slate-200/70' : 'hover:bg-slate-200/50')
                      : 'font-medium text-slate-700 hover:bg-slate-200/50 hover:text-slate-900',
                  )
                }
              >
                {({ isActive: active }) => {
                  const isActive = active || (nested && n.to === '/')
                  return (
                    <>
                      <Icon name={n.icon} size={20} fill={isActive} className={clsx('shrink-0', isActive ? 'text-brand-700' : 'text-slate-500')} />
                      <span className={label}>{n.label}</span>
                    </>
                  )
                }}
              </NavLink>
            ))}
          </nav>
        ))}
      </div>
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
