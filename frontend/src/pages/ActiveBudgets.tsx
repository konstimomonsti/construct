import { clsx } from 'clsx'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Icon, Meter } from '../components/ui'
import { EmptyNote, Page } from '../components/Page'
import { MoreMenu } from '../components/FolderCard'
import { useModel, type ListView } from '../lib/store'
import { money, plural, usageTone } from '../lib/format'
import { useActions } from '../lib/actions'

type Key = 'title' | 'folder' | 'positions' | 'total' | 'usage'

export function ActiveBudgets() {
  const { lists, folders } = useModel()
  const navigate = useNavigate()
  const { listMenu } = useActions()
  const [key, setKey] = useState<Key>('total')
  const [dir, setDir] = useState<1 | -1>(-1)

  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const rows = useMemo(() => {
    const live = lists.filter((l) => !l.trashedAt && l.total > 0 && !folderName.get(l.folderId)?.trashedAt && !folderName.get(l.folderId)?.archived)
    const usage = (l: ListView) => (l.cap ? l.total / l.cap : 0)
    const val = (l: ListView): number | string => {
      switch (key) {
        case 'title': return l.title.toLowerCase()
        case 'folder': return (folderName.get(l.folderId)?.name ?? '').toLowerCase()
        case 'positions': return l.positionsCount
        case 'usage': return usage(l)
        default: return l.total
      }
    }
    return [...live].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      return (typeof x === 'string' ? x.localeCompare(y as string, 'de') : (x as number) - (y as number)) * dir
    })
  }, [lists, key, dir, folderName])

  const grand = rows.reduce((s, l) => s + l.total, 0)

  const th = (k: Key, label: string, right?: boolean) => (
    <th scope="col" aria-sort={key === k ? (dir === 1 ? 'ascending' : 'descending') : 'none'} className={clsx('px-3 py-3', right && 'text-right')}>
      <button
        type="button"
        onClick={() => (key === k ? setDir((d) => (d === 1 ? -1 : 1)) : (setKey(k), setDir(k === 'title' || k === 'folder' ? 1 : -1)))}
        className={clsx('inline-flex items-center gap-1 tracking-wider uppercase transition-colors hover:text-slate-900', key === k && 'text-slate-900')}
      >
        {label}
        <Icon name={key === k ? (dir === 1 ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'} size={13} className={key === k ? '' : 'opacity-40'} />
      </button>
    </th>
  )

  return (
    <Page className="mx-auto w-full max-w-7xl px-4 pt-5 pb-16 sm:px-6">
      <div className="pb-4">
        <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
          <Link to="/" className="hover:text-slate-900">Home</Link>
          <Icon name="chevron_right" size={12} />
          <Link to="/" className="hover:text-slate-900">Workspace</Link>
          <Icon name="chevron_right" size={12} />
          <span className="font-medium text-slate-900">Active Budgets</span>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Active Budgets</h1>
          <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{plural(rows.length, 'priced list', 'priced lists')}</span>
          <span className="font-mono text-xs text-slate-500">Σ {money(grand)}</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyNote icon="account_balance_wallet" title="No priced lists" text="Lists with unit prices (offers, GAEB X84/X86, D84/D86) show up here." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  {th('title', 'List')}
                  {th('folder', 'Folder')}
                  {th('positions', 'Positions', true)}
                  {th('total', 'Total', true)}
                  {th('usage', 'Usage of cap')}
                  <th scope="col" className="w-10 px-3 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((l) => {
                  const pct = l.cap ? (l.total / l.cap) * 100 : 0
                  return (
                    <tr
                      key={l.id}
                      tabIndex={0}
                      onClick={() => navigate(`/list/${l.id}`)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && navigate(`/list/${l.id}`)}
                      className="cursor-pointer transition-colors hover:bg-slate-50/80"
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-600">
                            <Icon name="description" size={18} />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-slate-900">{l.title}</div>
                            <div className="truncate font-mono text-[11px] text-slate-400">{l.fileName}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-slate-600">{folderName.get(l.folderId)?.name}</td>
                      <td className="px-3 py-3 text-right font-mono text-slate-600">{l.positionsCount}</td>
                      <td className="px-3 py-3 text-right font-mono font-bold text-slate-900">{money(l.total)}</td>
                      <td className="w-56 px-3 py-3"><Meter value={pct} tone={usageTone(pct)} /></td>
                      <td className="px-3 py-3 text-right"><MoreMenu items={listMenu(l)} label={`Options for ${l.title}`} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Page>
  )
}
