import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { Icon, useInertRoot } from './ui'
import { loadList } from '../lib/data'
import { int, money, plural } from '../lib/format'
import { listLabel, phaseLabel } from './ListCard'
import { positionTotal } from '../lib/money'
import { folderDescription, useModel, useStore, type ListView } from '../lib/store'
import { useUi } from '../lib/ui-store'
import { setTheme, useTheme } from '../lib/theme'

interface PosIndexEntry {
  listId: string
  id: string
  oz: string
  short: string
  category: string
  total: number
  priced: boolean
  /** unit price (EP), null = not priced */
  up: number | null
  unit: string
}
type Group = 'Actions' | 'Projects' | 'Lists' | 'Positions'
interface Result {
  key: string
  group: Group
  icon: string
  tile?: string
  title: string
  sub: string
  /** a position's OZ, set in the code face ahead of `sub` */
  oz?: string
  /** right column; empty for unpriced items */
  right?: string
  /** smaller muted line under `right` (the GP under a position's EP) */
  rightSub?: string
  priced: boolean
  /** 0 = title (or OZ) starts with the query, 1 = title contains it, 2 = matched elsewhere */
  score: number
  go: () => void
}
type Option =
  | { kind: 'result'; key: string; r: Result }
  | { kind: 'more'; key: string; group: Group; next: number; top?: number }
interface GroupView {
  group: Group
  count: number
  options: { o: Option; i: number }[]
  /** expanded but capped at POS_MAX: how many are listed */
  capped?: number
}

/** rows per group before the "Show N more" row */
const CAP = 3
/** most positions listed when the group is expanded */
const POS_MAX = 50
/** every result tile is neutral; yellow is kept for the selection bar and the match highlight */
const NEUTRAL = 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300'
const GROUP_ORDER: Group[] = ['Actions', 'Projects', 'Lists', 'Positions']
const NOUN: Record<Group, [string, string]> = { Actions: ['action', 'actions'], Projects: ['project', 'projects'], Lists: ['list', 'lists'], Positions: ['position', 'positions'] }

/** bold the matched part of a result title or subtitle */
function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<mark className="bg-transparent font-bold text-brand-700">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>
}

/** footer key hint, same chip as the Esc button */
const Kbd = ({ children, label }: { children: string; label: string }) => (
  <kbd aria-label={label} className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-slate-100 px-2 font-sans text-xs font-medium text-slate-700">{children}</kbd>
)

