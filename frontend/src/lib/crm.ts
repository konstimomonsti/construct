/**
 * Supplier relationships: which suppliers deliver the categories of a bill, grouped quote requests (one email per
 * supplier with all its positions), and the shared contact log with response times and reminders.
 *
 * Nothing is sent from BillBuild. "Sent" in the log means the user opened or downloaded the prepared email; the
 * label in the UI says so.
 */
import { deDate } from './export/util'
import { qty } from './format'
import { encodeHeader, quotedPrintable, slug } from './subcontract-send'
import type { Position } from './types'

export type PartyKind = 'supplier' | 'subcontractor'
export type EventKind = 'rfq_sent' | 'reply' | 'offer_received' | 'reminder_sent' | 'call' | 'note'
export type Channel = 'email' | 'phone' | 'meeting' | 'other'
export type CategorySource = 'user' | 'catalogue' | 'ai' | 'keyword'

export type Category = { id: string; name: string }

export type PositionCategory = {
  id: string
  category_id: string | null
  category: string | null
  source: CategorySource | null
  confidence: number | null
  reason: string | null
  product: { id: string; name: string } | null
}

export type SourcingSupplier = {
  id: string
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  category_ids: string[]
  explicit_category_ids: string[]
  product_count: number
  requested_at: string | null
  answered: boolean
}

export type CategorizeRun = { method: 'ai' | 'keyword'; checked: number; assigned: number; without_category: number; fallback: number }

export type Sourcing = {
  categories: Category[]
  positions: PositionCategory[]
  suppliers: SourcingSupplier[]
  ai: boolean
  run?: CategorizeRun
}

export type RequestItem = { position_id: string; oz?: string; short?: string; qty?: number; unit?: string; category?: string }

export type CommEvent = {
  id: string
  party_kind: PartyKind
  party_id: string
  party_name: string | null
  kind: EventKind
  channel: Channel
  list_id: string | null
  list_title: string | null
  subject: string | null
  note: string | null
  items: RequestItem[]
  request_id: string | null
  due_at: string | null
  answered_at: string | null
  occurred_at: string
  created_by: string | null
  response_hours: number | null
}

export type NewEvent = {
  kind: EventKind
  party_kind: PartyKind
  party_id: string
  channel?: Channel
  list_id?: string
  list_title?: string
  subject?: string
  note?: string
  items?: RequestItem[]
  request_id?: string
  occurred_at?: string
  due_at?: string
  remind_at?: string
}

export type PartyStats = {
  party_kind: PartyKind
  id: string
  name: string
  trade: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  requests: number
  answered: number
  open: number
  overdue: number
  avg_response_hours: number | null
  last_contact_at: string | null
  events: number
  category_ids?: string[]
  explicit_category_ids?: string[]
  product_count?: number
}

export type Reminder = {
  id: string
  party_kind: PartyKind
  party_id: string
  party_name: string | null
  email: string | null
  communication_id: string | null
  due_at: string
  note: string | null
  subject: string | null
  list_id: string | null
  list_title: string | null
  requested_at: string | null
}

export type Overview = {
  parties: PartyStats[]
  reminders: Reminder[]
  totals: { requests: number; answered: number; overdue: number; avg_response_hours: number | null }
  categories: Category[]
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = body === undefined
    ? { cache: 'no-store', signal }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }
  const response = await fetch(`/api/crm/${path}`, init)
  if (!response.ok) {
    const message = await response.json().catch(() => null)
    throw new Error(message?.error || 'The supplier log is unavailable. Try again.')
  }
  return response.json()
}

type PositionInput = Pick<Position, 'id' | 'oz' | 'short' | 'long' | 'unit'>
const positionInput = (positions: readonly PositionInput[]) =>
  positions.map((p) => ({ id: p.id, oz: p.oz, short: p.short, long: p.long ?? '', unit: p.unit }))

export const fetchSourcing = (listId: string, positions: readonly PositionInput[], signal?: AbortSignal) =>
  call<Sourcing>('sourcing', { list_id: listId, positions: positionInput(positions) }, signal)

export const categorize = (listId: string, positions: readonly PositionInput[], redo = false) =>
  call<Sourcing>('categorize', { list_id: listId, positions: positionInput(positions), redo })

