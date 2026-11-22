import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import { exportList } from '../src/lib/export/index'
import { parseListFile } from '../src/lib/parse-list-file'
import { resolveList } from '../src/lib/resolve'
import {
  DEFAULT_SENDER, claims, composeEmail, defaultPackageName, emailBody, emailSubject, findConflicts, mailtoLink, makeBudget,
  markSent, newPackageId, prefillBudget, proposalTitle, pruneMissing, withoutProject, removePackage, salutation, sectionLabels, setStatus, suggestSubcontractors, sumBudget,
  summarize, toRequest, tradeMatches, upsertPackage, type SubcontractFormat, type SubcontractPackage,
} from '../src/lib/subcontract'
import { buildEml, buildRequestFile, encodeHeader, exportAndDraft, projectName, quotedPrintable, requestFileName, slug, type Recipient } from '../src/lib/subcontract-send'
import type { ListDoc, Position } from '../src/lib/types'

Object.assign(globalThis, { DOMParser })

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const pkg = (id: string, positionIds: string[], extra: Partial<SubcontractPackage> = {}): SubcontractPackage => ({
  id, name: id, positionIds, subcontractorIds: [], budget: { perPosition: {}, total: 0 }, format: 'x83', status: 'draft', ...extra,
})

const asFile = (name: string, data: Uint8Array | string) => new File([typeof data === 'string' ? data : new Uint8Array(data)], name)
const text = (b: Uint8Array) => new TextDecoder('utf-8').decode(b)

/** the demo tender, with prices of our own on every position (those must stay out of every request too) */
async function hall() {
  const bytes = await readFile(new URL('../../data/demo/building_hall_planted.X83', import.meta.url))
  const parsed = await parseListFile(asFile('building_hall_planted.X83', bytes))
  assert.ok(parsed)
  const positions = parsed.positions.map((p, i) => ({ ...p, up: 1357.91 + i }))
  const doc: ListDoc = {
    id: 'hall', folderId: 'f', fileName: 'building_hall_planted.X83', title: parsed.title ?? 'Halle', format: parsed.format, phase: parsed.phase,
    project: parsed.project, projectLabel: parsed.projectLabel, date: parsed.date, currency: 'EUR', positionsCount: positions.length,
    pricedCount: positions.length, categories: 0, total: 0, positions, tree: parsed.tree, source: parsed.source,
  }
  return { doc, resolved: resolveList(doc) }
}

const screed = (positions: Position[]) => positions.filter((p) => p.path?.some((c) => /estrich/i.test(c.label)))

const recipients: Recipient[] = [
  { id: 'a', name: 'Estrich Müller GmbH', email: 'angebot@estrich-mueller.example', contactName: 'Erika Müller' },
  { id: 'b', name: 'Boden & Putz AG', email: 'info@boden-putz.example' },
]

/* ------------------------------------------------------------------ */
/* package model                                                       */
/* ------------------------------------------------------------------ */

test('a position is in only one package: conflicts are found and saving moves positions out of the others', () => {
  const a = pkg('a', ['p1', 'p2', 'p3'])
  const b = pkg('b', ['p4'])
  assert.deepEqual([...claims([a, b]).keys()].sort(), ['p1', 'p2', 'p3', 'p4'])
  assert.deepEqual(findConflicts([a, b], ['p2', 'p4', 'p9']).map((c) => [c.positionId, c.pkg.id]), [['p2', 'a'], ['p4', 'b']])
  assert.deepEqual(findConflicts([a, b], ['p2'], 'a'), [], 'the package being edited does not conflict with itself')

  const moved = upsertPackage([a, b], pkg('c', ['p3', 'p4']))
  assert.deepEqual(moved.find((p) => p.id === 'a')!.positionIds, ['p1', 'p2'])
  assert.equal(moved.some((p) => p.id === 'b'), false, 'a draft left without positions disappears')
  assert.deepEqual(moved.find((p) => p.id === 'c')!.positionIds, ['p3', 'p4'])
  const seen = moved.flatMap((p) => p.positionIds)
  assert.equal(new Set(seen).size, seen.length, 'no position is in two packages')

  const kept = upsertPackage([a, pkg('s', ['p4'], { status: 'sent' })], pkg('c', ['p4']))
  assert.deepEqual(kept.find((p) => p.id === 's')!.positionIds, [], 'a sent package is kept even when emptied')
})

