import { clsx } from 'clsx'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Menu, toast } from './ui'
import { QtyStepper } from './QtyStepper'
import { money } from '../lib/format'
import { positionTotal } from '../lib/money'
import { unitIcon } from '../lib/actions'
import { useStore } from '../lib/store'
import type { Position } from '../lib/types'

const PAGE = 100

function PriceCell({ value, onSave, label }: { value: number | null; onSave: (v: number | null) => void; label: string }) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState('')
  const done = useRef(false)

  const commit = () => {
    if (done.current) return
    done.current = true
    setEdit(false)
    const t = text.trim().replace(/\s/g, '')
    if (t === '') {
      if (value !== null) onSave(null)
      return
    }
    const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t)
    if (Number.isFinite(n) && n >= 0 && n !== value) onSave(Math.round(n * 100) / 100)
  }

  if (edit) {
    return (
      <input
        autoFocus
        inputMode="decimal"
        aria-label={`Unit price of ${label}`}
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
        className="h-7 w-28 rounded-md border border-brand-500 bg-white px-2 text-right font-mono text-xs text-slate-900 ring-1 ring-brand-500 outline-none"
      />
    )
  }
  return (
    <button
      type="button"
      aria-label={`Edit unit price of ${label}`}
      onClick={() => {
        done.current = false
        setText(value == null ? '' : String(value))
        setEdit(true)
      }}
      className="group/price -my-1 rounded-md px-1.5 py-1 text-right font-mono font-medium text-slate-600 transition-colors hover:bg-slate-100"
    >
      {value != null ? (
        money(value)
      ) : (
        <>
          <span className="text-slate-300 group-hover/price:hidden group-focus-visible/price:hidden">—</span>
          <span className="hidden font-sans text-[11px] font-semibold text-brand-600 group-hover/price:inline group-focus-visible/price:inline">Set price</span>
        </>
      )}
    </button>
  )
}

interface RowProps {
  listId: string
  p: Position
  selected: boolean
  hot: boolean
  flash: boolean
  onToggle: (id: string) => void
  edited: boolean
  onOpen: (p: Position) => void
  onMove: (pid: string) => void
}

const Row = memo(function Row({ listId, p, selected, hot, flash, edited, onToggle, onOpen, onMove }: RowProps) {
  const total = positionTotal(p)
  const remove = () => {
    const st = useStore.getState()
    st.removePositions(listId, [p.id])
    toast(`Removed ${p.oz}`, 'ok', { label: 'Undo', run: () => useStore.getState().restorePositions(listId, [p.id]) })
  }
  return (
    <tr data-pid={p.id} className={clsx('group transition-colors hover:bg-slate-50/80', selected && 'bg-brand-50/40', flash && 'bg-brand-50 outline outline-1 -outline-offset-1 outline-brand-300')}>
      <td className="py-4 pr-2 pl-4 max-lg:sticky max-lg:left-0 max-lg:z-[1] max-lg:bg-white">
        <input type="checkbox" className="checkbox" checked={selected} onChange={() => onToggle(p.id)} aria-label={`Select ${p.oz} ${p.short}`} />
      </td>
      <td className="px-3 py-4 max-lg:sticky max-lg:left-10 max-lg:z-[1] max-lg:bg-white">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-600">
            <Icon name={unitIcon(p.unit)} size={18} />
          </div>
          <div className="min-w-0">
            <button type="button" onClick={() => onOpen(p)} title="Show full description" className="block max-w-full truncate text-left text-xs font-semibold text-slate-900 hover:text-brand-600">
              {p.short && p.short !== '(ohne Kurztext)' ? p.short : <span className="font-normal text-slate-400 italic">(ohne Kurztext)</span>}
            </button>
            <div className="truncate font-mono text-[11px] text-slate-400">OZ: {p.oz}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-4">
        <span className="block w-fit max-w-full truncate rounded-md bg-slate-100 px-2 py-0.5 align-middle text-[11px] font-medium text-slate-600" title={`${p.path?.[p.path.length - 1]?.oz ?? ''} ${p.category}`.trim()}>{p.category}</span>
      </td>
      <td className="px-3 py-4 text-right text-xs">
        <PriceCell value={p.up} label={p.oz} onSave={(v) => useStore.getState().setUp(listId, p.id, v)} />
      </td>
      <td className="px-3 py-4 text-center">
        <QtyStepper value={p.qty} label={p.oz} onChange={(n) => useStore.getState().setQty(listId, p.id, n)} />
      </td>
      <td className={clsx('px-3 py-4 text-right font-mono text-xs font-bold', hot ? 'text-amber-600' : total ? 'text-slate-900' : 'text-slate-300')}>
        {hot && <Icon name="local_fire_department" size={14} className="mr-1 -mt-0.5 inline-block align-middle" />}
        {p.up == null ? '—' : money(total)}
      </td>
      <td className="px-3 py-4 text-xs font-medium whitespace-nowrap text-slate-600">{p.unit}</td>
      <td className="py-4 pr-3 pl-3 text-right whitespace-nowrap">
        <button
          type="button"
          onClick={remove}
          title="Remove line"
          aria-label={`Remove ${p.oz}`}
          className="rounded p-1 text-slate-400 opacity-70 transition-all group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600"
        >
          <Icon name="delete" size={17} />
        </button>
        <Menu
          label={`Actions for ${p.oz}`}
          width="w-52"
          items={[
            { label: 'Edit details', icon: 'edit_note', onSelect: () => onOpen(p) },
            { label: 'Move to category…', icon: 'drive_file_move', onSelect: () => onMove(p.id) },
            ...(edited ? [{ label: 'Reset changes', icon: 'restart_alt', onSelect: () => useStore.getState().resetPosition(listId, p.id) }] : []),
            'sep',
            { label: 'Remove', icon: 'delete', danger: true, onSelect: remove },
          ]}
          trigger={(t) => (
            <button {...t} type="button" aria-label={`Actions for ${p.oz}`} className="rounded p-1 text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-700">
              <Icon name="more_vert" size={17} />
            </button>
          )}
        />
        {edited && <span className="sr-only">edited</span>}
      </td>
    </tr>
  )
})