export function CommandPalette() {
  const open = useUi((s) => s.palette)
  useInertRoot(open)
  const setOpen = useUi((s) => s.setPalette)
  const { folders, lists } = useModel()
  const navigate = useNavigate()
  const openDialog = useUi((s) => s.openDialog)
  const [theme] = useTheme()
  const [q, setQ] = useState('')
  // the option the user moved to; null = use the default (first title match)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<Group>>(() => new Set())
  const [index, setIndex] = useState<PosIndexEntry[] | null>(null)
  // the position index is built once, on first open
  const loading = open && index === null
  // the results overflow below the visible area: show the bottom fade
  const [fade, setFade] = useState(false)
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
    if (!open || index) return
    let live = true
    const ids = lists.filter((l) => !l.trashedAt).map((l) => l.id)
    Promise.allSettled(ids.map((id) => loadList(id))).then((rs) => {
      const out: PosIndexEntry[] = []
      rs.forEach((r, i) => {
        if (r.status !== 'fulfilled') return
        for (const p of r.value.positions) {
          out.push({ listId: ids[i], id: p.id, oz: p.oz, short: p.short, category: p.category, total: positionTotal(p), priced: p.up != null, up: p.up, unit: p.unit ?? '' })
        }
      })
      if (live) setIndex(out)
    })
    return () => { live = false }
  }, [open, index, lists])

  // start each opening with a fresh query (state adjusted during render, not in an effect)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQ('')
      setActiveKey(null)
      setExpanded(new Set())
      // rebuild the position index so prices and new imports are current
      setIndex(null)
    }
  }

  const close = () => setOpen(false)
  // focus returns to whatever opened the palette (a button, or the page for ⌘K)
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    return () => { requestAnimationFrame(() => { if (opener?.isConnected && !document.querySelector('[role=dialog]')) opener.focus() }) }
  }, [open])

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
        key: `f-${f.id}`, group: 'Projects', icon: f.icon, tile: NEUTRAL, title: f.name,
        sub: [plural(f.listMetas.length, 'list', 'lists'), folderDescription(f)].filter(Boolean).join(' · '),
        right: f.total ? money(f.total) : undefined, priced: !!f.total, score: s,
        go: go(`/folder/${f.id}`),
      }))
    const lRes: Result[] = rank(live, displayName, (l) => `${l.title} ${folderName.get(l.folderId) ?? ''} ${l.projectLabel ?? ''}`)
      .map(({ x: l, s }) => ({
        key: `l-${l.id}`, group: 'Lists', icon: 'request_quote', tile: NEUTRAL, title: displayName(l),
        sub: [folderName.get(l.folderId), phaseLabel(l) ?? plural(l.positionsCount, 'position', 'positions')].filter(Boolean).join(' · '),
        right: l.total ? money(l.total) : undefined, priced: !!l.total, score: s, go: go(`/list/${l.id}`, l.id),
      }))
    // commands: all of them on an empty query, otherwise the ones whose name matches
    const act = (key: string, icon: string, title: string, sub: string, run: () => void): Result => ({
      key: `a-${key}`, group: 'Actions', icon, tile: NEUTRAL, title, sub, priced: false, score: t ? score(title) : 1,
      go: () => { setOpen(false); run() },
    })
    const aRes = [
      act('new-project', 'create_new_folder', 'New project', 'Create an empty project', () => openDialog({ kind: 'new-folder' })),
      act('import', 'upload', 'Import files', 'GAEB, Excel, CSV, Word or PDF', () => openDialog({ kind: 'folder-target', action: 'import' })),
      act('budgets', 'account_balance_wallet', 'Go to Active Budgets', 'Every priced list against its cap', go('/active')),
      act('archived', 'archive', 'Go to Archived', 'Projects set aside', go('/archived')),
      act('trash', 'delete', 'Go to Trash', 'Restore or delete forever', go('/trash')),
      act('theme', theme === 'dark' ? 'light_mode' : 'dark_mode', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', 'Remembered on this device', () => setTheme(theme === 'dark' ? 'light' : 'dark')),
    ].filter((a) => !t || a.title.toLowerCase().includes(t))
    // a query that names no command can still become one
    if (t && !aRes.length) aRes.push({ ...act('new-named', 'create_new_folder', `New project “${q.trim()}”`, 'Create a project with this name', () => openDialog({ kind: 'new-folder', name: q.trim() })), score: 3 })
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
        const project = l ? folderName.get(l.folderId) : undefined
        const where = l ? `in ${displayName(l)}${project ? ` (${project})` : ''}` : null
        const ep = e.up != null && e.unit ? `EP ${money(e.up)} / ${e.unit}` : undefined
        return {
          key: `p-${e.listId}-${e.id}`,
          group: 'Positions',
          icon: 'tag',
          title: e.short,
          // category first, then the list it lives in, so the two don't read alike
          oz: e.oz,
          sub: [e.category, where].filter(Boolean).join(' · '),
          tile: NEUTRAL,
          right: !e.priced ? undefined : ep ?? money(e.total),
          rightSub: e.priced && ep ? `GP ${money(e.total)}` : undefined,
          priced: e.priced,
          score: s,
          go: go(`/list/${e.listId}?pos=${encodeURIComponent(e.id)}`, e.listId),
        }
      })
    }
    return [...aRes, ...fRes, ...lRes, ...pRes]
  }, [q, folders, lists, index, navigate, setOpen, openDialog, theme])

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
      const max = g === 'Positions' ? POS_MAX : rs.length
      const open = expanded.has(g)
      const limit = open || g === 'Actions' ? max : CAP
      const shown = rs.slice(0, limit)
      const view: GroupView = { group: g, count: rs.length, options: [] }
      const push = (o: Option) => { view.options.push({ o, i: options.length }); options.push(o) }
      shown.forEach((r) => push({ kind: 'result', key: r.key, r }))
      if (rs.length > limit) {
        // collapsed: offer the next batch; expanded and capped: explain the rest in a note row
        if (!open) push({ kind: 'more', key: `more-${g}`, group: g, next: Math.min(rs.length, max) - limit, top: rs.length > max ? max : undefined })
        else view.capped = limit
      }
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

  // measure after layout (and on resize) whether more results sit below the fold
  const measureFade = () => {
    const el = listRef.current
    setFade(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 4)
  }
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(measureFade)
    const el = listRef.current
    const ro = el ? new ResizeObserver(measureFade) : null
    if (el) ro?.observe(el)
    return () => { cancelAnimationFrame(raf); ro?.disconnect() }
  }, [open, groups])

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
  const cappedNote = (g: GroupView) => `Showing ${int(g.capped ?? 0)} of ${int(g.count)}. Type more to narrow the search.`
  const status = !needle ? '' : !results.length ? 'No matches'
    : [plural(results.length, 'result', 'results'), ...groups.filter((g) => g.capped).map((g) => `${NOUN[g.group][1]}: ${cappedNote(g)}`)].join('. ')
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[85] flex items-start justify-center sm:px-4 sm:pt-[12vh]">
          <motion.div
            className="absolute inset-0 bg-black/60"
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
            className="relative flex h-full w-full flex-col overflow-hidden bg-white sm:h-auto sm:max-w-2xl sm:rounded-lg sm:ring-1 sm:ring-slate-400"
            onKeyDown={onKey}
          >
            <div className="flex shrink-0 items-center gap-3 border-b-2 border-brand-600 px-5 pt-[env(safe-area-inset-top)] sm:pt-0">
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
                aria-label="Search projects, lists and positions, or run a command"
                placeholder="Search, or type a command"
                className="h-16 flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-500"
              />
              {loading && <Icon name="progress_activity" size={18} className="animate-spin text-slate-500" />}
              <button ref={closeRef} type="button" onClick={close} aria-label="Close search (Esc)" className="h-9 rounded-md bg-white px-3 text-[13px] font-medium text-slate-700 ring-1 ring-slate-400 ring-inset hover:bg-slate-100">
                <span className="max-sm:hidden">Esc</span><span className="sm:hidden">Cancel</span>
              </button>
            </div>
            <div role="status" aria-live="polite" className="sr-only">{status}</div>
            <div className="relative flex min-h-0 flex-1 flex-col sm:flex-none">
            <div ref={listRef} onScroll={measureFade} id="palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:max-h-[56vh] sm:flex-none">
              {results.length === 0 && (
                <div className="px-3 py-12 text-center text-sm text-slate-600">{loading ? 'Searching positions…' : `Nothing matches “${q.trim()}”`}</div>
              )}
              {groups.map((g) => {
                const headingId = `pal-group-${g.group.toLowerCase()}`
                return (
                  <div key={g.group} role="presentation">
                    {/* labels the group below; hidden from browse mode so it isn't read twice */}
                    <div id={headingId} aria-hidden="true" className="flex items-baseline gap-2 px-3 pt-5 pb-2 text-xs text-slate-600">
                      <span className="font-semibold text-slate-800">{g.group}</span>
                      {g.group !== 'Actions' && <span className="num font-medium">{int(g.count)}</span>}
                      {g.group === 'Positions' && g.count > POS_MAX && !g.capped && <span className="font-medium">· top {int(POS_MAX)} listed when expanded</span>}
                    </div>
                    <div role="group" aria-labelledby={headingId}>
                      {g.options.map(({ o, i }) => {
                        const on = i === active
                        const rowCls = clsx(
                          'relative flex w-full items-center gap-3.5 rounded-md px-3 text-left',
                          // the bar sits inside the rounded fill, never on the panel edge
                          on && 'bg-brand-50 before:absolute before:inset-y-3 before:left-1 before:w-[3px] before:rounded-full before:bg-brand-600',
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
                              {o.top ? `Show the top ${int(o.top)} ${NOUN[o.group][1]}` : `Show ${int(o.next)} more ${NOUN[o.group][o.next === 1 ? 0 : 1]}`}
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
                            <span className={clsx('flex size-10 shrink-0 items-center justify-center rounded-md', r.tile ?? 'bg-brand-50 text-brand-700')}>
                              <Icon name={r.icon} size={20} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[15px] font-medium text-slate-900"><Hl text={r.title} q={needle} /></span>
                              <span className="block truncate text-sm text-slate-600 max-sm:line-clamp-2 max-sm:whitespace-normal">
                                {r.oz && <span className="font-mono text-[13px] text-slate-700">{r.oz}</span>}
                                {r.oz && r.sub && <span aria-hidden> · </span>}
                                {r.sub}
                              </span>
                            </span>
                            {r.right ? (
                              <span className="flex shrink-0 flex-col items-end">
                                <span className="num text-sm font-semibold text-slate-900">{r.right}</span>
                                {r.rightSub && <span className="num text-xs text-slate-600">{r.rightSub}</span>}
                              </span>
                            ) : r.group !== 'Actions' && (
                              <span className="shrink-0 text-sm text-slate-600">Not priced</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                    {g.capped != null && (
                      // explains the hidden rest; not an option, so the arrow keys skip it (announced via the status region)
                      <div aria-hidden="true" className="flex items-center gap-3.5 px-3 py-2 text-sm text-slate-600">
                        <span className="flex w-10 shrink-0 justify-center"><Icon name="info" size={18} /></span>
                        {cappedNote(g)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div aria-hidden="true" className={clsx('pointer-events-none absolute inset-x-0 bottom-0 h-px bg-slate-300 transition-opacity', fade ? 'opacity-100' : 'opacity-0')} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 px-5 py-3 text-[13px] text-slate-600 max-sm:hidden [@media(pointer:coarse)]:hidden">
              <span className="flex items-center gap-1.5"><Kbd label="Up arrow">↑</Kbd><Kbd label="Down arrow">↓</Kbd> to move</span>
              <span className="flex items-center gap-1.5"><Kbd label="Enter">↵</Kbd> to open</span>
              <span className="ml-auto flex items-center gap-1.5"><Kbd label="Slash">/</Kbd> search a list</span>
              <span className="flex items-center gap-1.5"><Kbd label="j">j</Kbd><Kbd label="k">k</Kbd> next or previous position</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
