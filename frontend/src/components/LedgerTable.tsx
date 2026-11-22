import { clsx } from 'clsx'
import { LineTypeBadge } from './LineType'
import type { LineType } from '../lib/line-type'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Menu, toast } from './ui'
import { QtyInput, editableCls } from './QtyStepper'
import { FindingBadge, RISK_UI } from './RiskAssessment'
import { amount, int, nbHyphen, parseNumber, plural } from '../lib/format'
import type { PriceSuggestion } from '../lib/price-suggestions'
import type { CatalogueReport } from '../lib/workspace-catalogue'
import { positionTotal } from '../lib/money'
import { useStore } from '../lib/store'
import { leafOz, treeStats, type CatStat } from '../lib/resolve'
import type { Severity } from '../lib/risk-assessment'
import type { CategoryNode, Position } from '../lib/types'

export type RowRisk = { severity?: Severity; count: number; signalCount: number; points: number; label: string }

/** why a section adds up to nothing, in the words the rows use */
function zeroWhy(s: CatStat, waiting: number) {
  // every position waits on a suggested price: say so in the words the rows use
  if (waiting > 0 && (waiting === s.count || s.unpriced === s.count)) return <><Icon name="schedule" size={16} className="mr-1 align-[-3px] text-slate-500" />{int(waiting)} pending</>
  if (s.unpriced === s.count) return 'Not priced'
  return amount(0)
}

function EditDot({ on }: { on: boolean }) {
  if (!on) return null
  return <span aria-hidden title="Edited" className="absolute top-1/2 left-0 size-1.5 -translate-y-1/2 rounded-md bg-brand-600" />
}

function PriceCell({ value, onSave, oz, edited, muted, className }: { value: number | null; onSave: (v: number | null) => void; oz: string; edited?: boolean; muted?: boolean; className?: string }) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState('')
  const done = useRef(false)
  // Enter or Escape closes the editor: put focus back on the price it came from
  const refocus = useRef(false)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!edit && refocus.current) {
      refocus.current = false
      btn.current?.focus()
    }
  }, [edit])

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
          if (e.key === 'Enter') {
            e.preventDefault()
            refocus.current = true
            commit()
          }
          if (e.key === 'Escape') {
            refocus.current = true
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
      ref={btn}
      type="button"
      aria-label={value == null ? `Set price for ${oz}` : `${amount(value)} €, edit unit price of ${oz}${edited ? ' (edited)' : ''}`}
      onClick={() => {
        done.current = false
        setText(value == null ? '' : amount(value))
        setEdit(true)
      }}
      className={clsx(
        value != null ? clsx(editableCls, edited ? 'font-semibold text-brand-700' : muted ? 'text-slate-600' : 'text-slate-900') : clsx(editableCls, 'font-semibold text-brand-700'),
        className ?? 'w-full',
      )}
    >
      {value != null ? amount(value) : 'Set price'}
    </button>
  )
}

