import { clsx } from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Icon, inputCls, toast } from '../ui'
import { downloadResult } from '../../lib/export/index'
import { pct, plural, qty } from '../../lib/format'
import { useMedia } from '../../lib/hooks'
import {
  categorize, endOfDay, fetchSourcing, groupBySupplier, isoInDays, logEvents, requestItems, rfqEml, rfqFileName, rfqMailto,
  rfqSubject, rfqText, setPositionCategory, shortDate, SOURCE_LABEL,
  type PositionCategory, type Sourcing, type SupplierGroup,
} from '../../lib/crm'
import { salutation } from '../../lib/subcontract'
import { copyText, loadSender, projectName, saveSender, slug } from '../../lib/subcontract-send'
import type { CategoryNode, ListDoc, Position } from '../../lib/types'

interface Props {
  open: boolean
  onClose: () => void
  listId: string
  doc: ListDoc
  resolved: { positions: Position[]; tree: CategoryNode[] }
  selectedIds?: string[]
}

const ease = [0.16, 1, 0.3, 1] as const

export function RequestQuotesOverlay(props: Props) {
  return createPortal(<AnimatePresence>{props.open && <Panel key="quotes" {...props} />}</AnimatePresence>, document.body)
}

function SourceBadge({ entry }: { entry: PositionCategory | undefined }) {
  if (!entry?.source) return <span className="rounded bg-amber-50 px-1.5 py-px text-[11px] font-semibold text-amber-800">No category</span>
  const tone = {
    user: 'bg-slate-100 text-slate-700',
    catalogue: 'bg-emerald-50 text-emerald-800',
    ai: 'bg-brand-50 text-brand-700',
    keyword: 'bg-slate-100 text-slate-600',
  }[entry.source]
  const confidence = entry.source === 'ai' || entry.source === 'keyword' ? entry.confidence : null
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-semibold whitespace-nowrap', tone)} title={entry.reason ?? entry.product?.name ?? undefined}>
      {entry.source === 'ai' && <Icon name="auto_awesome" size={12} />}
      {SOURCE_LABEL[entry.source]}
      {confidence != null && <span className="font-normal">{pct(confidence * 100)}</span>}
    </span>
  )
}

