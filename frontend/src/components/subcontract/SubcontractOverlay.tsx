import { clsx } from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Icon, inputCls, toast } from '../ui'
import { WhatPane } from './WhatPane'
import { WhoPane } from './WhoPane'
import { CostPane } from './CostPane'
import { SendPane } from './SendPane'
import { PackageList } from './PackageList'
import { useSubcontractors } from './useSubcontractors'
import { downloadResult, layoutLoader } from '../../lib/export/index'
import { amount, money, parseNumber, plural } from '../../lib/format'
import { useMedia } from '../../lib/hooks'
import { useStore } from '../../lib/store'
import {
  composeEmail, defaultPackageName, emailBody, emailSubject, findConflicts, makeBudget, mergeSavedPackage, newPackageId, prefillBudget, pruneMissing,
  removePackage, salutation, sectionLabels, setStatus, suggestSubcontractors, toRequest, upsertPackage,
  type SubcontractFormat, type SubcontractPackage,
} from '../../lib/subcontract'
import { copyText, exportAndDraft, loadSender, projectName, saveSender, type Recipient } from '../../lib/subcontract-send'
import type { CategoryNode, ListDoc, Position } from '../../lib/types'

interface Props {
  open: boolean
  onClose: () => void
  listId: string
  doc: ListDoc
  /** the list as the user sees it (final OZ, tree order) */
  resolved: { positions: Position[]; tree: CategoryNode[] }
  /** the positions selected in the list, the starting selection of a new request */
  selectedIds?: string[]
}

const EMPTY: SubcontractPackage[] = []
const ease = [0.16, 1, 0.3, 1] as const

export function SubcontractOverlay(props: Props) {
  return createPortal(<AnimatePresence>{props.open && <Panel key="subcontract" {...props} />}</AnimatePresence>, document.body)
}

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3 border-b border-slate-100 px-4 py-4 last:border-0 sm:px-5">
      <h3 className="flex items-baseline gap-2 font-heading text-sm font-bold text-slate-900">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] text-brand-700">{n}</span>
        {title}
        {hint && <span className="text-xs font-normal text-slate-600">{hint}</span>}
      </h3>
      {children}
    </section>
  )
}

