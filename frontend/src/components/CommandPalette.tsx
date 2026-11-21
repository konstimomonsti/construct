import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { Icon, useInertRoot } from './ui'
import { loadList } from '../lib/data'
import { money, plural } from '../lib/format'
import { toneTile } from './Kit'
import { listLabel, phaseLabel } from './ListCard'
import { positionTotal } from '../lib/money'
import { folderDescription, useModel, useStore, type ListView } from '../lib/store'
import { useUi } from '../lib/ui-store'

interface PosIndexEntry {
  listId: string
  id: string
  oz: string
  short: string
  category: string
  total: number
  priced: boolean
}
type Group = 'Projects' | 'Lists' | 'Positions'
interface Result {
  key: string
  group: Group
  icon: string
  tile?: string
  title: string
  sub: string
  right?: string
  /** 0 = title (or OZ) starts with the query, 1 = title contains it, 2 = matched elsewhere */
  score: number
  go: () => void
}
type Option =
  | { kind: 'result'; key: string; r: Result }
  | { kind: 'more'; key: string; group: Group; hidden: number; total: number }
interface GroupView { group: Group; count: number; options: { o: Option; i: number }[] }

const NOT_PRICED = 'Not priced'
/** rows per group before the "Show all" row */
const CAP = 3
/** most positions listed when the group is expanded */
const POS_MAX = 50
const GROUP_ORDER: Group[] = ['Projects', 'Lists', 'Positions']
const NOUN: Record<Group, string> = { Projects: 'projects', Lists: 'lists', Positions: 'positions' }

/** bold the matched part of a result title or subtitle */
function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<mark className="bg-transparent font-bold text-brand-700">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>
}

/** footer key hint, same chip as the Esc button */
const Kbd = ({ children, label }: { children: string; label: string }) => (
  <kbd aria-label={label} className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-100 px-2 font-sans text-xs font-medium text-slate-700">{children}</kbd>
)

