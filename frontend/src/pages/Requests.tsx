import { clsx } from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Chips, EmptyState, PageFrame, PageHeader, Section } from '../components/Kit'
import { Button, Dialog, Icon, IconButton, inputCls, toast } from '../components/ui'
import { int, pct, plural } from '../lib/format'
import {
  dateTime, deleteEvent, duration, endOfDay, EVENT_ICON, EVENT_LABEL, fetchEvents, fetchOverview, isoInDays, logEvents, saveReminder,
  setSupplierCategories, shortDate,
  type Channel, type CommEvent, type EventKind, type Overview, type PartyKind, type PartyStats, type Reminder,
} from '../lib/crm'
import { salutation } from '../lib/subcontract'
import { loadSender } from '../lib/subcontract-send'

type Filter = 'all' | PartyKind

const KIND_NOUN: Record<PartyKind, string> = { supplier: 'Supplier', subcontractor: 'Subcontractor' }
const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', phone: 'Phone', meeting: 'Meeting', other: 'Other' }
const LOGGABLE: EventKind[] = ['reply', 'offer_received', 'call', 'note', 'rfq_sent', 'reminder_sent']

const rate = (answered: number, requests: number) => (requests ? pct((answered / requests) * 100) : '–')
const isOverdue = (iso: string) => new Date(iso).getTime() < Date.now()

