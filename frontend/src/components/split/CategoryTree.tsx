import { clsx } from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { Icon } from '../ui'
import { moneyCompact } from '../../lib/format'
import { positionTotal } from '../../lib/money'
import type { CatStat } from '../../lib/resolve'
import type { CategoryNode, Position } from '../../lib/types'

export const PIDS_MIME = 'application/x-vaultbudget-pids'

export type CheckState = 'on' | 'off' | 'mixed'

/** expand / collapse state helper shared by the trees */
export function useExpanded(tree: CategoryNode[], initial: 'roots' | 'all' | 'none' = 'roots') {
  const all = useMemo(() => {
    const out: string[] = []
    const walk = (l: CategoryNode[]) => l.forEach((n) => (n.children.length && out.push(n.oz), walk(n.children)))
    walk(tree)
    return out
  }, [tree])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial === 'all' ? allOzOf(tree) : initial === 'roots' ? tree.map((n) => n.oz) : []))
  const toggle = useCallback((oz: string) => setExpanded((s) => {
    const n = new Set(s)
    if (n.has(oz)) n.delete(oz)
    else n.add(oz)
    return n
  }), [])
  return {
    expanded,
    toggle,
    expandAll: () => setExpanded(new Set(allOzOf(tree))),
    collapseAll: () => setExpanded(new Set()),
    open: (oz: string) => setExpanded((s) => new Set(s).add(oz)),
    hasChildren: all.length > 0,
  }
}
const allOzOf = (tree: CategoryNode[]) => {
  const out: string[] = []
  const walk = (l: CategoryNode[]) => l.forEach((n) => (out.push(n.oz), walk(n.children)))
  walk(tree)
  return out
}

interface Row {
  key: string
  kind: 'cat' | 'pos'
  level: number
  node?: CategoryNode
  pos?: Position
  expandable: boolean
  isOpen: boolean
  parentKey: string | null
  setsize: number
  posinset: number
}

export interface CategoryTreeProps {
  tree: CategoryNode[]
  stats: Map<string, CatStat>
  /** direct positions per category OZ; when given, positions are shown as leaf rows */
  positions?: Map<string, Position[]>
  expanded: Set<string>
  onToggleExpand: (oz: string) => void
  mode: 'check' | 'pick'
  label: string
  query?: string
  checkState?: (kind: 'cat' | 'pos', id: string) => CheckState
  onToggle?: (kind: 'cat' | 'pos', id: string) => void
  selectedOz?: string
  onPick?: (oz: string) => void
  onRename?: (oz: string, label: string) => void
  onDropPositions?: (oz: string, pids: string[]) => void
  /** ids dragged when starting a drag on a position row */
  dragIds?: (pid: string) => string[]
  className?: string
  /** hide the aggregated priced totals */
  hideTotals?: boolean
  showCategoryCode?: boolean
}

const ck = (n: CategoryNode) => `c:${n.oz}`
const pk = (p: Position) => `p:${p.id}`

function Box({ state }: { state: CheckState }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
        state === 'off' ? 'border-slate-300 bg-white' : 'border-brand-600 bg-brand-600 text-ink',
      )}
    >
      {state === 'on' && <Icon name="check" size={13} />}
      {state === 'mixed' && <Icon name="remove" size={13} />}
    </span>
  )
}

