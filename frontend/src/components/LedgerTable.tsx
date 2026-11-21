import { clsx } from 'clsx'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Menu, toast } from './ui'
import { QtyInput, editableCls } from './QtyStepper'
import { amount, nbHyphen, parseNumber } from '../lib/format'
import { positionTotal } from '../lib/money'
import { useStore } from '../lib/store'
import { leafOz, treeStats, type CatStat } from '../lib/resolve'
import type { CategoryNode, Position } from '../lib/types'

/** why a section adds up to nothing, in the words the rows use */
function zeroWhy(s: CatStat) {
  if (s.zero === s.count) return 'All quantities 0'
  if (s.unpriced === s.count) return 'Not priced'
  if (s.zero + s.unpriced === s.count) return 'Not priced or quantity 0'
  return '0,00 €'
}

function EditDot({ on }: { on: boolean }) {
  if (!on) return null
  return <span aria-hidden title="Edited" className="absolute top-1/2 left-0 size-1.5 -translate-y-1/2 rounded-md bg-brand-600" />
}

function PriceCell({ value, onSave, oz, edited, muted, className }: { value: number | null; onSave: (v: number | null) => void; oz: string; edited?: boolean; muted?: boolean; className?: string }) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState('')
  const done = useRef(false)

  const commit = () => {
    if (done.current) return
    done.current = true
    setEdit(false)
    if (text.trim() === '') {
      if (value !== null) onSave(null)
      return
    }
    const n = parseNumber(text)
    if (n !== null && n >= 0 && n !== value) onSave(Math.round(n * 100) / 100)
  }

  if (edit) {
    return (
      <input
        autoFocus
        inputMode="decimal"
        aria-label={`Unit price of ${oz}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            done.current = true
            setEdit(false)
          }
        }}
        className={clsx('num h-9 rounded-md border border-transparent bg-white px-2 text-right text-sm text-slate-900 ring-2 ring-brand-700 outline-none', className ?? 'w-full')}
      />
    )
  }
  return (
    <button
      type="button"
      aria-label={value == null ? `Set price for ${oz}` : `${amount(value)} €, edit unit price of ${oz}${edited ? ' (edited)' : ''}`}
      onClick={() => {
        done.current = false
        setText(value == null ? '' : amount(value))
        setEdit(true)
      }}
      className={clsx(
        value != null ? clsx(editableCls, edited ? 'font-semibold text-brand-700' : muted ? 'text-slate-500' : 'text-slate-900') : 'h-9 rounded-lg px-2 text-right text-sm font-semibold text-brand-700 hover:bg-brand-50',
        className ?? 'w-full',
      )}
    >
      {value != null ? amount(value) : 'Set price'}
    </button>
  )
}

interface RowProps {
  listId: string
  p: Position
  showCategory: boolean
  selected: boolean
  flash: boolean
  onToggle: (id: string) => void
  edited: boolean
  qtyEdited: boolean
  upEdited: boolean
  onOpen: (p: Position) => void
  onMove: (pid: string) => void
}

const Row = memo(function Row({ listId, p, showCategory, selected, flash, edited, qtyEdited, upEdited, onToggle, onOpen, onMove }: RowProps) {
  const total = positionTotal(p)
  const remove = () => {
    useStore.getState().removePositions(listId, [p.id])
    toast(`Removed ${p.oz}`, 'ok', { label: 'Undo', run: () => useStore.getState().restorePositions(listId, [p.id]) })
  }
  const hasShort = p.short && p.short !== '(ohne Kurztext)'
  const zero = p.up != null && p.qty === 0
  const setUp = (v: number | null) => useStore.getState().setUp(listId, p.id, v)
  return (
    <tr
      data-pid={p.id}
      data-row="position"
      className={clsx(
        'group transition-colors',
        selected ? 'bg-brand-50/70' : 'hover:bg-slate-100',
        flash && 'bg-brand-50 outline-2 -outline-offset-2 outline-brand-300',
      )}
    >
      <td data-a="cb" className="w-10 py-1 pl-2 align-middle">
        <label className="cb-reveal flex size-9 cursor-pointer items-center justify-center rounded-md hover:bg-slate-100">
          <input type="checkbox" className="checkbox" checked={selected} onChange={() => onToggle(p.id)} aria-label={`Select ${p.oz} ${p.short}`} />
        </label>
      </td>
      <td data-a="hide" className="w-[88px] px-2 py-1 font-mono text-[13px] whitespace-nowrap text-slate-600 tabular-nums">{p.oz}</td>
      <td data-a="title" className="min-w-0 px-2 py-1">
        <button
          type="button"
          data-open-detail
          onClick={() => onOpen(p)}
          aria-haspopup="dialog"
          title="Show full description"
          className={clsx('block max-w-full text-left text-[15px] underline-offset-4 hover:underline max-lg:line-clamp-2 max-lg:font-medium lg:truncate', zero ? 'text-slate-500' : 'text-slate-900')}
        >
          {/* cards lead with the OZ, the way the group headers do */}
          <span className="mr-1.5 font-mono text-[13px] font-normal text-slate-600 lg:hidden">{p.oz}</span>
          {hasShort ? nbHyphen(p.short) : <span className="text-slate-600 italic">(ohne Kurztext)</span>}
          <span className="sr-only">, open details</span>
        </button>
        {showCategory && <div className="mt-0.5 truncate text-[13px] text-slate-600">{p.category}</div>}
      </td>
      <td data-a="qty" className="relative w-24 py-1 pr-1 pl-2 text-right">
        <span className="hidden lg:inline"><EditDot on={qtyEdited} /></span>
        <div className="flex items-center gap-1.5 lg:block">
          <QtyInput value={p.qty} label={p.oz} edited={qtyEdited} muted={zero} onChange={(n) => useStore.getState().setQty(listId, p.id, n)} />
          <span className="text-sm whitespace-nowrap text-slate-600 lg:hidden">{p.unit || '—'} ×</span>
          <span className="relative lg:hidden">
            <PriceCell value={p.up} oz={p.oz} edited={upEdited} muted={zero} onSave={setUp} className="w-auto min-w-20" />
          </span>
          {edited && <span className="size-1.5 shrink-0 rounded-md bg-brand-600 lg:hidden" aria-hidden title="Edited" />}
        </div>
      </td>
      <td data-a="hide" className={clsx('w-16 py-1 pr-2 pl-1 text-sm whitespace-nowrap', zero ? 'text-slate-500' : 'text-slate-600')}>{p.unit || <span aria-label="no unit">—</span>}</td>
      <td data-a="hide" className="relative w-[120px] py-1 pr-1 pl-2 text-right">
        <EditDot on={upEdited} />
        <PriceCell value={p.up} oz={p.oz} edited={upEdited} muted={zero} onSave={setUp} />
      </td>
      {/* desktop GP sits under the "GP (€)" header; cards have no header, so they carry the € */}
      <td data-a="total" className={clsx('num w-32 px-2 py-1 text-right text-sm whitespace-nowrap', p.up == null || zero ? 'text-slate-500' : 'font-medium text-slate-900')}>
        <span className="inline-flex h-9 items-center justify-end">
          {p.up == null ? 'Not priced' : zero ? <span aria-label="0 €, quantity 0">—</span> : <>{amount(total)}<span className="lg:hidden">&nbsp;€</span></>}
        </span>
      </td>
      <td data-a="menu" className="w-11 py-1 pr-1 text-right">
        <Menu
          label={`Actions for ${p.oz}`}
          width="w-56"
          items={[
            { label: 'Open details', icon: 'open_in_full', onSelect: () => onOpen(p) },
            { label: 'Move to category…', icon: 'drive_file_move', onSelect: () => onMove(p.id) },
            ...(edited ? [{ label: 'Reset changes', icon: 'restart_alt', onSelect: () => useStore.getState().resetPosition(listId, p.id) }] : []),
            'sep',
            { label: 'Remove', icon: 'delete', danger: true, onSelect: remove },
          ]}
          trigger={(t) => (
            <button {...t} type="button" aria-label={`Actions for ${p.oz}`} className="inline-flex size-10 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-slate-200/70 hover:text-slate-900">
              <Icon name="more_horiz" size={20} />
            </button>
          )}
        />
      </td>
    </tr>
  )
})

export function LedgerTable({
  listId, rows, tree, showEmpty, selected, setSelected, focusId, onOpen, onMove, editedIds, qtyEdited, upEdited, sortActive, selectMode,
}: {
  /** category tree; rows are grouped under it unless a sort is active */
  tree: CategoryNode[]
  /** show categories with no positions (only when nothing is filtered) */
  showEmpty: boolean
  /** touch layouts hide the checkboxes until the user turns on selection */
  selectMode?: boolean
  listId: string
  /** already filtered + sorted */
  rows: Position[]
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  focusId?: string | null
  onOpen: (p: Position) => void
  onMove: (pid: string) => void
  editedIds: Set<string>
  qtyEdited: Set<string>
  upEdited: Set<string>
  sortActive: boolean
}) {
  const [flash, setFlash] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(() => new Set<string>())
  const headCb = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!focusId) return
    const target = rows.find((r) => r.id === focusId)
    const path = new Set(target?.path?.map((part) => part.oz))
    setCollapsed((prev) => (prev.size ? new Set([...prev].filter((oz) => !path.has(oz))) : prev))
    setFlash(focusId)
    const t = setTimeout(() => document.querySelector(`[data-pid="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
    const t2 = setTimeout(() => setFlash(null), 2600)
    return () => {
      clearTimeout(t)
      clearTimeout(t2)
    }
    // a focus request comes from navigation; editing rows should not scroll again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  /** one block per category: its header and the positions filed directly under it */
  type Block = { cat?: CategoryNode; depth: number; items: Position[] }
  const stats = useMemo(() => treeStats(rows), [rows])
  const blocks = useMemo(() => {
    if (sortActive) return [{ depth: 0, items: rows }] as Block[]
    const direct = new Map<string, Position[]>()
    for (const r of rows) {
      const oz = leafOz(r)
      const list = direct.get(oz)
      if (list) list.push(r)
      else direct.set(oz, [r])
    }
    const out: Block[] = []
    const loose = direct.get('')
    if (loose?.length) out.push({ depth: 0, items: loose })
    const walk = (nodes: CategoryNode[], depth: number) => {
      for (const cat of nodes) {
        if (!showEmpty && !stats.has(cat.oz)) continue
        const open = !collapsed.has(cat.oz)
        out.push({ cat, depth, items: open ? direct.get(cat.oz) ?? [] : [] })
        if (open) walk(cat.children, depth + 1)
      }
    }
    walk(tree, 0)
    return out
  }, [rows, tree, sortActive, showEmpty, stats, collapsed])
  const visible = useMemo(() => blocks.flatMap((b) => b.items), [blocks])
  const toggleCat = (oz: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(oz)) next.delete(oz)
    else next.add(oz)
    return next
  })

  const selectedVisible = visible.reduce((n, r) => n + (selected.has(r.id) ? 1 : 0), 0)
  const all = visible.length > 0 && selectedVisible === visible.length
  const selecting = selected.size > 0
  useEffect(() => {
    if (headCb.current) headCb.current.indeterminate = selectedVisible > 0 && !all
  }, [selectedVisible, all])

  const toggle = (id: string) => {
    const n = new Set(selected)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setSelected(n)
  }
  return (
    <div>
      <table className="ledger group/table w-full table-fixed border-collapse text-left" data-selecting={selecting || selectMode ? '' : undefined}>
        <thead className="[&_th]:sticky [&_th]:top-16 [&_th]:z-10 [&_th]:bg-white">
          <tr className="text-sm font-medium text-slate-600 [&_th]:border-b [&_th]:border-slate-200">
            <th scope="col" className="w-10 py-2 pl-2">
              <label className="cb-reveal flex size-9 cursor-pointer items-center justify-center rounded-md hover:bg-slate-100">
                <input
                  ref={headCb}
                  type="checkbox"
                  className="checkbox"
                  checked={all}
                  onChange={() => {
                    const next = new Set(selected)
                    for (const r of visible) {
                      if (all) next.delete(r.id)
                      else next.add(r.id)
                    }
                    setSelected(next)
                  }}
                  aria-label="Select all rows"
                />
              </label>
            </th>
            <th scope="col" className="w-[88px] px-2 py-2 font-medium">OZ</th>
            <th scope="col" className="px-2 py-2 font-medium">Kurztext</th>
            <th scope="col" className="w-24 py-2 pr-3 pl-2 text-right font-medium">
Menge
            </th>
            <th scope="col" className="w-16 py-2 pr-2 pl-1 font-medium">Einheit</th>
            <th scope="col" className="w-[120px] py-2 pr-3 pl-2 text-right font-medium">
EP (€)
            </th>
            <th scope="col" className="w-32 px-2 py-2 text-right font-medium">GP (€)</th>
            <th scope="col" className="w-11 py-2 pr-1"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        {blocks.map((b) => {
          const cat = b.cat
          const open = cat ? !collapsed.has(cat.oz) : true
          const top = b.depth === 0
          return (
            <tbody key={cat ? `c-${cat.oz}` : 'loose'}>
              {cat && (
                <tr data-group className={clsx('border-b', top ? 'border-slate-300' : 'border-slate-200')}>
                  <th scope="rowgroup" colSpan={6} className={clsx('py-0 pr-2 text-left', top ? 'display pt-6 text-base text-slate-900' : 'pt-3 text-sm font-semibold text-slate-800')}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleCat(cat.oz)}
                      className="-ml-1 flex min-h-10 max-w-full items-center gap-1.5 rounded-lg pr-2 text-left hover:bg-slate-100"
                      style={{ marginLeft: b.depth * 20 }}
                    >
                      <Icon name="expand_more" size={20} className={clsx('shrink-0 text-slate-500 transition-transform', !open && '-rotate-90')} />
                      <span className="shrink-0 font-mono text-[13px] font-medium text-slate-600">{cat.oz}</span>
                      <span className="truncate">{cat.label || cat.oz}</span>
                    </button>
                  </th>
                  <td colSpan={2} className={clsx('num px-2 pr-[3.25rem] text-right whitespace-nowrap', top ? 'display pt-6 text-base text-slate-900' : 'pt-3 text-sm font-semibold text-slate-800')}>
                    {!stats.has(cat.oz) ? (
                      <span className="text-sm font-normal text-slate-600">No positions yet</span>
                    ) : stats.get(cat.oz)!.total === 0 ? (
                      <span className="text-sm font-normal text-slate-600">{zeroWhy(stats.get(cat.oz)!)}</span>
                    ) : (
                      <>{amount(stats.get(cat.oz)!.total)}<span className="lg:hidden">&nbsp;€</span></>
                    )}
                  </td>
                </tr>
              )}
              {b.items.map((p) => (
                <Row
                  key={p.id}
                  listId={listId}
                  p={p}
                  showCategory={sortActive}
                  selected={selected.has(p.id)}
                  flash={flash === p.id}
                  edited={editedIds.has(p.id)}
                  qtyEdited={qtyEdited.has(p.id)}
                  upEdited={upEdited.has(p.id)}
                  onToggle={toggle}
                  onOpen={onOpen}
                  onMove={onMove}
                />
              ))}
            </tbody>
          )
        })}
      </table>
      {rows.length === 0 && (
        <div className="px-6 py-14 text-center">
          <span className="mx-auto mb-3 flex size-14 items-center justify-center rounded-md bg-slate-100 text-slate-600">
            <Icon name="search_off" size={28} />
          </span>
          <p className="text-base font-semibold text-slate-900">No positions match</p>
          <p className="mt-1 text-sm text-slate-600">Change the search or filters, or add a position.</p>
        </div>
      )}
    </div>
  )
}
