import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './ui'
import { loadList } from '../lib/data'
import { money } from '../lib/format'
import { positionTotal } from '../lib/money'
import { useModel, useStore } from '../lib/store'
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
  group: 'Folders' | 'Lists' | 'Positions'
  icon: string
  title: string
  sub: string
  right?: string
  go: () => void
}

export function CommandPalette() {
  const open = useUi((s) => s.palette)
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
    const fRes: Result[] = folders
      .filter((f) => !f.trashedAt && (!t || `${f.name} ${f.description}`.toLowerCase().includes(t)))
      .slice(0, t ? 6 : 6)
      .map((f) => ({ key: `f-${f.id}`, group: 'Folders', icon: f.icon, title: f.name, sub: `${f.listMetas.length} lists · ${f.description}`, go: go(`/folder/${f.id}`) }))
    const lRes: Result[] = lists
      .filter((l) => !l.trashedAt && (!t || `${l.title} ${l.fileName} ${l.projectLabel ?? ''}`.toLowerCase().includes(t)))
      .slice(0, t ? 8 : 5)
      .map((l) => ({ key: `l-${l.id}`, group: 'Lists', icon: 'description', title: l.title, sub: l.fileName, right: l.total ? money(l.total) : undefined, go: go(`/list/${l.id}`, l.id) }))
    let pRes: Result[] = []
    if (t.length >= 2 && index) {
      const hit: PosIndexEntry[] = []
      for (const e of index) {
        if (e.oz.toLowerCase() === t || e.oz.toLowerCase().startsWith(t) || e.short.toLowerCase().includes(t)) {
          hit.push(e)
          if (hit.length >= 30) break
        }
      }
      pRes = hit.map((e) => ({
        key: `p-${e.listId}-${e.id}`,
        group: 'Positions',
        icon: 'receipt_long',
        title: e.short,
        sub: `OZ ${e.oz} · ${e.listTitle}`,
        right: e.total ? money(e.total) : undefined,
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
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); results[active]?.go() }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  let lastGroup = ''
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[85] flex items-start justify-center px-4 pt-[12vh]">
          <motion.div
            className="absolute inset-0 bg-slate-900/25 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={close}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_16px_40px_-8px_rgba(15,23,42,0.18)]"
            onKeyDown={onKey}
          >
            <div className="flex items-center gap-2 border-b border-slate-100 px-3.5">
              <Icon name="search" size={18} className="text-slate-400" />
              <input
                ref={inputRef}
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={results[active] ? `pal-${active}` : undefined}
                aria-label="Search"
                placeholder="Search folders, lists, positions by OZ or text..."
                className="h-12 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
              />
              {loading && <Icon name="progress_activity" size={16} className="animate-spin text-slate-400" />}
              <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">Esc</kbd>
            </div>
            <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
              {results.length === 0 && (
                <div className="px-3 py-10 text-center text-xs text-slate-400">{loading ? 'Indexing positions…' : 'No matches'}</div>
              )}
              {results.map((r, i) => {
                const head = r.group !== lastGroup
                lastGroup = r.group
                return (
                  <div key={r.key}>
                    {head && <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">{r.group}</div>}
                    <button
                      type="button"
                      id={`pal-${i}`}
                      data-idx={i}
                      role="option"
                      aria-selected={i === active}
                      onMouseMove={() => setActive(i)}
                      onClick={r.go}
                      className={clsx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left', i === active ? 'bg-brand-50' : '')}
                    >
                      <span className={clsx('flex size-7 shrink-0 items-center justify-center rounded-md border', i === active ? 'border-brand-200 bg-white text-brand-600' : 'border-slate-200 bg-slate-50 text-slate-500')}>
                        <Icon name={r.icon} size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-slate-900">{r.title}</span>
                        <span className="block truncate font-mono text-[11px] text-slate-400">{r.sub}</span>
                      </span>
                      {r.right && <span className="shrink-0 font-mono text-[11px] text-slate-500">{r.right}</span>}
                      {i === active && <Icon name="keyboard_return" size={14} className="text-brand-500" />}
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-3 border-t border-slate-100 bg-slate-50/70 px-3.5 py-2 text-[11px] text-slate-400">
              <span><kbd className="font-mono">↑↓</kbd> navigate</span>
              <span><kbd className="font-mono">↵</kbd> open</span>
              <span className="ml-auto">{index ? `${index.length.toLocaleString('en-US')} positions indexed` : ''}</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