test('saving an existing package replaces it in place', () => {
  const list = [pkg('a', ['p1']), pkg('b', ['p2']), pkg('c', ['p3'])]
  const next = upsertPackage(list, { ...list[1], name: 'Neu', positionIds: ['p2', 'p5'] })
  assert.deepEqual(next.map((p) => p.id), ['a', 'b', 'c'])
  assert.equal(next[1].name, 'Neu')
  assert.deepEqual(removePackage(next, 'b').map((p) => p.id), ['a', 'c'])
})

test('status changes and positions deleted from the list', () => {
  const list = [pkg('a', ['p1', 'p2'], { budget: { perPosition: { p1: 10, p2: 20 }, total: 30 } })]
  const sent = setStatus(list, 'a', 'sent', '2026-11-21T10:00:00.000Z')
  assert.equal(sent[0].status, 'sent')
  assert.equal(sent[0].sentAt, '2026-11-21T10:00:00.000Z')
  assert.equal(setStatus(sent, 'a', 'offer_received')[0].status, 'offer_received')
  const pruned = pruneMissing(list[0], new Set(['p1']))
  assert.deepEqual(pruned.positionIds, ['p1'])
  assert.deepEqual(pruned.budget.perPosition, { p1: 10 })
  assert.equal(pruneMissing(list[0], new Set(['p1', 'p2'])), list[0])
  assert.match(newPackageId(), /^sc-/)
})

test('summary, default name and budget helpers', () => {
  const s = summarize([{ qty: 10.5, unit: 'm²' }, { qty: 4, unit: 'm²' }, { qty: 3, unit: 'm' }])
  assert.equal(s.count, 3)
  assert.deepEqual(s.byUnit, [{ unit: 'm²', qty: 14.5 }, { unit: 'm', qty: 3 }])

  const path = (...labels: string[]) => labels.map((label, i) => ({ oz: labels.slice(0, i + 1).map((_, j) => j + 1).join('.'), label }))
  assert.equal(defaultPackageName([{ path: path('Ausbau', 'Estricharbeiten') }, { path: path('Ausbau', 'Estricharbeiten') }]), 'Estricharbeiten')
  assert.equal(defaultPackageName([{ path: path('Ausbau', 'Estrich') }, { path: [{ oz: '1', label: 'Ausbau' }, { oz: '1.3', label: 'Putz' }] }]), 'Ausbau')
  assert.equal(defaultPackageName([{ path: [{ oz: '1', label: 'A' }] }, { path: [{ oz: '2', label: 'B' }] }]), 'Leistungspaket', 'nothing in common')
  assert.equal(defaultPackageName([]), 'Leistungspaket')

  const prefilled = prefillBudget([
    { id: 'a', qty: 10, up: 12.5 }, { id: 'b', qty: 3, up: null }, { id: 'c', qty: 0, up: 5 }, { id: 'd', qty: 2, up: 0 },
  ])
  assert.deepEqual(prefilled, { a: 125 })
  assert.equal(sumBudget({ a: 100.1, b: 200.2 }), 300.3)
  assert.deepEqual(makeBudget({ a: 10, b: 20, c: 30 }, ['a', 'b']), { perPosition: { a: 10, b: 20 }, total: 30 })
  assert.equal(makeBudget({ a: 10 }, ['a'], 99.999).total, 100, 'a typed total replaces the sum')
})

test('subcontractors are suggested by trade, from the package name and the sections', () => {
  const subs = [
    { id: '1', trade: 'Estrich' }, { id: '2', trade: 'Trockenbau' }, { id: '3', trade: 'Elektro' }, { id: '4', trade: undefined }, { id: '5', trade: 'Maler & Lackierer' },
  ]
  assert.deepEqual(suggestSubcontractors(subs, ['Estricharbeiten']), ['1'])
  assert.deepEqual(suggestSubcontractors(subs, ['Ausbau', 'Trockenbauarbeiten', 'Malerarbeiten']), ['2', '5'])
  assert.deepEqual(suggestSubcontractors(subs, ['Allgemeine Arbeiten']), [], 'filler words do not match')
  assert.equal(tradeMatches('Elektroinstallation', ['Elektro']), true)
  assert.equal(tradeMatches('', ['Elektro']), false)
  assert.deepEqual(sectionLabels([{ path: [{ oz: '1', label: 'A' }, { oz: '1.1', label: 'B' }] }, { path: [{ oz: '1', label: 'A' }] }]), ['A', 'B'])
})