/** a price the catalogue proposes: shown, but not counted, until the user confirms it */
function PendingPrice({ s, oz, onConfirm, onReview, className }: { s: PriceSuggestion; oz: string; onConfirm: () => void; onReview: () => void; className?: string }) {
  return (
    // the box ends where saved prices end, and the confirm slot is reserved so every pending amount lines up
    <span className={clsx('flex h-9 items-center justify-end gap-0.5', className ?? 'w-full')}>
      {s.unitKnown ? (
        <button
          type="button"
          onClick={onConfirm}
          title="Confirm price"
          aria-label={`Confirm ${amount(s.price)} € for ${oz}`}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-800 ring-1 ring-slate-300 ring-inset hover:bg-brand-100 hover:text-brand-900 hover:ring-brand-400"
        >
          <Icon name="check" size={18} />
        </button>
      ) : (
        <span aria-hidden className="size-8 shrink-0" />
      )}
      <button
        type="button"
        onClick={onReview}
        title={s.unitKnown ? `Suggested from the catalogue: ${s.product.name}` : 'The units differ: review before confirming'}
        aria-label={`Suggested unit price ${amount(s.price)} € for ${oz}, pending confirmation${s.unitKnown ? '' : ', unit needs checking'}. Review price`}
        className="num h-8 rounded-md border border-dashed border-slate-500 pr-1 pl-2 text-right text-sm text-slate-700 hover:bg-slate-100 hover:text-slate-900"
      >
        {amount(s.price)}
      </button>
    </span>
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
  risk?: RowRisk
  lineTypeSuggestion?: LineType
  /** catalogue price waiting for confirmation (only on positions without a price) */
  pending?: PriceSuggestion
  hasWebSuggestion: boolean
  onConfirmPrice?: (pid: string) => void
  onOpen: (p: Position, field?: 'findings' | 'web_suggestion') => void
  onMove: (pid: string) => void
}

const Row = memo(function Row({ listId, p, showCategory, selected, flash, edited, qtyEdited, upEdited, risk, lineTypeSuggestion, pending, hasWebSuggestion, onConfirmPrice, onToggle, onOpen, onMove }: RowProps) {
  const severity = risk ? risk.severity ?? 'info' : undefined
  const reviewLabel = risk && [
    risk.count > 0 && plural(risk.count, 'finding', 'findings'),
    risk.signalCount > 0 && plural(risk.signalCount, 'change-order signal', 'change-order signals'),
  ].filter(Boolean).join(' · ')
  const total = positionTotal(p)
  const remove = () => {
    useStore.getState().removePositions(listId, [p.id])
    toast(`Removed ${p.oz}`, 'ok', { label: 'Undo', run: () => useStore.getState().restorePositions(listId, [p.id]) })
  }
  const hasShort = p.short && p.short !== '(ohne Kurztext)'
  const zero = p.up != null && p.qty === 0
  const setUp = (v: number | null) => useStore.getState().setUp(listId, p.id, v)
  const suggested = p.up == null ? pending : undefined
  const price = (className?: string) => suggested
    ? <PendingPrice s={suggested} oz={p.oz} onConfirm={() => {
        // remember the neighbours: under the pending filter this row leaves the table
        const all = [...document.querySelectorAll<HTMLElement>('tr[data-row=position]')]
        const at = all.findIndex((tr) => tr.dataset.pid === p.id)
        const near = [all[at + 1], all[at - 1]].map((tr) => tr?.dataset.pid).filter(Boolean) as string[]
        onConfirmPrice?.(p.id)
        // the confirm button is gone now; keep focus on the same row's price, else the next row's
        requestAnimationFrame(() => {
          for (const id of [p.id, ...near]) {
            const el = document.querySelector<HTMLElement>(`tr[data-pid="${CSS.escape(id)}"] td[data-a=hide] button`)
            if (el) return el.focus()
          }
          document.querySelector<HTMLElement>('[data-results-heading]')?.focus()
        })
      }} onReview={() => onOpen(p)} className={className} />
    : (
      <div className="flex items-center justify-end gap-1">
        <PriceCell value={p.up} oz={p.oz} edited={upEdited} muted={zero} onSave={setUp}
          className={className ?? 'w-full min-w-0'} />
        {hasWebSuggestion && (
          <button type="button" aria-haspopup="dialog" aria-label={`View web suggestion for ${p.oz}`} title="View web suggestion"
            onClick={() => onOpen(p, 'web_suggestion')}
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-brand-200 bg-white px-1.5 text-[13px] font-medium text-brand-700 hover:border-brand-400 hover:bg-brand-50">
            <Icon name="language" size={16} />Web
          </button>
        )}
      </div>
    )
  return (
    <tr
      data-pid={p.id}
      data-row="position"
      data-risk={risk?.severity}
      className={clsx(
        'group transition-colors lg:relative',
        selected ? 'bg-brand-50/70' : severity ? RISK_UI[severity].tint : 'hover:bg-slate-100',
        severity && [RISK_UI[severity].row, 'lg:[&>td]:align-top'],
        flash && 'bg-brand-50 outline-2 -outline-offset-2 outline-brand-300',
      )}
    >
      <td data-a="cb" className="w-10 py-1 pl-2 align-middle">
        <label className="cb-reveal flex size-9 cursor-pointer items-center justify-center rounded-md hover:bg-slate-100">
          <input type="checkbox" className="checkbox" checked={selected} onChange={() => onToggle(p.id)} aria-label={`Select ${p.oz} ${p.short}`} />
        </label>
      </td>
      <td data-a="hide" className="px-2 py-3 font-mono text-[13px] leading-5 wrap-anywhere text-slate-600 tabular-nums lg:pl-[calc(0.5rem+var(--ind,0)*0.25rem)]">{p.oz}</td>
      <td data-a="title" className="min-w-0 px-2 py-1 lg:pl-[calc(0.5rem+var(--ind,0)*0.25rem)]">
        <button
          type="button"
          data-open-detail
          onClick={() => onOpen(p)}
          aria-haspopup="dialog"
          title="Show full description"
          lang="de"
          className={clsx('block max-w-full text-left text-[15px] underline-offset-4 hover:underline max-lg:line-clamp-2 max-lg:font-medium lg:truncate lg:leading-9', zero ? 'text-slate-600' : 'text-slate-900')}
        >
          {/* cards lead with the OZ, the way the group headers do */}
          <span lang="" className="mr-1.5 font-mono text-[13px] wrap-anywhere font-normal text-slate-600 lg:hidden">{p.oz}</span>
          {hasShort ? nbHyphen(p.short) : <span className="text-slate-600 italic">(ohne Kurztext)</span>}
          <span lang="en" className="sr-only">, open details</span>
        </button>
        <div className="mt-0.5"><LineTypeBadge position={p} suggestion={lineTypeSuggestion} /></div>
        {showCategory && <div className="mt-0.5 truncate text-[13px] text-slate-600">{p.category}</div>}
        {risk && severity && (
          <button
            type="button"
            onClick={() => onOpen(p, 'findings')}
            title={risk.label}
            aria-label={`Review ${reviewLabel} for ${p.oz}${hasShort ? ` ${p.short}` : ''}: ${risk.label}`}
            className="mb-1.5 block rounded-md max-lg:mt-1"
          >
            {/* the row says how much; the titles live in the drawer, so nothing here gets clipped */}
            <FindingBadge severity={severity}>
              {risk.severity && <>{RISK_UI[risk.severity].label}<span aria-hidden>·</span></>}
              <span className="font-normal">{reviewLabel}</span>
            </FindingBadge>
            {risk.points > 0 && <span className="num ml-2 text-[13px] text-slate-600">{plural(risk.points, 'risk point', 'risk points')}</span>}
          </button>
        )}
      </td>
      <td data-a="qty" className="relative w-24 py-1 pr-1 pl-2 text-right">
        <span className="hidden lg:inline"><EditDot on={qtyEdited} /></span>
        <div className={clsx('flex items-center gap-1.5 lg:block', hasWebSuggestion && 'flex-wrap')}>
          <QtyInput value={p.qty} label={p.oz} edited={qtyEdited} muted={zero} onChange={(n) => useStore.getState().setQty(listId, p.id, n)} />
          <span className="text-sm whitespace-nowrap text-slate-600 lg:hidden">{p.unit || '—'} ×</span>
          <span className="relative lg:hidden">
            {price(hasWebSuggestion ? 'w-auto min-w-20 max-w-28' : 'w-auto min-w-20')}
          </span>
          {edited && <span className="size-1.5 shrink-0 rounded-md bg-brand-600 lg:hidden" aria-hidden title="Edited" />}
        </div>
      </td>
      <td data-a="hide" className={clsx('w-16 py-1 pr-2 pl-1 text-sm leading-9 whitespace-nowrap text-slate-600')}>{p.unit || <span aria-label="no unit">—</span>}</td>
      <td data-a="hide" className="relative w-[148px] py-1 pr-1 pl-2 text-right">
        <EditDot on={upEdited} />
        {price()}
      </td>
      {/* desktop totals sit under the "Gesamtpreis (€)" header; cards have no header, so they carry the € */}
      <td data-a="total" className={clsx('num w-36 py-1 pr-2 pl-2 text-right lg:pr-0 text-sm whitespace-nowrap lg:[@media(hover:hover)]:transition-[padding] lg:[@media(hover:hover)]:group-focus-within:pr-12 lg:[@media(hover:hover)]:group-hover:pr-12 lg:[@media(hover:hover)]:group-has-[[aria-expanded=true]]:pr-12', suggested || p.up == null || zero ? 'text-slate-600' : 'font-medium text-slate-900')}>
        <span className="inline-flex h-9 items-center justify-end">
          {suggested ? <><Icon name="schedule" size={16} className="mr-1 text-slate-500" />Pending</> : p.up == null ? 'Not priced' : zero ? <>{amount(0)}<span className="lg:hidden">&nbsp;€</span></> : <>{amount(total)}<span className="lg:hidden">&nbsp;€</span></>}
        </span>
      </td>
      <td data-a="menu" className="w-11 py-1 pr-1 text-right lg:[@media(hover:hover)]:absolute lg:[@media(hover:hover)]:top-1/2 lg:[@media(hover:hover)]:right-0 lg:[@media(hover:hover)]:w-auto lg:[@media(hover:hover)]:-translate-y-1/2 lg:[@media(hover:hover)]:p-0">
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
            <button {...t} type="button" aria-label={`Actions for ${p.oz}`} className="inline-flex size-10 items-center justify-center rounded-md text-slate-600 transition-[color,background-color,opacity] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-slate-200/70 hover:text-slate-900 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:hover)]:opacity-0">
              <Icon name="more_horiz" size={20} />
            </button>
          )}
        />
      </td>
    </tr>
  )
})

