import { clsx } from 'clsx'
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, Dialog, Field, Icon, IconButton, inputCls, toast } from '../components/ui'
import { Chips, PageFrame, PageHeader } from '../components/Kit'
import { useSubNames } from '../components/project/names'
import { useSubcontractors } from '../components/subcontract/useSubcontractors'
import { scanCatalogue } from '../lib/catalogues'
import {
  CHANNEL_LABEL, PARTY_LABEL, collectEvents, dayKey, entriesForDay, filterEvents, groupByDay, layoutDay, monthDays, newCalendarEntryId,
  newCommunicationId, validateEntry, weekDays,
  type CalendarEntry, type CalendarEvent, type CalendarPatch, type CommChannel, type CommParty, type Communication, type PartyFilter,
} from '../lib/communications'
import { downloadText } from '../lib/export'
import { money, plural } from '../lib/format'
import { useMedia } from '../lib/hooks'
import { overlapsRange, parseIcs, toIcs, type IcsImport } from '../lib/ics'
import { useModel, useStore } from '../lib/store'

/** the list the demo packages of `?demo=workflow` belong to (same as the list page) */
const DEMO_LIST_ID = 'angebot-an24-0305-d84'
const NO_PATCHES: Record<string, CalendarPatch> = {}
const NO_ENTRIES: Record<string, CalendarEntry> = {}

const DOT: Record<CommParty, string> = { subcontractor: 'bg-orange-500', client: 'bg-slate-900', supplier: 'bg-slate-400' }
const CHANNEL_ICON: Record<CommChannel, string> = { email: 'mail', phone: 'call', meeting: 'groups', letter: 'description', other: 'chat' }
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const PARTIES = Object.keys(PARTY_LABEL) as CommParty[]
const CHANNELS = Object.keys(CHANNEL_LABEL) as CommChannel[]
const HOUR_PX = 48
const FIRST_HOUR = 7
const VISIBLE_HOURS = 13 // 07:00 to 20:00 without scrolling

type View = 'month' | 'week' | 'agenda'
type Prefill = { date: string; time?: string }
type ExportScope = 'month' | 'view' | 'all'

