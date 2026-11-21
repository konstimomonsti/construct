import { clsx } from 'clsx'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion, useReducedMotion } from 'motion/react'
import { Icon, Menu, Meter } from './ui'
import { easeOutExpo } from './Page'
import { moneyCompact, plural, usageTone } from '../lib/format'
import { useActions } from '../lib/actions'
import { pickAndImport } from '../lib/import'
import type { FolderView } from '../lib/store'
import { useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'

export const toneTile: Record<string, string> = {
  indigo: 'bg-brand-50 text-brand-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  blue: 'bg-blue-50 text-blue-600',
  sky: 'bg-sky-50 text-sky-600',
  violet: 'bg-violet-50 text-violet-600',
  slate: 'bg-slate-100 text-slate-500',
}

/** cards animate in only the first time they're rendered in a session */
const entered = new Set<string>()
export function useFirstRender(key: string) {
  const [first] = useState(() => {
    const f = !entered.has(key)
    entered.add(key)
    return f
  })
  return first
}

/** total · meter · cap row shared by folder and list cards */
export function BudgetRow({ total, cap, onSetCap, className }: { total: number; cap: number; onSetCap: () => void; className?: string }) {
  const pct = cap ? (total / cap) * 100 : 0
  const tone = total === 0 ? 'ok' : usageTone(pct)
  return (
    <div className={clsx('flex w-full items-center justify-between gap-3 border-b border-slate-200/70 pb-2.5', className)}>
      <span className={clsx('shrink-0 font-mono text-xs font-semibold', total ? 'text-slate-900' : 'text-slate-500')}>{moneyCompact(total)}</span>
      <Meter value={pct} tone={tone} />
      {cap ? (
        <span className="shrink-0 font-mono text-xs text-slate-500">{moneyCompact(cap)}</span>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onSetCap()
          }}
          className="pointer-events-auto relative z-10 shrink-0 font-mono text-xs text-slate-500 transition-colors hover:text-brand-600"
        >
          Set cap
        </button>
      )}
    </div>
  )
}

export function MoreMenu({ items, label }: { items: Parameters<typeof Menu>[0]['items']; label: string }) {
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="pointer-events-auto relative z-10 inline-flex">
      <Menu
        label={label}
        items={items}
        trigger={(p) => (
          <button
            {...p}
            type="button"
            aria-label={label}
            title="More options"
            className="flex size-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-800"
          >
            <Icon name="more_vert" size={16} />
          </button>
        )}
      />
    </span>
  )
}

/** stretched, accessible hit area for a card; interactive siblings sit above it (z-10) */
export function CardLink({ to, label, selectMode, selected, onToggle }: { to: string; label: string; selectMode?: boolean; selected?: boolean; onToggle?: () => void }) {
  const cls = 'absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600'
  return selectMode ? (
    <button type="button" role="checkbox" aria-checked={!!selected} aria-label={label} onClick={onToggle} className={cls} />
  ) : (
    <Link to={to} aria-label={label} className={cls} />
  )
}

interface CardProps {
  folder: FolderView
  index: number
  selectMode?: boolean
  selected?: boolean
  onToggle?: () => void
}