const EMPTY = new Set<string>()
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

export function LedgerTable({
  listId, rows, tree, byOz, showEmpty, selected, setSelected, focusId, onOpen, onMove, editedIds, qtyEdited, upEdited, risks, lineTypes, pending, catalogue, onConfirmPrice, sortActive, selectMode, sectionsOpen = false,
}: {
  /** catalogue prices waiting for confirmation, by position id */
  pending?: ReadonlyMap<string, PriceSuggestion>
  catalogue?: CatalogueReport['positions']
  onConfirmPrice?: (pid: string) => void
  /** sections start collapsed so a long list reads as an outline; "Expand all" opens every level */
  sectionsOpen?: boolean
  /** category tree; rows are grouped under it unless a sort is active */
  tree: CategoryNode[]
  byOz: boolean
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
  onOpen: RowProps['onOpen']
  onMove: (pid: string) => void
  /** positions with open risk findings, by id */
  risks?: Map<string, RowRisk>
  lineTypes: ReadonlyMap<string, LineType>
  editedIds: Set<string>
  qtyEdited: Set<string>
  upEdited: Set<string>
  sortActive: boolean
}) {
  const [flash, setFlash] = useState<string | null>(null)
  // sections the user toggled away from the default. A search or filter opens everything so matches
  // are visible, and switching between filtered, unfiltered or "expand all" starts from a clean slate.
  const defaultOpen = sectionsOpen || !showEmpty
  const mode = `${sectionsOpen}|${showEmpty}`
  const [flips, setFlips] = useState(() => ({ mode, set: new Set<string>() }))
  const flipped = flips.mode === mode ? flips.set : EMPTY
  const isOpen = (oz: string) => defaultOpen !== flipped.has(oz)
  const headCb = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!focusId) return
    const target = rows.find((r) => r.id === focusId)
    const path = new Set(target?.path?.map((part) => part.oz))
    // open the sections that lead to the requested position
    setFlips((prev) => {
      const set = new Set(prev.mode === mode ? prev.set : EMPTY)
      for (const oz of path) {
        if (defaultOpen) set.delete(oz)
        else set.add(oz)
      }
      return { mode, set }
    })
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
  const listTotal = useMemo(() => rows.reduce((sum, p) => sum + positionTotal(p), 0), [rows])
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
        const open = defaultOpen !== flipped.has(cat.oz)
        out.push({ cat, depth, items: open ? direct.get(cat.oz) ?? [] : [] })
        if (open) walk(cat.children, depth + 1)
      }
    }
    walk(tree, 0)
    return out
  }, [rows, tree, sortActive, showEmpty, stats, flipped, defaultOpen])
  const visible = useMemo(() => blocks.flatMap((b) => b.items), [blocks])
  const toggleCat = (oz: string) => setFlips((prev) => {
    const set = new Set(prev.mode === mode ? prev.set : EMPTY)
    if (set.has(oz)) set.delete(oz)
    else set.add(oz)
    return { mode, set }
  })
  /** worst open finding inside a collapsed section, so flagged rows stay visible as a hint */
  const sectionRisk = (oz: string) => {
    if (!risks?.size) return null
    let worst: Severity | null = null
    let count = 0
    let points = 0
    for (const pid of stats.get(oz)?.pids ?? []) {
      const risk = risks.get(pid)
      if (!risk) continue
      count++
      points += risk.points
      const severity = risk.severity ?? 'info'
      if (!worst || SEVERITY_RANK[severity] < SEVERITY_RANK[worst]) worst = severity
    }
    return worst ? { severity: worst, count, points } : null
  }

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
          <tr className="text-[13px] font-semibold text-slate-800 [&_th]:border-b-2 [&_th]:border-slate-300">
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
            <th scope="col" className="w-32 px-2 py-2 font-medium">OZ</th>
            <th scope="col" className="px-2 py-2 font-medium">Kurztext</th>
            <th scope="col" className={clsx('w-24 py-2 pr-3 pl-2 text-right font-medium', !visible.length && 'text-transparent')}>
