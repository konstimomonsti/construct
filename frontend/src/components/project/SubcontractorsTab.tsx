import { clsx } from 'clsx'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Button, Dialog, Field, Icon, inputCls, toast } from '../ui'
import { useSubNames, shortDate, type SubName } from './names'
import { RequestDialog } from './RequestDialog'
import { removeDocuments, saveDocument } from '../../lib/documents'
import { int, money, parseNumber, plural } from '../../lib/format'
import { parseListFile } from '../../lib/parse-list-file'
import { matchOffer, ozOverlap, type OfferMatch } from '../../lib/subcontract-offer'
import { useModel, useStore } from '../../lib/store'
import { useUi } from '../../lib/ui-store'
import {
  chooseSubcontractor, declineOffer, offerOf, setOffer, type SubcontractOffer, type SubcontractPackage,
} from '../../lib/subcontract'
import type { CategoryNode, DocMeta, ListDoc, Position } from '../../lib/types'

type PendingFile = { fileName: string; positions: Position[]; file: File }

const ACCEPT = '.x84,.d84,.x83,.d83,.x86,.d86,.xlsx,.xls,.csv'
const EMPTY: SubcontractPackage[] = []
const COLS = 'md:grid-cols-[minmax(0,1.3fr)_8.5rem_8.5rem_minmax(0,2fr)_6.5rem]'

type Props = {
  listId: string
  doc: ListDoc
  /** the list as the user sees it, for rebuilding a request file */
  resolved: { positions: Position[]; tree: CategoryNode[] }
  /** real packages, plus read-only demo packages when `?demo=workflow` is on */
  packages: SubcontractPackage[]
  /** ids of packages that only exist as demo data: actions on them write nothing */
  demoIds?: ReadonlySet<string>
  demoNames?: Record<string, SubName>
  positions: Position[]
  /** opens the "send to subcontractor" overlay */
  onNew: () => void
}

