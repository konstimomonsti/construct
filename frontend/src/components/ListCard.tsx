import { clsx } from 'clsx'
import { motion, useReducedMotion } from 'motion/react'
import { Icon, Meter } from './ui'
import { easeOutExpo } from './Page'
import { BudgetRow, CardLink, MoreMenu, Rows, toneTile, useFirstRender } from './FolderCard'
import { money, moneyCompact, plural, usageTone } from '../lib/format'
import { useActions } from '../lib/actions'
import type { ListView } from '../lib/store'
import { useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'

export function ListCard({ list: l, index, tone: tile = 'indigo' }: { list: ListView; index: number; tone?: string }) {
  const { listMenu } = useActions()
  const openDialog = useUi((s) => s.openDialog)
  const reduce = useReducedMotion()
  const first = useFirstRender(`list-${l.id}`)
  const pct = l.cap ? (l.total / l.cap) * 100 : 0
  const tone = l.total === 0 ? 'ok' : usageTone(pct)
  return (
    <motion.div
      initial={first && !reduce ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ duration: 0.2, ease: easeOutExpo, delay: first ? Math.min(index, 12) * 0.04 : 0 }}
      className="group relative flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 transition-[border-color,box-shadow] duration-200 hover:border-slate-300 hover:shadow-md"
    >
      <CardLink to={`/list/${l.id}`} label={`${l.title}, ${plural(l.positionsCount, 'position', 'positions')}`} />
      <div className="pointer-events-none relative flex flex-col items-center text-center">
        <BudgetRow total={l.total} cap={l.cap} onSetCap={() => openDialog({ kind: 'cap', target: 'list', id: l.id })} className="mb-1" />
        <div className={clsx('mt-1 flex size-14 items-center justify-center rounded-xl shadow-xs', toneTile[tile] ?? toneTile.indigo)}>
          <Icon name="description" size={28} />
        </div>
        <h2 className="mt-2.5 max-w-full truncate text-sm font-semibold tracking-tight text-slate-900 transition-colors group-hover:text-brand-600">{l.title}</h2>
        <p className="mt-0.5 max-w-full truncate font-mono text-[11px] text-slate-400">{l.fileName}</p>
      </div>
      <div className={clsx('pointer-events-none relative mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs', tone === 'caution' ? 'font-medium text-amber-600' : tone === 'warn' || tone === 'over' ? 'font-medium text-rose-600' : 'text-slate-500')}>
        <span className="flex items-center gap-1.5">
          <span className={clsx('size-1.5 rounded-full', l.pricedCount ? 'bg-emerald-500' : 'bg-slate-300')} />
          <span>{plural(l.positionsCount, 'position', 'positions')}</span>
        </span>
        <span className="mx-1 truncate text-[11px] text-slate-400">{l.phase ?? l.format}</span>
        <MoreMenu items={listMenu(l)} label={`Options for ${l.title}`} />
      </div>
    </motion.div>
  )
}

export function ListGrid({ lists, tone }: { lists: ListView[]; tone?: string }) {
  const view = useStore((s) => s.view)
  const { navigate, listMenu } = useActions()
  if (view === 'list') {
    return (
      <Rows
        head={
          <>
            <th scope="col" className="px-4 py-3">List</th>
            <th scope="col" className="px-3 py-3">Format</th>
            <th scope="col" className="px-3 py-3 text-right">Positions</th>
            <th scope="col" className="px-3 py-3 text-right">Total</th>
            <th scope="col" className="w-48 px-3 py-3">Usage of cap</th>
            <th scope="col" className="w-10 px-3 py-3"><span className="sr-only">Actions</span></th>
          </>
        }
      >
        {lists.map((l) => {
          const pct = l.cap ? (l.total / l.cap) * 100 : 0
          return (
            <tr
              key={l.id}
              tabIndex={0}
              onClick={() => navigate(`/list/${l.id}`)}
              onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && navigate(`/list/${l.id}`)}
              className="cursor-pointer transition-colors hover:bg-slate-50/80"
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className={clsx('flex size-8 shrink-0 items-center justify-center rounded-lg', toneTile[tone ?? 'indigo'])}>
                    <Icon name="description" size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-slate-900">{l.title}</div>
                    <div className="truncate font-mono text-[11px] text-slate-400">{l.fileName}</div>
                  </div>
                </div>
              </td>
              <td className="px-3 py-3 whitespace-nowrap text-slate-600">{l.format}</td>
              <td className="px-3 py-3 text-right font-mono text-slate-600">{l.positionsCount}</td>
              <td className="px-3 py-3 text-right font-mono font-semibold text-slate-900" title={money(l.total)}>{moneyCompact(l.total)}</td>
              <td className="px-3 py-3">{l.cap ? <Meter value={pct} tone={l.total === 0 ? 'ok' : usageTone(pct)} /> : <span className="text-slate-400">—</span>}</td>
              <td className="px-3 py-3 text-right"><MoreMenu items={listMenu(l)} label={`Options for ${l.title}`} /></td>
            </tr>
          )
        })}
      </Rows>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {lists.map((l, i) => (
        <ListCard key={l.id} list={l} index={i} tone={tone} />
      ))}
    </div>
  )
}