/* ------------------------------------------------------------------ */
/* email template                                                      */
/* ------------------------------------------------------------------ */

test('the German email: salutation, project, package, count, deadline and the request to fill in prices', () => {
  assert.equal(salutation('Erika Müller'), 'Sehr geehrte/r Erika Müller,')
  assert.equal(salutation(null), 'Sehr geehrte Damen und Herren,')
  assert.equal(salutation('  '), 'Sehr geehrte Damen und Herren,')
  assert.equal(emailSubject('Estricharbeiten', 'Schulungshalle'), 'Anfrage Nachunternehmerleistung: Schulungshalle – Estricharbeiten')
  assert.equal(emailSubject('Schulungshalle – Estricharbeiten', 'Schulungshalle'), 'Anfrage Nachunternehmerleistung: Schulungshalle – Estricharbeiten', 'the project is named once')
  assert.match(emailBody({ project: 'Schulungshalle', packageName: 'Schulungshalle – Estrich', positionCount: 2, format: 'x83' }), /Leistungspaket „Estrich“/)

  const body = emailBody({ project: 'Schulungshalle', packageName: 'Estricharbeiten', positionCount: 12, dueDate: '2026-12-05', format: 'x83' })
  assert.match(body, /„Schulungshalle“/)
  assert.match(body, /„Estricharbeiten“ \(12 Positionen\)/)
  assert.match(body, /bis zum 05\.12\.2026/)
  assert.match(body, /Einheitspreise/)
  assert.match(body, /zurück/)
  assert.match(emailBody({ project: 'P', packageName: 'N', positionCount: 1, format: 'xlsx' }), /\(1 Position\)/)
  assert.match(emailBody({ project: 'P', packageName: 'N', positionCount: 1, format: 'xlsx' }), /möglichst zeitnah/)
  assert.match(emailBody({ project: 'P', packageName: 'N', positionCount: 1, format: 'xlsx' }), /Excel-Datei/)

  const full = composeEmail({ salutation: salutation('Erika Müller'), body, sender: DEFAULT_SENDER })
  assert.ok(full.startsWith('Sehr geehrte/r Erika Müller,\n\n'))
  assert.ok(full.trimEnd().endsWith('[Telefon / E-Mail]'))
  assert.match(full, /Mit freundlichen Grüßen/)
})

test('mailto link carries recipient, subject and text, with line breaks as CRLF', () => {
  const link = mailtoLink('a@b.example', 'Anfrage: Estrich – Halle', 'Zeile 1\nZeile 2')
  assert.ok(link.startsWith('mailto:a@b.example?subject='))
  assert.match(link, /body=Zeile%201%0D%0AZeile%202$/)
  assert.ok(mailtoLink(null, 's', 't').startsWith('mailto:?subject='))
})

/* ------------------------------------------------------------------ */
/* MIME builder                                                        */
/* ------------------------------------------------------------------ */

function qpDecode(s: string): string {
  const joined = s.replace(/=\r\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /^[0-9A-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(joined.charCodeAt(i))
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes)).replace(/\r\n/g, '\n')
}

function decodeWords(header: string): string {
  return header.replace(/\r\n /g, ' ').replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf-8'))
}

/** headers, text body and the attachment bytes of an .eml */
function parseEml(eml: string) {
  const [headText, ...rest] = eml.split('\r\n\r\n')
  const headers = new Map<string, string>()
  for (const line of headText.replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    const i = line.indexOf(':')
    headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim())
  }
  const boundary = headers.get('content-type')!.match(/boundary="([^"]+)"/)![1]
  const parts = rest.join('\r\n\r\n').split(`--${boundary}`).slice(1, -1)
  assert.equal(parts.length, 2, 'text part and attachment part')
  const [t, a] = parts.map((p) => {
    const [h, ...b] = p.replace(/^\r\n/, '').split('\r\n\r\n')
    return { head: h, body: b.join('\r\n\r\n').replace(/\r\n$/, '') }
  })
  return {
    headers,
    text: qpDecode(t.body),
    textHead: t.head,
    attachHead: a.head,
    attachment: new Uint8Array(Buffer.from(a.body.replace(/\r\n/g, ''), 'base64')),
  }
}

