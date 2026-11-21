/**
 * The communication calendar: what was sent to and received from subcontractors, the client and suppliers.
 * Events come from two places, merged here: automatic ones derived from the subcontract packages and the award
 * document of every list, and manual entries kept per list in `listPatch[listId].communications`. Pure functions only.
 */
import { offerOf, type SubcontractPackage } from './subcontract'

export type CommParty = 'subcontractor' | 'client' | 'supplier'
export type CommChannel = 'email' | 'phone' | 'meeting' | 'letter' | 'other'

export type Communication = {
  id: string
  /** ISO date-time */
  at: string
  party: CommParty
  name: string
  channel: CommChannel
  /** `out`: we sent it, `in`: we received it */
  direction: 'in' | 'out'
  note?: string
}

/** a custom appointment, independent of projects (synced workspace collection `calendar`) */
export type CalendarEntry = {
  id: string
  title: string
  /** ISO date-time; for an all-day entry the local midnight of its first day */
  start: string
  /** ISO date-time; for an all-day entry the local midnight of its last day (inclusive) */
  end?: string
  allDay: boolean
  /** optional project link */
  listId?: string
  location?: string
  note?: string
}

export type CalendarEvent = {
  id: string
  kind: 'communication' | 'appointment'
  /** start, ISO */
  at: string
  /** appointments only */
  end?: string
  allDay?: boolean
  location?: string
  /** communications only */
  party?: CommParty
  /** the subcontractor / client name, or the appointment title */
  name: string
  channel?: CommChannel
  direction?: 'in' | 'out'
  /** the manual note */
  note?: string
  /** one line: what happened ("Request sent: Kitchen"); empty for appointments */
  text: string
  /** the project; appointments may have none */
  listId?: string
  listTitle?: string
  /** EUR, on a received offer */
  amount?: number
  source: 'auto' | 'manual'
  /** the list tab an automatic event opens */
  tab?: 'subcontractors' | 'x86'
}

/** the parts of a list patch the calendar reads */
export type CalendarPatch = {
  subcontractPackages?: SubcontractPackage[]
  awardDocumentId?: string
  awardUploadedAt?: string
  communications?: Communication[]
}

export const PARTY_LABEL: Record<CommParty, string> = { subcontractor: 'Subcontractor', client: 'Client', supplier: 'Supplier' }
export const CHANNEL_LABEL: Record<CommChannel, string> = { email: 'Email', phone: 'Phone', meeting: 'Meeting', letter: 'Letter', other: 'Other' }

export const newCommunicationId = () => `com-${crypto.randomUUID()}`
export const newCalendarEntryId = () => `cal-${crypto.randomUUID()}`

const valid = (iso: string | undefined): iso is string => !!iso && !Number.isNaN(new Date(iso).getTime())

/**
 * Every event of every list, oldest first (ties by id, so the order is stable).
 * `names` turns a subcontractor catalogue id into a display name.
 * Automatic events: "Request sent" per subcontractor (their own date, else the package's; drafts were never sent),
 * "Offer received" per offer with a date, and the award document upload. Events without a readable date are skipped.
 */
export function collectEvents(
  lists: readonly { id: string; title: string }[],
  listPatch: Readonly<Record<string, CalendarPatch | undefined>>,
  names: (subId: string) => string,
  appointments: Readonly<Record<string, CalendarEntry>> | readonly CalendarEntry[] = [],
): CalendarEvent[] {
  const out: CalendarEvent[] = []
  for (const entry of Array.isArray(appointments) ? appointments : Object.values(appointments)) {
    if (!valid(entry.start)) continue
    const project = entry.listId ? lists.find((l) => l.id === entry.listId) : undefined
    out.push({
      id: entry.id, kind: 'appointment', at: entry.start, end: valid(entry.end) ? entry.end : undefined, allDay: entry.allDay,
      name: entry.title, location: entry.location, note: entry.note, text: '', source: 'manual',
      listId: project?.id, listTitle: project?.title,
    })
  }
  for (const list of lists) {
    const patch = listPatch[list.id]
    if (!patch) continue
    const base = { listId: list.id, listTitle: list.title, kind: 'communication' as const }
    for (const pkg of patch.subcontractPackages ?? []) {
      const subIds = [...new Set([...pkg.subcontractorIds, ...Object.keys(pkg.offers ?? {})])]
      for (const subId of subIds) {
        const offer = offerOf(pkg, subId)
        const sentAt = pkg.status === 'draft' ? undefined : offer.sentAt ?? pkg.sentAt
        if (valid(sentAt)) {
          out.push({ ...base, id: `auto:${list.id}:${pkg.id}:${subId}:sent`, at: sentAt, party: 'subcontractor', name: names(subId), channel: 'email', direction: 'out', text: `Request sent: ${pkg.name}`, source: 'auto', tab: 'subcontractors' })
        }
        if (valid(offer.receivedAt)) {
          out.push({ ...base, id: `auto:${list.id}:${pkg.id}:${subId}:received`, at: offer.receivedAt, party: 'subcontractor', name: names(subId), channel: 'email', direction: 'in', text: `Offer received: ${pkg.name}`, amount: offer.amount, source: 'auto', tab: 'subcontractors' })
        }
      }
    }
    if (patch.awardDocumentId && valid(patch.awardUploadedAt)) {
      out.push({ ...base, id: `auto:${list.id}:award`, at: patch.awardUploadedAt, party: 'client', name: 'Client', channel: 'other', direction: 'in', text: 'Award document received (X86)', source: 'auto', tab: 'x86' })
    }
    for (const c of patch.communications ?? []) {
      if (!valid(c.at)) continue
      out.push({ ...base, id: c.id, at: c.at, party: c.party, name: c.name, channel: c.channel, direction: c.direction, note: c.note, text: `${c.direction === 'out' ? 'Sent' : 'Received'} by ${CHANNEL_LABEL[c.channel].toLowerCase()}`, source: 'manual' })
    }
  }
  return out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.id.localeCompare(b.id))
}

