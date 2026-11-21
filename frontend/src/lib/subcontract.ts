/**
 * Subcontractor requests (Nachunternehmer-Anfrage): the package model and the German email template.
 * Pure functions only. Nothing in here ever receives the internal budget when it builds text for the
 * subcontractor, so the budget cannot leak into a file or an email by accident (tests/subcontract.test.ts).
 */
import { deDate, round2 } from './export/util'
import type { Position } from './types'

export type SubcontractFormat = 'x83' | 'xlsx' | 'pdf'
export type SubcontractStatus = 'draft' | 'sent' | 'offer_received'

/** a subcontractor's reply to one package. Internal: never part of a request file or an email. */
export type SubcontractOffer = {
  /** ISO; falls back to package.sentAt when missing */
  sentAt?: string
  /** ISO, when the subcontractor's X84 / reply arrived */
  receivedAt?: string
  /** EUR total they want (net) */
  amount?: number
  /** free text info about the reply */
  note?: string
  /** imported offer file */
  fileName?: string
  /** package positions found in the offer file */
  matched?: number
  /** package position ids the offer did not price */
  missing?: string[]
  /** we declined this offer */
  declined?: boolean
  /** id of the stored offer file (a `DocMeta`), when the file was imported */
  documentId?: string
}

export type SubcontractPackage = {
  id: string
  /** e.g. "Estricharbeiten" */
  name: string
  /** positions of this list */
  positionIds: string[]
  /** catalogue ids (kind `subcontractors`) */
  subcontractorIds: string[]
  /** internal expected cost in EUR. Never exported, never part of an email. */
  budget: { perPosition: Record<string, number>; total: number }
  /** offer deadline (ISO date) */
  dueDate?: string
  format: SubcontractFormat
  status: SubcontractStatus
  sentAt?: string
  /** the email text as it went out (generic salutation, sender block, no budget); `toRequest` never copies it */
  sentText?: string
  /** internal note, never exported */
  notes?: string
  /** replies by subcontractor catalogue id */
  offers?: Record<string, SubcontractOffer>
  /** subcontractor chosen for this package (shown in X84) */
  chosenId?: string
}

/** everything a request file or an email may know about a package: no budget, no notes */
export type PackageRequest = Pick<SubcontractPackage, 'name' | 'positionIds' | 'dueDate' | 'format'>

export const toRequest = (p: Pick<SubcontractPackage, 'name' | 'positionIds' | 'dueDate' | 'format'>): PackageRequest => ({
  name: p.name, positionIds: [...p.positionIds], dueDate: p.dueDate, format: p.format,
})

export const FORMAT_LABEL: Record<SubcontractFormat, string> = {
  x83: 'GAEB X83 (without prices)',
  xlsx: 'Excel (empty price cells)',
  pdf: 'PDF printout',
}

export const newPackageId = () => `sc-${crypto.randomUUID()}`

/* ------------------------------------------------------------------ */
/* package model: one package per position                             */
/* ------------------------------------------------------------------ */

/** position id → the package that holds it (optionally ignoring one package, the one being edited) */
export function claims(packages: readonly SubcontractPackage[], exceptId?: string): Map<string, SubcontractPackage> {
  const out = new Map<string, SubcontractPackage>()
  for (const p of packages) {
    if (p.id === exceptId) continue
    for (const id of p.positionIds) if (!out.has(id)) out.set(id, p)
  }
  return out
}

export type Conflict = { positionId: string; pkg: SubcontractPackage }

/** the positions of `positionIds` that another package already holds */
export function findConflicts(packages: readonly SubcontractPackage[], positionIds: Iterable<string>, exceptId?: string): Conflict[] {
  const held = claims(packages, exceptId)
  const out: Conflict[] = []
  for (const positionId of positionIds) {
    const pkg = held.get(positionId)
    if (pkg) out.push({ positionId, pkg })
  }
  return out
}

/**
 * Saves a package. Its positions move out of every other package (a position is in only one), and a draft left
 * without positions disappears. An existing package with the same id is replaced in place.
 */