export function LedgerTable({
  listId, rows, allPositions, selected, setSelected, over75, focusId, onOpen, onMove, editedIds, sortActive, onResetSort, resetKey, footer,
}: {
  listId: string
  /** already filtered + sorted */
  rows: Position[]
  allPositions: Position[]
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  over75: boolean
  focusId?: string | null
  onOpen: (p: Position) => void
  onMove: (pid: string) => void
  editedIds: Set<string>
  sortActive: boolean
  onResetSort: () => void
  resetKey: string
  footer?: React.ReactNode
}) {
  const [limit, setLimit] = useState(PAGE)
  const [flash, setFlash] = useState<string | null>(null)
  const headCb = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atEnd, setAtEnd] = useState(false)
  const onScroll = () => {
    const el = scrollRef.current
    if (el) setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4)
  }
  useEffect(() => {
    onScroll()
    window.addEventListener('resize', onScroll)
    return () => window.removeEventListener('resize', onScroll)
  }, [])

  const hotId = useMemo(() => {
    if (!over75) return null
    let best: Position | null = null
    for (const p of allPositions) if (!best || positionTotal(p) > positionTotal(best)) best = p
    return best && positionTotal(best) > 0 ? best.id : null
  }, [allPositions, over75])

  useEffect(() => setLimit(PAGE), [resetKey])

  useEffect(() => {
    if (!focusId) return
    const i = rows.findIndex((r) => r.id === focusId)
    if (i < 0) return
    if (i >= limit) setLimit(Math.ceil((i + 1) / PAGE) * PAGE)
    setFlash(focusId)
    const t = setTimeout(() => document.querySelector(`[data-pid="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
    const t2 = setTimeout(() => setFlash(null), 2600)
    return () => {
      clearTimeout(t)
      clearTimeout(t2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  const selectedVisible = rows.reduce((n, r) => n + (selected.has(r.id) ? 1 : 0), 0)
  const all = rows.length > 0 && selectedVisible === rows.length
  useEffect(() => {
    if (headCb.current) headCb.current.indeterminate = selectedVisible > 0 && !all
  }, [selectedVisible, all])

  const toggle = (id: string) => {
    const n = new Set(selected)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setSelected(n)
  }
  const shown = rows.slice(0, limit)

  return (
    <div className="mt-3.5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
      {sortActive && (
        <div className="flex items-center gap-2 border-b border-slate-100 bg-amber-50/60 px-4 py-2 text-xs text-amber-900">
          <Icon name="sort" size={15} />
          Sorted by subtotal, highest first
          <button type="button" onClick={onResetSort} className="font-semibold underline-offset-2 hover:underline">Reset order</button>
        </div>
      )}
      <div className="relative">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative overflow-auto md:max-h-[calc(100vh-520px)] md:min-h-[320px]"
      >
        <table className="w-full min-w-[900px] table-fixed border-collapse text-left">
          <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-slate-50">
            <tr className="border-b border-slate-200 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
              <th scope="col" className="w-10 py-3 pr-2 pl-4 max-lg:left-0 max-lg:z-20">
                <input
                  ref={headCb}
                  type="checkbox"
                  className="checkbox"
                  checked={all}
                  onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))}
                  aria-label="Select all rows"
                />
              </th>
              <th scope="col" className="px-3 py-3 max-lg:left-10 max-lg:z-20">OZ / Kurztext</th>
              <th scope="col" className="w-40 px-3 py-3">Kategorie</th>
              <th scope="col" className="w-28 px-3 py-3 text-right">Einheitspreis</th>
              <th scope="col" className="w-36 px-3 py-3 text-center">Menge</th>
              <th scope="col" className="w-28 px-3 py-3 text-right">Gesamt</th>
              <th scope="col" className="w-20 px-3 py-3">Einheit</th>
              <th scope="col" className="w-20 py-3 pr-3 pl-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((p) => (
              <Row key={p.id} listId={listId} p={p} selected={selected.has(p.id)} hot={p.id === hotId} flash={flash === p.id} edited={editedIds.has(p.id)} onToggle={toggle} onOpen={onOpen} onMove={onMove} />
            ))}
          </tbody>
        </table>
      {rows.length === 0 && (
        <div className="px-6 py-14 text-center">
          <Icon name="search_off" size={30} className="text-slate-300" />
          <p className="mt-2 text-sm font-semibold text-slate-700">No positions to show</p>
          <p className="mt-0.5 text-xs text-slate-500">Adjust the search or category filter, or add an item.</p>
        </div>
      )}
      <div className="sticky left-0 flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-xs text-slate-500">
        <span>
          Showing <span className="font-mono font-semibold text-slate-700">{shown.length}</span> of <span className="font-mono font-semibold text-slate-700">{rows.length}</span> positions
          {rows.length !== allPositions.length && <> (filtered from {allPositions.length})</>}
        </span>
        {rows.length > limit && (
          <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 font-medium text-slate-700 shadow-xs transition-colors hover:bg-slate-50">
            Show more
            <span className="font-mono text-slate-400">+{Math.min(PAGE, rows.length - limit)}</span>
          </button>
        )}
      </div>
      </div>
      <div aria-hidden className={clsx('pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-white via-white/70 to-transparent transition-opacity duration-200 lg:hidden', atEnd && 'opacity-0')} />
      </div>
      {footer}
    </div>
  )
}
