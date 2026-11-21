import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectEvents, type CalendarEntry } from '../src/lib/communications'
import { foldLine, overlapsRange, parseIcs, toIcs } from '../src/lib/ics'

const lists = [{ id: 'l1', title: 'AN24' }]
const now = new Date(Date.UTC(2026, 10, 21, 8, 30, 0))
const at = (d: number, h = 0, m = 0) => new Date(2026, 10, d, h, m).toISOString()
const appt = (extra: Partial<CalendarEntry> = {}): CalendarEntry => ({ id: 'cal-1', title: 'Site visit', start: at(5, 9), end: at(5, 11), allDay: false, ...extra })
const events = (entries: CalendarEntry[]) => collectEvents(lists, {}, (id) => id, entries)
const wrap = (...body: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n')
const vevent = (...props: string[]) => wrap('BEGIN:VEVENT', ...props, 'END:VEVENT')

const octets = (s: string) => new TextEncoder().encode(s).length

test('export writes the calendar header, CRLF lines and UTC times', () => {
  const ics = toIcs(events([appt({ location: 'Bau 3' })]), { now, calendarName: 'BillBuild' })
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//BillBuild//Calendar//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:BillBuild\r\n'))
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'))
  assert.ok(!/[^\r]\n/.test(ics), 'no bare LF')
  assert.match(ics, /UID:cal-1@billbuild\r\n/)
  assert.match(ics, /DTSTAMP:20261121T083000Z\r\n/)
  assert.match(ics, new RegExp(`DTSTART:${new Date(at(5, 9)).toISOString().replace(/[-:]|\.\d{3}/g, '')}\r\n`))
  assert.match(ics, /LOCATION:Bau 3\r\n/)
  assert.match(ics, /CATEGORIES:Appointment\r\n/)
})

test('all-day entries use VALUE=DATE with an exclusive end', () => {
  const ics = toIcs(events([appt({ allDay: true, start: at(3), end: at(5) })]), { now })
  assert.match(ics, /DTSTART;VALUE=DATE:20261103\r\n/)
  assert.match(ics, /DTEND;VALUE=DATE:20261106\r\n/)
  const single = toIcs(events([appt({ allDay: true, start: at(3), end: undefined })]), { now })
  assert.match(single, /DTEND;VALUE=DATE:20261104\r\n/)
})

test('communications are exported with party, name, channel and direction', () => {
  const evs = collectEvents(lists, { l1: { communications: [{ id: 'c1', at: at(5, 10), party: 'client', name: 'Bauherr; GmbH', channel: 'phone', direction: 'in', note: 'Rückruf' }] } }, (id) => id)
  const ics = toIcs(evs, { now })
  assert.match(ics, /CATEGORIES:Client\r\n/)
  const unfolded = ics.replace(/\r\n /g, '')
  assert.match(unfolded, /DESCRIPTION:.*Party: Client\\nName: Bauherr\\; GmbH\\nChannel: Phone\\nDirection: Received\\nProject: AN24\\nNote: Rückruf/)
  assert.match(unfolded, /SUMMARY:Bauherr\\; GmbH: Received by phone/)
})

test('round trip keeps title, start, end, all-day, location and note', () => {
  const source = [
    appt({ location: 'Baustelle, Halle 2; Tor 3', note: 'Zeile eins\nZeile zwei, mit Komma; und Backslash \\' }),
    appt({ id: 'cal-2', title: 'Urlaub', allDay: true, start: at(10), end: at(12) }),
    appt({ id: 'cal-3', title: 'Frist', allDay: true, start: at(15), end: undefined }),
    appt({ id: 'cal-4', title: 'Overnight', start: at(20, 22), end: at(21, 6) }),
  ]
  const back = parseIcs(toIcs(events(source), { now }))
  assert.equal(back.skipped, 0)
  assert.deepEqual(back.entries, source)
})

test('re-importing our own export with a project does not grow the note', () => {
  const evs = collectEvents(lists, {}, (id) => id, [appt({ listId: 'l1', note: 'Bring helmets' })])
  const back = parseIcs(toIcs(evs, { now })).entries[0]
  assert.equal(back.note, 'Bring helmets')
  assert.equal(back.id, 'cal-1')
})

test('exported communications are not imported back as appointments', () => {
  const evs = collectEvents(lists, { l1: { communications: [{ id: 'c1', at: at(5, 10), party: 'client', name: 'A', channel: 'phone', direction: 'in' }] } }, (id) => id)
  const back = parseIcs(toIcs(evs, { now }))
  assert.equal(back.entries.length, 0)
  assert.equal(back.skipped, 1)
})

test('long German text is folded at 75 octets without splitting umlauts, and unfolds again', () => {
  const title = 'Übergabe der Bewehrungsabnahme für die Fertigteil-Sockel äöüß – Größe, Maße und Gewährleistung prüfen '.repeat(3).trim()
  const ics = toIcs(events([appt({ title })]), { now })
  for (const line of ics.split('\r\n')) assert.ok(octets(line) <= 75, `line too long: ${octets(line)}`)
  assert.ok(ics.includes('\r\n '), 'folded')
  assert.ok(!ics.includes('�'))
  assert.equal(parseIcs(ics).entries[0].title, title)
  const line = 'X:' + 'ä'.repeat(100)
  const folded = foldLine(line).split('\r\n')
  assert.ok(folded.every((l) => octets(l) <= 75))
  assert.equal(folded.map((l, i) => (i ? l.slice(1) : l)).join(''), line)
})

test('parse: UTC, floating, TZID and VALUE=DATE', () => {
  const r = parseIcs(wrap(
    'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261105T090000Z', 'DTEND:20261105T100000Z', 'SUMMARY:Utc', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261105T090000', 'DTEND:20261105T103000', 'SUMMARY:Floating', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'DTSTART;TZID=Europe/Berlin:20261105T140000', 'DTEND;TZID=Europe/Berlin:20261105T150000', 'SUMMARY:Tz', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261113', 'SUMMARY:Allday', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e', 'DTSTART;TZID="Customized Time Zone":20261106T080000', 'SUMMARY:Quoted tz', 'END:VEVENT',
  ))
  const by = Object.fromEntries(r.entries.map((e) => [e.title, e]))
  assert.equal(by.Utc.start, '2026-11-05T09:00:00.000Z')
  assert.equal(by.Utc.end, '2026-11-05T10:00:00.000Z')
  assert.equal(by.Floating.start, at(5, 9))
  assert.equal(by.Floating.end, at(5, 10, 30))
  assert.equal(by.Tz.start, at(5, 14))
  assert.equal(by.Allday.allDay, true)
  assert.equal(by.Allday.start, at(10))
  assert.equal(by.Allday.end, at(12), 'exclusive end becomes the last day')
  assert.equal(by['Quoted tz'].start, at(6, 8))
  assert.equal(by['Quoted tz'].end, undefined)
})

test('parse: DURATION without DTEND', () => {
  const r = parseIcs(wrap(
    'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261105T090000', 'DURATION:PT1H30M', 'SUMMARY:A', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART;VALUE=DATE:20261110', 'DURATION:P3D', 'SUMMARY:B', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'DTSTART;VALUE=DATE:20261120', 'DURATION:P1D', 'SUMMARY:C', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'DTSTART:20261105T090000', 'DURATION:P1DT2H', 'SUMMARY:D', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e', 'DTSTART:20261105T090000', 'DURATION:nonsense', 'SUMMARY:E', 'END:VEVENT',
  ))
  const by = Object.fromEntries(r.entries.map((e) => [e.title, e]))
  assert.equal(by.A.end, at(5, 10, 30))
  assert.equal(by.B.end, at(12))
  assert.equal(by.C.end, undefined)
  assert.equal(by.D.end, at(6, 11))
  assert.equal(by.E.end, undefined)
})

test('parse: Outlook and Google style samples, folded lines and escapes', () => {
  const outlook = [
    'BEGIN:VCALENDAR', 'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN', 'VERSION:2.0', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time', 'BEGIN:STANDARD', 'DTSTART:16011028T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'CLASS:PUBLIC', 'DESCRIPTION:Agenda:\\n1. Termine\\n2. Nachträge\\, Änderungen', 'DTEND;TZID=W. Europe Standard Time:20261105T113000',
    'DTSTART;TZID=W. Europe Standard Time:20261105T100000', 'LOCATION:Besprechungsraum 1', 'SUMMARY;LANGUAGE=de:Bauberatung', 'UID:040000008200E00074C5B7101A82E008', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n')
  const o = parseIcs(outlook)
  assert.equal(o.entries.length, 1)
  assert.equal(o.entries[0].title, 'Bauberatung')
  assert.equal(o.entries[0].note, 'Agenda:\n1. Termine\n2. Nachträge, Änderungen')
  assert.equal(o.entries[0].location, 'Besprechungsraum 1')
  assert.equal(o.entries[0].start, at(5, 10))

  const google = [
    'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Work',
    'BEGIN:VEVENT', 'DTSTART:20261105T080000Z', 'DTEND:20261105T090000Z', 'DTSTAMP:20261101T120000Z', 'UID:abc123@google.com', 'STATUS:CONFIRMED',
    'SUMMARY:Lieferantengespräch mit sehr langem Titel der in der Datei umgebrochen wurde und', '  trotzdem zusammengehört', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\n')
  const g = parseIcs(google)
  assert.equal(g.entries[0].title, 'Lieferantengespräch mit sehr langem Titel der in der Datei umgebrochen wurde und trotzdem zusammengehört')
})

test('parse: RRULE events import once and are counted, VALARM and other components are ignored', () => {
  const r = parseIcs(wrap(
    'BEGIN:VEVENT', 'UID:weekly', 'DTSTART:20261105T090000Z', 'DTEND:20261105T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=10', 'SUMMARY:Jour fixe',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'SUMMARY:Alarm', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VTODO', 'UID:todo', 'DTSTART:20261106T090000Z', 'SUMMARY:Todo', 'END:VTODO',
    'BEGIN:VEVENT', 'UID:weekly', 'RECURRENCE-ID:20261112T090000Z', 'DTSTART:20261112T100000Z', 'SUMMARY:Moved', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:gone', 'DTSTART:20261107T090000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelled', 'END:VEVENT',
  ))
  assert.deepEqual(r.entries.map((e) => e.title), ['Jour fixe'])
  assert.equal(r.entries[0].note, undefined, 'the alarm description is not the note')
  assert.equal(r.recurring, 1)
  assert.equal(r.skipped, 2)
})

test('parse: ids are stable, so importing twice updates instead of duplicating', () => {
  const file = vevent('UID:abc@google.com', 'DTSTART:20261105T080000Z', 'SUMMARY:A')
  const a = parseIcs(file).entries[0]
  const b = parseIcs(file).entries[0]
  assert.equal(a.id, b.id)
  assert.match(a.id, /^ics-[0-9a-f]{16}$/)
  assert.equal(parseIcs(wrap(...['BEGIN:VEVENT', 'UID:abc@google.com', 'DTSTART:20261105T080000Z', 'SUMMARY:A', 'END:VEVENT'], ...['BEGIN:VEVENT', 'UID:abc@google.com', 'DTSTART:20261105T080000Z', 'SUMMARY:A2', 'END:VEVENT'])).entries.length, 1)
  const noUid = vevent('DTSTART:20261105T080000Z', 'SUMMARY:No uid')
  assert.equal(parseIcs(noUid).entries[0].id, parseIcs(noUid).entries[0].id)
  assert.notEqual(parseIcs(noUid).entries[0].id, parseIcs(vevent('DTSTART:20261106T080000Z', 'SUMMARY:No uid')).entries[0].id)
  assert.notEqual(a.id, parseIcs(vevent('UID:other', 'DTSTART:20261105T080000Z', 'SUMMARY:A')).entries[0].id)
})

test('parse: a missing summary becomes "Untitled", a missing or broken start is skipped', () => {
  const r = parseIcs(wrap(
    'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261105T080000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:No start', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'DTSTART:garbage', 'SUMMARY:Bad', 'END:VEVENT',
  ))
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].title, 'Untitled')
  assert.equal(r.skipped, 2)
})

test('parse: garbage and empty input give zero entries without throwing', () => {
  for (const text of ['', 'hello world', '\u0000\u0001', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', 'BEGIN:VEVENT\r\nDTSTART:2026', ':::;;;', 'END:VEVENT\r\nEND:VEVENT\r\nEND:VEVENT']) {
    const r = parseIcs(text)
    assert.equal(r.entries.length, 0)
  }
})

test('overlapsRange: spans, points and the exclusive end', () => {
  const sorted = events([appt({ id: 'a', start: at(5, 23), end: at(6, 1) }), appt({ id: 'b', allDay: true, start: at(5), end: at(5) })])
  const a = sorted.find((e) => e.id.endsWith('a'))!
  const b = sorted.find((e) => e.id.endsWith('b'))!
  const day6 = [new Date(2026, 10, 6), new Date(2026, 10, 7)] as const
  assert.equal(overlapsRange(a, ...day6), true)
  assert.equal(overlapsRange(b, ...day6), false)
  assert.equal(overlapsRange(b, new Date(2026, 10, 5), new Date(2026, 10, 6)), true)
  const point = collectEvents(lists, { l1: { communications: [{ id: 'c', at: at(6), party: 'client', name: 'A', channel: 'phone', direction: 'in' }] } }, (id) => id)[0]
  assert.equal(overlapsRange(point, ...day6), true)
  assert.equal(overlapsRange(point, new Date(2026, 10, 5), new Date(2026, 10, 6)), false)
})