export function upsertPackage(packages: readonly SubcontractPackage[], pkg: SubcontractPackage): SubcontractPackage[] {
  const mine = new Set(pkg.positionIds)
  const others = packages
    .filter((p) => p.id !== pkg.id)
    .map((p) => (p.positionIds.some((id) => mine.has(id)) ? { ...p, positionIds: p.positionIds.filter((id) => !mine.has(id)) } : p))
    .filter((p) => p.positionIds.length > 0 || p.status !== 'draft')
  const at = packages.findIndex((p) => p.id === pkg.id)
  if (at < 0) return [...others, pkg]
  // keep the package where it was in the list
  const before = packages.slice(0, at).filter((p) => others.some((o) => o.id === p.id)).length
  return [...others.slice(0, before), pkg, ...others.slice(before)]
}

/**
 * The package to store when the overlay saves or re-exports `next`. A new id is stored as built. For an existing
 * id the replies survive: `offers` and `chosenId` are carried over (those of subcontractors removed from the
 * package are dropped, and so is the choice if that subcontractor is gone) and `sentText` stays unless `next`
 * carries a new one (a newly composed and sent email).
 */
export function mergeSavedPackage(existing: SubcontractPackage | undefined, next: SubcontractPackage): SubcontractPackage {
  if (!existing) return next
  const keep = new Set(next.subcontractorIds)
  const offers = Object.fromEntries(Object.entries(next.offers ?? existing.offers ?? {}).filter(([id]) => keep.has(id)))
  const chosenId = next.chosenId ?? existing.chosenId
  const { offers: _o, chosenId: _c, sentText: _s, ...rest } = next
  const sentText = next.sentText ?? existing.sentText
  return {
    ...rest,
    ...(Object.keys(offers).length ? { offers } : {}),
    ...(chosenId && keep.has(chosenId) ? { chosenId } : {}),
    ...(sentText !== undefined ? { sentText } : {}),
  }
}

export const removePackage =(packages: readonly SubcontractPackage[], id: string): SubcontractPackage[] => packages.filter((p) => p.id !== id)

export const setStatus = (packages: readonly SubcontractPackage[], id: string, status: SubcontractStatus, at?: string): SubcontractPackage[] =>
  packages.map((p) => (p.id === id ? { ...p, status, sentAt: status === 'sent' ? at ?? p.sentAt : p.sentAt } : p))

/* ------------------------------------------------------------------ */
/* offers (replies from subcontractors)                                */
/* ------------------------------------------------------------------ */

const NO_OFFER: SubcontractOffer = {}

export const offerOf = (pkg: Pick<SubcontractPackage, 'offers'>, subId: string): SubcontractOffer => pkg.offers?.[subId] ?? NO_OFFER

const mapPackage = (packages: readonly SubcontractPackage[], id: string, fn: (p: SubcontractPackage) => SubcontractPackage) =>
  packages.map((p) => (p.id === id ? fn(p) : p))

/** merges `patch` into one subcontractor's offer; a key set to undefined is removed */
export function setOffer(packages: readonly SubcontractPackage[], pkgId: string, subId: string, patch: Partial<SubcontractOffer>): SubcontractPackage[] {
  return mapPackage(packages, pkgId, (p) => {
    const next: SubcontractOffer = { ...offerOf(p, subId), ...patch }
    for (const k of Object.keys(next) as (keyof SubcontractOffer)[]) if (next[k] === undefined) delete next[k]
    return { ...p, offers: { ...p.offers, [subId]: next } }
  })
}

/** chooses a subcontractor (null clears the choice). Choosing marks the package as having an offer. */
export function chooseSubcontractor(packages: readonly SubcontractPackage[], pkgId: string, subId: string | null): SubcontractPackage[] {
  return mapPackage(packages, pkgId, (p) => {
    if (subId == null) {
      const { chosenId: _drop, ...rest } = p
      return rest
    }
    const offers = p.offers?.[subId]?.declined ? { ...p.offers, [subId]: { ...p.offers[subId], declined: false } } : p.offers
    return { ...p, chosenId: subId, offers, status: p.status === 'draft' || p.status === 'sent' ? 'offer_received' : p.status }
  })
}