function Panel({ onClose, listId, doc, resolved, selectedIds }: Props) {
  const wide = useMedia('(min-width: 1024px)')
  const panel = useRef<HTMLDivElement>(null)
  const project = projectName(doc)
  const selection = useMemo(() => new Set(selectedIds ?? []), [selectedIds])
  const [scope, setScope] = useState<'selection' | 'all'>(selection.size ? 'selection' : 'all')
  const positions = useMemo(
    () => resolved.positions.filter((p) => (p.short || p.long) && (scope === 'all' || selection.has(p.id))),
    [resolved.positions, scope, selection],
  )
  const [sourcing, setSourcing] = useState<Sourcing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [categorizing, setCategorizing] = useState(false)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [logged, setLogged] = useState<Set<string>>(new Set())
  const [dueDate, setDueDate] = useState(() => isoInDays(7))
  const [remindDays, setRemindDays] = useState(3)
  const [sender, setSender] = useState(loadSender)
  const [pane, setPane] = useState<'categories' | 'suppliers'>('suppliers')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['']))

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null)
      setSourcing(await fetchSourcing(listId, positions, signal))
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message)
    }
  }, [listId, positions])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  /* ---------- keyboard: Escape and focus trap ---------- */
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Tab' && panel.current) {
        const f = [...panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null)
        if (!f.length) return
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [onClose])

  /* ---------- derived ---------- */
  const byPosition = useMemo(() => new Map((sourcing?.positions ?? []).map((p) => [p.id, p])), [sourcing])
  const grouping = useMemo(() => (sourcing ? groupBySupplier(positions, sourcing) : { groups: [], uncovered: [], uncategorized: [] }), [positions, sourcing])
  const chosen = grouping.groups.filter((g) => !excluded.has(g.supplier.id) && g.supplier.email)
  const pending = chosen.filter((g) => !logged.has(g.supplier.id))
  const counts = useMemo(() => {
    const c = { catalogue: 0, ai: 0, other: 0, none: 0 }
    for (const p of positions) {
      const s = byPosition.get(p.id)?.source
      if (!s) c.none++
      else if (s === 'catalogue') c.catalogue++
      else if (s === 'ai') c.ai++
      else c.other++
    }
    return c
  }, [positions, byPosition])
  const categoryGroups = useMemo(() => {
    const map = new Map<string, Position[]>()
    for (const p of positions) {
      const key = byPosition.get(p.id)?.category_id ?? ''
      map.set(key, [...(map.get(key) ?? []), p])
    }
    const names = new Map((sourcing?.categories ?? []).map((c) => [c.id, c.name]))
    const suppliersOf = (id: string) => (sourcing?.suppliers ?? []).filter((s) => s.category_ids.includes(id)).length
    return [...map.entries()]
      .map(([id, list]) => ({ id, name: id ? names.get(id) ?? 'Unknown category' : 'Without category', positions: list, suppliers: id ? suppliersOf(id) : 0 }))
      .sort((a, b) => (a.id === '' ? -1 : b.id === '' ? 1 : a.name.localeCompare(b.name, 'de')))
  }, [positions, byPosition, sourcing])

  const subjectFor = (g: SupplierGroup) => rfqSubject(project, g.positions.length)
  const textFor = (g: SupplierGroup) => rfqText({ salutation: salutation(g.supplier.contact_name), project, positions: g.positions, dueDate, sender })
  const categoryName = (id: string) => byPosition.get(id)?.category ?? null

  /* ---------- actions ---------- */
  const runCategorize = async (redo = false) => {
    setCategorizing(true)
    try {
      const view = await categorize(listId, positions, redo)
      setSourcing(view)
      const run = view.run
      if (run) {
        const how = run.method === 'ai' ? 'AI' : 'keyword matching'
        toast(run.checked
          ? `${how}: ${plural(run.assigned, 'position', 'positions')} categorized${run.without_category ? `, ${run.without_category} without material` : ''}`
          : 'Every position already has a category')
      }
    } catch (e) {
      toast(`Categorizing failed: ${(e as Error).message}`, 'error')
    } finally {
      setCategorizing(false)
    }
  }

  const changeCategory = async (positionId: string, categoryId: string | null) => {
    try {
      await setPositionCategory(listId, positionId, categoryId)
      await load()
    } catch (e) {
      toast(`Could not save the category: ${(e as Error).message}`, 'error')
    }
  }

  const log = async (groups: SupplierGroup[]) => {
    const fresh = groups.filter((g) => !logged.has(g.supplier.id))
    if (!fresh.length) return
    try {
      await logEvents(fresh.map((g) => ({
        kind: 'rfq_sent',
        party_kind: 'supplier',
        party_id: g.supplier.id,
        channel: 'email',
        list_id: listId,
        list_title: doc.title,
        subject: subjectFor(g),
        items: requestItems(g.positions, categoryName),
        due_at: dueDate ? endOfDay(dueDate) : undefined,
        remind_at: endOfDay(isoInDays(remindDays)),
      })))
      setLogged((s) => new Set([...s, ...fresh.map((g) => g.supplier.id)]))
      saveSender(sender)
      void load()
    } catch (e) {
      toast(`The request was prepared but could not be logged: ${(e as Error).message}`, 'error')
    }
  }

  const downloadEml = (g: SupplierGroup) => {
    const eml = rfqEml({ to: g.supplier.email, subject: subjectFor(g), text: textFor(g) })
    downloadResult({ data: new TextEncoder().encode(eml), fileName: rfqFileName(g.supplier.name, project), mime: 'message/rfc822', mode: 'generated' })
  }

  const openEmail = (g: SupplierGroup) => {
    const link = rfqMailto(g.supplier.email, subjectFor(g), textFor(g))
    if (link) window.location.assign(link)
    else downloadEml(g)
    void log([g])
    toast(link ? `Opened the email to ${g.supplier.name} and logged the request` : `The email to ${g.supplier.name} is long, so it downloaded as a draft (.eml). Logged the request.`)
  }

  const openNext = () => {
    const next = pending[0]
    if (next) openEmail(next)
  }

  const downloadAll = async () => {
    if (!chosen.length) return
    const { zipSync, strToU8 } = await import('fflate')
    const files: Record<string, Uint8Array> = {}
    for (const g of chosen) files[rfqFileName(g.supplier.name, project)] = strToU8(rfqEml({ to: g.supplier.email, subject: subjectFor(g), text: textFor(g) }))
    downloadResult({ data: zipSync(files, { level: 6 }), fileName: `Preisanfragen_${slug(project, 40)}.zip`, mime: 'application/zip', mode: 'generated' })
    await log(chosen)
    toast(`Downloaded ${plural(chosen.length, 'draft', 'drafts')} and logged the requests`)
  }

  const copy = async (g: SupplierGroup) => {
    const ok = await copyText(`${subjectFor(g)}\n\n${textFor(g)}`)
    toast(ok ? `Copied the email to ${g.supplier.name}. Mark it as sent once it is out.` : 'Copying failed. Select the text and copy it by hand.')
  }

  /* ---------- panes ---------- */
  const categoriesPane = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto font-heading text-sm font-bold text-slate-900">Categories</h3>
          <Button size="sm" variant="primary" icon="auto_awesome" disabled={categorizing || !sourcing || counts.none === 0} onClick={() => runCategorize(false)} data-testid="rq-categorize">
            {categorizing ? 'Categorizing…' : `Categorize ${counts.none ? plural(counts.none, 'open position', 'open positions') : 'open positions'}`}
          </Button>
          {(counts.ai > 0 || counts.other > 0) && (
            <Button size="sm" icon="refresh" disabled={categorizing} onClick={() => runCategorize(true)} title="Ask again for every position the AI or keyword guess categorized">Redo</Button>
          )}
        </div>
        <p className="text-xs text-slate-600">
          {plural(counts.catalogue, 'position', 'positions')} from catalogue matches · {counts.ai} by AI{counts.other ? ` · ${counts.other} other` : ''} · <span className={counts.none ? 'font-semibold text-amber-800' : ''}>{counts.none} without category</span>
          {sourcing && !sourcing.ai && <span className="block pt-1">No AI model is configured on the server, so open positions are matched by keywords against the catalogue.</span>}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {categoryGroups.map((group) => {
          const isOpen = openGroups.has(group.id)
          return (
            <div key={group.id || 'none'} className="border-b border-slate-100">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpenGroups((s) => { const n = new Set(s); if (n.has(group.id)) n.delete(group.id); else n.add(group.id); return n })}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 sm:px-5"
              >
                <Icon name={isOpen ? 'expand_more' : 'chevron_right'} size={18} className="text-slate-500" />
                <span className={clsx('min-w-0 flex-1 truncate text-sm font-semibold', group.id ? 'text-slate-900' : 'text-amber-800')}>{group.name}</span>
                <span className="num text-xs text-slate-600">{plural(group.positions.length, 'position', 'positions')}</span>
                {group.id && (
                  <span className={clsx('rounded px-1.5 py-px text-[11px] font-semibold', group.suppliers ? 'bg-slate-100 text-slate-700' : 'bg-red-50 text-red-700')}>
                    {group.suppliers ? plural(group.suppliers, 'supplier', 'suppliers') : 'No supplier'}
                  </span>
                )}
              </button>
              {isOpen && (
                <ul className="pb-2">
                  {group.positions.map((p) => {
                    const entry = byPosition.get(p.id)
                    return (
                      <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-1.5 pl-11 sm:px-5 sm:pl-12">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-slate-800" title={p.short}><span className="mr-2 font-mono text-xs text-slate-500">{p.oz}</span>{p.short || p.long?.slice(0, 80)}</p>
                          <div className="mt-0.5 flex min-w-0 items-center gap-2">
                            <SourceBadge entry={entry} />
                            {entry?.reason && <span className="truncate text-[11px] text-slate-500">{entry.reason}</span>}
                            {entry?.product && <span className="truncate text-[11px] text-slate-500">{entry.product.name}</span>}
                          </div>
                        </div>
                        <select
                          aria-label={`Category of ${p.oz} ${p.short}`}
                          value={entry?.category_id ?? ''}
                          onChange={(e) => changeCategory(p.id, e.target.value || null)}
                          className="h-8 max-w-44 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-800"
                        >
                          <option value="">No category</option>
                          {(sourcing?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  const supplierCard = (g: SupplierGroup) => {
    const s = g.supplier
    const off = excluded.has(s.id)
    const done = logged.has(s.id)
    const link = s.email ? rfqMailto(s.email, subjectFor(g), textFor(g)) : null
    return (
      <li key={s.id} className={clsx('rounded-lg border bg-white p-3 transition-colors', off ? 'border-slate-200 opacity-60' : done ? 'border-emerald-300' : 'border-slate-300')} data-testid="rq-supplier">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            aria-label={`Include ${s.name}`}
            checked={!off && !!s.email}
            disabled={!s.email}
            onChange={() => setExcluded((x) => { const n = new Set(x); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n })}
            className="mt-1 size-4 accent-[var(--color-brand-600)]"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-slate-900">{s.name}</p>
              {done && <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-px text-[11px] font-semibold text-emerald-800"><Icon name="check" size={12} />Logged as sent</span>}
              {!done && s.requested_at && (
                <span className="rounded bg-slate-100 px-1.5 py-px text-[11px] font-semibold text-slate-700" title="A quote request for this bill is already in the log">
                  {s.answered ? 'Answered' : 'Requested'} {shortDate(s.requested_at)}
                </span>
              )}
            </div>
            <p className="truncate text-xs text-slate-600">
              {s.email ? <>{s.contact_name ? `${s.contact_name} · ` : ''}{s.email}</> : <span className="font-semibold text-amber-800">No email address in the supplier catalogue</span>}
            </p>
            <p className="mt-1 text-xs text-slate-600">{g.categories.map((c) => c.name).join(', ')}</p>
            <ul className="mt-2 space-y-0.5 text-xs text-slate-700">
              {g.positions.slice(0, 4).map((p) => (
                <li key={p.id} className="flex gap-2"><span className="min-w-[12ch] shrink-0 whitespace-nowrap font-mono text-slate-500">{p.oz}</span><span className="min-w-0 flex-1 truncate">{p.short}</span><span className="num shrink-0 text-slate-500">{qty(p.qty)} {p.unit}</span></li>
              ))}
              {g.positions.length > 4 && <li className="text-slate-500">and {plural(g.positions.length - 4, 'more position', 'more positions')}</li>}
            </ul>
          </div>
        </div>
        {s.email && (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" icon="content_copy" onClick={() => copy(g)}>Copy text</Button>
            {!done && <Button size="sm" icon="done" onClick={() => log([g]).then(() => toast(`Logged the request to ${s.name}`))}>Mark as sent</Button>}
            <Button size="sm" icon="download" onClick={() => { downloadEml(g); void log([g]) }}>.eml</Button>
            <Button size="sm" variant={done ? 'secondary' : 'primary'} icon="mail" onClick={() => openEmail(g)} title={link ? undefined : 'Too long for a mail link: downloads as a draft instead'}>
              {link ? 'Open email' : 'Draft email'}
            </Button>
          </div>
        )}
      </li>
    )
  }

  const suppliersPane = (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50/50">
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="mr-auto font-heading text-sm font-bold text-slate-900">One email per supplier</h3>
          <Link to="/requests" className="text-xs font-semibold text-brand-700 hover:underline" onClick={onClose}>Manage supplier categories</Link>
        </div>
        {error && (
          <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <span className="flex-1">{error}</span>
            <Button size="sm" onClick={() => load()}>Retry</Button>
          </div>
        )}
        {!sourcing && !error && <p className="text-sm text-slate-600">Looking up suppliers…</p>}
        {sourcing && grouping.groups.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            No supplier delivers the categories of these positions yet. Categorize the open positions, or assign categories to suppliers on the Requests page.
          </p>
        )}
        <ul className="space-y-3">{grouping.groups.map(supplierCard)}</ul>
        {grouping.uncovered.length > 0 && (
          <p className="text-xs text-amber-800">{plural(grouping.uncovered.length, 'position has a category', 'positions have a category')} that no supplier delivers. They are in no email.</p>
        )}
        {grouping.uncategorized.length > 0 && (
          <p className="text-xs text-amber-800">{plural(grouping.uncategorized.length, 'position has', 'positions have')} no category and {grouping.uncategorized.length === 1 ? 'is' : 'are'} in no email.</p>
        )}
      </div>
      <div className="grid gap-3 border-t border-slate-200 px-4 py-4 sm:grid-cols-2 sm:px-5">
        <label className="block space-y-1">
          <span className="text-[11px] font-semibold text-slate-600">Offer due by</span>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} aria-label="Offer due by" />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-semibold text-slate-600">Remind me after</span>
          <select value={remindDays} onChange={(e) => setRemindDays(Number(e.target.value))} className={inputCls} aria-label="Remind me after">
            {[1, 2, 3, 5, 7, 10].map((d) => <option key={d} value={d}>{plural(d, 'day', 'days')} without an answer</option>)}
          </select>
        </label>
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[11px] font-semibold text-slate-600">Sender block</span>
          <textarea value={sender} onChange={(e) => setSender(e.target.value)} rows={4} className={clsx(inputCls, 'h-auto py-2')} aria-label="Sender block" />
        </label>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[78]">
      <motion.div className="absolute inset-0 bg-[var(--scrim)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quotes-title"
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24, transition: { duration: 0.16 } }}
        transition={{ duration: 0.22, ease }}
        className="absolute inset-0 flex flex-col overflow-hidden bg-white md:inset-6 md:rounded-lg md:border md:border-slate-300 lg:inset-8"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Icon name="request_quote" size={20} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="quotes-title" className="font-heading text-base font-bold tracking-tight text-slate-900">Request quotes from suppliers</h2>
            <p className="truncate text-xs text-slate-600">{doc.title}</p>
          </div>
          {selection.size > 0 && (
            <div role="group" aria-label="Positions" className="flex gap-1">
              {(['selection', 'all'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={scope === k} onClick={() => setScope(k)} className={clsx('rounded-md px-3 py-1.5 text-sm font-semibold transition-colors', scope === k ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
                  {k === 'selection' ? `Selected (${selection.size})` : 'Whole bill'}
                </button>
              ))}
            </div>
          )}
          <button type="button" aria-label="Close quote requests" onClick={onClose} className="flex size-10 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900">
            <Icon name="close" size={20} />
          </button>
        </header>
        {!wide && (
          <div role="group" aria-label="Panel" className="flex gap-1 border-b border-slate-100 p-2">
            {(['categories', 'suppliers'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={pane === k} onClick={() => setPane(k)} className={clsx('flex-1 rounded-lg py-1.5 text-xs font-semibold', pane === k ? 'bg-brand-50 text-brand-700' : 'text-slate-500')}>
                {k === 'categories' ? `Categories${counts.none ? ` (${counts.none} open)` : ''}` : `Suppliers (${grouping.groups.length})`}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1 divide-x divide-slate-100">
          {(wide || pane === 'categories') && <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:max-w-[48%]">{categoriesPane}</div>}
          {(wide || pane === 'suppliers') && suppliersPane}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/60 px-4 py-3 sm:px-5">
          <p className="min-w-0 text-xs text-slate-600" aria-live="polite">
            <span className="font-semibold text-slate-800">{plural(chosen.length, 'supplier', 'suppliers')}</span> · {plural(positions.length - grouping.uncovered.length - grouping.uncategorized.length, 'position', 'positions')} covered
            <span className="block text-[11px]">Emails open in your mail app. BillBuild logs a request as sent when you open or download it.</span>
          </p>
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>Close</Button>
            <Button icon="folder_zip" disabled={!chosen.length} onClick={downloadAll}>Download all (.eml)</Button>
            <Button variant="primary" size="lg" icon="forward_to_inbox" disabled={!pending.length} onClick={openNext} data-testid="rq-open-next">
              {pending.length ? `Open next email (${chosen.length - pending.length + 1} of ${chosen.length})` : chosen.length ? 'All emails prepared' : 'Open emails'}
            </Button>
          </div>
        </footer>
      </motion.div>
    </div>
  )
}