const time = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
const longDay = (d: Date) => d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
const two = (n: number) => String(n).padStart(2, '0')
const dateInput = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
const timeInput = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`
const minutesOf = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
const clock = (minutes: number) => `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`
const isAppointment = (e: CalendarEvent) => e.kind === 'appointment'

/** "09:00", "09:00 – 11:30" or "All day" */
function whenLabel(e: CalendarEvent): string {
  if (e.kind === 'appointment' && e.allDay) return 'All day'
  if (e.kind === 'appointment' && e.end && dayKey(e.end) === dayKey(e.at)) return `${time(e.at)} – ${time(e.end)}`
  return time(e.at)
}

/** `?demo=workflow` adds demo packages and manual entries (tests/fixtures/workflow-demo.ts). They are never written to the store. */
function useWorkflowDemo(on: boolean) {
  const [demo, setDemo] = useState<typeof import('../../tests/fixtures/workflow-demo') | null>(null)
  useEffect(() => {
    if (on) void import('../../tests/fixtures/workflow-demo').then(setDemo)
  }, [on])
  return on ? demo : null
}

/** supplier names for the suggestions of the log dialog; without the backend the list stays empty and typing still works */
function useSupplierNames(enabled: boolean) {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    scanCatalogue('suppliers', { q: '', supplier: null, archived: false }, controller.signal)
      .then((r) => setNames(r.rows.map((row) => row.name)))
      .catch(() => undefined)
    return () => controller.abort()
  }, [enabled])
  return names
}

export function CalendarPage() {
  const [params] = useSearchParams()
  const { lists } = useModel()
  const stored = useStore((s) => s.listPatch) ?? NO_PATCHES
  const storedEntries = useStore((s) => s.calendar) ?? NO_ENTRIES
  const demo = useWorkflowDemo(params.get('demo') === 'workflow')
  const nameOf = useSubNames(true, demo?.demoNames)
  const live = useMemo(() => lists.filter((l) => !l.trashedAt), [lists])
  const phone = useMedia('(max-width: 767px)')

  // demo data is merged into the AN24 list only, and only when that list exists
  const { patches, demoIds, entries } = useMemo(() => {
    const demoIds = new Set<string>()
    const entries = { ...storedEntries }
    if (!demo) return { patches: stored, demoIds, entries }
    for (const a of demo.demoAppointments) {
      if (a.id in entries) continue
      entries[a.id] = a
      demoIds.add(a.id)
    }
    if (!live.some((l) => l.id === DEMO_LIST_ID)) return { patches: stored, demoIds, entries }
    const own = stored[DEMO_LIST_ID]
    const heldPackages = new Set((own?.subcontractPackages ?? []).map((p) => p.id))
    const heldComms = new Set((own?.communications ?? []).map((c) => c.id))
    const packages = demo.demoPackages.filter((p) => !heldPackages.has(p.id))
    const comms = demo.demoCommunications.filter((c) => !heldComms.has(c.id))
    for (const c of comms) demoIds.add(c.id)
    return {
      patches: { ...stored, [DEMO_LIST_ID]: { ...own, subcontractPackages: [...(own?.subcontractPackages ?? []), ...packages], communications: [...(own?.communications ?? []), ...comms] } },
      demoIds,
      entries,
    }
  }, [stored, storedEntries, demo, live])

  const events = useMemo(() => collectEvents(live, patches, (id) => nameOf(id).name, entries), [live, patches, nameOf, entries])

  const today = new Date()
  const todayKey = dayKey(today)
  const [anchor, setAnchor] = useState(() => new Date(today.getFullYear(), today.getMonth(), today.getDate()))
  const [chosenView, setView] = useState<View | null>(null)
  const view: View = chosenView ?? (phone ? 'agenda' : 'month')
  const [party, setParty] = useState<PartyFilter>('all')
  const [selectedDay, setSelectedDay] = useState<string | null>(todayKey)
  const [dialog, setDialog] = useState<{ event?: CalendarEvent; prefill?: Prefill } | null>(null)
  const [importing, setImporting] = useState<(IcsImport & { fileName: string }) | null>(null)
  const [exporting, setExporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const shown = filterEvents(events, party)
  const byDay = groupByDay(shown)
  const month = { year: anchor.getFullYear(), month: anchor.getMonth() }
  const days = monthDays(month.year, month.month)
  const week = weekDays(anchor)
  const prefix = `${month.year}-${two(month.month + 1)}-`
  const agenda = [...byDay.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
  const monthLabel = anchor.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
  const weekLabel = `${week[0].toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })} – ${week[6].toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })}`
  const rangeLabel = view === 'week' ? weekLabel : monthLabel

  const go = (delta: number) => {
    setAnchor(view === 'week'
      ? new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + delta * 7)
      : new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1))
    setSelectedDay(null)
  }
  const toToday = () => {
    setAnchor(new Date(today.getFullYear(), today.getMonth(), today.getDate()))
    setSelectedDay(todayKey)
  }
  const showDay = (iso: string) => {
    const d = new Date(iso)
    setSelectedDay(dayKey(d))
    setAnchor(new Date(d.getFullYear(), d.getMonth(), d.getDate()))
  }

  /* ---------- saving communications (kept per project) ---------- */
  const comms = (listId: string) => useStore.getState().listPatch[listId]?.communications ?? []
  const write = (listId: string, next: Communication[]) => useStore.getState().patchList(listId, { communications: next })

  const saveComm = (listId: string, entry: Communication, previousListId?: string) => {
    const moved = previousListId && previousListId !== listId ? previousListId : null
    const beforeTo = comms(listId)
    const beforeFrom = moved ? comms(moved) : null
    if (moved && beforeFrom) write(moved, beforeFrom.filter((c) => c.id !== entry.id))
    write(listId, [...beforeTo.filter((c) => c.id !== entry.id), entry])
    toast(previousListId ? 'Saved the entry' : 'Logged the communication', 'ok', {
      label: 'Undo',
      run: () => {
        write(listId, beforeTo)
        if (moved && beforeFrom) write(moved, beforeFrom)
      },
    })
    showDay(entry.at)
  }

  /* ---------- saving appointments (their own synced collection) ---------- */
  const saveAppointment = (entry: CalendarEntry) => {
    const store = useStore.getState()
    const before = store.calendar[entry.id]
    store.saveCalendarEntry(entry)
    toast(before ? 'Saved the appointment' : 'Added the appointment', 'ok', {
      label: 'Undo',
      run: () => (before ? useStore.getState().saveCalendarEntry(before) : useStore.getState().deleteCalendarEntry(entry.id)),
    })
    showDay(entry.start)
  }

  /* ---------- .ics import and export ---------- */
  const pickFile = async (file: File | undefined) => {
    if (!file) return
    try {
      setImporting({ ...parseIcs(await file.text()), fileName: file.name })
    } catch {
      toast('Could not read that file', 'error')
    }
  }

  const importEntries = (entries: CalendarEntry[], projectId: string) => {
    const store = useStore.getState()
    const before = new Map(entries.map((e) => [e.id, store.calendar[e.id]]))
    for (const entry of entries) {
      store.saveCalendarEntry({ ...entry, listId: projectId || before.get(entry.id)?.listId })
    }
    toast(`Imported ${plural(entries.length, 'entry', 'entries')}`, 'ok', {
      label: 'Undo',
      run: () => {
        const s = useStore.getState()
        for (const [id, prev] of before) {
          if (prev) s.saveCalendarEntry(prev)
          else s.deleteCalendarEntry(id)
        }
      },
    })
    if (entries[0]) showDay(entries[0].start)
    setImporting(null)
  }

  /** `shown` already respects the filter chips; the range and the communication log are the dialog's choices */
  const exportList = (scope: ExportScope, withComms: boolean): CalendarEvent[] => {
    const range: [Date, Date] | null = scope === 'month'
      ? [new Date(month.year, month.month, 1), new Date(month.year, month.month + 1, 1)]
      : scope === 'view' ? visibleRange() : null
    return shown.filter((e) => (withComms || isAppointment(e)) && (!range || overlapsRange(e, range[0], range[1])))
  }

  const exportEvents = (list: CalendarEvent[]) => {
    downloadText(`BillBuild-Kalender-${dayKey(new Date())}.ics`, toIcs(list, { now: new Date(), calendarName: 'BillBuild' }), 'text/calendar')
    toast(`Exported ${plural(list.length, 'entry', 'entries')}`, 'ok')
    setExporting(false)
  }

  /** the range the "Visible view" option covers: the week, or the month grid */
  const visibleRange = (): [Date, Date] => view === 'week'
    ? [week[0], new Date(week[6].getFullYear(), week[6].getMonth(), week[6].getDate() + 1)]
    : view === 'month'
      ? [days[0], new Date(days[days.length - 1].getFullYear(), days[days.length - 1].getMonth(), days[days.length - 1].getDate() + 1)]
      : [new Date(month.year, month.month, 1), new Date(month.year, month.month + 1, 1)]

  const remove = (e: CalendarEvent) => {
    if (demoIds.has(e.id)) {
      toast('Demo data: nothing was saved', 'info')
      return
    }
    if (isAppointment(e)) {
      const before = useStore.getState().calendar[e.id]
      if (!before) return
      useStore.getState().deleteCalendarEntry(e.id)
      toast(`Deleted “${e.name}”`, 'ok', { label: 'Undo', run: () => useStore.getState().saveCalendarEntry(before) })
      return
    }
    if (!e.listId) return
    const listId = e.listId
    const before = comms(listId)
    write(listId, before.filter((c) => c.id !== e.id))
    toast(`Deleted the entry with ${e.name}`, 'ok', { label: 'Undo', run: () => write(listId, before) })
  }

  const edit = (e: CalendarEvent) => {
    if (demoIds.has(e.id)) toast('Demo data: nothing was saved', 'info')
    setDialog({ event: e })
  }
  const create = (prefill?: Prefill) => {
    if (prefill) setSelectedDay(prefill.date)
    setDialog({ prefill })
  }

  const selectedEvents = selectedDay ? entriesForDay(shown, selectedDay) : []
  const count = (f: PartyFilter) => filterEvents(events, f).length

  return (
    <PageFrame>
      <PageHeader
        title="Calendar"
        subtitle="Appointments, and the requests, offers and conversations with subcontractors, clients and suppliers"
        aside={
          <div className="flex gap-2">
            {/* phones: icon buttons (same pattern as "Add position" on the list page), so the header never overflows */}
            <Button icon="upload" aria-label="Import .ics" onClick={() => fileInput.current?.click()} className="max-sm:w-10 max-sm:px-0">
              <span className="max-sm:hidden">Import .ics</span>
            </Button>
            <Button icon="download" aria-label="Export .ics" onClick={() => setExporting(true)} className="max-sm:w-10 max-sm:px-0">
              <span className="max-sm:hidden">Export .ics</span>
            </Button>
            <Button variant="primary" icon="add" aria-label="New entry" onClick={() => create()} className="max-sm:w-10 max-sm:px-0">
              <span className="max-sm:hidden">New entry</span>
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".ics,text/calendar"
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose an .ics file"
              onChange={(e) => {
                void pickFile(e.target.files?.[0])
                e.target.value = '' // the same file can be chosen again
              }}
            />
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1" role="group" aria-label={view === 'week' ? 'Week' : 'Month'}>
          <IconButton icon="chevron_left" label={view === 'week' ? 'Previous week' : 'Previous month'} onClick={() => go(-1)} />
          <h2 aria-live="polite" className="min-w-[10.5rem] text-center font-heading text-lg font-bold text-slate-900 capitalize">{rangeLabel}</h2>
          <IconButton icon="chevron_right" label={view === 'week' ? 'Next week' : 'Next month'} onClick={() => go(1)} />
          <Button onClick={toToday} className="ml-2">Today</Button>
        </div>
        <Chips<View>
          label="Calendar view"
          value={view}
          onChange={setView}
          options={[{ key: 'month', label: 'Month' }, { key: 'week', label: 'Week' }, { key: 'agenda', label: 'Agenda' }]}
        />
      </div>
      <div className="mb-4">
        <Chips
          label="Filter entries"
          value={party}
          onChange={setParty}
          options={[
            { key: 'all', label: 'All', count: events.length },
            { key: 'appointment', label: 'Appointments', count: count('appointment') },
            { key: 'subcontractor', label: 'Subcontractors', count: count('subcontractor') },
            { key: 'client', label: 'Clients', count: count('client') },
            { key: 'supplier', label: 'Suppliers', count: count('supplier') },
          ]}
        />
      </div>

      {view === 'month' && (
        <>
          <div className="overflow-x-auto">
            <div role="group" aria-label={`Calendar ${monthLabel}`} className="min-w-[36rem] overflow-hidden rounded-lg ring-1 ring-slate-200">
              <div aria-hidden className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
                {WEEKDAYS.map((d) => <div key={d} className="px-2 py-1.5 text-xs font-semibold text-slate-600">{d}</div>)}
              </div>
              <div className="grid grid-cols-7">
                {days.map((d) => {
                  const key = dayKey(d)
                  const inMonth = d.getMonth() === month.month
                  const items = byDay.get(key) ?? []
                  const selected = key === selectedDay
                  return (
                    <div key={key} className={clsx('relative min-h-[6.75rem] border-r border-b border-slate-100 p-1.5 [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-slate-50/70', selected && 'bg-brand-50')}>
                      <button
                        type="button"
                        onClick={() => create({ date: key, time: '09:00' })}
                        aria-label={`${longDay(d)}, ${plural(items.length, 'entry', 'entries')}. New entry`}
                        className="absolute inset-0 hover:bg-slate-100/60 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:outline-none focus-visible:ring-inset"
                      />
                      <span className={clsx('pointer-events-none relative num inline-flex size-6 items-center justify-center rounded-full text-[13px]', key === todayKey ? 'bg-slate-900 font-semibold text-white' : inMonth ? 'font-medium text-slate-800' : 'text-slate-500')}>{d.getDate()}</span>
                      <ul className="pointer-events-none relative mt-1 space-y-0.5">
                        {items.slice(0, 3).map((e) => (
                          <li key={`${e.id}`} className="pointer-events-auto">
                            <EventChip event={e} demoIds={demoIds} onEdit={edit} className="flex w-full items-center gap-1 truncate rounded px-1 text-left text-xs text-slate-800">
                              <Marker event={e} />
                              {!(isAppointment(e) && e.allDay) && <span className="num shrink-0 text-slate-600">{time(e.at)}</span>}
                              <span className="truncate">{e.name}</span>
                            </EventChip>
                          </li>
                        ))}
                        {items.length > 3 && (
                          <li className="pointer-events-auto">
                            <button type="button" onClick={() => setSelectedDay(key)} className="px-1 text-xs font-medium text-slate-700 underline decoration-slate-400 underline-offset-2 hover:text-slate-900">+{items.length - 3} more</button>
                          </li>
                        )}
                      </ul>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          <section aria-label="Selected day" className="mt-5">
            {selectedDay ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-heading text-[15px] font-bold text-slate-900">{longDay(new Date(`${selectedDay}T12:00:00`))}</h3>
                  <Button icon="add" onClick={() => create({ date: selectedDay, time: '09:00' })}>Add entry</Button>
                </div>
                {selectedEvents.length === 0
                  ? <p className="mt-1 text-sm text-slate-600">Nothing on this day.</p>
                  : <EventList events={selectedEvents} demoIds={demoIds} onEdit={edit} onDelete={remove} />}
              </>
            ) : <p className="text-sm text-slate-600">Select a day to see what is planned.</p>}
          </section>
        </>
      )}

      {view === 'week' && (
        <WeekView days={week} events={shown} todayKey={todayKey} demoIds={demoIds} onEdit={edit} onCreate={create} />
      )}

      {view === 'agenda' && (
        <div>
          {agenda.length === 0 ? <p className="py-6 text-center text-sm text-slate-600">Nothing this month.</p> : agenda.map(([key, items]) => (
            <section key={key} aria-label={longDay(new Date(`${key}T12:00:00`))} className="mb-5">
              <h3 className="border-b border-slate-200 pb-1 font-heading text-[15px] font-bold text-slate-900">{longDay(new Date(`${key}T12:00:00`))}</h3>
              <EventList events={items} demoIds={demoIds} onEdit={edit} onDelete={remove} />
            </section>
          ))}
        </div>
      )}

      {importing && (
        <ImportDialog
          result={importing}
          existingIds={new Set(Object.keys(storedEntries))}
          lists={live}
          onClose={() => setImporting(null)}
          onImport={importEntries}
        />
      )}
      {exporting && (
        <ExportDialog
          count={(scope, withComms) => exportList(scope, withComms).length}
          onClose={() => setExporting(false)}
          onExport={(scope, withComms) => exportEvents(exportList(scope, withComms))}
        />
      )}

      {dialog && (
        <EntryDialog
          key={dialog.event?.id ?? 'new'}
          event={dialog.event}
          prefill={dialog.prefill}
          lists={live}
          demoNames={demo?.demoNames}
          isDemo={!!dialog.event && demoIds.has(dialog.event.id)}
          defaultListId={dialog.event?.listId ?? (live.some((l) => l.id === DEMO_LIST_ID) && demo ? DEMO_LIST_ID : live[0]?.id ?? '')}
          onClose={() => setDialog(null)}
          onSaveComm={(listId, entry) => {
            saveComm(listId, entry, dialog.event?.kind === 'communication' ? dialog.event.listId : undefined)
            setDialog(null)
          }}
          onSaveAppointment={(entry) => {
            saveAppointment(entry)
            setDialog(null)
          }}
          onDelete={remove}
        />
      )}
    </PageFrame>
  )
}

function ExportDialog({ count, onClose, onExport }: {
  count: (scope: ExportScope, withComms: boolean) => number
  onClose: () => void
  onExport: (scope: ExportScope, withComms: boolean) => void
}) {
  const [scope, setScope] = useState<ExportScope>('month')
  const [withComms, setWithComms] = useState(true)
  const n = count(scope, withComms)
  const options: [ExportScope, string][] = [['month', 'This month'], ['view', 'Visible view'], ['all', 'Everything']]
  return (
    <Dialog
      open
      onClose={onClose}
      title="Export .ics"
      description="Download entries as an iCalendar file for Outlook, Google Calendar or Apple Calendar. The filter above is respected."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="download" disabled={n === 0} onClick={() => onExport(scope, withComms)}>Export {plural(n, 'entry', 'entries')}</Button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold text-slate-800">Range</legend>
        <div role="group" aria-label="Range" className="flex gap-2">
          {options.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={scope === key}
              onClick={() => setScope(key)}
              className={clsx('inline-flex h-10 flex-1 items-center justify-center rounded-md text-sm font-medium transition-colors', scope === key ? 'bg-slate-900 font-semibold text-white' : 'bg-slate-100 text-slate-800 hover:bg-slate-200/70')}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="mt-3 flex items-center gap-2 text-sm font-medium text-slate-800">
        <input type="checkbox" checked={withComms} onChange={(e) => setWithComms(e.target.checked)} className="size-4 accent-slate-900" />
        Include communication log
      </label>
      {n === 0 && <p className="mt-2 text-sm text-slate-700">Nothing to export in this range.</p>}
    </Dialog>
  )
}

function ImportDialog({ result, existingIds, lists, onClose, onImport }: {
  result: IcsImport & { fileName: string }
  existingIds: ReadonlySet<string>
  lists: { id: string; title: string }[]
  onClose: () => void
  onImport: (entries: CalendarEntry[], projectId: string) => void
}) {
  const [projectId, setProjectId] = useState('')
  const { entries, skipped, recurring, fileName } = result
  const updates = entries.filter((e) => existingIds.has(e.id)).length
  const sorted = [...entries].sort((a, b) => a.start.localeCompare(b.start))
  const preview = sorted.slice(0, 5)
  return (
    <Dialog
      open
      onClose={onClose}
      title={entries.length ? `Import ${plural(entries.length, 'entry', 'entries')}` : 'Nothing to import'}
      description={fileName}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="upload" disabled={entries.length === 0} onClick={() => onImport(entries, projectId)}>Import</Button>
        </>
      }
    >
      {entries.length === 0
        ? <p className="text-sm text-slate-700">No usable events were found in this file.{skipped > 0 && ` ${plural(skipped, 'event was', 'events were')} skipped.`}</p>
        : (
          <>
            <ul className="divide-y divide-slate-100 text-sm">
              {preview.map((e) => (
                <li key={e.id} className="flex gap-3 py-1.5">
                  <span className="num w-[5.5rem] shrink-0 text-slate-700">{new Date(e.start).toLocaleDateString('de-DE')}</span>
                  <span className="num w-12 shrink-0 text-slate-700">{e.allDay ? 'All day' : time(e.start)}</span>
                  <span className="min-w-0 truncate font-medium text-slate-900">{e.title}</span>
                </li>
              ))}
            </ul>
            {entries.length > preview.length && <p className="mt-1 text-sm text-slate-700">and {entries.length - preview.length} more</p>}
            <ul className="mt-3 space-y-0.5 text-sm text-slate-700">
              {updates > 0 && <li>{plural(updates, 'entry', 'entries')} will update existing ones.</li>}
              {recurring > 0 && <li>{plural(recurring, 'recurring event', 'recurring events')}: only the first occurrence is imported.</li>}
              {skipped > 0 && <li>{plural(skipped, 'event', 'events')} skipped (no valid start, cancelled or exported log entries).</li>}
            </ul>
            <div className="mt-3">
              <Field label="Project" hint="Applied to all imported entries.">
                <select className={inputCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">No project</option>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                </select>
              </Field>
            </div>
          </>
        )}
    </Dialog>
  )
}

/** the small marker in front of an entry: a brand square for an appointment, a coloured dot for the party */
function Marker({ event, className }: { event: CalendarEvent; className?: string }) {
  return event.kind === 'appointment'
    ? <span aria-hidden className={clsx('size-2 shrink-0 rounded-sm bg-brand-600', className)} />
    : <span aria-hidden className={clsx('size-2 shrink-0 rounded-full', DOT[event.party ?? 'subcontractor'], className)} />
}

/** a compact entry in the grids: manual entries open the editor, automatic ones link to their project, appointments are tinted brand */
function EventChip({ event, demoIds, onEdit, className, style, children }: {
  event: CalendarEvent
  demoIds: ReadonlySet<string>
  onEdit: (e: CalendarEvent) => void
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const tone = clsx(className, 'transition-colors', isAppointment(event) ? 'bg-brand-100 ring-1 ring-brand-500/50 hover:bg-brand-100/70' : 'bg-white/80 ring-1 ring-slate-200 hover:bg-white')
  const label = `${whenLabel(event)} ${event.name}${demoIds.has(event.id) ? ' (demo)' : ''}`
  if (event.source === 'manual') {
    return <button type="button" style={style} title={label} aria-label={label} onClick={() => onEdit(event)} className={clsx(tone, 'focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:outline-none')}>{children}</button>
  }
  if (event.tab && event.listId) {
    return <Link to={`/list/${event.listId}?phase=${event.tab}`} style={style} title={label} className={clsx(tone, 'focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:outline-none')}>{children}</Link>
  }
  return <div style={style} title={label} className={tone}>{children}</div>
}

function WeekView({ days, events, todayKey, demoIds, onEdit, onCreate }: {
  days: Date[]
  events: CalendarEvent[]
  todayKey: string
  demoIds: ReadonlySet<string>
  onEdit: (e: CalendarEvent) => void
  onCreate: (p: Prefill) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = FIRST_HOUR * HOUR_PX
  }, [])
  const hours = Array.from({ length: 24 }, (_, h) => h)
  const keys = days.map(dayKey)
  const header = (d: Date, key: string) => (
    <div key={key} className="px-1 py-1.5 text-center">
      <span className="block text-xs font-semibold text-slate-600">{WEEKDAYS[(d.getDay() + 6) % 7]}</span>
      <span className={clsx('num inline-flex size-6 items-center justify-center rounded-full text-[13px]', key === todayKey ? 'bg-slate-900 font-semibold text-white' : 'font-medium text-slate-800')}>{d.getDate()}</span>
    </div>
  )

  return (
    <div className="overflow-x-auto">
      <div role="group" aria-label="Week" className="min-w-[44rem] overflow-hidden rounded-lg ring-1 ring-slate-200">
        <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] border-b border-slate-200 bg-slate-50">
          <div aria-hidden />
          {days.map((d, i) => header(d, keys[i]))}
        </div>
        {/* all-day row */}
        <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] border-b border-slate-200">
          <div className="px-1 py-1.5 text-[11px] text-slate-600">All day</div>
          {keys.map((key) => {
            const items = entriesForDay(events, key).filter((e) => isAppointment(e) && e.allDay)
            return (
              <div key={key} className="relative min-h-9 border-l border-slate-100 p-0.5">
                <button
                  type="button"
                  aria-label={`${longDay(new Date(`${key}T12:00:00`))}, all day. New entry`}
                  onClick={() => onCreate({ date: key })}
                  className="absolute inset-0 hover:bg-slate-100/60 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:outline-none focus-visible:ring-inset"
                />
                <ul className="relative space-y-0.5">
                  {items.map((e) => (
                    <li key={e.id}>
                      <EventChip event={e} demoIds={demoIds} onEdit={onEdit} className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-xs text-slate-900">
                        <Marker event={e} />
                        <span className="truncate">{e.name}</span>
                      </EventChip>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
        {/* hours: 07:00–20:00 visible, scroll for the rest of the day */}
        <div ref={scroller} className="overflow-y-auto" style={{ height: VISIBLE_HOURS * HOUR_PX }}>
          <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))]" style={{ height: 24 * HOUR_PX }}>
            <div aria-hidden className="relative">
              {hours.map((h) => (
                <span key={h} className="num absolute right-1 -translate-y-1/2 text-[11px] text-slate-600" style={{ top: h * HOUR_PX, display: h === 0 ? 'none' : undefined }}>{two(h)}:00</span>
              ))}
            </div>
            {keys.map((key) => (
              <div key={key} className={clsx('relative border-l border-slate-100', key === todayKey && 'bg-brand-50/40')}>
                {hours.map((h) => (
                  <button
                    key={h}
                    type="button"
                    aria-label={`${longDay(new Date(`${key}T12:00:00`))}, ${two(h)}:00. New entry`}
                    onClick={() => onCreate({ date: key, time: `${two(h)}:00` })}
                    className="block w-full border-b border-slate-100 hover:bg-slate-100/60 focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:outline-none focus-visible:ring-inset"
                    style={{ height: HOUR_PX }}
                  />
                ))}
                {layoutDay(events, key).map((p) => (
                  <EventChip
                    key={p.event.id}
                    event={p.event}
                    demoIds={demoIds}
                    onEdit={onEdit}
                    className="absolute z-10 block overflow-hidden rounded px-1 py-0.5 text-left text-xs text-slate-900"
                    style={{
                      top: (p.top * HOUR_PX) / 60,
                      height: ((p.bottom - p.top) * HOUR_PX) / 60 - 1,
                      left: `calc(${(p.column / p.columns) * 100}% + 1px)`,
                      width: `calc(${100 / p.columns}% - 2px)`,
                    }}
                  >
                    {/* short blocks (communication is 30 min) fit time and name on one line */}
                    {p.bottom - p.top < 45 ? (
                      <span className="flex min-w-0 items-center gap-1"><Marker event={p.event} /><span className="num shrink-0 text-slate-600">{time(p.event.at)}</span><span className="truncate font-medium">{p.event.name}</span></span>
                    ) : (
                      <>
                        <span className="flex items-center gap-1"><Marker event={p.event} /><span className="num shrink-0 text-slate-600">{time(p.event.at)}</span></span>
                        <span className="block truncate font-medium">{p.event.name}</span>
                      </>
                    )}
                    {p.event.listTitle && p.bottom - p.top >= 60 && <span className="block truncate text-slate-600">{p.event.listTitle}</span>}
                  </EventChip>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function EventList({ events, demoIds, onEdit, onDelete }: { events: CalendarEvent[]; demoIds: ReadonlySet<string>; onEdit: (e: CalendarEvent) => void; onDelete: (e: CalendarEvent) => void }) {
  return (
    <ul className="divide-y divide-slate-100">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-3 py-3">
          <span className="num mt-0.5 w-[6.5rem] shrink-0 text-sm text-slate-700">{whenLabel(e)}</span>
          <span className="mt-1 flex shrink-0 items-center gap-1.5 text-slate-600">
            <Marker event={e} className="size-2.5" />
            {e.kind === 'appointment'
              ? <><Icon name="event" size={18} /><span className="sr-only">Appointment</span></>
              : <><Icon name={CHANNEL_ICON[e.channel ?? 'other']} size={18} />
                <span className="sr-only">{PARTY_LABEL[e.party ?? 'subcontractor']}, {CHANNEL_LABEL[e.channel ?? 'other']}, {e.direction === 'out' ? 'sent' : 'received'}</span></>}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-semibold text-slate-900">{e.name}</span>
              {e.party && <span className="text-slate-600">{PARTY_LABEL[e.party]}</span>}
              {e.kind === 'appointment' && <span className="rounded bg-brand-100 px-1.5 text-xs font-semibold text-slate-900">Appointment</span>}
              {demoIds.has(e.id) && <span className="rounded bg-amber-50 px-1.5 text-xs font-semibold text-amber-900">Demo</span>}
            </p>
            {(e.text || e.amount != null) && (
              <p className="text-sm text-slate-700">
                {e.text}
                {e.amount != null && <> · <span className="num font-medium text-slate-900">{money(e.amount)}</span></>}
              </p>
            )}
            {e.location && <p className="text-sm text-slate-700">{e.location}</p>}
            {e.note && <p className="text-sm text-slate-700">{e.note}</p>}
            {e.listTitle && (
              <p className="mt-0.5 text-[13px] text-slate-600">
                {e.listId && (e.tab || e.kind === 'appointment')
                  ? <Link to={e.tab ? `/list/${e.listId}?phase=${e.tab}` : `/list/${e.listId}`} className="font-medium underline decoration-slate-400 underline-offset-4 hover:text-slate-900">{e.listTitle}</Link>
                  : e.listTitle}
              </p>
            )}
          </div>
          {e.source === 'manual' && (
            <div className="flex shrink-0">
              <IconButton icon="edit" label={`Edit ${e.kind === 'appointment' ? 'appointment' : 'entry with'} ${e.name}`} onClick={() => onEdit(e)} />
              <IconButton icon="delete" label={`Delete ${e.kind === 'appointment' ? 'appointment' : 'entry with'} ${e.name}`} onClick={() => onDelete(e)} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function EntryDialog({ event, prefill, lists, demoNames, isDemo, defaultListId, onClose, onSaveComm, onSaveAppointment, onDelete }: {
  event?: CalendarEvent
  prefill?: Prefill
  lists: { id: string; title: string }[]
  demoNames?: Record<string, { name: string }>
  isDemo: boolean
  defaultListId: string
  onClose: () => void
  onSaveComm: (listId: string, entry: Communication) => void
  onSaveAppointment: (entry: CalendarEntry) => void
  onDelete: (e: CalendarEvent) => void
}) {
  const formId = useId()
  const [kind, setKind] = useState<'appointment' | 'communication'>(event?.kind ?? 'appointment')
  const [now] = useState(() => new Date())
  const start = event ? new Date(event.at) : null
  const end = event?.end ? new Date(event.end) : null
  const nextHour = `${two(Math.min(23, now.getHours() + 1))}:00`

  const [date, setDate] = useState(() => start ? dateInput(start) : prefill?.date ?? dateInput(now))
  const [at, setAt] = useState(() => start ? timeInput(start) : prefill?.time ?? nextHour)
  const [note, setNote] = useState(event?.note ?? '')
  // communication
  const [listId, setListId] = useState(defaultListId)
  const [party, setParty] = useState<CommParty>(event?.party ?? 'subcontractor')
  const [name, setName] = useState(event?.kind === 'communication' ? event.name : '')
  const [channel, setChannel] = useState<CommChannel>(event?.channel ?? 'email')
  const [direction, setDirection] = useState<'in' | 'out'>(event?.direction ?? 'out')
  // appointment
  const [title, setTitle] = useState(event?.kind === 'appointment' ? event.name : '')
  const [allDay, setAllDay] = useState(event?.allDay ?? false)
  const [endDate, setEndDate] = useState(() => end ? dateInput(end) : start ? dateInput(start) : prefill?.date ?? dateInput(now))
  const [endTime, setEndTime] = useState(() => end && !event?.allDay ? timeInput(end) : clock(Math.min(1439, minutesOf(start ? timeInput(start) : prefill?.time ?? nextHour) + 60)))
  const [location, setLocation] = useState(event?.location ?? '')
  const [projectId, setProjectId] = useState(event?.kind === 'appointment' ? event.listId ?? '' : '')
  const [tried, setTried] = useState(false)

  const subs = useSubcontractors(kind === 'communication' && party === 'subcontractor')
  const suppliers = useSupplierNames(kind === 'communication' && party === 'supplier')
  const suggestions = party === 'subcontractor'
    ? [...new Set([...subs.rows.map((r) => r.name), ...Object.values(demoNames ?? {}).map((n) => n.name)])]
    : party === 'supplier' ? suppliers : []

  const changeStart = (next: string) => {
    // moving the start moves the end with it, so the length stays
    const delta = minutesOf(next || '00:00') - minutesOf(at || '00:00')
    if (endDate === date && endTime && next) setEndTime(clock(Math.max(0, Math.min(1439, minutesOf(endTime) + delta))))
    setAt(next)
  }
  const changeDate = (next: string) => {
    if (endDate === date || endDate < next) setEndDate(next)
    setDate(next)
  }

  const when = new Date(`${date}T${at || '00:00'}`)
  const commReady = !!listId && !!name.trim() && !Number.isNaN(when.getTime())
  const draft: CalendarEntry = {
    id: event?.id ?? newCalendarEntryId(),
    title: title.trim(),
    start: allDay ? new Date(`${date}T00:00:00`).toISOString() : when.toISOString(),
    end: allDay
      ? (endDate && endDate !== date ? new Date(`${endDate}T00:00:00`).toISOString() : undefined)
      : endTime ? new Date(`${endDate || date}T${endTime}`).toISOString() : undefined,
    allDay,
    listId: projectId || undefined,
    location: location.trim() || undefined,
    note: note.trim() || undefined,
  }
  const apptError = Number.isNaN(when.getTime()) ? 'Enter a valid date.' : validateEntry(draft)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (kind === 'appointment' ? !!apptError : !commReady) {
      setTried(true)
      return
    }
    if (isDemo) {
      toast('Demo data: nothing was saved', 'info')
      onClose()
      return
    }
    if (kind === 'appointment') onSaveAppointment(draft)
    else onSaveComm(listId, { id: event?.kind === 'communication' ? event.id : newCommunicationId(), at: when.toISOString(), party, name: name.trim(), channel, direction, note: note.trim() || undefined })
  }

  const noun = kind === 'appointment' ? 'appointment' : 'communication'
  return (
    <Dialog
      open
      onClose={onClose}
      title={event ? `Edit ${noun}` : 'New entry'}
      description={kind === 'appointment' ? 'Plan a site visit, a deadline or an internal meeting.' : 'Write down a call, an email, a meeting or a letter.'}
      footer={
        <>
          {event && event.source === 'manual' && (
            <Button icon="delete" className="mr-auto" onClick={() => { onDelete(event); onClose() }}>Delete</Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={kind === 'communication' && !commReady}>{event ? 'Save' : kind === 'appointment' ? 'Add' : 'Log it'}</Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="grid grid-cols-2 gap-3">
        {!event && (
          <div role="group" aria-label="Entry type" className="col-span-2 flex gap-2">
            {([['appointment', 'Appointment', 'event'], ['communication', 'Communication', 'forum']] as const).map(([key, label, icon]) => (
              <button
                key={key}
                type="button"
                aria-pressed={kind === key}
                onClick={() => setKind(key)}
                className={clsx('inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors', kind === key ? 'bg-slate-900 font-semibold text-white' : 'bg-slate-100 text-slate-800 hover:bg-slate-200/70')}
              >
                <Icon name={icon} size={16} />{label}
              </button>
            ))}
          </div>
        )}

        {kind === 'appointment' ? (
          <>
            <div className="col-span-2">
              <Field label="Title">
                <input data-autofocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoComplete="off" aria-invalid={tried && !title.trim()} />
              </Field>
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm font-medium text-slate-800">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="size-4 accent-slate-900" />
              All day
            </label>
            <Field label={allDay ? 'First day' : 'Date'}><input type="date" className={inputCls} value={date} onChange={(e) => changeDate(e.target.value)} /></Field>
            <Field label={allDay ? 'Last day' : 'End date'}><input type="date" className={inputCls} value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} /></Field>
            {!allDay && (
              <>
                <Field label="Start time"><input type="time" className={inputCls} value={at} onChange={(e) => changeStart(e.target.value)} /></Field>
                <Field label="End time"><input type="time" className={inputCls} value={endTime} onChange={(e) => setEndTime(e.target.value)} /></Field>
              </>
            )}
            <div className="col-span-2">
              <Field label="Location"><input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} placeholder="optional" /></Field>
            </div>
            <div className="col-span-2">
              <Field label="Project">
                <select className={inputCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">No project</option>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                </select>
              </Field>
            </div>
            {(tried || title.trim()) && apptError && <p role="alert" className="col-span-2 text-sm font-medium text-red-700">{apptError}</p>}
          </>
        ) : (
          <>
            <div className="col-span-2">
              <Field label="Project">
                <select className={inputCls} value={listId} onChange={(e) => setListId(e.target.value)}>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Date"><input type="date" className={inputCls} value={date} onChange={(e) => changeDate(e.target.value)} /></Field>
            <Field label="Time"><input type="time" className={inputCls} value={at} onChange={(e) => changeStart(e.target.value)} /></Field>
            <Field label="Party">
              <select className={inputCls} value={party} onChange={(e) => setParty(e.target.value as CommParty)}>
                {PARTIES.map((p) => <option key={p} value={p}>{PARTY_LABEL[p]}</option>)}
              </select>
            </Field>
            <Field label="Channel">
              <select className={inputCls} value={channel} onChange={(e) => setChannel(e.target.value as CommChannel)}>
                {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              </select>
            </Field>
            <div className="col-span-2">
              <Field label="Name" hint={suggestions.length ? 'Pick from the catalogue or type any name.' : undefined}>
                <input data-autofocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} list={`${formId}-names`} maxLength={120} autoComplete="off" />
              </Field>
              <datalist id={`${formId}-names`}>{suggestions.map((n) => <option key={n} value={n} />)}</datalist>
            </div>
            <fieldset className="col-span-2">
              <legend className="mb-1.5 text-sm font-semibold text-slate-800">Direction</legend>
              <div role="group" aria-label="Direction" className="flex gap-2">
                {([['out', 'Sent'], ['in', 'Received']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={direction === key}
                    onClick={() => setDirection(key)}
                    className={clsx('inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors', direction === key ? 'bg-slate-900 font-semibold text-white' : 'bg-slate-100 text-slate-800 hover:bg-slate-200/70')}
                  >
                    <Icon name={key === 'out' ? 'north_east' : 'south_west'} size={16} />{label}
                  </button>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <div className="col-span-2">
          <Field label="Note"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="optional" /></Field>
        </div>
      </form>
    </Dialog>
  )
}