export function FolderCard({ folder: f, index, selectMode, selected, onToggle }: CardProps) {
  const { navigate, folderMenu } = useActions()
  const openDialog = useUi((s) => s.openDialog)
  const reduce = useReducedMotion()
  const first = useFirstRender(`folder-${f.id}`)
  const tone = f.total === 0 ? 'ok' : usageTone(f.cap ? (f.total / f.cap) * 100 : 0)
  const empty = f.listMetas.length === 0
  const footerTone = tone === 'caution' ? 'text-amber-600 font-medium' : tone === 'warn' || tone === 'over' ? 'text-rose-600 font-medium' : 'text-slate-500'
  const dot = tone === 'caution' ? 'bg-amber-500' : tone === 'warn' || tone === 'over' ? 'bg-rose-500' : 'bg-emerald-500'

  return (
    <motion.div
      initial={first && !reduce ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ duration: 0.2, ease: easeOutExpo, delay: first ? Math.min(index, 12) * 0.04 : 0 }}
      className={clsx(
        'group relative flex flex-col justify-between rounded-xl border p-4 transition-[border-color,box-shadow,background-color] duration-200 hover:shadow-md',
        f.userCreated && empty ? 'border-dashed border-slate-200' : 'border-slate-200',
        selected ? 'border-brand-600 bg-brand-50/30 ring-2 ring-brand-600' : 'bg-white hover:border-slate-300',
      )}
    >
      <CardLink to={`/folder/${f.id}`} label={`${f.name}, ${plural(f.listMetas.length, 'list', 'lists')}`} selectMode={selectMode} selected={selected} onToggle={onToggle} />
      {selectMode && (
        <span className="absolute -top-2 -left-2 z-10 rounded bg-white p-0.5 shadow-xs ring-1 ring-slate-200">
          <input
            type="checkbox"
            className="checkbox"
            checked={!!selected}
            onChange={() => onToggle?.()}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${f.name}`}
          />
        </span>
      )}
      <div className="pointer-events-none relative flex flex-col items-center text-center">
        <BudgetRow total={f.total} cap={f.cap} onSetCap={() => openDialog({ kind: 'cap', target: 'folder', id: f.id })} className="mb-1" />
        <div className={clsx('mt-1 flex size-14 items-center justify-center rounded-xl shadow-xs', toneTile[f.tone] ?? toneTile.slate)}>
          <Icon name={f.icon} size={28} />
        </div>
        <h2 className="mt-2.5 max-w-full truncate text-sm font-semibold tracking-tight text-slate-900 transition-colors group-hover:text-brand-600">{f.name}</h2>
        <p className="mt-0.5 max-w-full truncate text-xs text-slate-500">{f.description}</p>
        {f.userCreated && empty && (
          <button
            type="button"
            onClick={(e: MouseEvent) => {
              e.stopPropagation()
              pickAndImport(f.id, () => navigate(`/folder/${f.id}`))
            }}
            className="pointer-events-auto relative z-10 mt-2 inline-flex h-6 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-brand-600 transition-colors hover:border-brand-500 hover:bg-brand-50"
          >
            <Icon name="add" size={14} />
            Import Files
          </button>
        )}
      </div>
      <div className={clsx('pointer-events-none relative mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs', footerTone)}>
        <span className="flex items-center gap-1.5">
          {!empty && <span className={clsx('size-1.5 rounded-full', dot)} />}
          <span>{plural(f.listMetas.length, 'list', 'lists')} inside</span>
        </span>
        <MoreMenu items={folderMenu(f)} label={`Options for ${f.name}`} />
      </div>
    </motion.div>
  )
}

function Rows({ children, head }: { children: ReactNode; head: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">{head}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">{children}</tbody>
        </table>
      </div>
    </div>
  )
}

export function FolderGrid({
  folders, selectMode, selected, onToggle,
}: {
  folders: FolderView[]
  selectMode?: boolean
  selected?: Set<string>
  onToggle?: (id: string) => void
}) {
  const view = useStore((s) => s.view)
  const { navigate, folderMenu } = useActions()
  const openDialog = useUi((s) => s.openDialog)

  if (view === 'list') {
    return (
      <Rows
        head={
          <>
            {selectMode && <th scope="col" className="w-10 py-3 pr-2 pl-4"><span className="sr-only">Select</span></th>}
            <th scope="col" className="px-4 py-3">Folder</th>
            <th scope="col" className="px-3 py-3 text-right">Lists</th>
            <th scope="col" className="px-3 py-3 text-right">Positions</th>
            <th scope="col" className="px-3 py-3 text-right">Total</th>
            <th scope="col" className="w-48 px-3 py-3">Usage of cap</th>
            <th scope="col" className="px-3 py-3 text-right">Cap</th>
            <th scope="col" className="w-10 px-3 py-3"><span className="sr-only">Actions</span></th>
          </>
        }
      >
        {folders.map((f) => {
          const pct = f.cap ? (f.total / f.cap) * 100 : 0
          return (
            <tr
              key={f.id}
              tabIndex={0}
              onClick={() => (selectMode ? onToggle?.(f.id) : navigate(`/folder/${f.id}`))}
              onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && navigate(`/folder/${f.id}`)}
              className={clsx('cursor-pointer transition-colors hover:bg-slate-50/80', selected?.has(f.id) && 'bg-brand-50/40')}
            >
              {selectMode && (
                <td className="py-3 pr-2 pl-4">
                  <input type="checkbox" className="checkbox" checked={!!selected?.has(f.id)} onChange={() => onToggle?.(f.id)} onClick={(e) => e.stopPropagation()} aria-label={`Select ${f.name}`} />
                </td>
              )}
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className={clsx('flex size-8 shrink-0 items-center justify-center rounded-lg', toneTile[f.tone] ?? toneTile.slate)}>
                    <Icon name={f.icon} size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-slate-900">{f.name}</div>
                    <div className="max-w-xs truncate text-[11px] text-slate-500">{f.description}</div>
                  </div>
                </div>
              </td>
              <td className="px-3 py-3 text-right font-mono text-slate-600">{f.listMetas.length}</td>
              <td className="px-3 py-3 text-right font-mono text-slate-600">{f.positions.toLocaleString('en-US')}</td>
              <td className="px-3 py-3 text-right font-mono font-semibold text-slate-900">{moneyCompact(f.total)}</td>
              <td className="px-3 py-3">{f.cap ? <Meter value={pct} tone={f.total === 0 ? 'ok' : usageTone(pct)} /> : <span className="text-slate-400">—</span>}</td>
              <td className="px-3 py-3 text-right font-mono text-slate-500">
                {f.cap ? moneyCompact(f.cap) : (
                  <button type="button" className="font-medium text-brand-600 hover:underline" onClick={(e) => { e.stopPropagation(); openDialog({ kind: 'cap', target: 'folder', id: f.id }) }}>Set cap</button>
                )}
              </td>
              <td className="px-3 py-3 text-right"><MoreMenu items={folderMenu(f)} label={`Options for ${f.name}`} /></td>
            </tr>
          )
        })}
      </Rows>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {folders.map((f, i) => (
        <FolderCard key={f.id} folder={f} index={i} selectMode={selectMode} selected={selected?.has(f.id)} onToggle={() => onToggle?.(f.id)} />
      ))}
    </div>
  )
}

export { Rows }