export const setPositionCategory = (listId: string, positionId: string, categoryId: string | null) =>
  call<{ position_id: string; category_id: string | null }>('position-category', { list_id: listId, position_id: positionId, category_id: categoryId })

export const logEvents = (events: NewEvent[]) => call<{ events: CommEvent[] }>('log', { events })

export const deleteEvent = (id: string) => call<{ id: string }>('log-delete', { id })

export function fetchEvents(filter: { party_kind?: PartyKind; party_id?: string; list_id?: string; limit?: number } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') params.set(key, String(value))
  return call<{ events: CommEvent[] }>(`log${params.size ? `?${params}` : ''}`, undefined, signal)
}

export const fetchOverview = (signal?: AbortSignal) => call<Overview>('overview', undefined, signal)

export const saveReminder = (fields: { id?: string; party_kind?: PartyKind; party_id?: string; due_at?: string; note?: string; done?: boolean; communication_id?: string }) =>
  call<Reminder>('reminder', fields)

export const setSupplierCategories = (supplierId: string, categoryIds: string[]) =>
  call<{ supplier_id: string; category_ids: string[] }>('supplier-categories', { supplier_id: supplierId, category_ids: categoryIds })

/* ------------------------------------------------------------------ */
/* grouping                                                            */
/* ------------------------------------------------------------------ */

export type SupplierGroup = { supplier: SourcingSupplier; positions: Position[]; categories: Category[] }

export type Grouping = {
  groups: SupplierGroup[]
  /** positions with a category that no active supplier delivers */
  uncovered: Position[]
  /** positions without any category yet */
  uncategorized: Position[]
}

/**
 * one group per supplier with every position of the categories it delivers, so each supplier gets a single email.
 * Largest groups first; ties by name.
 */
export function groupBySupplier(positions: readonly Position[], sourcing: Pick<Sourcing, 'positions' | 'suppliers' | 'categories'>): Grouping {
  const assigned = new Map(sourcing.positions.map((p) => [p.id, p.category_id]))
  const categories = new Map(sourcing.categories.map((c) => [c.id, c]))
  const byCategory = new Map<string, Position[]>()
  const uncategorized: Position[] = []
  for (const p of positions) {
    const category = assigned.get(p.id)
    if (!category) {
      uncategorized.push(p)
      continue
    }
    const list = byCategory.get(category) ?? []
    list.push(p)
    byCategory.set(category, list)
  }
  const covered = new Set<string>()
  const groups: SupplierGroup[] = []
  for (const supplier of sourcing.suppliers) {
    const cats = supplier.category_ids.filter((id) => byCategory.has(id))
    if (!cats.length) continue
    cats.forEach((id) => covered.add(id))
    const ids = new Set(cats.flatMap((id) => byCategory.get(id)!.map((p) => p.id)))
    groups.push({
      supplier,
      positions: positions.filter((p) => ids.has(p.id)),
      categories: cats.map((id) => categories.get(id)).filter((c): c is Category => !!c),
    })
  }
  groups.sort((a, b) => b.positions.length - a.positions.length || a.supplier.name.localeCompare(b.supplier.name, 'de'))
  const uncovered = [...byCategory.entries()].filter(([id]) => !covered.has(id)).flatMap(([, list]) => list)
  return { groups, uncovered, uncategorized }
}

/* ------------------------------------------------------------------ */
/* the quote request email                                             */
/* ------------------------------------------------------------------ */

/** mail clients start cutting `mailto:` links somewhere past 2,000 characters; longer emails go out as `.eml` */
export const MAILTO_LIMIT = 1900

export const rfqSubject = (project: string, count: number): string =>
  `Preisanfrage: ${project.trim() || 'Bauvorhaben'} – ${count} ${count === 1 ? 'Position' : 'Positionen'}`

/** "01.02.0030  PP-Rohr DN 110 SN 8  –  120,000 m" */
export const rfqLine = (p: Pick<Position, 'oz' | 'short' | 'qty' | 'unit'>): string =>
  `${p.oz ? `${p.oz}  ` : ''}${p.short.trim() || 'Position'}  –  ${qty(p.qty)} ${p.unit}`.trimEnd()