function Panel({ onClose, listId, doc, resolved, selectedIds }: Props) {
  const wide = useMedia('(min-width: 768px)')
  const panel = useRef<HTMLDivElement>(null)
  const stored = useStore((s) => s.listPatch[listId]?.subcontractPackages)
  const packages = stored ?? EMPTY
  const subs = useSubcontractors(true)

  const existing = useMemo(() => new Set(resolved.positions.map((p) => p.id)), [resolved.positions])
  const prefill = useMemo(() => prefillBudget(resolved.positions), [resolved.positions])
  const project = projectName(doc)

  const [view, setView] = useState<'new' | 'packages'>('new')
  const [pane, setPane] = useState<'what' | 'details'>('what')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(() => new Set((selectedIds ?? []).filter((id) => existing.has(id))))
  const [keepHere, setKeepHere] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [subIds, setSubIds] = useState<string[]>([])
  const [costText, setCostText] = useState<Record<string, string>>({})
  const [totalText, setTotalText] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [format, setFormat] = useState<SubcontractFormat>('x83')
  const [bodyOverride, setBodyOverride] = useState<string | null>(null)
  const [sender, setSender] = useState(loadSender)
  const [busy, setBusy] = useState(false)

  /* ---------- derived ---------- */
  const chosen = useMemo(() => resolved.positions.filter((p) => sel.has(p.id)), [resolved.positions, sel])
  const chosenIds = useMemo(() => chosen.map((p) => p.id), [chosen])
  const packageName = (nameTouched ? name : defaultPackageName(chosen)).trim()
  const conflicts = useMemo(
    () => findConflicts(packages, chosenIds, editingId ?? undefined).filter((c) => !keepHere.has(c.positionId)),
    [packages, chosenIds, editingId, keepHere],
  )
  const suggested = useMemo(
    () => suggestSubcontractors(subs.rows, [packageName, ...sectionLabels(chosen)]),
    [subs.rows, packageName, chosen],
  )
  const recipients: Recipient[] = useMemo(
    () => subIds.flatMap((id) => {
      const e = subs.rows.find((r) => r.id === id)
      return e ? [{ id: e.id, name: e.name, email: e.email, contactName: e.contact_name }] : []
    }),
    [subIds, subs.rows],
  )

  const costOf = (id: string): number | null => (costText[id] !== undefined ? parseNumber(costText[id]) : prefill[id] ?? null)
  const perPosition = useMemo(
    () => Object.fromEntries(chosenIds.flatMap((id) => {
      const v = costText[id] !== undefined ? parseNumber(costText[id]) : prefill[id] ?? null
      return v == null ? [] : [[id, v]]
    })),
    [chosenIds, costText, prefill],
  )
  const sum = useMemo(() => makeBudget(perPosition, chosenIds).total, [perPosition, chosenIds])
  const totalValue = totalText !== null && totalText.trim() ? parseNumber(totalText) : null

  const generatedBody = emailBody({ project, packageName, positionCount: chosen.length, dueDate: dueDate || undefined, format })
  const body = bodyOverride ?? generatedBody
  const subject = emailSubject(packageName, project)
  const textFor = useCallback((r: Recipient) => composeEmail({ salutation: salutation(r.contactName), body, sender }), [body, sender])

  const canExport = !busy && chosen.length > 0 && packageName.length > 0 && recipients.length > 0 && conflicts.length === 0
  const why = chosen.length === 0 ? 'Select positions first' : !packageName ? 'Name the package' : recipients.length === 0 ? 'Pick a subcontractor' : conflicts.length ? 'Resolve the position conflict first' : ''

  /* ---------- keyboard: Escape and focus trap ---------- */
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(), 60)
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
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [onClose])

  /* ---------- actions ---------- */
  const writePackages = (next: SubcontractPackage[]) => useStore.getState().patchList(listId, { subcontractPackages: next })
  const current = () => useStore.getState().listPatch[listId]?.subcontractPackages ?? EMPTY

  const reset = (ids: string[]) => {
    setEditingId(null)
    setSel(new Set(ids.filter((id) => existing.has(id))))
    setKeepHere(new Set())
    setName('')
    setNameTouched(false)
    setSubIds([])
    setCostText({})
    setTotalText(null)
    setNotes('')
    setDueDate('')
    setFormat('x83')
    setBodyOverride(null)
  }

  const startNew = () => {
    reset([])
    setView('new')
    setPane('what')
  }

  const startEdit = (saved: SubcontractPackage) => {
    const p = pruneMissing(saved, existing)
    setEditingId(p.id)
    setSel(new Set(p.positionIds))
    setKeepHere(new Set())
    setName(p.name)
    setNameTouched(true)
    setSubIds(p.subcontractorIds)
    setCostText(Object.fromEntries(Object.entries(p.budget.perPosition).map(([id, v]) => [id, amount(v)])))
    const own = makeBudget(p.budget.perPosition, p.positionIds).total
    setTotalText(Math.abs(own - p.budget.total) > 0.005 ? amount(p.budget.total) : null)
    setNotes(p.notes ?? '')
    setDueDate(p.dueDate ?? '')
    setFormat(p.format)
    setBodyOverride(null)
    setView('new')
    setPane('details')
  }

  const buildPackage = (status: SubcontractPackage['status'], sentAt?: string): SubcontractPackage => ({
    id: editingId ?? newPackageId(),
    name: packageName,
    positionIds: chosenIds,
    subcontractorIds: subIds,
    budget: makeBudget(perPosition, chosenIds, totalValue),
    dueDate: dueDate || undefined,
    format,
    status,
    sentAt,
    notes: notes.trim() || undefined,
  })

  const saveDraft = () => {
    if (!chosen.length || !packageName) return
    const built = buildPackage('draft')
    writePackages(upsertPackage(current(), mergeSavedPackage(current().find((p) => p.id === built.id), built)))
    toast(`Saved package “${packageName}” as draft`)
    reset([])
    setView('packages')
  }

  const run = async () => {
    if (!canExport) return
    setBusy(true)
    try {
      const now = new Date()
      // the text kept for "View request": generic salutation (each draft gets its own), sender block, no budget
      const pkg = { ...buildPackage('sent', now.toISOString()), sentText: composeEmail({ salutation: salutation(), body, sender }) }
      const result = await exportAndDraft({
        doc, resolved, request: toRequest(pkg), recipients, body, sender, now,
        loadLayout: format === 'pdf' ? layoutLoader(doc) : undefined,
      })
      downloadResult(result.download)
      saveSender(sender)
      writePackages(upsertPackage(current(), mergeSavedPackage(current().find((p) => p.id === pkg.id), pkg)))
      toast(`${result.download.fileName}: ${plural(recipients.length, 'draft', 'drafts')} with the request file attached`)
      reset([])
      setView('packages')
    } catch (e) {
      console.error(e)
      toast(`Export failed: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (r: Recipient) => {
    saveSender(sender)
    toast((await copyText(textFor(r))) ? `Copied the email text for ${r.name}` : 'Copying failed. Select the text and copy it by hand.', 'ok')
  }

  const onDelete = (p: SubcontractPackage) => {
    const before = current()
    writePackages(removePackage(before, p.id))
    toast(`Deleted package “${p.name}”`, 'ok', { label: 'Undo', run: () => writePackages(upsertPackage(current(), p)) })
  }

  const nameOf = (id: string) => subs.rows.find((r) => r.id === id)?.name

  /* ---------- panes ---------- */
  const what = (
    <WhatPane
      tree={resolved.tree}
      positions={resolved.positions}
      sel={sel}
      onSel={setSel}
      conflicts={conflicts}
      onKeepHere={(ids) => setKeepHere((s) => new Set([...s, ...ids]))}
      onDeselect={(ids) => setSel((s) => new Set([...s].filter((id) => !ids.includes(id))))}
    />
  )

  const details = (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50/50" data-testid="sc-details">
      <Section n={1} title="Package">
        <label className="block space-y-1">
          <span className="text-[11px] font-semibold text-slate-600">Package name</span>
          <input
            data-autofocus
            aria-label="Package name"
            value={nameTouched ? name : chosen.length ? packageName : ''}
            onChange={(e) => { setName(e.target.value); setNameTouched(true) }}
            placeholder="e.g. Estricharbeiten"
            maxLength={100}
            className={inputCls}
          />
        </label>
        {editingId && <p className="text-xs text-slate-600">Editing an existing package. Exporting again creates new drafts and keeps this package.</p>}
      </Section>
      <Section n={2} title="Who" hint="from the subcontractor catalogue">
        <WhoPane entries={subs.rows} loading={subs.loading} error={subs.error} onRetry={subs.retry} selected={subIds} onChange={setSubIds} suggested={suggested} />
      </Section>
      <Section n={3} title="Expected cost" hint="internal, not sent">
        <CostPane
          rows={chosen}
          text={(id) => (costText[id] !== undefined ? costText[id] : prefill[id] !== undefined ? amount(prefill[id]) : '')}
          onText={(id, v) => setCostText((m) => ({ ...m, [id]: v }))}
          sum={sum}
          totalText={totalText ?? (sum > 0 ? amount(sum) : '')}
          totalOverridden={totalText !== null && totalText.trim() !== '' && totalValue !== null && Math.abs(totalValue - sum) > 0.005}
          onTotal={setTotalText}
          onResetTotal={() => setTotalText(null)}
          notes={notes}
          onNotes={setNotes}
        />
        {chosen.some((p) => costOf(p.id) == null) && chosen.length > 0 && (
          <p className="text-[11px] text-slate-600">Positions without a cost are left out of the sum. Prefilled from the list’s own unit price × quantity where there is one.</p>
        )}
      </Section>
      <Section n={4} title="Send">
        <SendPane
          dueDate={dueDate}
          onDueDate={setDueDate}
          format={format}
          onFormat={setFormat}
          subject={subject}
          body={body}
          bodyEdited={bodyOverride !== null}
          onBody={setBodyOverride}
          onResetBody={() => setBodyOverride(null)}
          sender={sender}
          onSender={setSender}
          recipients={recipients}
          textFor={textFor}
          onCopy={copy}
          salutationFor={(r) => salutation(r.contactName)}
        />
      </Section>
    </div>
  )

  const tab = (k: 'new' | 'packages', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === k}
      onClick={() => (k === 'new' ? setView('new') : setView('packages'))}
      className={clsx('rounded-md px-3 py-1.5 text-sm font-semibold transition-colors', view === k ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}
    >
      {label}
    </button>
  )

  return (
    <div className="fixed inset-0 z-[78]">
      <motion.div className="absolute inset-0 bg-[var(--scrim)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="subcontract-title"
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24, transition: { duration: 0.16 } }}
        transition={{ duration: 0.22, ease }}
        className="absolute inset-0 flex flex-col overflow-hidden bg-white md:inset-6 md:rounded-lg md:border md:border-slate-300 lg:inset-8"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Icon name="engineering" size={20} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="subcontract-title" className="font-heading text-base font-bold tracking-tight text-slate-900">Send to subcontractor</h2>
            <p className="truncate text-xs text-slate-600">{doc.title}</p>
          </div>
          <div role="tablist" aria-label="Subcontract view" className="flex gap-1">
            {tab('new', editingId ? 'Edit request' : 'New request')}
            {tab('packages', `Subcontract packages (${packages.length})`)}
          </div>
          <button type="button" aria-label="Close subcontractor panel" onClick={onClose} className="flex size-10 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900">
            <Icon name="close" size={20} />
          </button>
        </header>

        {view === 'packages' ? (
          <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel" aria-label="Subcontract packages">
            <PackageList
              packages={packages}
              nameOf={nameOf}
              onReexport={startEdit}
              onReceived={(p) => writePackages(setStatus(current(), p.id, 'offer_received'))}
              onDelete={onDelete}
              onNew={startNew}
            />
            {packages.length > 0 && (
              <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 sm:px-5">
                <span className="text-xs text-slate-600">
                  Expected cost of all packages (internal): <span className="font-mono font-semibold text-slate-800">{money(packages.reduce((s, p) => s + p.budget.total, 0))}</span>
                </span>
                <Button icon="add" onClick={startNew}>New request</Button>
              </div>
            )}
          </div>
        ) : (
          <>
            {!wide && (
              <div role="group" aria-label="Panel" className="flex gap-1 border-b border-slate-100 p-2">
                {(['what', 'details'] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={pane === k} onClick={() => setPane(k)} className={clsx('flex-1 rounded-lg py-1.5 text-xs font-semibold', pane === k ? 'bg-brand-50 text-brand-700' : 'text-slate-500')}>
                    {k === 'what' ? `What (${sel.size})` : 'Who, cost, send'}
                  </button>
                ))}
              </div>
            )}
            <div className="flex min-h-0 flex-1 divide-x divide-slate-100" role="tabpanel" aria-label="New request">
              {(wide || pane === 'what') && <div className="flex min-h-0 min-w-0 flex-1 flex-col md:max-w-[42%]">{what}</div>}
              {(wide || pane === 'details') && details}
            </div>
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/60 px-4 py-3 sm:px-5">
              <p className="min-w-0 text-xs text-slate-600" aria-live="polite">
                <span className="font-semibold text-slate-800">{plural(chosen.length, 'position', 'positions')}</span> · {plural(recipients.length, 'subcontractor', 'subcontractors')}
                {!canExport && why ? <span className="ml-2 text-amber-800">{why}</span> : null}
              </p>
              <div className="flex items-center gap-2">
                <Button onClick={onClose}>Cancel</Button>
                <Button disabled={!chosen.length || !packageName} onClick={saveDraft}>Save as draft</Button>
                <Button variant="primary" size="lg" icon="forward_to_inbox" disabled={!canExport} title={why || undefined} onClick={run} data-testid="sc-export">
                  {busy ? 'Exporting…' : 'Export & draft email'}
                </Button>
              </div>
            </footer>
          </>
        )}
      </motion.div>
    </div>
  )
}