export function SubcontractorsTab({ listId, doc, resolved, packages, demoIds, demoNames, positions, onNew }: Props) {
  const nameOf = useSubNames(true, demoNames)
  const byId = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions])
  const { documents } = useModel()
  const openDialog = useUi((s) => s.openDialog)
  const [editing, setEditing] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingFile | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /** applies `fn` to the stored packages and offers Undo; demo-only packages are never written */
  const change = (pkgId: string, fn: (all: SubcontractPackage[]) => SubcontractPackage[], text: string) => {
    if (demoIds?.has(pkgId)) {
      toast('Demo data: nothing was saved', 'info')
      return
    }
    const before = useStore.getState().listPatch[listId]?.subcontractPackages ?? EMPTY
    useStore.getState().patchList(listId, { subcontractPackages: fn(before) })
    toast(text, 'ok', { label: 'Undo', run: () => useStore.getState().patchList(listId, { subcontractPackages: before }) })
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const parsed = await parseListFile(file)
      if (!parsed?.positions.length) {
        toast('No positions found in that file', 'error')
        return
      }
      setPending({ fileName: file.name, positions: parsed.positions, file })
    } catch (e) {
      toast(`The file could not be read: ${(e as Error).message}`, 'error')
    }
  }

  /** keeps the offer file the way the award document is kept; demo packages never write, so they keep nothing */
  const assign = async (pkgId: string, subId: string, patch: Partial<SubcontractOffer>, text: string, file: File) => {
    setPending(null)
    let documentId: string | undefined
    if (!demoIds?.has(pkgId)) {
      const meta: DocMeta = { id: `doc-${crypto.randomUUID()}`, name: file.name, file: '', pages: 0, excerpt: `${(file.size / 1024).toFixed(0)} KB`, listId, stored: true }
      try {
        await saveDocument(meta.id, file)
        if (!useStore.getState().addImportedFile(meta)) {
          removeDocuments([meta.id])
          throw new Error('The destination list is unavailable.')
        }
        documentId = meta.id
      } catch (e) {
        toast(`The offer file could not be kept, the offer is saved without it: ${(e as Error).message}`, 'error')
      }
    }
    change(pkgId, (all) => setOffer(all, pkgId, subId, documentId ? { ...patch, documentId } : patch), text)
  }

  return (
    <div className="space-y-6">
      {packages.length === 0 ? (
        <div className="rounded-lg bg-slate-50 px-5 py-8 text-center">
          <Icon name="engineering" size={28} className="text-slate-500" />
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-700">Pick positions or sections in X83 and send them to subcontractors. Their replies show up here.</p>
          <Button variant="primary" icon="send" onClick={onNew} className="mt-4">Send to subcontractor…</Button>
        </div>
      ) : (
        packages.map((pkg) => (
          <section key={pkg.id} aria-label={pkg.name} className="rounded-lg ring-1 ring-slate-200">
            <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-200 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="font-heading text-[15px] font-bold text-slate-900">{pkg.name}</h3>
                <Button size="sm" variant="ghost" icon="visibility" onClick={() => setViewing(pkg.id)} aria-label={`View request: ${pkg.name}`}>View request</Button>
              </div>
              <p className="text-sm text-slate-600">
                <span className="num">{plural(pkg.positionIds.length, 'position', 'positions')}</span>
                {pkg.dueDate && <> · due <span className="num">{shortDate(pkg.dueDate)}</span></>}
                {pkg.budget.total > 0 && <> · Expected cost <span className="num">{money(pkg.budget.total)}</span>, internal</>}
              </p>
            </header>
            <div role="row" className={clsx('hidden gap-x-4 px-4 py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase md:grid', COLS)}>
              <span>Subcontractor</span><span>Sent</span><span>Received</span><span>Info</span><span>Action</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {pkg.subcontractorIds.length === 0 && <li className="px-4 py-3 text-sm text-slate-600">No subcontractor added yet.</li>}
              {pkg.subcontractorIds.map((subId) => {
                const offer = offerOf(pkg, subId)
                const who = nameOf(subId)
                const key = `${pkg.id}:${subId}`
                // shown only while the stored file is known to this workspace
                const storedFile = offer.documentId ? documents.find((d) => d.id === offer.documentId) : undefined
                return (
                  <li key={subId} className="px-4 py-3">
                    <Row
                      pkg={pkg} offer={offer} who={who} chosen={pkg.chosenId === subId}
                      onView={storedFile ? () => openDialog({ kind: 'doc', doc: storedFile }) : undefined}
                      names={(ids) => ids.map((id) => byId.get(id)?.oz).filter(Boolean).join(', ')}
                      onEdit={() => setEditing(editing === key ? null : key)}
                      onChoose={() => change(pkg.id, (all) => chooseSubcontractor(all, pkg.id, pkg.chosenId === subId ? null : subId),
                        pkg.chosenId === subId ? `${who.name} is no longer chosen for ${pkg.name}` : `Chose ${who.name} for ${pkg.name}`)}
                      onDecline={() => change(pkg.id, (all) => declineOffer(all, pkg.id, subId, !offer.declined),
                        offer.declined ? `Reopened the offer from ${who.name}` : `Declined the offer from ${who.name}`)}
                    />
                    {editing === key && (
                      <ReplyForm
                        offer={offer}
                        onCancel={() => setEditing(null)}
                        onSave={(patch) => {
                          change(pkg.id, (all) => setOffer(all, pkg.id, subId, patch), `Saved the reply from ${who.name}`)
                          setEditing(null)
                        }}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileInput} type="file" accept={ACCEPT} hidden aria-label="Offer file" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
        <Button variant="primary" icon="download" onClick={() => fileInput.current?.click()} disabled={packages.length === 0}>Import offer</Button>
        <Button icon="add" onClick={onNew}>New category…</Button>
      </div>

      <ImportDialog
        pending={pending}
        packages={packages}
        positions={byId}
        nameOf={nameOf}
        onClose={() => setPending(null)}
        onAssign={(pkgId, subId, patch, text, file) => void assign(pkgId, subId, patch, text, file)}
      />

      {viewing && (() => {
        const pkg = packages.find((p) => p.id === viewing)
        return pkg ? <RequestDialog pkg={pkg} doc={doc} resolved={resolved} nameOf={nameOf} onClose={() => setViewing(null)} /> : null
      })()}
    </div>
  )
}

function DateCard({ label, date, empty }: { label: string; date?: string; empty: string }) {
  return date ? (
    <div className="rounded-md border border-slate-300 px-2.5 py-1.5">
      <div className="text-xs text-slate-600">{label}</div>
      <div className="num text-sm font-semibold text-slate-900">{date}</div>
    </div>
  ) : (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-2.5 py-1.5">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm text-slate-500">{empty}</div>
    </div>
  )
}

function Row({ pkg, offer, who, chosen, onView, names, onEdit, onChoose, onDecline }: {
  pkg: SubcontractPackage
  offer: SubcontractOffer
  who: SubName
  chosen: boolean
  /** opens the stored offer file; missing when no file was kept */
  onView?: () => void
  names: (ids: string[]) => string
  onEdit: () => void
  onChoose: () => void
  onDecline: () => void
}) {
  const sent = pkg.status === 'draft' ? '' : shortDate(offer.sentAt ?? pkg.sentAt)
  const received = shortDate(offer.receivedAt)
  const delta = offer.amount != null && pkg.budget.total > 0 ? (offer.amount / pkg.budget.total - 1) * 100 : null
  const dim = offer.declined ? 'opacity-60' : undefined
  const missing = offer.missing ?? []
  const total = (offer.matched ?? 0) + missing.length
  return (
    <div className={clsx('grid grid-cols-2 items-start gap-x-4 gap-y-2', COLS)}>
      <div className={clsx('col-span-2 min-w-0 md:col-span-1', dim)}>
        <div className="truncate text-sm font-semibold text-slate-900">{who.name}</div>
        {who.trade && <div className="truncate text-[13px] text-slate-600">{who.trade}</div>}
        {chosen && <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-emerald-800"><Icon name="check_circle" size={14} fill />Chosen</span>}
        {offer.declined && <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-slate-700"><Icon name="block" size={14} />Declined</span>}
      </div>
      <div className={dim}><DateCard label="Sent X83" date={sent} empty="Not sent" /></div>
      <div className={dim}>
        <DateCard label="Received X84" date={received} empty="Waiting" />
        {onView && (
          <button type="button" onClick={onView} aria-label={`View offer file from ${who.name}`} className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-slate-700 underline decoration-slate-400 underline-offset-4 hover:text-slate-900">
            <Icon name="visibility" size={16} />View
          </button>
        )}
      </div>
      <div className={clsx('col-span-2 min-w-0 text-sm md:col-span-1', dim)}>
        {offer.amount != null ? (
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="num font-semibold text-slate-900">{money(offer.amount)}</span>
            {delta != null && <span className={clsx('num text-[13px]', delta > 0 ? 'font-medium text-amber-800' : 'text-slate-600')}>{delta > 0 ? '+' : delta < 0 ? '−' : ''}{int(Math.round(Math.abs(delta)))} % vs estimate</span>}
          </p>
        ) : <p className="text-slate-500">No amount yet</p>}
        {offer.note && <p className="mt-0.5 text-slate-700">{offer.note}</p>}
        {offer.fileName && <p className="mt-0.5 flex items-center gap-1 text-[13px] text-slate-600"><Icon name="attach_file" size={14} /><span className="truncate">{offer.fileName}</span></p>}
        {missing.length > 0 && (
          <p className="mt-0.5 text-[13px] text-amber-800" title={`Not priced: ${names(missing)}`}>
            <span className="num">{int(offer.matched ?? 0)}</span> of <span className="num">{int(total)}</span> positions priced
          </p>
        )}
        <button type="button" onClick={onEdit} aria-label={`Edit reply from ${who.name}`} className="mt-1 text-[13px] font-medium text-slate-700 underline decoration-slate-400 underline-offset-4 hover:text-slate-900">Edit</button>
      </div>
      <div className="col-span-2 flex gap-2 md:col-span-1">
        <button
          type="button"
          onClick={onChoose}
          disabled={!chosen && (offer.amount == null || offer.declined)}
          aria-pressed={chosen}
          aria-label={chosen ? `Undo choice of ${who.name}` : `Choose ${who.name}`}
          title={chosen ? 'Chosen. Click to undo' : offer.amount == null ? 'Add an amount first' : 'Choose'}
          className={clsx('inline-flex size-9 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40', chosen ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-600' : 'text-slate-700 ring-1 ring-slate-300 ring-inset hover:bg-emerald-50 hover:text-emerald-800')}
        >
          <Icon name="check" size={18} fill={chosen} />
        </button>
        <button
          type="button"
          onClick={onDecline}
          aria-pressed={!!offer.declined}
          aria-label={offer.declined ? `Reopen offer from ${who.name}` : `Decline ${who.name}`}
          title={offer.declined ? 'Declined. Click to reopen' : 'Decline'}
          className={clsx('inline-flex size-9 items-center justify-center rounded-md transition-colors', offer.declined ? 'bg-slate-200 text-slate-900 ring-1 ring-slate-500' : 'text-slate-700 ring-1 ring-slate-300 ring-inset hover:bg-rose-50 hover:text-rose-700')}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  )
}

const todayInput = () => new Date().toISOString().slice(0, 10)

/** a reply that came by email without a file */
function ReplyForm({ offer, onSave, onCancel }: { offer: SubcontractOffer; onSave: (patch: Partial<SubcontractOffer>) => void; onCancel: () => void }) {
  const [amount, setAmount] = useState(offer.amount != null ? String(offer.amount).replace('.', ',') : '')
  const [date, setDate] = useState(offer.receivedAt?.slice(0, 10) ?? todayInput())
  const [note, setNote] = useState(offer.note ?? '')
  const parsed = amount.trim() ? parseNumber(amount) : null
  const invalid = amount.trim() !== '' && (parsed == null || parsed < 0)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (invalid) return
    onSave({ amount: parsed ?? undefined, receivedAt: date ? new Date(`${date}T12:00:00`).toISOString() : undefined, note: note.trim() || undefined })
  }
  return (
    <form onSubmit={submit} className="mt-3 grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[10rem_10rem_minmax(0,1fr)_auto] sm:items-end">
      <Field label="Amount (€, net)"><input data-autofocus inputMode="decimal" className={`${inputCls} num`} value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={invalid || undefined} /></Field>
      <Field label="Received"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Note"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={invalid}>Save</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

function ImportDialog({ pending, packages, positions, nameOf, onClose, onAssign }: {
  pending: PendingFile | null
  packages: SubcontractPackage[]
  positions: Map<string, Position>
  nameOf: (id: string) => SubName
  onClose: () => void
  onAssign: (pkgId: string, subId: string, patch: Partial<SubcontractOffer>, text: string, file: File) => void
}) {
  // the dialog is remounted per file (key), so the preselection runs once per import
  return pending && <ImportForm key={pending.fileName + pending.positions.length} {...{ pending, packages, positions, nameOf, onClose, onAssign }} />
}

function ImportForm({ pending, packages, positions, nameOf, onClose, onAssign }: {
  pending: PendingFile
  packages: SubcontractPackage[]
  positions: Map<string, Position>
  nameOf: (id: string) => SubName
  onClose: () => void
  onAssign: (pkgId: string, subId: string, patch: Partial<SubcontractOffer>, text: string, file: File) => void
}) {
  const pkgPositions = (pkg: SubcontractPackage) => pkg.positionIds.flatMap((id) => positions.get(id) ?? [])
  const defaultSub = (p?: SubcontractPackage) => p?.subcontractorIds.find((id) => offerOf(p, id).amount == null) ?? p?.subcontractorIds[0] ?? ''
  // the package whose positions the file covers best is preselected, once per import
  const [start] = useState(() => {
    let top = packages[0]
    let score = -1
    for (const p of packages) {
      const s = ozOverlap(pkgPositions(p), pending)
      if (s > score) { top = p; score = s }
    }
    return top
  })
  const [pkgId, setPkgId] = useState(start?.id ?? '')
  const pkg = packages.find((p) => p.id === pkgId)
  const [subId, setSubId] = useState(defaultSub(start))
  const match: OfferMatch | null = pkg ? matchOffer(pkgPositions(pkg), pending) : null
  const total = match ? match.matched + match.missing.length : 0
  const ready = !!pkg && !!subId && !!match && match.matched > 0

  return (
    <Dialog
      open
      onClose={onClose}
      title="Import offer"
      description={<>Assign <span className="font-medium">{pending.fileName}</span> to a package and subcontractor.</>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => pkg && match && onAssign(pkg.id, subId, { receivedAt: new Date().toISOString(), amount: match.amount, fileName: pending.fileName, matched: match.matched, missing: match.missing },
              `Assigned ${pending.fileName} to ${nameOf(subId).name}`, pending.file)}
          >
            Assign
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Package">
          <select className={inputCls} value={pkgId} onChange={(e) => { setPkgId(e.target.value); setSubId(defaultSub(packages.find((p) => p.id === e.target.value))) }}>
            {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Subcontractor">
          <select className={inputCls} value={subId} onChange={(e) => setSubId(e.target.value)}>
            {pkg?.subcontractorIds.map((id) => <option key={id} value={id}>{nameOf(id).name}</option>)}
          </select>
        </Field>
        {match && (
          <p role="status" className={clsx('rounded-md px-3 py-2 text-sm', match.matched > 0 ? 'bg-slate-50 text-slate-800' : 'bg-amber-50 text-amber-900')}>
            {match.matched > 0
              ? <><span className="num font-semibold">{int(match.matched)} of {int(total)}</span> positions priced · <span className="num font-semibold">{money(match.amount)}</span></>
              : 'None of the package positions are priced in this file. Check the package.'}
            {match.extra > 0 && <span className="block text-[13px] text-slate-600"><span className="num">{int(match.extra)}</span> priced positions in the file are not in this package.</span>}
          </p>
        )}
      </div>
    </Dialog>
  )
}