/** salutation to sender: the complete German text of one supplier's request */
export function rfqText(o: { salutation: string; project: string; positions: readonly Pick<Position, 'oz' | 'short' | 'qty' | 'unit'>[]; dueDate?: string; sender: string }): string {
  const lines = [
    o.salutation,
    '',
    `für unser Bauvorhaben „${o.project.trim() || 'Bauvorhaben'}“ bitten wir Sie um Ihr Angebot für die folgenden ${o.positions.length === 1 ? 'Position' : `${o.positions.length} Positionen`}:`,
    '',
    ...o.positions.map(rfqLine),
    '',
    'Bitte nennen Sie uns je Position Ihren Einheitspreis (netto, frei Baustelle), die Lieferzeit sowie gegebenenfalls Mindestabnahmemengen.',
    o.dueDate ? `Wir freuen uns über Ihr Angebot bis zum ${deDate(o.dueDate)}.` : 'Wir freuen uns über Ihr Angebot möglichst zeitnah.',
    '',
    o.sender.trim(),
    '',
  ]
  return lines.join('\n')
}

export function rfqMailto(to: string | null | undefined, subject: string, text: string): string | null {
  const enc = (s: string) => encodeURIComponent(s).replace(/%0A/g, '%0D%0A')
  const link = `mailto:${encodeURIComponent((to ?? '').trim()).replace(/%40/g, '@')}?subject=${enc(subject)}&body=${enc(text)}`
  return link.length <= MAILTO_LIMIT ? link : null
}

/** a plain-text `.eml` draft; `X-Unsent: 1` makes Outlook, Apple Mail and Thunderbird open it ready to send */
export function rfqEml(o: { to?: string | null; subject: string; text: string; date?: Date }): string {
  const to = (o.to ?? '').replace(/[\r\n,;<>]+/g, ' ').trim()
  const date = (o.date ?? new Date()).toUTCString().replace('GMT', '+0000')
  return [
    'X-Unsent: 1',
    ...(to ? [`To: ${to}`] : []),
    `Subject: ${encodeHeader(o.subject)}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(o.text),
    '',
  ].join('\r\n')
}

export const rfqFileName = (supplier: string, project: string) => `Preisanfrage_${slug(supplier, 40)}_${slug(project, 40)}.eml`

export const requestItems = (positions: readonly Position[], categoryOf: (id: string) => string | null | undefined): RequestItem[] =>
  positions.map((p) => ({ position_id: p.id, oz: p.oz, short: p.short.slice(0, 300), qty: Number.isFinite(p.qty) ? p.qty : undefined, unit: p.unit, category: categoryOf(p.id) ?? undefined }))

/* ------------------------------------------------------------------ */
/* labels                                                              */
/* ------------------------------------------------------------------ */

export const EVENT_LABEL: Record<EventKind, string> = {
  rfq_sent: 'Quote requested',
  reply: 'Reply received',
  offer_received: 'Offer received',
  reminder_sent: 'Reminder sent',
  call: 'Call',
  note: 'Note',
}

export const EVENT_ICON: Record<EventKind, string> = {
  rfq_sent: 'outgoing_mail',
  reply: 'mark_email_read',
  offer_received: 'request_quote',
  reminder_sent: 'notifications_active',
  call: 'call',
  note: 'sticky_note_2',
}

export const SOURCE_LABEL: Record<CategorySource, string> = {
  user: 'Set by you',
  catalogue: 'Catalogue match',
  ai: 'AI',
  keyword: 'Keyword guess',
}

/** "3 h", "1,5 d" */
export function duration(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '–'
  if (hours < 1) return '< 1 h'
  if (hours < 48) return `${Math.round(hours)} h`
  const days = Math.round((hours / 24) * 10) / 10
  return `${String(days).replace('.', ',')} d`
}

/** an ISO date `days` from `now`, for date inputs */
export const isoInDays = (days: number, now = new Date()) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10)

/** end of the given day in local time, as an ISO timestamp for the API */
export const endOfDay = (isoDate: string) => new Date(`${isoDate}T17:00:00`).toISOString()

export const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

export const shortDate = (iso: string) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso))