test('quoted-printable round-trips German text and keeps lines short', () => {
  const sample = 'Sehr geehrte/r Müller,\n\nbitte prüfen Sie „Estrich“ für 12 m² – Größe ≥ 5 €.  \nEin = Gleichheitszeichen und ein sehr langer Satz, der über die Zeilengrenze von sechsundsiebzig Zeichen hinausgeht, damit weich umbrochen wird.\n'
  const encoded = quotedPrintable(sample)
  for (const line of encoded.split('\r\n')) assert.ok(line.length <= 76, `line too long: ${line.length}`)
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(encoded), 'pure ASCII on the wire')
  assert.equal(qpDecode(encoded), sample.replace(/ {2}\n/, '  \n'))
  assert.match(encoded, /=3D/)
  assert.match(encoded, / {1}=20\r\n/, 'trailing whitespace is encoded')
})

test('header encoding: ASCII stays, other text becomes RFC 2047 words that decode back', () => {
  assert.equal(encodeHeader('Anfrage Estrich'), 'Anfrage Estrich')
  const subject = 'Anfrage Nachunternehmerleistung: Estricharbeiten – Schulungshalle mit Bürotrakt, Größe 5 m²'
  const encoded = encodeHeader(subject)
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(encoded))
  assert.ok(encoded.split('\r\n').every((l) => l.length <= 76))
  assert.equal(decodeWords(encoded), subject)
  assert.equal(encodeHeader('a\r\nBcc: evil@x.example'), 'a Bcc: evil@x.example', 'no header injection')
})

test('an .eml is an unsent MIME draft with the recipient, German text and the file as base64 attachment', () => {
  const file = { fileName: 'Anfrage_Estrich_Halle.X83', mime: 'application/xml', data: new Uint8Array(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256)) }
  const body = 'Sehr geehrte/r Erika Müller,\n\nbitte bis zum 05.12.2026.\n'
  const eml = buildEml({ to: 'angebot@estrich-mueller.example', subject: 'Anfrage Nachunternehmerleistung: Estrich – Halle', text: body, attachment: file, date: new Date('2026-11-21T10:00:00Z'), boundary: 'BOUNDARY' })
  assert.ok(eml.startsWith('X-Unsent: 1\r\n'))
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(eml), 'the whole message is ASCII')
  assert.ok(!/(^|[^\r])\n/.test(eml), 'CRLF line endings only')
  const m = parseEml(eml)
  assert.equal(m.headers.get('to'), 'angebot@estrich-mueller.example')
  assert.equal(decodeWords(m.headers.get('subject')!), 'Anfrage Nachunternehmerleistung: Estrich – Halle')
  assert.equal(m.headers.get('mime-version'), '1.0')
  assert.equal(m.headers.get('date'), 'Sat, 21 Nov 2026 10:00:00 +0000')
  assert.match(m.textHead, /charset=utf-8/)
  assert.equal(m.text, body)
  assert.match(m.attachHead, /Content-Type: application\/xml; name="Anfrage_Estrich_Halle\.X83"/)
  assert.match(m.attachHead, /Content-Disposition: attachment; filename="Anfrage_Estrich_Halle\.X83"/)
  assert.match(m.attachHead, /Content-Transfer-Encoding: base64/)
  assert.deepEqual(m.attachment, file.data)
  assert.ok(eml.split('\r\n').every((l) => l.length <= 998))

  const noTo = buildEml({ to: null, subject: 's', text: 't', attachment: file })
  assert.ok(!/^To:/m.test(noTo), 'no To header when the catalogue has no email')
  const injected = buildEml({ to: 'a@b.example\r\nBcc: x@y.example', subject: 's', text: 't', attachment: file })
  assert.ok(!/^Bcc:/m.test(injected))
})

test('file names are safe', () => {
  assert.equal(slug('Estricharbeiten & Böden / Süd'), 'Estricharbeiten_Boeden_Sued')
  assert.equal(slug('???'), 'Anfrage')
  assert.ok(slug('x'.repeat(200)).length <= 50)
})

