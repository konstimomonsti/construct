import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon, kbdCls, useInertRoot } from './ui'
import { Kbd } from './Kit'
import { MOD_KEY } from '../lib/keys'
import { loadList } from '../lib/data'
import { int, money, plural } from '../lib/format'
import { listLabel, phaseLabel } from './ListCard'
import { positionTotal } from '../lib/money'
import { folderDescription, normEdits, useModel, useStore, type ListView } from '../lib/store'
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
  title: string
  sub: string
  /** the project the result lives in; when a whole group shares it, the group header names it once */
  projectId?: string
  /** `sub` without the project, used when the group header names it */
  subLocal?: string
  /** a position's OZ, set in the code face ahead of `sub` */
  oz?: string
  /** right column; empty for unpriced items */
  right?: string
  /** smaller muted line under `right` (the GP under a position's EP) */
  rightSub?: string
  /** a position's pricing state, said beside the amount or in the empty price slot */
  state?: 'Priced' | 'Not priced'
  priced: boolean
  /** 0 = title (or OZ) starts with the query, 1 = title contains it, 2 = matched elsewhere */
  score: number
  go: () => void
}
type Option =
  | { kind: 'result'; key: string; r: Result }
  /** shows rows `from`–`to` (1-based) of `total` */
  | { kind: 'more'; key: string; group: Group; from: number; to: number; total: number }
interface GroupView {
  group: Group
  count: number
  options: { o: Option; i: number }[]
  /** how many results have a price, said once in the header instead of "Not priced" on every row; null = not a priced group */
  priced: number | null
  /** every result in the group sits in this project, so the header names it and the rows leave it out */
  project?: string
  /** only priced positions are shown */
  pricedOnly?: boolean
}

/** rows per group before the "Show N more" row */
const CAP = 3
/** positions are paged in place, this many at a time (the first page tops the 3 up to 50) */
const POS_PAGE = 50
const ALT_KEY = MOD_KEY === '⌘' ? '⌥' : 'Alt'
/** the same filled tile as the app's list rows; one step deeper on the selected row so it doesn't melt into the fill */
const TILE = 'bg-brand-50 text-brand-700'
const TILE_ON = 'bg-brand-100 text-brand-700'
const GROUP_ORDER: Group[] = ['Actions', 'Projects', 'Lists', 'Positions']
/** key of the "New project “query”" command offered when no command matches */
const FALLBACK = 'a-new-named'
const NOUN: Record<Group, [string, string]> = { Actions: ['action', 'actions'], Projects: ['project', 'projects'], Lists: ['list', 'lists'], Positions: ['position', 'positions'] }

/** bold the matched part of a result title or subtitle */
function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<mark className="bg-transparent font-bold text-brand-700">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>
}

/** rows to show after one more "Show N more": positions page by POS_PAGE, the other groups open fully */
const nextLimit = (g: Group, limit: number, total: number) => (g === 'Positions' ? (limit < POS_PAGE ? POS_PAGE : limit + POS_PAGE) : total)