export function CategoryTree(props: CategoryTreeProps) {
  const { tree, stats, positions, expanded, onToggleExpand, mode, label, checkState, onToggle, selectedOz, onPick, onRename, onDropPositions, dragIds, className, hideTotals, showCategoryCode = true } = props
  const q = (props.query ?? '').trim().toLowerCase()
  const root = useRef<HTMLDivElement>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [dropOz, setDropOz] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const rows = useMemo(() => {
    const out: Row[] = []
    const posMatch = (p: Position) => p.oz.toLowerCase().includes(q) || p.short.toLowerCase().includes(q)
    // does a node (or anything below it) match the query?
    const hit = new Map<string, boolean>()
    const nodeHit = (n: CategoryNode): boolean => {
      if (!q) return true
      const cached = hit.get(n.oz)
      if (cached !== undefined) return cached
      const own = n.label.toLowerCase().includes(q) || n.oz.toLowerCase().includes(q)
      const r = own || (positions?.get(n.oz) ?? []).some(posMatch) || n.children.some(nodeHit)
      hit.set(n.oz, r)
      return r
    }
    const walk = (list: CategoryNode[], level: number, parentKey: string | null) => {
      const vis = list.filter(nodeHit)
      vis.forEach((n, i) => {
        const direct = positions?.get(n.oz) ?? []
        const expandable = n.children.length > 0 || direct.length > 0
        const open = expandable && (q ? true : expanded.has(n.oz))
        out.push({ key: ck(n), kind: 'cat', level, node: n, expandable, isOpen: open, parentKey, setsize: vis.length, posinset: i + 1 })
        if (open) {
          walk(n.children, level + 1, ck(n))
          const ownMatch = !q || n.label.toLowerCase().includes(q) || n.oz.toLowerCase().includes(q)
          const dp = direct.filter((p) => ownMatch || posMatch(p))
          dp.forEach((p, j) => out.push({ key: pk(p), kind: 'pos', level: level + 1, pos: p, expandable: false, isOpen: false, parentKey: ck(n), setsize: dp.length, posinset: j + 1 }))
        }
      })
    }
    walk(tree, 1, null)
    return out
  }, [tree, positions, expanded, q])

  const activeKey = focusKey && rows.some((r) => r.key === focusKey) ? focusKey : rows[0]?.key ?? null

  const focusRow = (key: string) => {
    setFocusKey(key)
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus())
  }

  useEffect(() => {
    if (renaming) setTimeout(() => root.current?.querySelector<HTMLInputElement>('input[data-rename]')?.select(), 0)
  }, [renaming])

  const activate = (r: Row) => {
    if (mode === 'pick') {
      if (r.kind === 'cat') onPick?.(r.node!.oz)
    } else onToggle?.(r.kind, r.kind === 'cat' ? r.node!.oz : r.pos!.id)
  }

  const onKey = (e: KeyboardEvent) => {
    if (renaming) return
    const i = rows.findIndex((r) => r.key === activeKey)
    const r = rows[i]
    if (!r) return
    const go = (j: number) => rows[j] && focusRow(rows[j].key)
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(Math.min(rows.length - 1, i + 1)); break
      case 'ArrowUp': e.preventDefault(); go(Math.max(0, i - 1)); break
      case 'Home': e.preventDefault(); go(0); break
      case 'End': e.preventDefault(); go(rows.length - 1); break
      case 'ArrowRight':
        e.preventDefault()
        if (r.kind === 'cat' && r.expandable) {
          if (!r.isOpen) onToggleExpand(r.node!.oz)
          else go(i + 1)
        }
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (r.kind === 'cat' && r.isOpen && !q) onToggleExpand(r.node!.oz)
        else if (r.parentKey) focusRow(r.parentKey)
        break
      case ' ':
      case 'Enter':
        e.preventDefault()
        activate(r)
        break
      case 'F2':
        if (r.kind === 'cat' && onRename) {
          e.preventDefault()
          setRenaming(r.node!.oz)
          setDraft(r.node!.label)
        }
        break
    }
  }

  const commitRename = () => {
    if (renaming && draft.trim()) onRename?.(renaming, draft.trim())
    const key = `c:${renaming}`
    setRenaming(null)
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus())
  }

  const dragOver = (e: DragEvent, oz: string) => {
    if (!onDropPositions || ![...e.dataTransfer.types].includes(PIDS_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropOz(oz)
  }
  const drop = (e: DragEvent, oz: string) => {
    setDropOz(null)
    if (!onDropPositions) return
    const raw = e.dataTransfer.getData(PIDS_MIME)
    if (!raw) return
    e.preventDefault()
    try {
      onDropPositions(oz, JSON.parse(raw) as string[])
    } catch { /* ignore malformed payload */ }
  }

  if (!rows.length) {
    return <div className={clsx('px-3 py-10 text-center text-sm text-slate-600', className)}>{q ? 'No matching categories or positions' : 'No categories'}</div>
  }

  return (
    <div ref={root} role="tree" aria-label={label} aria-multiselectable={mode === 'check'} onKeyDown={onKey} className={clsx('select-none', className)}>
      {rows.map((r) => {
        const isCat = r.kind === 'cat'
        const n = r.node
        const st = isCat ? stats.get(n!.oz) : undefined
        const state = checkState ? checkState(r.kind, isCat ? n!.oz : r.pos!.id) : 'off'
        const selected = mode === 'pick' && isCat && selectedOz === n!.oz
        const indent = 8 + (r.level - 1) * 18
        const isActive = r.key === activeKey
        return (
          <div
            key={r.key}
            role="treeitem"
            data-key={r.key}
            data-oz={isCat ? n!.oz : r.pos!.oz}
            aria-level={r.level}
            aria-setsize={r.setsize}
            aria-posinset={r.posinset}
            aria-expanded={isCat && r.expandable ? r.isOpen : undefined}
            aria-selected={mode === 'pick' ? selected : undefined}
            aria-checked={mode === 'check' ? (state === 'mixed' ? 'mixed' : state === 'on') : undefined}
            aria-label={isCat ? `${showCategoryCode ? n!.oz + ' ' : ''}${n!.label}, ${st?.count ?? 0} positions` : `${r.pos!.oz} ${r.pos!.short}`}
            tabIndex={isActive ? 0 : -1}
            draggable={!isCat && !!dragIds}
            onDragStart={(e) => {
              if (isCat || !dragIds) return
              e.dataTransfer.setData(PIDS_MIME, JSON.stringify(dragIds(r.pos!.id)))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={isCat ? (e) => dragOver(e, n!.oz) : undefined}
            onDragLeave={isCat ? () => setDropOz((o) => (o === n!.oz ? null : o)) : undefined}
            onDrop={isCat ? (e) => drop(e, n!.oz) : undefined}
            onFocus={() => setFocusKey(r.key)}
            onClick={() => {
              setFocusKey(r.key)
              activate(r)
            }}
            onDoubleClick={() => {
              if (isCat && onRename) {
                setRenaming(n!.oz)
                setDraft(n!.label)
              }
            }}
            style={{ paddingLeft: indent }}
            className={clsx(
              'group/row flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg pr-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-inset',
              selected ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-50',
              dropOz === n?.oz && isCat && 'bg-brand-50 ring-2 ring-brand-500 ring-inset',
              !isCat && 'text-slate-600',
            )}
          >
            {isCat ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                disabled={!r.expandable}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleExpand(n!.oz)
                }}
                className={clsx('flex size-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800', !r.expandable && 'invisible')}
              >
                <Icon name="chevron_right" size={16} className={clsx('transition-transform duration-[120ms]', r.isOpen && 'rotate-90')} />
              </button>
            ) : (
              <span className="size-5 shrink-0" />
            )}
            {mode === 'check' ? <Box state={state} /> : selected ? <Icon name="radio_button_checked" size={16} className="text-brand-700" /> : isCat ? <Icon name="radio_button_unchecked" size={16} className="text-slate-300" /> : null}
            {(!isCat || showCategoryCode) && <span className="shrink-0 font-mono text-xs text-slate-500">{isCat ? n!.oz : r.pos!.oz}</span>}
            {isCat && renaming === n!.oz ? (
              <input
                data-rename
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={commitRename}
                aria-label={`Rename category ${n!.oz}`}
                className="h-6 min-w-0 flex-1 rounded border border-brand-500 bg-white px-1.5 text-xs text-slate-900 outline-none"
              />
            ) : (
              <span className={clsx('min-w-0 flex-1 truncate', isCat ? 'font-medium text-slate-800' : '')} title={isCat ? n!.label : r.pos!.short}>
                {isCat ? n!.label : r.pos!.short && r.pos!.short !== '(ohne Kurztext)' ? r.pos!.short : <span className="text-slate-600 italic">(ohne Kurztext)</span>}
              </span>
            )}
            {isCat && onRename && renaming !== n!.oz && (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                title="Rename category"
                onClick={(e) => {
                  e.stopPropagation()
                  setRenaming(n!.oz)
                  setDraft(n!.label)
                }}
                className="hidden size-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 group-hover/row:flex"
              >
                <Icon name="edit" size={13} />
              </button>
            )}
            {isCat && st && <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-px font-mono text-[10px] text-slate-500">{st.count}</span>}
            {!hideTotals && (isCat ? (st && st.total > 0 ? <span className="w-16 shrink-0 text-right font-mono text-[11px] text-slate-600">{moneyCompact(st.total)}</span> : <span className="w-16 shrink-0" />) : <span className="w-16 shrink-0 text-right font-mono text-[11px] text-slate-500">{positionTotal(r.pos!) > 0 ? moneyCompact(positionTotal(r.pos!)) : '—'}</span>)}
          </div>
        )
      })}
    </div>
  )
}
