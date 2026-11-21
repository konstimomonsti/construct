/**
 * iCalendar (RFC 5545) subset for the calendar: export events as .ics, import .ics files as appointments.
 * Pure functions, no dependencies. Time zones: export writes UTC; import reads UTC (`Z`), floating times and
 * `TZID=` times as local time (there is no tz database here).
 */
import { CHANNEL_LABEL, PARTY_LABEL, eventRange, type CalendarEntry, type CalendarEvent } from './communications'

const UID_SUFFIX = '@billbuild'
const CRLF = '\r\n'
const two = (n: number) => String(n).padStart(2, '0')

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')

const utc = (d: Date) =>
  `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`
const dateOnly = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`

const encoder = new TextEncoder()

/** folds a content line at 75 octets (without the CRLF); continuation lines start with one space. Never splits a character. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const ch of line) {
    const n = encoder.encode(ch).length
    const limit = parts.length === 0 ? 75 : 74 // the leading space of a continuation counts
    if (size + n > limit) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += ch
    size += n
  }
  parts.push(current)
  return parts.join(`${CRLF} `)
}

function description(e: CalendarEvent): string {
  const lines: string[] = []
  if (e.kind === 'appointment') {
    if (e.note) lines.push(e.note)
    if (e.listTitle) lines.push(`${e.note ? '\n' : ''}Project: ${e.listTitle}`)
    return lines.join('\n')
  }
  if (e.text) lines.push(e.text)
  if (e.party) lines.push(`Party: ${PARTY_LABEL[e.party]}`)
  lines.push(`Name: ${e.name}`)
  if (e.channel) lines.push(`Channel: ${CHANNEL_LABEL[e.channel]}`)
  if (e.direction) lines.push(`Direction: ${e.direction === 'out' ? 'Sent' : 'Received'}`)
  if (e.listTitle) lines.push(`Project: ${e.listTitle}`)
  if (e.note) lines.push(`Note: ${e.note}`)
  return lines.join('\n')
}

/** an iCalendar document with one VEVENT per event */
export function toIcs(events: readonly CalendarEvent[], opts: { now: Date; calendarName?: string }): string {
  const stamp = utc(opts.now)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BillBuild//Calendar//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(opts.calendarName ?? 'BillBuild')}`,
  ]
  for (const e of events) {
    const start = new Date(e.at)
    if (Number.isNaN(start.getTime())) continue
    const allDay = e.kind === 'appointment' && !!e.allDay
    let { end } = eventRange(e)
    if (e.kind === 'communication') end = new Date(start.getTime() + 30 * 60_000) // a point in time shows as a short block
    const summary = e.kind === 'appointment' ? e.name : `${e.name}${e.text ? `: ${e.text}` : ''}`
    lines.push('BEGIN:VEVENT', `UID:${e.id}${UID_SUFFIX}`, `DTSTAMP:${stamp}`)
    if (allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(start)}`, `DTEND;VALUE=DATE:${dateOnly(end)}`)
    } else {
      lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`)
    }
    lines.push(`SUMMARY:${escapeText(summary)}`)
    const desc = description(e)
    if (desc) lines.push(`DESCRIPTION:${escapeText(desc)}`)
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`)
    lines.push(`CATEGORIES:${e.kind === 'appointment' ? 'Appointment' : PARTY_LABEL[e.party ?? 'subcontractor']}`, 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join(CRLF) + CRLF
}

/** does the event touch [from, to)? a point in time counts when it lies inside */
export function overlapsRange(e: CalendarEvent, from: Date, to: Date): boolean {
  const { start, end } = eventRange(e)
  return start < to && (end > from || start >= from)
}

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

export type IcsImport = {
  entries: CalendarEntry[]
  /** events that could not be used: no or unreadable start, cancelled, a changed occurrence, or exported communications */
  skipped: number
  /** recurring events: imported once, with their first occurrence only */
  recurring: number
}

type Prop = { name: string; params: Record<string, string>; value: string }

/** splits "NAME;PARAM=x:value" at the first colon outside quotes */
function parseProp(line: string): Prop | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 1) return null
  const head: string[] = []
  let part = ''
  quoted = false
  for (const c of line.slice(0, colon)) {
    if (c === '"') quoted = !quoted
    if (c === ';' && !quoted) {
      head.push(part)
      part = ''
    } else part += c
  }
  head.push(part)
  const params: Record<string, string> = {}
  for (const p of head.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) }
}

const unescapeText = (s: string) => s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

/** a DATE or DATE-TIME value; UTC (`Z`) is absolute, everything else is local time */
function parseDate(p: Prop): { date: Date; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(p.value.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const date = m[4] === undefined
    ? new Date(y, mo, d)
    : m[7]
      ? new Date(Date.UTC(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0)))
      : new Date(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
  if (Number.isNaN(date.getTime())) return null
  return { date, allDay: m[4] === undefined || p.params.VALUE === 'DATE' }
}

/** the `start + duration` of a DURATION like P1D, PT1H30M, P1W; null when unreadable */
function addDuration(start: Date, value: string): Date | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim())
  if (!m) return null
  const n = (s: string | undefined) => Number(s ?? 0)
  const sign = m[1] === '-' ? -1 : 1
  const days = sign * (n(m[2]) * 7 + n(m[3]))
  const out = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days, start.getHours(), start.getMinutes(), start.getSeconds())
  return new Date(out.getTime() + sign * (n(m[4]) * 3600 + n(m[5]) * 60 + n(m[6])) * 1000)
}

/** a stable 64-bit hex hash (two FNV-1a passes) */
function hash(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x85ebca6b) ^ (b >>> 13)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

/** reads the VEVENTs of an .ics file as appointments; never throws */
export function parseIcs(text: string): IcsImport {
  const result: IcsImport = { entries: [], skipped: 0, recurring: 0 }
  // unfold: a line that starts with a space or tab continues the previous one
  const lines: string[] = []
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1)
    else lines.push(raw)
  }

  const byId = new Map<string, CalendarEntry>()
  const stack: string[] = []
  let props: Prop[] = []
  for (const line of lines) {
    const p = parseProp(line)
    if (!p) continue
    if (p.name === 'BEGIN') {
      stack.push(p.value.trim().toUpperCase())
      if (stack[stack.length - 1] === 'VEVENT' && stack.length === 2) props = []
    } else if (p.name === 'END') {
      const closed = stack.pop()
      if (closed === 'VEVENT' && stack.length === 1) {
        const entry = toEntry(props, result)
        if (entry) byId.set(entry.id, entry)
        props = []
      }
    } else if (stack.length === 2 && stack[1] === 'VEVENT') props.push(p)
  }
  result.entries = [...byId.values()]
  return result
}

function toEntry(props: Prop[], result: IcsImport): CalendarEntry | null {
  const get = (name: string) => props.find((p) => p.name === name)
  const startProp = get('DTSTART')
  const start = startProp ? parseDate(startProp) : null
  const uid = get('UID')?.value.trim()
  const ours = !!uid && uid.endsWith(UID_SUFFIX)
  const ownId = ours ? uid.slice(0, -UID_SUFFIX.length) : ''
  if (!start || get('RECURRENCE-ID') || get('STATUS')?.value.trim().toUpperCase() === 'CANCELLED' || (ours && !ownId.startsWith('cal-'))) {
    result.skipped++
    return null
  }
  if (get('RRULE')) result.recurring++

  const endProp = get('DTEND')
  const durationProp = get('DURATION')
  let end: Date | null = null
  if (endProp) end = parseDate(endProp)?.date ?? null
  else if (durationProp) end = addDuration(start.date, durationProp.value)
  let finalEnd: string | undefined
  let startIso = start.date.toISOString()
  if (start.allDay) {
    // the file's end is exclusive, ours is the (inclusive) last day
    if (!endProp && !durationProp) end = null
    else if (end) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1)
    const first = new Date(start.date.getFullYear(), start.date.getMonth(), start.date.getDate())
    startIso = first.toISOString()
    if (end && end > first) finalEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate()).toISOString()
  } else if (end && end > start.date) finalEnd = end.toISOString()

  const summary = unescapeText(get('SUMMARY')?.value ?? '').trim()
  const location = unescapeText(get('LOCATION')?.value ?? '').trim()
  let note = unescapeText(get('DESCRIPTION')?.value ?? '').replace(/\r/g, '').trim()
  if (ours) note = note.replace(/(^|\n\n?)Project: [^\n]*$/, '').trim()
  const id = ours ? ownId : `ics-${hash(uid || `${summary}|${startIso}`)}`
  return { id, title: summary || 'Untitled', start: startIso, end: finalEnd, allDay: start.allDay, ...(location ? { location } : {}), ...(note ? { note } : {}) }
}