export function CommandPalette() {
  const open = useUi((s) => s.palette)
  useInertRoot(open)
  const setOpen = useUi((s) => s.setPalette)
  const { folders, lists } = useModel()
  const navigate = useNavigate()
  const onList = useLocation().pathname.startsWith('/list/')
  const openDialog = useUi((s) => s.openDialog)
  const [theme] = useTheme()
  const [q, setQ] = useState('')
  // the option the user moved to; null = use the default (first title match)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  // rows shown per group once the user asked for more; absent = the first CAP
  const [limits, setLimits] = useState<Map<Group, number>>(() => new Map())
  const [index, setIndex] = useState<PosIndexEntry[] | null>(null)
  // narrows a large Positions group to the priced rows while keeping the query
  const [pricedOnly, setPricedOnly] = useState(false)
  // the position index is built once, on first open
  const loading = open && index === null
  // the results overflow below the visible area: show the bottom fade
  const [fade, setFade] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const pricedRef = useRef<HTMLButtonElement>(null)
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
      const edits = useStore.getState().edits
      rs.forEach((r, i) => {
        if (r.status !== 'fulfilled') return
        // saved edits on top of the file, so a price typed (even 0,00 €) or removed here is what the palette shows
        const e = normEdits(edits[ids[i]])
        const removed = new Set(e.removed)
        for (const raw of [...r.value.positions, ...e.added]) {
          if (removed.has(raw.id)) continue
          const p = { ...raw, ...e.patch[raw.id], qty: e.qty[raw.id] ?? raw.qty, up: raw.id in e.up ? e.up[raw.id] : raw.up }
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
      setLimits(new Map())
      setPricedOnly(false)
      // rebuild the position index so prices and new imports are current
      setIndex(null)
    }
  }

  const close = () => setOpen(false)
  // focus returns to whatever had it before the palette opened (a button, a field, or the page for ⌘K). The opener is
  // read in the store's own listener, which runs before React renders the palette and its autofocused input.
  useEffect(() => {
    let opener: HTMLElement | null = null
    return useUi.subscribe((s, prev) => {
      if (s.palette && !prev.palette) {
        opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
      } else if (!s.palette && prev.palette) {
        const target = opener
        opener = null
        // two frames: the app behind is no longer inert, and a dialog a command opened has mounted (it keeps focus);
        // the palette itself may still be fading out, so it doesn't count
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (target?.isConnected && !document.querySelector('[role=dialog]:not([data-palette])')) target.focus({ preventScroll: true })
        }))
      }
    })
  }, [])

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
        key: `f-${f.id}`, group: 'Projects', icon: f.icon, title: f.name,
        sub: [plural(f.listMetas.length, 'list', 'lists'), folderDescription(f)].filter(Boolean).join(' · '),
        // read from confirmed position counts, so a saved zero price still shows 0,00 €
        right: f.total || f.priced ? money(f.total) : undefined, priced: !!f.total || f.priced > 0, score: s,
        go: go(`/folder/${f.id}`),
      }))
    const lRes: Result[] = rank(live, displayName, (l) => `${l.title} ${folderName.get(l.folderId) ?? ''} ${l.projectLabel ?? ''}`)
      .map(({ x: l, s }) => ({
        key: `l-${l.id}`, group: 'Lists', icon: 'request_quote', title: displayName(l),
        sub: [folderName.get(l.folderId), phaseLabel(l) ?? plural(l.positionsCount, 'position', 'positions')].filter(Boolean).join(' · '),
        projectId: l.folderId, subLocal: phaseLabel(l) ?? plural(l.positionsCount, 'position', 'positions'),
        right: l.total || l.pricedCount ? money(l.total) : undefined, priced: !!l.total || l.pricedCount > 0, score: s, go: go(`/list/${l.id}`, l.id),
      }))
    // commands: all of them on an empty query, otherwise the ones whose name matches
    const act = (key: string, icon: string, title: string, sub: string, run: () => void): Result => ({
      key: `a-${key}`, group: 'Actions', icon, title, sub, priced: false, score: t ? score(title) : 1,
      go: () => { setOpen(false); run() },
    })
    const aRes = [
      act('new-project', 'create_new_folder', 'New project', 'Create an empty project', () => openDialog({ kind: 'new-folder' })),
      act('import', 'upload', 'Import files', 'GAEB, Excel, CSV, Word or PDF', () => openDialog({ kind: 'folder-target', action: 'import' })),
      act('priced-lists', 'account_balance_wallet', 'Go to Priced Lists', 'Totals across priced lists', go('/active')),
      act('archived', 'archive', 'Go to Archived', 'Projects set aside', go('/archived')),
      act('products', 'package_2', 'Go to Products', 'Catalogue items and prices', go('/catalogues/products')),
      act('suppliers', 'local_shipping', 'Go to Suppliers', 'Companies you buy from', go('/catalogues/suppliers')),
      act('subcontractors', 'engineering', 'Go to Subcontractors', 'Companies you hire for trades', go('/catalogues/subcontractors')),
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
        const where = l ? `in ${displayName(l)}` : null
        // labelled like the ledger's EP and GP columns, with or without a unit
        const ep = e.up != null ? `${money(e.up)}${e.unit ? ` per ${e.unit}` : ''}` : undefined
        return {
          key: `p-${e.listId}-${e.id}`,
          group: 'Positions',
          icon: 'tag',
          title: e.short,
          // category first, then the list it lives in, so the two don't read alike
          oz: e.oz,
          sub: [e.category, where && project ? `${where} (${project})` : where].filter(Boolean).join(' · '),
          subLocal: [e.category, where].filter(Boolean).join(' · '),
          projectId: l?.folderId,
          right: !e.priced ? undefined : ep ?? `Gesamtpreis ${money(e.total)}`,
          rightSub: e.priced && ep ? `Gesamtpreis ${money(e.total)}` : undefined,
          state: e.priced ? 'Priced' : 'Not priced',
          priced: e.priced,
          score: s,
          go: go(`/list/${e.listId}?pos=${encodeURIComponent(e.id)}`, e.listId),
        }
      })
    }
    return [...aRes, ...fRes, ...lRes, ...pRes]
  }, [q, folders, lists, index, navigate, setOpen, openDialog, theme])

  // groups ordered by their best match, so a query that names a position term shows Positions first;
  // each group shows CAP rows plus a "Show N more" option; positions then page in place
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const { groups, options, shown, defaultIdx } = useMemo(() => {
    const byGroup = new Map<Group, Result[]>()
    for (const r of results) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r])
    // the "New project" fallback (score 3) always sorts its group after the actual search results
    const best = (g: Group) => Math.min(...(byGroup.get(g) ?? []).map((r) => r.score))
    const order = GROUP_ORDER.filter((g) => byGroup.has(g)).sort((a, b) => best(a) - best(b))
    const options: Option[] = []
    const shown = new Map<Group, Result[]>()
    const groups: GroupView[] = order.map((g) => {
      const all = byGroup.get(g)!
      const narrowed = g === 'Positions' && pricedOnly
      const rs = narrowed ? all.filter((r) => r.priced) : all
      shown.set(g, rs)
      const limit = g === 'Actions' ? rs.length : limits.get(g) ?? CAP
      const pids = new Set(all.map((r) => r.projectId))
      const pid = pids.size === 1 ? [...pids][0] : undefined
      const view: GroupView = {
        group: g, count: all.length, options: [], priced: g === 'Actions' ? null : all.filter((r) => r.priced).length,
        project: pid ? folderById.get(pid)?.name : undefined, pricedOnly: narrowed,
      }
      const push = (o: Option) => { view.options.push({ o, i: options.length }); options.push(o) }
      rs.slice(0, limit).forEach((r) => push({ kind: 'result', key: r.key, r }))
      if (rs.length > limit) {
        push({ kind: 'more', key: `more-${g}`, group: g, from: limit + 1, to: Math.min(rs.length, nextLimit(g, limit, rs.length)), total: rs.length })
      }
      return view
    })
    // the first title match, else the first real result; the "New project" fallback is only the default when it is alone
    const firstTitle = options.findIndex((o) => o.kind === 'result' && o.r.score < 2)
    const firstReal = options.findIndex((o) => o.kind !== 'result' || o.r.key !== FALLBACK)
    return { groups, options, shown, defaultIdx: Math.max(firstTitle >= 0 ? firstTitle : firstReal, 0) }
  }, [results, limits, pricedOnly, folderById])

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
    // page in place; the active row moves to the first newly shown result, and the field keeps focus for the arrow keys
    inputRef.current?.focus()
    const rs = shown.get(o.group) ?? []
    const from = limits.get(o.group) ?? CAP
    setLimits((m) => new Map(m).set(o.group, nextLimit(o.group, from, rs.length)))
    setActiveKey(rs[from]?.key ?? null)
  }
  // Alt+arrow jumps to the first row of the next or previous group
  const jumpGroup = (dir: 1 | -1) => {
    const at = groups.findIndex((g) => g.options.some(({ i }) => i === active))
    const g = groups[Math.min(Math.max(at + dir, 0), groups.length - 1)]
    const o = g?.options[0]?.o
    if (o) setActiveKey(o.key)
  }

  const posGroup = groups.find((g) => g.group === 'Positions')
  // offered whenever the position matches mix priced and unpriced rows, however few, and while it is on
  const canNarrow = !!posGroup && (pricedOnly || ((posGroup.priced ?? 0) > 0 && (posGroup.priced ?? 0) < posGroup.count))
  const togglePriced = () => { setPricedOnly((v) => !v); setActiveKey(null) }

  const onKey = (e: React.KeyboardEvent) => {
    // Tab / Shift+Tab cycle through the search field, the priced-only toggle (when shown) and the close button; results use the arrow keys
    if (e.key === 'Tab') {
      e.preventDefault()
      const stops = [inputRef.current, pricedRef.current, closeRef.current].filter((x): x is HTMLInputElement | HTMLButtonElement => !!x)
      const at = stops.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement)
      stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus()
    } else if (e.key === 'Escape') { e.preventDefault(); close() }
    // Alt/Option+P toggles Priced only from anywhere in the palette, without leaving the query (code: Option+P types π on a Mac)
    else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyP') {
      e.preventDefault()
      if (canNarrow) togglePriced()
    }
    else if (e.target !== inputRef.current) return
    // on a list, "/" with an empty field hands over to the list's own position search ("/" inside a query, as in C30/37, still types)
    else if (e.key === '/' && onList && !q.trim()) {
      e.preventDefault()
      close()
      // after the focus restore (two frames), the list page's "/" shortcut moves focus to its search field
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
      })))
    }
    else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); jumpGroup(e.key === 'ArrowDown' ? 1 : -1) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); const o = options[Math.min(active + 1, options.length - 1)]; if (o) setActiveKey(o.key) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const o = options[Math.max(active - 1, 0)]; if (o) setActiveKey(o.key) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(options[active]) }
  }

  const needle = q.trim().toLowerCase()
  const onlyFallback = results.length === 1 && results[0].key === FALLBACK
  const shownCount = [...shown.values()].reduce((x, rs) => x + rs.length, 0)
  const posPriced = posGroup?.priced ?? 0
  const posCount = posGroup?.count ?? 0
  // said when the query or Priced only changes: the filtered position count, or that no priced position matches
  const status = !needle ? '' : !results.length ? 'No matches' : onlyFallback ? `No matches for ${q.trim()}. New project ${q.trim()} is available`
    : pricedOnly && posGroup ? `${plural(shownCount, 'result', 'results')}. Priced only: ${posPriced ? `${int(posPriced)} of ${plural(posCount, 'position', 'positions')}` : 'no priced matches'}`
    : plural(results.length, 'result', 'results')
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[85] flex items-start justify-center sm:px-4 sm:pt-[12vh]">
          <motion.div
            className="absolute inset-0 bg-[var(--scrim)]"
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
            data-palette
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
                onChange={(e) => { setQ(e.target.value); setActiveKey(null); setLimits(new Map()) }}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={options[active] ? `pal-${active}` : undefined}
                aria-describedby="palette-keys"
                aria-label="Search projects, lists and positions, or run a command"
                placeholder="Search, or type a command"
                className="h-16 min-w-0 flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-500"
              />
              {loading && <Icon name="progress_activity" size={18} className="animate-spin text-slate-500" />}
              {/* narrows the Positions group to priced rows, keeping the query; only offered when it would change something */}
              {canNarrow && (
                <button
                  ref={pricedRef}
                  type="button"
                  aria-pressed={pricedOnly}
                  aria-keyshortcuts="Alt+P"
                  title={`Priced only (${ALT_KEY} P)`}
                  onClick={() => { togglePriced(); inputRef.current?.focus() }}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-slate-100 px-2.5 text-[13px] font-medium whitespace-nowrap text-slate-800 transition-colors hover:bg-slate-200 aria-pressed:bg-slate-900 aria-pressed:text-white"
                >
                  <Icon name={pricedOnly ? 'check' : 'filter_list'} size={16} />
                  Priced only
                  <kbd aria-hidden className={clsx('num ml-1 rounded px-1 font-sans text-[11px] font-medium max-sm:hidden [@media(hover:none)]:hidden', pricedOnly ? 'bg-white/15 text-white' : 'bg-slate-200 text-slate-700')}>{ALT_KEY} P</kbd>
                </button>
              )}
              {/* the same chip as the footer's key hints; an invisible pad keeps the 44px hit area */}
              <button ref={closeRef} type="button" onClick={close} aria-label="Close search (Esc)" className={clsx(kbdCls, "relative shrink-0 transition-colors after:absolute after:-inset-x-2.5 after:-inset-y-2.5 after:content-[''] hover:bg-slate-300 max-sm:h-7 max-sm:px-2.5")}>
                <span className="max-sm:hidden">Esc</span><span className="sm:hidden">Cancel</span>
              </button>
            </div>
            <div role="status" aria-live="polite" className="sr-only">{status}</div>
            <p id="palette-keys" className="sr-only">
              Up and down arrows move through results, Enter opens one, {ALT_KEY === '⌥' ? 'Option' : 'Alt'} with the arrows jumps between groups, Tab moves to the other controls, Escape closes.{canNarrow ? ` ${ALT_KEY === '⌥' ? 'Option' : 'Alt'} P toggles Priced only.` : ''}
              {onList ? ' With an empty field, slash searches positions in this list.' : ''}
            </p>
            <div className="relative flex min-h-0 flex-1 flex-col sm:flex-none">
            <div ref={listRef} onScroll={measureFade} id="palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:max-h-[56vh] sm:flex-none">
              {results.length === 0 && (
                <div className="px-3 py-12 text-center text-sm text-slate-600">{loading ? 'Searching positions…' : `No matches for “${q.trim()}”`}</div>
              )}
              {/* the "New project" fallback alone: say plainly that nothing matched, above the one thing on offer */}
              {onlyFallback && (
                <div className="px-3 pt-6 pb-2 text-center text-sm text-slate-600">{loading ? 'Searching positions…' : <>No matches for “<span lang="de" className="font-medium text-slate-900">{q.trim()}</span>”</>}</div>
              )}
              {groups.map((g) => {
                const headingId = `pal-group-${g.group.toLowerCase()}`
                return (
                  <div key={g.group} role="presentation">
                    {/* labels the group below; hidden from browse mode so it isn't read twice */}
                    <div id={headingId} aria-hidden="true" className="flex min-w-0 items-baseline gap-2 px-3 pt-3 pb-1 text-xs text-slate-600">
                      <span className="font-semibold text-slate-800">{g.group}</span>
                      {g.priced != null && (
                        <span className="num shrink-0 font-medium">
                          {g.pricedOnly ? `${int(g.priced)} of ${int(g.count)} · priced only` : <>{int(g.count)}{g.priced === 0 ? ' · none priced' : g.priced < g.count ? ` · ${int(g.priced)} priced` : ''}</>}
                        </span>
                      )}
                      {/* one project for the whole group: said here once, not on every row */}
                      {g.project && g.group !== 'Projects' && <span lang="de" className="-ml-1 min-w-0 truncate font-medium">· all in {g.project}</span>}
                    </div>
                    <div role="group" aria-labelledby={headingId}>
                      {g.pricedOnly && g.options.length === 0 && (
                        <div className="flex min-h-11 items-center gap-3.5 px-3 text-sm text-slate-600">
                          <span className="flex w-9 shrink-0 justify-center"><Icon name="filter_list_off" size={20} className="text-slate-500" /></span>
                          <span>No priced matches · <span className="max-sm:hidden [@media(hover:none)]:hidden"><Kbd label={`${ALT_KEY === '⌥' ? 'Option' : 'Alt'} P`}>{ALT_KEY} P</Kbd> to </span>show all {plural(g.count, 'position', 'positions')}</span>
                        </div>
                      )}
                      {g.options.map(({ o, i }) => {
                        const on = i === active
                        const rowCls = clsx(
                          'relative flex w-full items-center gap-3.5 rounded-md px-3 text-left',
                          // the bar sits inside the rounded fill, never on the panel edge
                          on && 'bg-brand-50 before:absolute before:inset-y-2.5 before:left-1 before:w-[3px] before:rounded-full before:bg-brand-600',
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
                              className={clsx(rowCls, 'min-h-10 py-1 text-sm font-medium text-brand-700')}
                            >
                              <span className="flex w-9 shrink-0 justify-center"><Icon name="expand_more" size={20} /></span>
                              {/* names the rows it adds, out of how many match */}
                              <span className="num min-w-0 truncate">
                                {o.from === o.to ? `Show ${NOUN[o.group][0]} ${int(o.from)} of ${int(o.total)}` : `Show ${NOUN[o.group][1]} ${int(o.from)}–${int(o.to)} of ${int(o.total)}`}
                                {o.to < o.total && <span className="font-normal text-slate-600"> · or type more to narrow</span>}
                              </span>
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
                            className={clsx(rowCls, 'min-h-11 py-0.5')}
                          >
                            <span className={clsx('flex size-9 shrink-0 items-center justify-center rounded-md', on ? TILE_ON : TILE)}>
                              <Icon name={r.icon} size={20} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span lang={r.group === 'Actions' ? undefined : 'de'} className="block truncate text-[15px] leading-5 font-medium text-slate-900"><Hl text={r.title} q={needle} /></span>
                              <span className="block truncate text-sm leading-5 text-slate-600 max-sm:line-clamp-2 max-sm:whitespace-normal">
                                {r.oz && <span className="font-mono text-[13px] text-slate-700">{r.oz}</span>}
                                {r.oz && r.sub && <span aria-hidden> · </span>}
                                {g.project ? r.subLocal ?? r.sub : r.sub}
                              </span>
                              {/* phones: the figures go under the title instead of squeezing it */}
                              {(r.right || r.state) && (
                                <span className="num mt-0.5 block truncate text-sm sm:hidden">
                                  {r.state && <span className={r.right ? 'text-slate-600' : 'text-slate-700'}>{r.state}{r.right && ' · '}</span>}
                                  {r.right && <span className="font-semibold text-slate-900">{r.right}</span>}
                                  {r.rightSub && <span className="text-slate-600"> · {r.rightSub}</span>}
                                </span>
                              )}
                            </span>
                            {/* positions say their pricing state beside the amount, or in the empty price slot */}
                            {(r.right || r.state) && (
                              <span className="flex shrink-0 flex-col items-end max-sm:hidden">
                                {r.right ? (
                                  <span className="num text-sm leading-5 font-semibold text-slate-900">{r.right}</span>
                                ) : (
                                  <span className="inline-flex h-5 items-center rounded bg-slate-100 px-1.5 text-[13px] leading-5 font-medium text-slate-700">{r.state}</span>
                                )}
                                {r.right && (r.rightSub || r.state) && (
                                  <span className="num text-[13px] leading-5 text-slate-600">{[r.state, r.rightSub].filter(Boolean).join(' · ')}</span>
                                )}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
            <div aria-hidden="true" className={clsx('pointer-events-none absolute inset-x-0 bottom-0 h-px bg-slate-300 transition-opacity', fade ? 'opacity-100' : 'opacity-0')} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 px-5 py-3 text-[13px] text-slate-600 max-sm:hidden [@media(hover:none)]:hidden">
              <span className="flex items-center gap-1.5"><Kbd label="Up arrow">↑</Kbd><Kbd label="Down arrow">↓</Kbd> to move</span>
              <span className="flex items-center gap-1.5"><Kbd label="Enter">↵</Kbd> to open</span>
              {groups.length > 1 && <span className="flex items-center gap-1.5"><Kbd label={`${ALT_KEY === '⌥' ? 'Option' : 'Alt'} and arrow keys`}>{ALT_KEY} ↑↓</Kbd> to jump between groups</span>}
              {canNarrow && <span className="flex items-center gap-1.5"><Kbd label={`${ALT_KEY === '⌥' ? 'Option' : 'Alt'} P`}>{ALT_KEY} P</Kbd> {pricedOnly ? 'to show all positions' : 'for priced only'}</span>}
              {/* the list page's own position search; elsewhere there is nothing for the slash to open */}
              {onList && !needle && <span className="ml-auto flex items-center gap-1.5"><Kbd label="Slash">/</Kbd> search positions in this list</span>}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
