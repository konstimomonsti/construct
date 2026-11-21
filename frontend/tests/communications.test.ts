import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectEvents, dayKey, filterEvents, groupByDay, monthDays, type CalendarPatch, type Communication } from '../src/lib/communications'
import type { SubcontractPackage } from '../src/lib/subcontract'

const pkg = (extra: Partial<SubcontractPackage> = {}): SubcontractPackage => ({
  id: 'k', name: 'Kitchen', positionIds: ['a'], subcontractorIds: ['s1', 's2'], budget: { perPosition: {}, total: 1000 }, format: 'x83', status: 'sent',
  sentAt: '2026-11-10T09:00:00.000Z', ...extra,
})
const lists = [{ id: 'l1', title: 'AN24' }, { id: 'l2', title: 'Other' }]
const names = (id: string) => `name-${id}`

test('automatic events: request sent per subcontractor, offer received with amount', () => {
  const patch: Record<string, CalendarPatch> = {
    l1: { subcontractPackages: [pkg({ offers: { s1: { receivedAt: '2026-11-14T10:00:00.000Z', amount: 9400 }, s2: { sentAt: '2026-11-11T09:00:00.000Z' } } })] },
  }
  const events = collectEvents(lists, patch, names)
  assert.deepEqual(events.map((e) => e.id), ['auto:l1:k:s1:sent', 'auto:l1:k:s2:sent', 'auto:l1:k:s1:received'])
  assert.deepEqual(events.map((e) => e.at), ['2026-11-10T09:00:00.000Z', '2026-11-11T09:00:00.000Z', '2026-11-14T10:00:00.000Z'])
  const received = events.find((e) => e.id.endsWith(':received'))!
  assert.equal(received.direction, 'in')
  assert.equal(received.amount, 9400)
  assert.equal(received.name, 'name-s1')
  assert.equal(received.party, 'subcontractor')
  assert.equal(received.tab, 'subcontractors')
  assert.equal(received.listTitle, 'AN24')
  const sent = events.find((e) => e.id === 'auto:l1:k:s2:sent')!
  assert.equal(sent.direction, 'out')
  assert.equal(sent.at, '2026-11-11T09:00:00.000Z', "the subcontractor's own sent date wins over the package's")
})

test('drafts were never sent: no request event, and undated offers add nothing', () => {
  const patch = { l1: { subcontractPackages: [pkg({ status: 'draft', sentAt: undefined, offers: { s1: { amount: 5 } } })] } }
  assert.deepEqual(collectEvents(lists, patch, names), [])
})

test('the award document becomes a client event only with its upload date', () => {
  const dated = collectEvents(lists, { l1: { awardDocumentId: 'd1', awardUploadedAt: '2026-11-20T08:00:00.000Z' } }, names)
  assert.equal(dated.length, 1)
  assert.equal(dated[0].party, 'client')
  assert.equal(dated[0].direction, 'in')
  assert.equal(dated[0].tab, 'x86')
  assert.deepEqual(collectEvents(lists, { l1: { awardDocumentId: 'd1' } }, names), [])
  assert.deepEqual(collectEvents(lists, { l1: { awardUploadedAt: '2026-11-20T08:00:00.000Z' } }, names), [], 'award was removed')
})

test('manual entries are merged, keep their note and are tied to their list', () => {
  const call: Communication = { id: 'com-1', at: '2026-11-12T12:00:00.000Z', party: 'client', name: 'Frau Muster', channel: 'phone', direction: 'in', note: 'Fristverlängerung' }
  const events = collectEvents(lists, { l2: { communications: [call] } }, names)
  assert.equal(events.length, 1)
  assert.equal(events[0].source, 'manual')
  assert.equal(events[0].listId, 'l2')
  assert.equal(events[0].listTitle, 'Other')
  assert.equal(events[0].note, 'Fristverlängerung')
  assert.equal(events[0].id, 'com-1')
})

test('events from all sources are sorted oldest first, ties by id; unreadable dates are skipped', () => {
  const patch: Record<string, CalendarPatch> = {
    l1: {
      subcontractPackages: [pkg({ offers: { s1: { receivedAt: '2026-11-12T12:00:00.000Z' } } })],
      communications: [
        { id: 'com-b', at: '2026-11-12T12:00:00.000Z', party: 'supplier', name: 'B', channel: 'email', direction: 'out' },
        { id: 'com-a', at: '2026-11-01T08:00:00.000Z', party: 'client', name: 'A', channel: 'letter', direction: 'in' },
        { id: 'com-bad', at: 'not a date', party: 'client', name: 'X', channel: 'other', direction: 'in' },
      ],
    },
  }
  const events = collectEvents(lists, patch, names)
  assert.equal(events[0].id, 'com-a')
  const sameTime = events.filter((e) => e.at === '2026-11-12T12:00:00.000Z').map((e) => e.id)
  assert.deepEqual(sameTime, [...sameTime].sort())
  assert.equal(events.some((e) => e.id === 'com-bad'), false)
  for (let i = 1; i < events.length; i++) assert.ok(new Date(events[i - 1].at) <= new Date(events[i].at))
})

test('filterEvents keeps one party', () => {
  const events = collectEvents(lists, {
    l1: { communications: [
      { id: 'c1', at: '2026-11-01T08:00:00.000Z', party: 'client', name: 'A', channel: 'letter', direction: 'in' },
      { id: 'c2', at: '2026-11-02T08:00:00.000Z', party: 'supplier', name: 'B', channel: 'email', direction: 'out' },
    ] },
  }, names)
  assert.equal(filterEvents(events, 'all').length, 2)
  assert.deepEqual(filterEvents(events, 'supplier').map((e) => e.id), ['c2'])
  assert.deepEqual(filterEvents(events, 'subcontractor'), [])
})

test('monthDays covers whole weeks starting on Monday', () => {
  // November 2026 starts on a Sunday: the grid begins on Monday 26 October
  const days = monthDays(2026, 10)
  assert.equal(days.length % 7, 0)
  assert.equal(days[0].getDay(), 1)
  assert.equal(dayKey(days[0]), '2026-10-26')
  assert.equal(dayKey(days.at(-1)!), '2026-12-06')
  assert.equal(days.length, 42)
  // February 2027 starts on a Monday and has 28 days: exactly four weeks
  assert.equal(monthDays(2027, 1).length, 28)
})

test('groupByDay buckets by local day and keeps the order given', () => {
  const noon = (d: number, h = 12) => new Date(2026, 10, d, h).toISOString()
  const events = collectEvents(lists, {
    l1: { communications: [
      { id: 'c1', at: noon(5, 9), party: 'client', name: 'A', channel: 'phone', direction: 'in' },
      { id: 'c2', at: noon(5, 15), party: 'client', name: 'B', channel: 'phone', direction: 'in' },
      { id: 'c3', at: noon(6), party: 'client', name: 'C', channel: 'phone', direction: 'in' },
    ] },
  }, names)
  const groups = groupByDay(events)
  assert.deepEqual(groups.get('2026-11-05')?.map((e) => e.id), ['c1', 'c2'])
  assert.deepEqual(groups.get('2026-11-06')?.map((e) => e.id), ['c3'])
  assert.equal(groups.size, 2)
})