export function CommandPalette() {
  const open = useUi((s) => s.palette)
  useInertRoot(open)
  const setOpen = useUi((s) => s.setPalette)
  const { folders, lists } = useModel()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  // the option the user moved to; null = use the default (first title match)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<Group>>(() => new Set())
  const [index, setIndex] = useState<PosIndexEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
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
    const ids = lists.filter((l) => !l.trashedAt).map((l) => l.id)
    Promise.allSettled(ids.map((id) => loadList(id))).then((rs) => {
      const out: PosIndexEntry[] = []
      rs.forEach((r, i) => {
        if (r.status !== 'fulfilled') return
        for (const p of r.value.positions) {
          out.push({ listId: ids[i], id: p.id, oz: p.oz, short: p.short, category: p.category, total: positionTotal(p), priced: p.up != null })
        }
      })
      setIndex(out)
      setLoading(false)
    })
  }, [open, index, loading, lists])

  useEffect(() => {
    if (open) {
      setQ('')
      setActiveKey(null)
      setExpanded(new Set())
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
    const score = (title: string) => {
      const s = title.toLowerCase()
      return s.startsWith(t) ? 0 : s.includes(t) ? 1 : 2
    }
    // title matches first (prefix before infix), then matches in descriptions / file names
    const rank = <T,>(xs: T[], title: (x: T) => string, rest: (x: T) => string) =>
      !t ? xs.map((x) => ({ x, s: 1 })) : xs
        .filter((x) => title(x).toLowerCase().includes(t) || rest(x).toLowerCase().includes(t))
        .map((x) => ({ x, s: score(title(x)) }))
        .sort((a, b) => a.s - b.s)
    const folderName = new Map(folders.map((f) => [f.id, f.name]))
    const live = lists.filter((l) => !l.trashedAt)
    const listById = new Map(live.map((l) => [l.id, l]))
    const displayName = (l: ListView) => listLabel(l, live.filter((x) => x.folderId === l.folderId)).title
    const fRes: Result[] = rank(folders.filter((f) => !f.trashedAt), (f) => f.name, (f) => f.description ?? '')
      .map(({ x: f, s }) => ({
        key: `f-${f.id}`, group: 'Projects', icon: f.icon, tile: toneTile[f.tone] ?? toneTile.indigo, title: f.name,
        sub: [plural(f.listMetas.length, 'list', 'lists'), folderDescription(f)].filter(Boolean).join(' · '),
        right: f.total ? money(f.total) : undefined, score: s,
        go: go(`/folder/${f.id}`),
      }))
    const lRes: Result[] = rank(live, displayName, (l) => `${l.title} ${folderName.get(l.folderId) ?? ''} ${l.projectLabel ?? ''}`)
      .map(({ x: l, s }) => ({
        key: `l-${l.id}`, group: 'Lists', icon: 'request_quote', title: displayName(l),
        sub: [folderName.get(l.folderId), phaseLabel(l) ?? plural(l.positionsCount, 'position', 'positions')].filter(Boolean).join(' · '),
        right: l.total ? money(l.total) : NOT_PRICED, score: s, go: go(`/list/${l.id}`, l.id),
      }))
    let pRes: Result[] = []
    if (t.length >= 2 && index) {
      const hit: { e: PosIndexEntry; s: number }[] = []
      for (const e of index) {
        const oz = e.oz.toLowerCase()
        if (oz.startsWith(t)) hit.push({ e, s: 0 })
        else if (e.short.toLowerCase().includes(t)) hit.push({ e, s: score(e.short) })
      }
      hit.sort((a, b) => a.s - b.s)
      pRes = hit.map(({ e, s }) => {
        const l = listById.get(e.listId)
        return {
          key: `p-${e.listId}-${e.id}`,
          group: 'Positions',
          icon: 'receipt_long',
          title: e.short,
          sub: [`OZ ${e.oz}`, l ? displayName(l) : null, e.category].filter(Boolean).join(' · '),
          tile: 'bg-slate-100 text-slate-700',
          right: e.priced ? money(e.total) : NOT_PRICED,
          score: s,
          go: go(`/list/${e.listId}?pos=${encodeURIComponent(e.id)}`, e.listId),
        }
      })
    }
    return [...fRes, ...lRes, ...pRes]
  }, [q, folders, lists, index, navigate, setOpen])

  // groups ordered by their best match, so a query that names a position term shows Positions first;
  // each group shows CAP rows plus a "Show all" option until expanded
  const { groups, options, defaultIdx } = useMemo(() => {
    const byGroup = new Map<Group, Result[]>()
    for (const r of results) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r])
    const best = (g: Group) => Math.min(...(byGroup.get(g) ?? []).map((r) => r.score))
    const order = GROUP_ORDER.filter((g) => byGroup.has(g)).sort((a, b) => best(a) - best(b))
    const options: Option[] = []
    const groups: GroupView[] = order.map((g) => {
      const rs = byGroup.get(g)!
      const limit = expanded.has(g) ? (g === 'Positions' ? POS_MAX : rs.length) : CAP
      const view: GroupView = { group: g, count: rs.length, options: [] }
      const push = (o: Option) => { view.options.push({ o, i: options.length }); options.push(o) }
      rs.slice(0, limit).forEach((r) => push({ kind: 'result', key: r.key, r }))
      if (rs.length > limit && !expanded.has(g)) push({ kind: 'more', key: `more-${g}`, group: g, hidden: rs.length - limit, total: rs.length })
      return view
    })
    const firstTitle = options.findIndex((o) => o.kind === 'result' && o.r.score < 2)
    return { groups, options, defaultIdx: Math.max(firstTitle, 0) }
  }, [results, expanded])

  const found = options.findIndex((o) => o.key === activeKey)
  const active = found >= 0 ? found : defaultIdx

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (o: Option | undefined) => {
    if (!o) return
    if (o.kind === 'result') { o.r.go(); return }
    // expand in place; the active row moves to the first newly shown result
    setExpanded((s) => new Set(s).add(o.group))
    setActiveKey(results.filter((r) => r.group === o.group)[CAP]?.key ?? null)
  }

  const onKey = (e: React.KeyboardEvent) => {
    // Tab / Shift+Tab cycle between the search field and the close button; results use the arrow keys
    if (e.key === 'Tab') {
      e.preventDefault()
      if (document.activeElement === inputRef.current) closeRef.current?.focus()
      else inputRef.current?.focus()
    } else if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.target !== inputRef.current) return
    else if (e.key === 'ArrowDown') { e.preventDefault(); const o = options[Math.min(active + 1, options.length - 1)]; if (o) setActiveKey(o.key) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const o = options[Math.max(active - 1, 0)]; if (o) setActiveKey(o.key) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(options[active]) }
  }

  const needle = q.trim().toLowerCase()
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
                onChange={(e) => { setQ(e.target.value); setActiveKey(null); setExpanded(new Set()) }}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={options[active] ? `pal-${active}` : undefined}
                aria-label="Search projects, lists and positions"
                placeholder="Search projects, lists, OZ or text"
                className="h-16 flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-500"
              />
              {loading && <Icon name="progress_activity" size={18} className="animate-spin text-slate-500" />}
              <button ref={closeRef} type="button" onClick={close} aria-label="Close search (Esc)" className="h-9 rounded-full bg-slate-100 px-3 text-[13px] font-medium text-slate-700 hover:bg-slate-200">
                <span className="max-sm:hidden">Esc</span><span className="sm:hidden">Cancel</span>
              </button>
            </div>
            <div role="status" aria-live="polite" className="sr-only">{needle ? (results.length ? plural(results.length, 'result', 'results') : 'No matches') : ''}</div>
            <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 sm:max-h-[56vh] sm:flex-none">
              {results.length === 0 && (
                <div className="px-3 py-12 text-center text-sm text-slate-600">{loading ? 'Searching positions…' : `Nothing matches “${q.trim()}”`}</div>
              )}
              {groups.map((g) => {
                const headingId = `pal-group-${g.group.toLowerCase()}`
                return (
                  <div key={g.group} role="presentation">
                    {/* labels the group below; hidden from browse mode so it isn't read twice */}
                    <div id={headingId} aria-hidden="true" className="flex items-baseline gap-1.5 px-3 pt-5 pb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                      {g.group}<span className="num">{g.count}</span>
                    </div>
                    <div role="group" aria-labelledby={headingId}>
                      {g.options.map(({ o, i }) => {
                        const on = i === active
                        const rowCls = clsx(
                          'relative flex w-full items-center gap-3.5 rounded-2xl px-3 text-left',
                          on && 'bg-brand-50 before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-brand-600',
                        )
                        if (o.kind === 'more') {
                          return (
                            <button
                              key={o.key}
                              type="button"
                              tabIndex={-1}
                              id={`pal-${i}`}
                              data-idx={i}
                              role="option"
                              aria-selected={on}
                              onMouseMove={() => setActiveKey(o.key)}
                              onClick={() => choose(o)}
                              className={clsx(rowCls, 'py-2 text-sm font-medium text-brand-700')}
                            >
                              <span className="flex w-10 shrink-0 justify-center"><Icon name="expand_more" size={20} /></span>
                              {o.group === 'Positions' && o.total > POS_MAX ? `Show ${POS_MAX} of ${o.total} positions` : `Show all ${o.total} ${NOUN[o.group]}`}
                            </button>
                          )
                        }
                        const r = o.r
                        return (
                          <button
                            key={o.key}
                            type="button"
                            tabIndex={-1}
                            id={`pal-${i}`}
                            data-idx={i}
                            role="option"
                            aria-selected={on}
                            onMouseMove={() => setActiveKey(o.key)}
                            onClick={r.go}
                            className={clsx(rowCls, 'py-2.5')}
                          >
                            <span className={clsx('flex size-10 shrink-0 items-center justify-center rounded-full', r.tile ?? 'bg-brand-50 text-brand-700')}>
                              <Icon name={r.icon} size={20} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[15px] font-medium text-slate-900"><Hl text={r.title} q={needle} /></span>
                              <span className="block truncate text-sm text-slate-600"><Hl text={r.sub} q={needle} /></span>
                            </span>
                            {r.right && <span className={r.right === NOT_PRICED ? 'shrink-0 text-sm text-slate-600' : 'num shrink-0 text-sm font-semibold text-slate-900'}>{r.right}</span>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-4 border-t border-slate-100 px-5 py-3 text-[13px] text-slate-600 [@media(pointer:coarse)]:hidden">
              <span className="flex items-center gap-1.5"><Kbd label="Up arrow">↑</Kbd><Kbd label="Down arrow">↓</Kbd> to move</span>
              <span className="flex items-center gap-1.5"><Kbd label="Enter">↵</Kbd> to open</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