/* ------------------------------------------------------------------ */
/* request files from the demo tender                                  */
/* ------------------------------------------------------------------ */

test('the X83 request re-imports with exactly the package positions and no prices', async () => {
  const { doc, resolved } = await hall()
  const chosen = screed(resolved.positions)
  assert.ok(chosen.length >= 2, 'the demo tender has a screed section')
  assert.ok(chosen.length < resolved.positions.length)
  const request = { name: 'Estricharbeiten', positionIds: chosen.map((p) => p.id), format: 'x83' as const, dueDate: '2026-12-05' }
  const file = await buildRequestFile({ doc, resolved, request, now: new Date('2026-11-21T10:00:00Z') })
  assert.equal(file.fileName, `Anfrage_Estricharbeiten_${slug(projectName(doc), 40)}.X83`)
  assert.equal(file.mime, 'application/xml')

  const parsed = await parseListFile(asFile(file.fileName, file.data))
  assert.ok(parsed)
  assert.deepEqual(parsed.positions.map((p) => p.oz).sort(), chosen.map((p) => p.oz).sort())
  assert.ok(parsed.positions.every((p) => p.up == null), 'no prices')
  const xml = text(file.data)
  assert.ok(!/<(UP|IT|Totals|Total)>/.test(xml), 'no price, line total or list total element')
  for (const p of chosen) assert.ok(xml.includes(p.short.slice(0, 20)))
  assert.ok(!xml.includes(resolved.positions.find((p) => !chosen.includes(p))!.short), 'positions of other sections are not in the file')
})

test('the Excel request has empty unit-price cells and formula totals', async () => {
  const { doc, resolved } = await hall()
  const chosen = screed(resolved.positions)
  const file = await buildRequestFile({ doc, resolved, request: { name: 'Estrich', positionIds: chosen.map((p) => p.id), format: 'xlsx', dueDate: '2026-12-05' } })
  assert.ok(file.fileName.endsWith('.xlsx'))
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(file.data as unknown as ArrayBuffer)
  const ws = wb.getWorksheet('Anfrage')!
  assert.match(String(ws.getCell('A3').value), /Angebotsfrist: 05\.12\.2026/)
  const byOz = new Map<string, ExcelJS.Row>()
  ws.eachRow((row) => byOz.set(String(row.getCell(1).value), row))
  for (const p of chosen) {
    const row = byOz.get(p.oz)
    assert.ok(row, `row for ${p.oz}`)
    assert.equal(row.getCell(4).value, p.qty)
    const ep = row.getCell(6).value
    assert.ok(ep === null || ep === undefined || ep === '', `EP of ${p.oz} is empty`)
    const gp = row.getCell(7).value as { formula?: string }
    assert.ok(gp && typeof gp === 'object' && /D\d+\*F\d+/.test(gp.formula ?? ''), `GP of ${p.oz} is a formula`)
  }
  assert.equal(byOz.size >= chosen.length, true)
})

test('the PDF request is a printout of the package positions', async () => {
  const { doc, resolved } = await hall()
  const chosen = screed(resolved.positions)
  const file = await buildRequestFile({ doc, resolved, request: { name: 'Estrich', positionIds: chosen.map((p) => p.id), format: 'pdf' } })
  assert.equal(text(file.data.subarray(0, 5)), '%PDF-')
  assert.ok(file.fileName.endsWith('.pdf'))
})

test('an empty package cannot be exported, and so cannot a package without recipients', async () => {
  const { doc, resolved } = await hall()
  await assert.rejects(buildRequestFile({ doc, resolved, request: { name: 'x', positionIds: ['nope'], format: 'x83' } }), /no positions/)
  const some = { name: 'x', positionIds: [resolved.positions[0].id], format: 'x83' as const }
  await assert.rejects(exportAndDraft({ doc, resolved, request: some, recipients: [], body: 'b' }), /at least one/)
})

