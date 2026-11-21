import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { Icon, useInertRoot } from './ui'
import { loadList } from '../lib/data'
import { money, moneyWhole, plural } from '../lib/format'
import { toneTile } from './Kit'
import { phaseLabel } from './ListCard'
import { positionTotal } from '../lib/money'
import { folderDescription, useModel, useStore } from '../lib/store'
import { useUi } from '../lib/ui-store'

interface PosIndexEntry {
  listId: string
  listTitle: string
  id: string
  oz: string
  short: string
  total: number
}
interface Result {
  key: string
  group: 'Projects' | 'Lists' | 'Positions'
  icon: string
  tile?: string
  title: string
  sub: string
  right?: string
  go: () => void
}

/** bold the matched part of a result title */
function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<mark className="bg-transparent font-bold text-brand-700">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>
}

export function CommandPalette() {
  const open = useUi((s) => s.palette)
  useInertRoot(open)
  const setOpen = useUi((s) => s.setPalette)
  const { folders, lists } = useModel()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [index, setIndex] = useState<PosIndexEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // global shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useUi.getState().setPalette(!useUi.getState().palette)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // lazily load all lists for position search
  useEffect(() => {
    if (!open || index || loading) return
    setLoading(true)
    const ids = lists.filter((l) => !l.trashedAt).map((l) => ({ id: l.id, title: l.title }))
    Promise.allSettled(ids.map((l) => loadList(l.id))).then((rs) => {
      const out: PosIndexEntry[] = []
      rs.forEach((r, i) => {
        if (r.status !== 'fulfilled') return
        for (const p of r.value.positions) {
          out.push({ listId: ids[i].id, listTitle: ids[i].title, id: p.id, oz: p.oz, short: p.short, total: positionTotal(p) })
        }
      })
      setIndex(out)
      setLoading(false)
    })
  }, [open, index, loading, lists])

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
    }
  }, [open])

  const close = () => setOpen(false)

  const results = useMemo<Result[]>(() => {
    const t = q.trim().toLowerCase()
    const go = (path: string, tab?: string) => () => {
      if (tab) useStore.getState().openTab(tab)
      navigate(path)
      setOpen(false)
    }
    // title matches first, then matches in descriptions / file names
    const rank = <T,>(xs: T[], title: (x: T) => string, rest: (x: T) => string) =>
      !t ? xs : xs.filter((x) => title(x).toLowerCase().includes(t) || rest(x).toLowerCase().includes(t))
        .sort((a, b) => Number(!title(a).toLowerCase().includes(t)) - Number(!title(b).toLowerCase().includes(t)))
    const folderName = new Map(folders.map((f) => [f.id, f.name]))
    const fRes: Result[] = rank(folders.filter((f) => !f.trashedAt), (f) => f.name, (f) => f.description ?? '')
      .slice(0, t ? 3 : 4)
      .map((f) => ({
        key: `f-${f.id}`, group: 'Projects', icon: f.icon, tile: toneTile[f.tone] ?? toneTile.indigo, title: f.name,
        sub: [plural(f.listMetas.length, 'list', 'lists'), folderDescription(f)].filter(Boolean).join(' · '),
        right: f.total ? moneyWhole(f.total) : undefined,
        go: go(`/folder/${f.id}`),
      }))
    const lRes: Result[] = rank(lists.filter((l) => !l.trashedAt), (l) => l.title, (l) => `${l.fileName} ${l.projectLabel ?? ''}`)
      .slice(0, t ? 4 : 4)
      .map((l) => ({
        key: `l-${l.id}`, group: 'Lists', icon: 'request_quote', title: l.title,
        sub: [folderName.get(l.folderId), phaseLabel(l) ?? l.fileName].filter(Boolean).join(' · '),
        right: l.total ? moneyWhole(l.total) : undefined, go: go(`/list/${l.id}`, l.id),
      }))
    let pRes: Result[] = []
    if (t.length >= 2 && index) {
      const hit: PosIndexEntry[] = []
      for (const e of index) {
        if (e.oz.toLowerCase() === t || e.oz.toLowerCase().startsWith(t) || e.short.toLowerCase().includes(t)) {
          hit.push(e)
          if (hit.length >= 8) break
        }
      }
      pRes = hit.map((e) => ({
        key: `p-${e.listId}-${e.id}`,
        group: 'Positions',
        icon: 'receipt_long',
        title: e.short,
        sub: `OZ ${e.oz} · ${e.listTitle}`,
        tile: 'bg-slate-100 text-slate-700',
        right: e.total ? money(e.total) : 'Not priced',
        go: go(`/list/${e.listId}?pos=${encodeURIComponent(e.id)}`, e.listId),
      }))
    }
    return [...fRes, ...lRes, ...pRes]
  }, [q, folders, lists, index, navigate, setOpen])

  useEffect(() => setActive(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKey = (e: React.KeyboardEvent) => {
    // results are reached with the arrow keys; Tab stays inside the dialog
    if (e.key === 'Tab') { e.preventDefault(); inputRef.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); results[active]?.go() }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  const needle = q.trim().toLowerCase()
  const groupCounts = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.group]: (m[r.group] ?? 0) + 1 }), {})
  let lastGroup = ''
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[85] flex items-start justify-center sm:px-4 sm:pt-[12vh]">
          <motion.div
            className="absolute inset-0 bg-slate-900/20 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={close}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-[0_24px_60px_-12px_rgba(15,23,42,0.35)] sm:h-auto sm:rounded-3xl"
            onKeyDown={onKey}
          >
            <div className="flex items-center gap-3 border-b border-slate-100 px-5">
              <Icon name="search" size={22} className="text-slate-500" />
              <input
                ref={inputRef}
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={results[active] ? `pal-${active}` : undefined}
                aria-label="Search projects, lists and positions"
                placeholder="Search projects, lists, OZ or text"
                className="h-16 flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-500"
              />
              {loading && <Icon name="progress_activity" size={18} className="animate-spin text-slate-500" />}
              <button type="button" onClick={close} aria-label="Close search (Esc)" className="h-9 rounded-full bg-slate-100 px-3 text-[13px] font-medium text-slate-700 hover:bg-slate-200">
                <span className="max-sm:hidden">Esc</span><span className="sm:hidden">Cancel</span>
              </button>
            </div>
            <div role="status" aria-live="polite" className="sr-only">{needle ? (results.length ? plural(results.length, 'result', 'results') : 'No matches') : ''}</div>
            <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2 sm:max-h-[56vh] sm:flex-none">
              {results.length === 0 && (
                <div className="px-3 py-12 text-center text-sm text-slate-600">{loading ? 'Searching positions…' : `Nothing matches “${q.trim()}”`}</div>
              )}
              {results.map((r, i) => {
                const head = r.group !== lastGroup
                lastGroup = r.group
                return (
                  <div key={r.key}>
                    {head && (
                      <div role="presentation" className="flex items-baseline gap-1.5 px-3 pt-3 pb-1.5 text-[13px] font-semibold text-slate-600">
                        {r.group}<span className="num font-normal">{groupCounts[r.group]}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      tabIndex={-1}
                      id={`pal-${i}`}
                      data-idx={i}
                      role="option"
                      aria-selected={i === active}
                      onMouseMove={() => setActive(i)}
                      onClick={r.go}
                      className={clsx('flex w-full items-center gap-3.5 rounded-2xl px-3 py-2.5 text-left', i === active ? 'bg-brand-50 ring-1 ring-brand-200' : '')}
                    >
                      <span className={clsx('flex size-10 shrink-0 items-center justify-center rounded-full', r.tile ?? 'bg-brand-50 text-brand-700')}>
                        <Icon name={r.icon} size={20} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium text-slate-900"><Hl text={r.title} q={needle} /></span>
                        <span className="block truncate text-sm text-slate-600">{r.sub}</span>
                      </span>
                      {r.right && <span className={r.right === 'Not priced' ? 'shrink-0 text-sm text-slate-600' : 'num shrink-0 text-sm font-semibold text-slate-900'}>{r.right}</span>}
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-4 border-t border-slate-100 px-5 py-3 text-[13px] text-slate-600 [@media(pointer:coarse)]:hidden">
              <span><kbd className="font-sans font-semibold">↑↓</kbd> to move</span>
              <span><kbd className="font-sans font-semibold">↵</kbd> to open</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
