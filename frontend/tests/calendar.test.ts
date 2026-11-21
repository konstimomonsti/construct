import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectEvents, dayKey, daysOf, entriesForDay, filterEvents, groupByDay, layoutDay, validateEntry, weekDays, type CalendarEntry,
} from '../src/lib/communications'
import { mergeSavedPackage, type SubcontractPackage } from '../src/lib/subcontract'

const lists = [{ id: 'l1', title: 'AN24' }, { id: 'l2', title: 'Other' }]
const names = (id: string) => `name-${id}`
const at = (d: number, h = 0, m = 0) => new Date(2026, 10, d, h, m).toISOString()
const appt = (extra: Partial<CalendarEntry> = {}): CalendarEntry => ({ id: 'cal-1', title: 'Site visit', start: at(5, 9), end: at(5, 11), allDay: false, ...extra })
const call = { id: 'c1', at: at(5, 10), party: 'client' as const, name: 'A', channel: 'phone' as const, direction: 'in' as const }

test('appointments merge with communications, link a project and sort by start', () => {
  const events = collectEvents(lists, { l1: { communications: [call] } }, names, {
    'cal-1': appt({ listId: 'l2' }),
    'cal-2': appt({ id: 'cal-2', title: 'Orphan', start: at(4, 8), end: undefined, listId: 'gone' }),
    'cal-3': appt({ id: 'cal-3', start: 'nope' }),
  })
  assert.deepEqual(events.map((e) => e.id), ['cal-2', 'cal-1', 'c1'])
  const a = events.find((e) => e.id === 'cal-1')!
  assert.equal(a.kind, 'appointment')
  assert.equal(a.name, 'Site visit')
  assert.equal(a.listTitle, 'Other')
  assert.equal(events.find((e) => e.id === 'cal-2')!.listId, undefined, 'a deleted project is not linked')
  assert.equal(events.find((e) => e.id === 'c1')!.kind, 'communication')
})

test('filterEvents: appointments are their own filter and never match a party', () => {
  const events = collectEvents(lists, { l1: { communications: [call] } }, names, [appt()])
  assert.deepEqual(filterEvents(events, 'appointment').map((e) => e.id), ['cal-1'])
  assert.deepEqual(filterEvents(events, 'client').map((e) => e.id), ['c1'])
  assert.equal(filterEvents(events, 'all').length, 2)
})

test('multi-day and all-day appointments appear on every day they span', () => {
  const three = collectEvents(lists, {}, names, [appt({ allDay: true, start: at(3), end: at(5) })])[0]
  assert.deepEqual(daysOf(three), ['2026-11-03', '2026-11-04', '2026-11-05'])
  const overnight = collectEvents(lists, {}, names, [appt({ start: at(3, 22), end: at(4, 6) })])[0]
  assert.deepEqual(daysOf(overnight), ['2026-11-03', '2026-11-04'])
  const endsAtMidnight = collectEvents(lists, {}, names, [appt({ start: at(3, 22), end: at(4, 0) })])[0]
  assert.deepEqual(daysOf(endsAtMidnight), ['2026-11-03'])
  const noEnd = collectEvents(lists, {}, names, [appt({ allDay: true, start: at(7), end: undefined })])[0]
  assert.deepEqual(daysOf(noEnd), ['2026-11-07'])
  assert.deepEqual(entriesForDay([three], '2026-11-04').map((e) => e.id), ['cal-1'])
  assert.deepEqual(entriesForDay([three], '2026-11-06'), [])
  assert.deepEqual([...groupByDay([three]).keys()], ['2026-11-03', '2026-11-04', '2026-11-05'])
})

test('validateEntry needs a title and an end after the start', () => {
  assert.equal(validateEntry(appt()), null)
  assert.match(validateEntry(appt({ title: '  ' }))!, /title/)
  assert.match(validateEntry(appt({ end: at(5, 9) }))!, /after/)
  assert.match(validateEntry(appt({ end: at(5, 8) }))!, /after/)
  assert.equal(validateEntry(appt({ end: undefined })), null)
  assert.equal(validateEntry(appt({ allDay: true, start: at(5), end: at(5) })), null, 'a one-day all-day entry ends on its start day')
  assert.match(validateEntry(appt({ allDay: true, start: at(5), end: at(4) }))!, /after/)
})

test('weekDays starts on Monday', () => {
  const week = weekDays(new Date(2026, 10, 21)) // a Saturday
  assert.deepEqual(week.map(dayKey), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'])
})

test('layoutDay positions timed entries, defaults to one hour and splits overlaps', () => {
  const events = collectEvents(lists, {}, names, [
    appt({ id: 'a', start: at(5, 9), end: at(5, 11) }),
    appt({ id: 'b', start: at(5, 10), end: at(5, 12) }),
    appt({ id: 'c', start: at(5, 13), end: undefined }),
    appt({ id: 'd', allDay: true, start: at(5), end: undefined }),
  ])
  const placed = layoutDay(events, '2026-11-05')
  assert.deepEqual(placed.map((p) => p.event.id), ['a', 'b', 'c'], 'all-day entries are not on the time axis')
  const [a, b, c] = placed
  assert.deepEqual([a.top, a.bottom, a.column, a.columns], [540, 660, 0, 2])
  assert.deepEqual([b.top, b.bottom, b.column, b.columns], [600, 720, 1, 2])
  assert.deepEqual([c.top, c.bottom, c.column, c.columns], [780, 840, 0, 1])
})

/* ---------------- re-saving a package keeps the replies ---------------- */

const pkg = (extra: Partial<SubcontractPackage> = {}): SubcontractPackage => ({
  id: 'p', name: 'p', positionIds: ['a'], subcontractorIds: ['s1', 's2'], budget: { perPosition: {}, total: 1 }, format: 'x83', status: 'sent', ...extra,
})

test('re-saving a package keeps offers, choice and sent text; removed subcontractors lose theirs', () => {
  const existing = pkg({
    status: 'offer_received', chosenId: 's2', sentText: 'old email',
    offers: { s1: { amount: 5 }, s2: { amount: 7, receivedAt: '2026-01-03' } },
  })
  const rebuilt = pkg({ sentAt: '2026-02-01' })
  const kept = mergeSavedPackage(existing, rebuilt)
  assert.deepEqual(kept.offers, existing.offers)
  assert.equal(kept.chosenId, 's2')
  assert.equal(kept.sentText, 'old email', 'no new email composed')
  assert.equal(mergeSavedPackage(existing, { ...rebuilt, sentText: 'new email' }).sentText, 'new email')

  const dropped = mergeSavedPackage(existing, { ...rebuilt, subcontractorIds: ['s1', 's3'] })
  assert.deepEqual(dropped.offers, { s1: { amount: 5 } })
  assert.equal('chosenId' in dropped, false)
})

test('a new package id is stored as built', () => {
  const built = pkg()
  assert.equal(mergeSavedPackage(undefined, built), built)
  assert.equal('offers' in mergeSavedPackage(pkg(), built), false)
})