/** formal German follow-up, opened in the mail app */
function reminderMailto(r: Reminder): string | null {
  if (!r.email) return null
  const subject = `Erinnerung: ${r.subject ?? `Preisanfrage ${r.list_title ?? ''}`.trim()}`
  const sent = r.requested_at ? ` vom ${shortDate(r.requested_at)}` : ''
  const text = `${salutation(null)}\n\nwir möchten freundlich an unsere Anfrage${sent}${r.list_title ? ` zum Projekt „${r.list_title}“` : ''} erinnern. Über Ihr Angebot oder eine kurze Rückmeldung würden wir uns sehr freuen.\n\n${loadSender()}`
  return `mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <div className={clsx('rounded-lg border bg-white px-4 py-3', tone === 'warn' ? 'border-amber-300' : 'border-slate-300')}>
      <p className="text-xs font-semibold text-slate-600">{label}</p>
      <p className={clsx('num mt-1 font-heading text-2xl font-extrabold tracking-tight', tone === 'warn' ? 'text-amber-800' : 'text-slate-900')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-600">{hint}</p>}
    </div>
  )
}

function EventRow({ e, showParty, onDelete }: { e: CommEvent; showParty?: boolean; onDelete?: () => void }) {
  const answer = e.kind === 'reply' || e.kind === 'offer_received'
  return (
    <li className="group flex gap-3 py-2.5">
      <span className={clsx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', answer ? 'bg-emerald-50 text-emerald-700' : e.kind === 'rfq_sent' ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600')}>
        <Icon name={EVENT_ICON[e.kind]} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate-900">
          <span className="font-semibold">{EVENT_LABEL[e.kind]}</span>
          {showParty && e.party_name && <> · {e.party_name}</>}
          {e.channel !== 'email' && <span className="text-slate-600"> · {CHANNEL_LABEL[e.channel]}</span>}
        </p>
        <p className="truncate text-xs text-slate-600">
          {dateTime(e.occurred_at)}
          {e.list_title && <> · {e.list_id ? <Link to={`/list/${e.list_id}`} className="hover:underline">{e.list_title}</Link> : e.list_title}</>}
          {e.items.length > 0 && <> · {plural(e.items.length, 'position', 'positions')}</>}
          {e.kind === 'rfq_sent' && (e.answered_at ? <span className="text-emerald-700"> · answered after {duration(e.response_hours)}</span> : e.due_at && <span className={isOverdue(e.due_at) ? 'text-amber-800' : ''}> · due {shortDate(e.due_at)}</span>)}
          {answer && e.response_hours != null && <> · after {duration(e.response_hours)}</>}
        </p>
        {e.note && <p className="mt-0.5 text-xs whitespace-pre-line text-slate-700">{e.note}</p>}
      </div>
      {onDelete && (
        <IconButton icon="delete" label={`Delete ${EVENT_LABEL[e.kind]} from ${dateTime(e.occurred_at)}`} onClick={onDelete} className="opacity-60 group-hover:opacity-100" />
      )}
    </li>
  )
}

function ReminderRow({ r, onChange, onOpen }: { r: Reminder; onChange: () => void; onOpen: () => void }) {
  const late = isOverdue(r.due_at)
  const link = reminderMailto(r)
  const run = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn()
      toast(message)
      onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const answer = (kind: 'reply' | 'offer_received') => run(
    () => logEvents([{ kind, party_kind: r.party_kind, party_id: r.party_id, request_id: r.communication_id ?? undefined, list_id: r.list_id ?? undefined, list_title: r.list_title ?? undefined }]),
    `Logged the ${kind === 'reply' ? 'reply' : 'offer'} from ${r.party_name}`,
  )
  const remind = () => {
    if (link) window.location.assign(link)
    void run(
      () => logEvents([{ kind: 'reminder_sent', party_kind: r.party_kind, party_id: r.party_id, request_id: r.communication_id ?? undefined, list_id: r.list_id ?? undefined, list_title: r.list_title ?? undefined }]),
      link ? `Opened the reminder to ${r.party_name}. Next follow-up in 2 days.` : `Logged the reminder. Next follow-up in 2 days.`,
    )
  }
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className={clsx('flex size-9 shrink-0 items-center justify-center rounded-full', late ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600')}>
        <Icon name={late ? 'notification_important' : 'schedule'} size={18} />
      </span>
      <div className="min-w-0 flex-1 basis-60">
        <button type="button" onClick={onOpen} className="text-left text-[15px] font-semibold text-slate-900 hover:underline">{r.party_name ?? 'Unknown contact'}</button>
        <p className="truncate text-xs text-slate-600">
          <span className={late ? 'font-semibold text-amber-800' : ''}>{late ? 'Due since' : 'Due'} {dateTime(r.due_at)}</span>
          {r.requested_at && <> · requested {shortDate(r.requested_at)}</>}
          {r.list_title && <> · {r.list_title}</>}
        </p>
        {r.note && <p className="truncate text-xs text-slate-700">{r.note}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {r.communication_id && <Button size="sm" icon="request_quote" onClick={() => answer('offer_received')}>Offer received</Button>}
        {r.communication_id && <Button size="sm" icon="mark_email_read" onClick={() => answer('reply')}>Replied</Button>}
        <Button size="sm" icon="notifications_active" onClick={remind} title={link ? 'Opens a reminder email and logs it' : 'Logs a reminder you sent another way'}>{link ? 'Send reminder' : 'Reminder sent'}</Button>
        <Button size="sm" variant="ghost" icon="snooze" onClick={() => run(() => saveReminder({ id: r.id, due_at: endOfDay(isoInDays(2)) }), 'Snoozed for 2 days')}>2 days</Button>
        <Button size="sm" variant="ghost" icon="check" onClick={() => run(() => saveReminder({ id: r.id, done: true }), 'Reminder done')}>Done</Button>
      </div>
    </li>
  )
}

function PartyDialog({ party, overview, onClose, onChange }: { party: PartyStats; overview: Overview; onClose: () => void; onChange: () => void }) {
  const [events, setEvents] = useState<CommEvent[] | null>(null)
  const [kind, setKind] = useState<EventKind>('reply')
  const [channel, setChannel] = useState<Channel>('email')
  const [note, setNote] = useState('')
  const [when, setWhen] = useState('')
  const [remindOn, setRemindOn] = useState(() => isoInDays(3))
  const [remindNote, setRemindNote] = useState('')
  const [busy, setBusy] = useState(false)
  const explicit = new Set(party.explicit_category_ids ?? [])
  const fromProducts = new Set((party.category_ids ?? []).filter((id) => !explicit.has(id)))

  const load = useCallback(async () => {
    try {
      setEvents((await fetchEvents({ party_kind: party.party_kind, party_id: party.id, limit: 200 })).events)
    } catch (e) {
      toast((e as Error).message, 'error')
      setEvents([])
    }
  }, [party.party_kind, party.id])
  useEffect(() => { void load() }, [load])

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true)
    try {
      await fn()
      toast(message)
      await load()
      onChange()
      return true
    } catch (e) {
      toast((e as Error).message, 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    const ok = await act(
      () => logEvents([{ kind, party_kind: party.party_kind, party_id: party.id, channel, note: note.trim() || undefined, occurred_at: when ? new Date(when).toISOString() : undefined }]),
      `Logged: ${EVENT_LABEL[kind]}`,
    )
    if (ok) { setNote(''); setWhen('') }
  }

  const toggleCategory = (id: string) => {
    const next = new Set(explicit)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void act(() => setSupplierCategories(party.id, [...next]), 'Saved the categories')
  }

  return (
    <Dialog open onClose={onClose} title={party.name} width="max-w-2xl" description={`${KIND_NOUN[party.party_kind]}${party.trade ? ` · ${party.trade}` : ''}`}>
      <div className="space-y-6">
        <div className="grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
          {party.contact_name && <p><Icon name="person" size={16} className="mr-1.5 align-[-3px] text-slate-500" />{party.contact_name}</p>}
          {party.email && <p className="truncate"><Icon name="mail" size={16} className="mr-1.5 align-[-3px] text-slate-500" /><a href={`mailto:${party.email}`} className="hover:underline">{party.email}</a></p>}
          {party.phone && <p><Icon name="call" size={16} className="mr-1.5 align-[-3px] text-slate-500" /><a href={`tel:${party.phone}`} className="hover:underline">{party.phone}</a></p>}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Requests" value={int(party.requests)} />
          <Tile label="Answered" value={rate(party.answered, party.requests)} hint={`${party.answered} of ${party.requests}`} />
          <Tile label="Avg. response" value={duration(party.avg_response_hours)} />
          <Tile label="Open" value={int(party.open)} hint={party.overdue ? `${party.overdue} overdue` : undefined} tone={party.overdue ? 'warn' : undefined} />
        </div>

        {party.party_kind === 'supplier' && (
          <div>
            <h3 className="font-heading text-sm font-bold text-slate-900">Delivers these categories</h3>
            <p className="mb-2 text-xs text-slate-600">Quote requests group positions by category. Categories of this supplier's catalogue products are always on.</p>
            <div className="flex flex-wrap gap-2">
              {overview.categories.map((c) => {
                const locked = fromProducts.has(c.id)
                const on = locked || explicit.has(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    disabled={locked || busy}
                    onClick={() => toggleCategory(c.id)}
                    title={locked ? 'From catalogue products' : undefined}
                    className={clsx('inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors', on ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50', locked && 'cursor-default')}
                  >
                    {on && <Icon name={locked ? 'lock' : 'check'} size={14} />}
                    {c.name}
                  </button>
                )
              })}
              {!overview.categories.length && <p className="text-sm text-slate-600">No product categories yet.</p>}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <h3 className="mb-2 font-heading text-sm font-bold text-slate-900">Log contact</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <select aria-label="What happened" value={kind} onChange={(e) => setKind(e.target.value as EventKind)} className={inputCls}>
              {LOGGABLE.map((k) => <option key={k} value={k}>{EVENT_LABEL[k]}</option>)}
            </select>
            <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={inputCls}>
              {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
            </select>
            <input aria-label="When (empty: now)" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls} />
            <textarea aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={clsx(inputCls, 'h-auto py-2 sm:col-span-3')} />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-600">{kind === 'reply' || kind === 'offer_received' ? 'Answers close the latest open request and its reminders.' : ' '}</p>
            <Button size="sm" variant="primary" icon="add" disabled={busy} onClick={submit}>Log</Button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-slate-600">Remind me on</span>
            <input type="date" value={remindOn} onChange={(e) => setRemindOn(e.target.value)} className={inputCls} />
          </label>
          <label className="block min-w-40 flex-1 space-y-1">
            <span className="text-[11px] font-semibold text-slate-600">About</span>
            <input value={remindNote} onChange={(e) => setRemindNote(e.target.value)} placeholder="Call about delivery dates" className={inputCls} />
          </label>
          <Button icon="alarm_add" disabled={busy || !remindOn} onClick={() => act(() => saveReminder({ party_kind: party.party_kind, party_id: party.id, due_at: endOfDay(remindOn), note: remindNote.trim() || undefined }), `Reminder set for ${shortDate(endOfDay(remindOn))}`).then((ok) => ok && setRemindNote(''))}>Add reminder</Button>
        </div>

        <div>
          <h3 className="font-heading text-sm font-bold text-slate-900">History</h3>
          {events === null ? <p className="py-3 text-sm text-slate-600">Loading…</p>
            : events.length === 0 ? <p className="py-3 text-sm text-slate-600">Nothing logged yet.</p>
            : (
              <ul className="divide-y divide-slate-100">
                {events.map((e) => (
                  <EventRow key={e.id} e={e} onDelete={() => act(() => deleteEvent(e.id), 'Deleted the entry')} />
                ))}
              </ul>
            )}
        </div>
      </div>
    </Dialog>
  )
}

export function Requests() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [recent, setRecent] = useState<CommEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState(0)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [o, e] = await Promise.all([fetchOverview(signal), fetchEvents({ limit: 25 }, signal)])
      setOverview(o)
      setLoadedAt(Date.now())
      setRecent(e.events)
      setError(null)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const parties = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (overview?.parties ?? [])
      .filter((p) => filter === 'all' || p.party_kind === filter)
      .filter((p) => !q || [p.name, p.contact_name, p.email, p.trade].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open || (b.last_contact_at ?? '').localeCompare(a.last_contact_at ?? '') || a.name.localeCompare(b.name, 'de'))
  }, [overview, filter, query])
  const count = (k: PartyKind) => overview?.parties.filter((p) => p.party_kind === k).length ?? 0
  const partyKey = (p: { party_kind: PartyKind; id: string }) => `${p.party_kind}:${p.id}`
  const open = overview?.parties.find((p) => partyKey(p) === openId) ?? null
  const totals = overview?.totals
  const due = (overview?.reminders ?? []).filter((r) => new Date(r.due_at).getTime() < loadedAt + 86_400_000)
  const later = (overview?.reminders ?? []).length - due.length

  return (
    <PageFrame>
      <PageHeader title="Requests" subtitle="Quote requests to suppliers and subcontractors, their answers and your follow-ups" icon="forward_to_inbox" />
      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <span className="flex-1">{error}</span>
          <Button size="sm" onClick={() => load()}>Retry</Button>
        </div>
      )}
      {!overview && !error && <p className="text-sm text-slate-600">Loading…</p>}
      {overview && (
        <>
          <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Requests sent" value={int(totals?.requests ?? 0)} />
            <Tile label="Answered" value={rate(totals?.answered ?? 0, totals?.requests ?? 0)} hint={`${totals?.answered ?? 0} of ${totals?.requests ?? 0}`} />
            <Tile label="Avg. response time" value={duration(totals?.avg_response_hours)} />
            <Tile label="Overdue" value={int(totals?.overdue ?? 0)} hint="past the offer date, no answer" tone={totals?.overdue ? 'warn' : undefined} />
          </div>

          <Section title="Follow up" count={due.length}>
            {due.length ? (
              <ul className="divide-y divide-slate-200">
                {due.map((r) => <ReminderRow key={r.id} r={r} onChange={() => load()} onOpen={() => setOpenId(partyKey(r))} />)}
              </ul>
            ) : (
              <p className="rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-600">Nothing due today.{later ? ` ${plural(later, 'reminder is', 'reminders are')} scheduled later.` : ''}</p>
            )}
          </Section>

          <Section
            title="Contacts"
            count={parties.length}
            filters={<Chips<Filter> label="Contact type" value={filter} onChange={setFilter} options={[{ key: 'all', label: 'All', count: overview.parties.length }, { key: 'supplier', label: 'Suppliers', count: count('supplier') }, { key: 'subcontractor', label: 'Subcontractors', count: count('subcontractor') }]} />}
            tools={<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search contacts" aria-label="Search contacts" className={clsx(inputCls, 'w-48')} />}
          >
            {parties.length === 0 ? (
              <EmptyState compact icon="contacts" title="No contacts" text={<>Add suppliers and subcontractors in the <Link to="/catalogues/suppliers" className="font-semibold text-brand-700 hover:underline">catalogues</Link>.</>} />
            ) : (
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-300 text-left text-xs font-semibold text-slate-600">
                      <th className="px-4 py-2 sm:pl-0">Contact</th>
                      <th className="px-3 py-2 text-right">Requests</th>
                      <th className="px-3 py-2 text-right">Answered</th>
                      <th className="px-3 py-2 text-right">Avg. response</th>
                      <th className="px-3 py-2 text-right">Open</th>
                      <th className="px-4 py-2 text-right sm:pr-0">Last contact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {parties.map((p) => (
                      <tr key={partyKey(p)} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenId(partyKey(p))}>
                        <td className="max-w-0 px-4 py-2.5 sm:pl-0">
                          <button type="button" className="block max-w-full truncate text-left font-semibold text-slate-900 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(partyKey(p)) }}>{p.name}</button>
                          <p className="truncate text-xs text-slate-600">{KIND_NOUN[p.party_kind]}{p.trade ? ` · ${p.trade}` : ''}{p.party_kind === 'supplier' && p.category_ids ? ` · ${plural(p.category_ids.length, 'category', 'categories')}` : ''}</p>
                        </td>
                        <td className="num px-3 py-2.5 text-right">{int(p.requests)}</td>
                        <td className="num px-3 py-2.5 text-right">{p.requests ? <>{rate(p.answered, p.requests)} <span className="text-xs text-slate-500">({p.answered})</span></> : '–'}</td>
                        <td className="num px-3 py-2.5 text-right">{duration(p.avg_response_hours)}</td>
                        <td className="num px-3 py-2.5 text-right">{p.open ? <span className={p.overdue ? 'font-semibold text-amber-800' : ''}>{p.open}{p.overdue ? ` (${p.overdue} late)` : ''}</span> : '–'}</td>
                        <td className="num px-4 py-2.5 text-right whitespace-nowrap text-slate-700 sm:pr-0">{p.last_contact_at ? shortDate(p.last_contact_at) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Recent activity">
            {recent.length ? (
              <ul className="divide-y divide-slate-100">{recent.map((e) => <EventRow key={e.id} e={e} showParty />)}</ul>
            ) : (
              <p className="rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-600">No contact logged yet. Open a bill and choose Export → Request quotes from suppliers.</p>
            )}
          </Section>
        </>
      )}
      {open && overview && <PartyDialog party={open} overview={overview} onClose={() => setOpenId(null)} onChange={() => load()} />}
    </PageFrame>
  )
}