/** declines (or reopens) an offer. Declining the chosen one clears the choice. */
export function declineOffer(packages: readonly SubcontractPackage[], pkgId: string, subId: string, declined: boolean): SubcontractPackage[] {
  const next = setOffer(packages, pkgId, subId, { declined })
  return declined ? mapPackage(next, pkgId, (p) => {
    if (p.chosenId !== subId) return p
    const { chosenId: _drop, ...rest } = p
    return rest
  }) : next
}

/** a package whose positions were deleted from the list loses them */
export function pruneMissing(pkg: SubcontractPackage, existingIds: ReadonlySet<string>): SubcontractPackage {
  const positionIds = pkg.positionIds.filter((id) => existingIds.has(id))
  if (positionIds.length === pkg.positionIds.length) return pkg
  const perPosition = Object.fromEntries(Object.entries(pkg.budget.perPosition).filter(([id]) => existingIds.has(id)))
  return { ...pkg, positionIds, budget: { ...pkg.budget, perPosition } }
}

/* ------------------------------------------------------------------ */
/* selection summary and default name                                  */
/* ------------------------------------------------------------------ */

export type Summary = { count: number; byUnit: { unit: string; qty: number }[] }

/** position count and the quantity per unit ("480 m², 35 m") */
export function summarize(positions: readonly Pick<Position, 'qty' | 'unit'>[]): Summary {
  const byUnit = new Map<string, number>()
  for (const p of positions) {
    const unit = p.unit || '–'
    byUnit.set(unit, (byUnit.get(unit) ?? 0) + (p.qty || 0))
  }
  return {
    count: positions.length,
    byUnit: [...byUnit.entries()].map(([unit, qty]) => ({ unit, qty: Math.round(qty * 1000) / 1000 })).sort((a, b) => b.qty - a.qty),
  }
}

/** the deepest category all given positions share, else the common top-level one, else a generic name */
export function defaultPackageName(positions: readonly Pick<Position, 'path'>[]): string {
  const chains = positions.map((p) => p.path ?? []).filter((c) => c.length)
  if (!chains.length) return 'Leistungspaket'
  let label = ''
  for (let i = 0; i < chains[0].length; i++) {
    const ref = chains[0][i]
    if (chains.every((c) => c[i]?.oz === ref.oz)) label = ref.label
    else break
  }
  return label.trim() || 'Leistungspaket'
}

/* ------------------------------------------------------------------ */
/* budget (internal)                                                   */
/* ------------------------------------------------------------------ */

/** the list's own price times quantity, for every position that has one */
export function prefillBudget(positions: readonly Pick<Position, 'id' | 'qty' | 'up'>[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of positions) if (p.up != null && p.up > 0 && p.qty > 0) out[p.id] = round2(p.up * p.qty)
  return out
}

export const sumBudget = (perPosition: Record<string, number>, ids?: Iterable<string>): number =>
  round2([...(ids ?? Object.keys(perPosition))].reduce((s, id) => s + (perPosition[id] ?? 0), 0))

/** a budget limited to the given positions; the total is the sum unless the user typed one */
export function makeBudget(perPosition: Record<string, number>, ids: readonly string[], totalOverride?: number | null): SubcontractPackage['budget'] {
  const kept = Object.fromEntries(ids.filter((id) => Number.isFinite(perPosition[id])).map((id) => [id, round2(perPosition[id])]))
  return { perPosition: kept, total: totalOverride != null && Number.isFinite(totalOverride) ? round2(totalOverride) : sumBudget(kept) }
}

/* ------------------------------------------------------------------ */
/* suggesting subcontractors by trade                                  */
/* ------------------------------------------------------------------ */

const STOP = new Set(['arbeiten', 'arbeit', 'leistungen', 'leistung', 'allgemein', 'allgemeine', 'sonstige', 'und', 'fuer', 'der', 'die', 'das', 'teil', 'gewerk', 'gewerke'])