test('one recipient downloads an .eml, several download a .zip with the request file and one draft each', async () => {
  const { doc, resolved } = await hall()
  const chosen = screed(resolved.positions)
  const request = { name: 'Estricharbeiten', positionIds: chosen.map((p) => p.id), format: 'x83' as const, dueDate: '2026-12-05' }
  const body = emailBody({ project: projectName(doc), packageName: request.name, positionCount: chosen.length, dueDate: request.dueDate, format: 'x83' })

  const one = await exportAndDraft({ doc, resolved, request, recipients: [recipients[0]], body })
  assert.equal(one.download.mime, 'message/rfc822')
  assert.ok(one.download.fileName.endsWith('.eml'))
  const single = parseEml(text(one.download.data))
  assert.equal(single.headers.get('to'), 'angebot@estrich-mueller.example')
  assert.deepEqual(single.attachment, one.file.data)

  const two = await exportAndDraft({ doc, resolved, request, recipients, body, sender: 'Mit freundlichen Grüßen\nBau GmbH' })
  assert.equal(two.download.mime, 'application/zip')
  assert.equal(two.download.fileName, 'Anfrage_Estricharbeiten.zip')
  const entries = unzipSync(two.download.data)
  const names = Object.keys(entries).sort()
  assert.equal(names.length, 3)
  assert.ok(names.includes(two.file.fileName))
  assert.deepEqual(entries[two.file.fileName], two.file.data, 'the X83 is in the zip once, unchanged')
  const emls = names.filter((n) => n.endsWith('.eml')).map((n) => parseEml(text(entries[n])))
  assert.equal(emls.length, 2)
  const byTo = new Map(emls.map((m) => [m.headers.get('to'), m]))
  const first = byTo.get('angebot@estrich-mueller.example')!
  const second = byTo.get('info@boden-putz.example')!
  assert.ok(first.text.startsWith('Sehr geehrte/r Erika Müller,'), 'salutation with the contact name')
  assert.ok(second.text.startsWith('Sehr geehrte Damen und Herren,'), 'neutral salutation without one')
  for (const m of [first, second]) {
    assert.match(m.text, /Bau GmbH/)
    assert.match(m.text, /05\.12\.2026/)
    assert.deepEqual(m.attachment, two.file.data, 'each draft carries the file')
    assert.equal(decodeWords(m.headers.get('subject')!), `Anfrage Nachunternehmerleistung: ${projectName(doc)} – Estricharbeiten`)
  }
})

/* ------------------------------------------------------------------ */
/* the budget is internal                                              */
/* ------------------------------------------------------------------ */

/** every way a number could be written into a file or an email */
function forms(n: number): string[] {
  const fixed = n.toFixed(2)
  const [int, dec] = fixed.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return [fixed, `${int},${dec}`, `${grouped},${dec}`, String(n), String(n).replace('.', ','), `${grouped}`.concat(dec === '00' ? '' : `,${dec}`)].filter((s) => s.length >= 5)
}