export type PartyFilter = 'all' | 'appointment' | CommParty

export const filterEvents = (events: readonly CalendarEvent[], party: PartyFilter): CalendarEvent[] =>
  party === 'all' ? [...events]
    : party === 'appointment' ? events.filter((e) => e.kind === 'appointment')
    : events.filter((e) => e.kind === 'communication' && e.party === party)

/** appointment form check: a title, and an end that is not before the start */
export function validateEntry(e: Pick<CalendarEntry, 'title' | 'start' | 'end' | 'allDay'>): string | null {
  if (!e.title.trim()) return 'Enter a title.'
  const start = new Date(e.start)
  if (Number.isNaN(start.getTime())) return 'Enter a valid date.'
  if (e.end) {
    const end = new Date(e.end)
    if (Number.isNaN(end.getTime())) return 'Enter a valid end.'
    if (e.allDay ? end < start : end <= start) return 'The end must be after the start.'
  }
  return null
}

/* ------------------------------------------------------------------ */
/* calendar grid                                                       */
/* ------------------------------------------------------------------ */

const two = (n: number) => String(n).padStart(2, '0')

/** "2026-11-05" in the viewer's time zone, the key of a calendar day */
export const dayKey = (d: Date | string): string => {
  const date = typeof d === 'string' ? new Date(d) : d
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/** the days a month grid shows: whole weeks, Monday first (German week) */
export function monthDays(year: number, month: number): Date[] {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7
  const length = new Date(year, month + 1, 0).getDate()
  const count = Math.ceil((offset + length) / 7) * 7
  return Array.from({ length: count }, (_, i) => new Date(year, month, 1 - offset + i))
}

const HOUR = 3_600_000

/** the time span of an event; a timed appointment without an end lasts one hour, anything else is a point */
export function eventRange(e: Pick<CalendarEvent, 'kind' | 'at' | 'end' | 'allDay'>): { start: Date; end: Date } {
  const start = new Date(e.at)
  if (e.kind !== 'appointment') return { start, end: start }
  const end = e.end ? new Date(e.end) : null
  if (e.allDay) {
    const last = end && end > start ? end : start
    return { start, end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1) } // exclusive
  }
  return { start, end: end && end > start ? end : new Date(start.getTime() + HOUR) }
}

/** the day keys an event touches (a multi-day appointment appears on each day) */
export function daysOf(e: CalendarEvent): string[] {
  const { start, end } = eventRange(e)
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const keys: string[] = []
  for (let d = first; d < end || keys.length === 0; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    keys.push(dayKey(d))
    if (keys.length > 366) break
  }
  return keys
}

/** events by day key, in the order given; multi-day appointments are listed on every day they span */
export function groupByDay(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const out = new Map<string, CalendarEvent[]>()
  for (const e of events) {
    for (const key of daysOf(e)) {
      const list = out.get(key)
      if (list) list.push(e)
      else out.set(key, [e])
    }
  }
  return out
}

/** the events on one day, in the order given */
export const entriesForDay = (events: readonly CalendarEvent[], key: string): CalendarEvent[] =>
  events.filter((e) => daysOf(e).includes(key))

/** the seven days of the week (Monday first) that contains `date` */
export function weekDays(date: Date): Date[] {
  const offset = (date.getDay() + 6) % 7
  return Array.from({ length: 7 }, (_, i) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset + i))
}

export type Placed = { event: CalendarEvent; /** minutes from midnight */ top: number; bottom: number; column: number; columns: number }

/**
 * Places the timed events of one day on a time axis. Events that overlap share the width: each gets a column
 * and the number of columns of its overlap group. A span is at least 30 minutes tall so it stays clickable.
 */
export function layoutDay(events: readonly CalendarEvent[], key: string): Placed[] {
  const dayStart = new Date(`${key}T00:00:00`)
  const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1)
  const items = events
    .filter((e) => !(e.kind === 'appointment' && e.allDay) && daysOf(e).includes(key))
    .map((event) => {
      const { start, end } = eventRange(event)
      const top = Math.max(0, (start.getTime() - dayStart.getTime()) / 60_000)
      const bottom = Math.max(top + 30, Math.min(1440, (Math.min(end.getTime(), dayEnd.getTime()) - dayStart.getTime()) / 60_000))
      return { event, top, bottom, column: 0, columns: 1 }
    })
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom || a.event.id.localeCompare(b.event.id))
  let group: typeof items = []
  let groupEnd = -1
  const close = () => {
    const columns = group.reduce((m, p) => Math.max(m, p.column + 1), 1)
    for (const p of group) p.columns = columns
    group = []
  }
  for (const item of items) {
    if (group.length && item.top >= groupEnd) close()
    const taken = new Set(group.filter((p) => p.bottom > item.top).map((p) => p.column))
    while (taken.has(item.column)) item.column++
    group.push(item)
    groupEnd = Math.max(groupEnd, item.bottom)
  }
  if (group.length) close()
  return items
}
