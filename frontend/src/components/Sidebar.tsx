import { clsx } from 'clsx'
import { NavLink, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon, Menu, Meter } from './ui'
import { moneyCompact } from '../lib/format'
import { useStore, useWorkspaceBudget } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { useMedia } from '../lib/hooks'

const NAV = [
  { to: '/', label: 'All Projects', icon: 'source', end: true },
  { to: '/active', label: 'Active Budgets', icon: 'account_balance_wallet', end: false },
  { to: '/archived', label: 'Archived', icon: 'archive', end: false },
  { to: '/shared', label: 'Shared with Team', icon: 'group', end: false },
  { to: '/trash', label: 'Trash', icon: 'delete', end: false },
]

export function Sidebar() {
  const collapsedPref = useStore((s) => s.sidebarCollapsed)
  const toggle = useStore((s) => s.toggleSidebar)
  const mobileOpen = useUi((s) => s.mobileNav)
  const setMobile = useUi((s) => s.setMobileNav)
  const isLg = useMedia('(min-width: 1024px)')
  const { pathname } = useLocation()
  const { total, cap, pct } = useWorkspaceBudget()
  const rail = collapsedPref && isLg

  useEffect(() => setMobile(false), [pathname, setMobile])

  const body = (
    <aside
      aria-label="Sidebar"
      inert={!isLg && !mobileOpen}
      className={clsx(
        'fixed top-0 left-0 z-50 flex h-full w-60 flex-col justify-between border-r border-slate-200 bg-white transition-[transform,width] duration-200 ease-out-expo select-none',
        rail && 'lg:w-16',
        mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      )}
    >
      <div className="flex flex-col">
        <div className={clsx('flex h-14 items-center border-b border-slate-100', rail ? 'justify-center px-2' : 'justify-between px-5')}>
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm shadow-brand-500/20">
              <Icon name="folder_supervised" size={17} />
            </div>
            {!rail && <span className="font-heading text-base font-bold tracking-tight text-slate-900">BillBuild</span>}
          </div>
          {!rail && (
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={() => (isLg ? toggle() : setMobile(false))}
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <Icon name="dock_to_left" size={18} />
            </button>
          )}
        </div>

        <div className={clsx('py-3', rail ? 'px-2' : 'px-3')}>
          <Menu
            label="Workspaces"
            align="start"
            width="w-56"
            items={[
              { label: 'Acme Workspace', icon: 'corporate_fare', checked: true, onSelect: () => {} },
              { label: 'Personal Sandbox', icon: 'person', disabled: true, hint: 'soon', onSelect: () => {} },
            ]}
            trigger={(p) => (
              <button
                {...p}
                type="button"
                title="Acme Workspace"
                className={clsx(
                  'flex w-full items-center rounded-lg border border-slate-200/80 bg-slate-50 py-2 text-left transition-colors hover:bg-slate-100',
                  rail ? 'justify-center px-0' : 'justify-between px-3',
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex size-5 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
                    <Icon name="corporate_fare" size={14} />
                  </div>
                  {!rail && <span className="truncate text-xs font-semibold text-slate-700">Acme Workspace</span>}
                </div>
                {!rail && <Icon name="unfold_more" size={16} className="text-slate-400" />}
              </button>
            )}
          />
        </div>

        <div className={clsx('mt-1', rail ? 'px-2' : 'px-3')}>
          {!rail && <div className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Repositories</div>}
          <nav aria-label="Repositories" className="space-y-0.5">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                title={n.label}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2.5 rounded-lg py-1.5 text-[13px] transition-colors',
                    rail ? 'justify-center px-0' : 'px-3',
                    isActive ? 'bg-brand-50 font-medium text-brand-700' : 'font-normal text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon name={n.icon} size={18} className={isActive ? 'text-brand-600' : 'text-slate-400'} />
                    {!rail && <span>{n.label}</span>}
                  </>
                )}
              </NavLink>
            ))}
            <a
              href="/tender-desk/"
              aria-label="Tender Desk"
              title="Tender Desk"
              className={clsx(
                'flex items-center gap-2.5 rounded-lg py-1.5 text-[13px] text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900',
                rail ? 'justify-center px-0' : 'px-3',
              )}
            >
              <Icon name="fact_check" size={18} className="text-slate-400" />
              {!rail && <span>Tender Desk</span>}
            </a>
          </nav>
        </div>
      </div>

      <div className="border-t border-slate-100 bg-white p-4">
        {rail ? (
          <button
            type="button"
            onClick={toggle}
            aria-label="Expand sidebar"
            title={`Allocated budget ${Math.round(pct)}%`}
            className="flex w-full items-center justify-center rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <Icon name="dock_to_right" size={18} />
          </button>
        ) : (
          <div className="space-y-2.5 rounded-lg border border-slate-200/80 bg-slate-50 p-3">
            <div className="text-xs font-medium text-slate-500">Allocated Budget</div>
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="font-mono text-[11px] text-slate-700">{moneyCompact(total)}</span>
              <Meter value={pct} tone="brand" label="Allocated workspace budget" />
              <span className="font-mono text-[11px] text-slate-500">{moneyCompact(cap)}</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  )

  return (
    <>
      <AnimatePresence>
        {mobileOpen && !isLg && (
          <motion.div
            key="scrim"
            className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-[2px] lg:hidden"
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