const fold = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')

const tokens = (s: string): string[] => fold(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t))

/** does a catalogue trade ("Estrich", "Trockenbau") fit one of the hints (package or section names)? */
export function tradeMatches(trade: string | null | undefined, hints: readonly string[]): boolean {
  const a = tokens(trade ?? '')
  if (!a.length) return false
  const b = hints.flatMap(tokens)
  return a.some((x) => b.some((y) => x.includes(y) || y.includes(x)))
}

/** ids of the subcontractors whose trade fits the package name or the sections of its positions */
export function suggestSubcontractors<T extends { id: string; trade?: string | null }>(entries: readonly T[], hints: readonly string[]): string[] {
  return entries.filter((e) => tradeMatches(e.trade, hints)).map((e) => e.id)
}

/** the category labels (every level) of some positions, for suggesting trades */
export function sectionLabels(positions: readonly Pick<Position, 'path'>[]): string[] {
  const out = new Set<string>()
  for (const p of positions) for (const r of p.path ?? []) if (r.label) out.add(r.label)
  return [...out]
}

/* ------------------------------------------------------------------ */
/* email template (German, formal)                                     */
/* ------------------------------------------------------------------ */

export const DEFAULT_SENDER = 'Mit freundlichen Grüßen\n\n[Name]\n[Firma]\n[Telefon / E-Mail]'

/** "Sehr geehrte/r Erika Muster," or the neutral form when no contact is known */
export const salutation = (contactName?: string | null): string => {
  const name = (contactName ?? '').trim()
  return name ? `Sehr geehrte/r ${name},` : 'Sehr geehrte Damen und Herren,'
}

export const emailSubject = (packageName: string, project: string): string =>
  `Anfrage Nachunternehmerleistung: ${packageName.trim() || 'Leistungspaket'} – ${project.trim()}`

const HOW: Record<SubcontractFormat, string> = {
  x83: 'Bitte hinterlegen Sie Ihre Einheitspreise in der beigefügten GAEB-Datei (X83) und senden Sie uns die ausgefüllte Datei zurück.',
  xlsx: 'Bitte tragen Sie Ihre Einheitspreise in die leeren Preisspalten der beigefügten Excel-Datei ein (die Gesamtpreise werden automatisch berechnet) und senden Sie uns die ausgefüllte Datei zurück.',
  pdf: 'Bitte senden Sie uns Ihr Angebot mit Einheitspreisen je Position anhand des beigefügten Leistungsverzeichnisses zurück.',
}

/** the middle of the email: project, package, count, deadline and what to do. No salutation, no sender, no money. */
export function emailBody(o: { project: string; packageName: string; positionCount: number; dueDate?: string; format: SubcontractFormat }): string {
  const n = o.positionCount
  const lines = [
    `für unser Projekt „${o.project.trim()}“ bitten wir Sie um ein Angebot für das Leistungspaket „${o.packageName.trim() || 'Leistungspaket'}“ (${n} ${n === 1 ? 'Position' : 'Positionen'}).`,
    '',
    HOW[o.format],
    '',
    o.dueDate ? `Bitte senden Sie uns Ihr Angebot bis zum ${deDate(o.dueDate)}.` : 'Bitte senden Sie uns Ihr Angebot möglichst zeitnah.',
    '',
    'Bei Rückfragen melden Sie sich gerne bei uns.',
  ]
  return lines.join('\n')
}

/** salutation, body and sender block as the complete text of one email */
export const composeEmail = (o: { salutation: string; body: string; sender: string }): string =>
  `${o.salutation}\n\n${o.body.trim()}\n\n${o.sender.trim()}\n`

/** a `mailto:` link. A mail client cannot attach a file through it. */
export function mailtoLink(to: string | null | undefined, subject: string, text: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%0A/g, '%0D%0A')
  return `mailto:${(to ?? '').trim()}?subject=${enc(subject)}&body=${enc(text)}`
}