Menge
            </th>
            <th scope="col" className={clsx('w-16 py-2 pr-2 pl-1 font-medium', !visible.length && 'text-transparent')}>Einheit</th>
            <th scope="col" className={clsx('w-[148px] py-2 pr-3 pl-2 text-right font-medium', !visible.length && 'text-transparent')}>
Einheitspreis (€)
            </th>
            <th scope="col" className="w-36 py-2 pr-2 pl-2 text-right font-medium lg:pr-0">Gesamtpreis (€)</th>
            <th scope="col" className="w-11 py-2 pr-1 lg:[@media(hover:hover)]:w-0 lg:[@media(hover:hover)]:p-0"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        {blocks.map((b) => {
          const cat = b.cat
          const open = cat ? isOpen(cat.oz) : true
          const flagged = cat ? sectionRisk(cat.oz) : null
          const top = b.depth === 0
          return (
            // a sub-section and its positions step in one level per depth (capped at three), so the tree reads at a glance
            <tbody key={cat ? `c-${cat.oz}` : 'loose'} style={{ '--ind': Math.min(b.depth, 3) } as React.CSSProperties}>
              {cat && (() => {
                const st = stats.get(cat.oz)
                const sectionIds = st?.pids ?? []
                const sectionChecked = sectionIds.length > 0 && sectionIds.every((id) => selected.has(id))
                const sectionMixed = !sectionChecked && sectionIds.some((id) => selected.has(id))
                const waiting = st && pending?.size ? st.pids.reduce((n, pid) => n + (pending.has(pid) ? 1 : 0), 0) : 0
                return (
                  <tr
                    data-group
                    data-depth={b.depth}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest('button, label')) toggleCat(cat.oz) }}
                    // an open section is a band over its rows, so the tree reads before a single word does; sub-sections are lighter bands
                    className={clsx('cursor-pointer border-b transition-colors', top ? (open ? 'border-slate-300 bg-slate-100 hover:bg-slate-200/70' : 'border-slate-200 hover:bg-slate-50') : 'border-slate-200 bg-slate-50 hover:bg-slate-100')}
                  >
                    <th scope="rowgroup" colSpan={6} className="p-0 text-left font-normal">
                      <div className="flex items-start">
                        <label className="mt-1 ml-2 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-slate-200 max-lg:mt-0.5 max-lg:ml-0 has-disabled:cursor-default">
                          <input
                            ref={(input) => { if (input) input.indeterminate = sectionMixed }}
                            type="checkbox"
                            className="checkbox disabled:cursor-default disabled:opacity-50"
                            aria-label={`Select all positions in ${cat.label || cat.oz}`}
                            checked={sectionChecked}
                            disabled={!sectionIds.length}
                            onChange={(event) => {
                              const next = new Set(selected)
                              for (const id of sectionIds) {
                                if (event.target.checked) next.add(id)
                                else next.delete(id)
                              }
                              setSelected(next)
                            }}
                          />
                        </label>
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => toggleCat(cat.oz)}
                            className="flex min-h-11 w-full items-center pl-[calc(var(--ind,0)*16px)] text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-inset max-lg:min-h-10 lg:pl-[calc(var(--ind,0)*28px)]"
                          >
                            <span className="flex w-10 shrink-0 justify-center pl-2 max-lg:w-7 max-lg:justify-start max-lg:pl-0">
                              <Icon name="chevron_right" size={18} className={clsx('text-slate-600 transition-transform', open && 'rotate-90')} />
                            </span>
                            {!byOz && <span className={clsx('w-[88px] shrink-0 px-2 font-mono text-[13px] tabular-nums max-lg:w-auto max-lg:pr-2 max-lg:pl-0', top ? 'font-semibold text-slate-900' : 'text-slate-700')}>{cat.oz}</span>}
                            <span className="flex min-w-0 flex-1 items-baseline gap-2.5 px-2 max-lg:flex-col max-lg:items-start max-lg:gap-0 max-lg:pl-0">
                              <span lang="de" className={clsx('min-w-0 hyphens-auto max-lg:line-clamp-2 max-lg:break-words lg:line-clamp-2 2xl:truncate', top ? 'text-[15px] font-bold text-slate-900' : 'text-sm font-semibold text-slate-900')}>{cat.label || cat.oz}</span>
                              {!open && st && (
                                <span className="num shrink-0 text-[13px] text-slate-600">
                                  {plural(st.count, 'position', 'positions')}
                                  {/* where the money is, without expanding: each top section's share of the list */}
                                  {top && showEmpty && listTotal > 0 && st.total > 0 && <span className="ml-2 text-slate-600">{st.total / listTotal < 0.01 ? '< 1' : Math.round((st.total / listTotal) * 100)}% of list</span>}
                                  {waiting > 0 && st.total > 0 && <span className="ml-2 font-medium text-slate-700">{int(waiting)} pending</span>}
                                </span>
                              )}
                            </span>
                          </button>
                          {flagged && (!open || flagged.points > 0) && (
                            <span className="-mt-1 mb-2 flex flex-wrap items-center gap-2 pl-[calc(136px+var(--ind,0)*28px)] text-sm max-lg:pl-[calc(1.75rem+var(--ind,0)*16px)]">
                              {!open && <FindingBadge severity={flagged.severity}>{plural(flagged.count, 'flagged position', 'flagged positions')}</FindingBadge>}
                              {flagged.points > 0 && <span className="num text-[13px] text-slate-600">{plural(flagged.points, 'risk point', 'risk points')}</span>}
                            </span>
                          )}
                        </div>
                      </div>
                    </th>
                    <td colSpan={2} className={clsx('num px-2 pr-[3.25rem] text-right whitespace-nowrap lg:[@media(hover:hover)]:pr-0', top ? 'text-[15px] font-bold text-slate-900' : 'text-sm font-semibold text-slate-900')}>
                      {!st ? (
                        <span className="text-sm font-normal text-slate-500">No positions yet</span>
                      ) : st.total === 0 ? (
                        <span className="text-sm font-normal text-slate-600">{zeroWhy(st, waiting)}</span>
                      ) : (
                        <>{amount(st.total)}<span className="lg:hidden">&nbsp;€</span></>
                      )}
                    </td>
                  </tr>
                )
              })()}
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
                  risk={risks?.get(p.id)}
                  lineTypeSuggestion={lineTypes.get(p.id)}
                  pending={pending?.get(p.id)}
                  hasWebSuggestion={Boolean(catalogue?.[p.id]?.suggestion)}
                  onConfirmPrice={onConfirmPrice}
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