/** all searchable text of a request: raw bytes, the inner files of zip-based formats, decoded mail parts */
function haystack(name: string, data: Uint8Array): string[] {
  const out = [Buffer.from(data).toString('latin1'), text(data)]
  if (/\.(xlsx|zip)$/i.test(name)) {
    for (const [inner, bytes] of Object.entries(unzipSync(data))) out.push(...haystack(inner, bytes))
  }
  if (/\.eml$/i.test(name)) {
    const m = parseEml(text(data))
    out.push(m.text, [...m.headers.entries()].map(([k, v]) => `${k}: ${decodeWords(v)}`).join('\n'), ...haystack('attachment', m.attachment))
    out.push(...haystack(m.attachHead.match(/filename="([^"]+)"/)![1], m.attachment))
  }
  return out
}

for (const format of ['x83', 'xlsx', 'pdf'] as SubcontractFormat[]) {
  test(`the budget appears nowhere in the ${format} request or the emails`, async () => {
    const { doc, resolved } = await hall()
    const chosen = screed(resolved.positions)
    const perPosition = Object.fromEntries(chosen.map((p, i) => [p.id, 7777.77 + i * 1111.11]))
    const full: SubcontractPackage = {
      ...pkg('budgeted', chosen.map((p) => p.id)),
      name: 'Estricharbeiten',
      format,
      dueDate: '2026-12-05',
      subcontractorIds: ['a', 'b'],
      budget: { perPosition, total: 98765.43 },
      notes: 'INTERNE-NOTIZ-NICHT-SENDEN',
    }
    const secrets = [
      ...Object.values(perPosition), full.budget.total, sumBudget(perPosition),
      ...resolved.positions.map((p) => p.up!), // the list's own prices are internal too
    ].flatMap(forms)
    assert.ok(secrets.length > 20)

    const request = toRequest(full)
    assert.deepEqual(Object.keys(request).sort(), ['dueDate', 'format', 'name', 'positionIds'], 'the request type has no budget and no notes')
    const body = emailBody({ project: projectName(doc), packageName: request.name, positionCount: request.positionIds.length, dueDate: request.dueDate, format })
    const result = await exportAndDraft({ doc, resolved, request, recipients, body })

    const targets: [string, Uint8Array][] = [
      [result.file.fileName, result.file.data],
      [result.download.fileName, result.download.data],
      ...result.drafts.map((d): [string, Uint8Array] => [d.fileName, new TextEncoder().encode(d.eml)]),
    ]
    for (const [name, data] of targets) {
      for (const hay of haystack(name, data)) {
        for (const secret of secrets) assert.ok(!hay.includes(secret), `${secret} found in ${name}`)
        assert.ok(!hay.includes('INTERNE-NOTIZ'), `internal note found in ${name}`)
      }
    }
    for (const d of result.drafts) {
      const m = parseEml(d.eml)
      assert.ok(!/budget|erwartete kosten|kalkul/i.test(m.text), 'the email text names no budget')
    }
  })
}

test('the sanity check really can find a number (the leak test is not vacuous)', async () => {
  const { doc, resolved } = await hall()
  const own = resolved.positions[0]
  const priced = { ...doc, positions: doc.positions.map((p) => (p.id === own.id ? { ...p, up: 4242.42 } : p)) }
  const file = await buildRequestFile({ doc: priced, resolved: resolveList(priced), request: { name: 'x', positionIds: [own.id], format: 'x83' } })
  assert.ok(!text(file.data).includes('4242'), 'the X83 request drops a list price')
  const csv = await exportList({ doc: priced, resolved: resolveList(priced), format: 'csv', scope: 'selection', selectedIds: [own.id], prices: true })
  assert.ok(text(csv.data).includes('4242,42'), 'a priced export does carry it, and the search finds it')
})

test('the request title is the main project, then the section being sent', () => {
  assert.equal(proposalTitle('Schulungshalle', 'Estricharbeiten'), 'Schulungshalle – Estricharbeiten')
  assert.equal(proposalTitle('', 'Estricharbeiten'), 'Estricharbeiten')
  assert.equal(proposalTitle('Schulungshalle', ''), 'Schulungshalle')
  assert.equal(withoutProject('Schulungshalle – Estricharbeiten', 'Schulungshalle'), 'Estricharbeiten')
  assert.equal(withoutProject('Schulungshalle - Estrich', 'Schulungshalle'), 'Estrich')
  assert.equal(withoutProject('Hallenboden', 'Halle'), 'Hallenboden', 'a name that only starts with the project text is kept')
  assert.equal(withoutProject('Estrich', 'Schulungshalle'), 'Estrich')
  assert.equal(withoutProject('Schulungshalle', 'Schulungshalle'), 'Schulungshalle')
  const doc = { title: 'Angebot AN24-0305' }
  assert.equal(requestFileName(doc, { name: 'Fernleitung – Rohrgraben', format: 'x83' }, 'Fernleitung'), 'Anfrage_Rohrgraben_Fernleitung.X83', 'the project is in the file name once')
  assert.equal(requestFileName(doc, { name: 'Rohrgraben', format: 'pdf' }), 'Anfrage_Rohrgraben_Angebot_AN24_0305.pdf')
})

test('marking a request as sent without exporting it again', () => {
  const at = '2026-11-22T09:00:00.000Z'
  const list = [pkg('a', ['p1'], { status: 'draft' }), pkg('b', ['p2'], { status: 'offer_received', sentAt: '2026-11-20T08:00:00.000Z' })]
  const a = markSent(list, 'a', at)
  assert.equal(a[0].status, 'sent')
  assert.equal(a[0].sentAt, at)
  assert.equal(a[1], list[1], 'other packages are untouched')
  const b = markSent(list, 'b', at)
  assert.equal(b[1].status, 'offer_received', 'a later status is kept')
  assert.equal(b[1].sentAt, '2026-11-20T08:00:00.000Z', 'the real sent date is kept')
})
