/**
 * "Export & draft email": builds the request file of a subcontract package (no prices) and one `.eml` draft per
 * subcontractor with that file attached. Nothing is sent from here or from the server: the user opens the drafts in
 * their own mail client. Reuses lib/export read-only.
 *
 * Every function in this file takes a `PackageRequest` (name, positions, deadline, format), never a full
 * `SubcontractPackage`, so the internal budget has no way into a file or an email.
 */
import { exportList, type ExportResult } from './export/index'
import type { LayoutFile } from './export/types'
import { buildCats, deDate } from './export/util'
import { DEFAULT_SENDER, composeEmail, emailSubject, salutation, type PackageRequest, type SubcontractFormat } from './subcontract'
import type { CategoryNode, ListDoc, Position } from './types'

export type RequestFile = { fileName: string; mime: string; data: Uint8Array }

export type Recipient = { id: string; name: string; email?: string | null; contactName?: string | null }

export type Draft = { recipient: Recipient; fileName: string; eml: string }

type Resolved = { positions: Position[]; tree: CategoryNode[] }

/* ------------------------------------------------------------------ */
/* names                                                               */
/* ------------------------------------------------------------------ */

/** the project as the subcontractor knows it: label, else project number, else the list title */
export const projectName = (doc: Pick<ListDoc, 'title' | 'project' | 'projectLabel'>): string =>
  (doc.projectLabel || doc.project || doc.title || '').trim()

/** a file-name safe piece of text (umlauts spelled out, no spaces or punctuation) */
export function slug(text: string, max = 50): string {
  const s = text
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (s.length <= max) return s || 'Anfrage'
  // cut at a word boundary when one is near, so a name never ends mid-word
  const cut = s.slice(0, max)
  const at = cut.lastIndexOf('_')
  return (at > max / 2 ? cut.slice(0, at) : cut).replace(/_+$/, '')
}

const EXT: Record<SubcontractFormat, string> = { x83: 'X83', xlsx: 'xlsx', pdf: 'pdf' }
const MIME: Record<SubcontractFormat, string> = {
  x83: 'application/xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
}

export const requestFileName = (doc: Pick<ListDoc, 'title' | 'project' | 'projectLabel'>, req: Pick<PackageRequest, 'name' | 'format'>): string =>
  `Anfrage_${slug(req.name, 40)}_${slug(projectName(doc), 40)}.${EXT[req.format]}`

/* ------------------------------------------------------------------ */
/* the request file                                                    */
/* ------------------------------------------------------------------ */

/**
 * Excel with empty unit-price cells and line totals as formulas. The table export has no such variant (its price
 * columns are either filled or absent), so it is written here.
 */
export async function buildXlsxRequest(doc: ListDoc, positions: Position[], dueDate?: string): Promise<Uint8Array> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'BillBuild'
  wb.created = new Date()
  wb.calcProperties = { fullCalcOnLoad: true }
  const ws = wb.addWorksheet('Anfrage', { views: [{ state: 'frozen', ySplit: 6 }] })
  const cols = [
    { header: 'OZ', width: 14 }, { header: 'Kurztext', width: 48 }, { header: 'Langtext', width: 70 },
    { header: 'Menge', width: 12 }, { header: 'ME', width: 7 }, { header: 'EP (EUR)', width: 14 }, { header: 'GP (EUR)', width: 16 },
  ]
  ws.columns = cols.map((c) => ({ width: c.width }))
  ws.getCell('A1').value = projectName(doc)
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('A2').value = doc.title
  ws.getCell('A2').font = { bold: true, size: 11 }
  ws.getCell('A3').value = dueDate ? `Angebotsfrist: ${deDate(dueDate)}` : ''
  ws.getCell('A4').value = 'Bitte tragen Sie Ihre Einheitspreise in die gelb markierten Zellen der Spalte EP ein. Die Gesamtpreise werden berechnet.'
  ws.getCell('A4').font = { italic: true }
  const head = ws.getRow(6)
  cols.forEach((c, i) => (head.getCell(i + 1).value = c.header))
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
  ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: cols.length } }

  const money = '#,##0.00 "€"'
  const thin = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } }
  let row = 7
  const first = row
  const tree = buildCats(positions)
  const emit = (cats: typeof tree.roots, rootItems: Position[]) => {
    const item = (p: Position) => {
      const r = ws.getRow(row)
      r.getCell(1).value = p.oz
      r.getCell(1).alignment = { vertical: 'top' }
      r.getCell(2).value = p.short
      r.getCell(2).alignment = { wrapText: true, vertical: 'top' }
      r.getCell(3).value = p.long ?? ''
      r.getCell(3).alignment = { wrapText: true, vertical: 'top' }
      r.getCell(4).value = p.qty
      r.getCell(4).numFmt = '#,##0.000'
      r.getCell(5).value = p.unit
      const ep = r.getCell(6)
      ep.numFmt = money
      ep.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }
      ep.border = { top: thin, bottom: thin, left: thin, right: thin }
      // empty until the unit price is filled in; no cached result, so no number of ours is in the file
      r.getCell(7).value = { formula: `IF(F${row}="","",D${row}*F${row})`, result: '' }
      r.getCell(7).numFmt = money
      row++
    }
    for (const p of rootItems) item(p)
    const rec = (c: (typeof tree.roots)[number]) => {
      const r = ws.getRow(row)
      const catRow = row
      r.getCell(1).value = c.oz
      r.getCell(2).value = c.label
      r.getCell(2).alignment = { indent: (c.depth - 1) * 2 }
      r.font = { bold: true }
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.depth === 1 ? 'FFDDEBF7' : 'FFF2F2F2' } }
      row++
      for (const k of c.cats) rec(k)
      for (const p of c.items) item(p)
      ws.getRow(catRow).getCell(7).value = { formula: `SUBTOTAL(9,G${catRow + 1}:G${Math.max(row - 1, catRow + 1)})`, result: 0 }
      ws.getRow(catRow).getCell(7).numFmt = money
    }
    for (const c of cats) rec(c)
  }
  emit(tree.roots, tree.rootItems)
  row++
  const sum = ws.getRow(row)
  sum.getCell(2).value = 'Summe Angebot (netto)'
  sum.getCell(7).value = { formula: `SUBTOTAL(9,G${first}:G${row - 2})`, result: 0 }
  sum.getCell(7).numFmt = money
  sum.font = { bold: true }
  sum.border = { top: { style: 'thin' }, bottom: { style: 'double' } }
  const buf = await wb.xlsx.writeBuffer()
  return new Uint8Array(buf as ArrayBuffer)
}

/** the file the subcontractor fills in: the package's positions only, never a price of ours */
export async function buildRequestFile(a: {
  doc: ListDoc
  resolved: Resolved
  request: PackageRequest
  now?: Date
  loadLayout?: () => Promise<LayoutFile | null>
}): Promise<RequestFile> {
  const { doc, resolved, request } = a
  const ids = new Set(request.positionIds)
  const positions = resolved.positions.filter((p) => ids.has(p.id))
  if (!positions.length) throw new Error('The package has no positions.')
  const fileName = requestFileName(doc, request)
  const mime = MIME[request.format]
  if (request.format === 'xlsx') return { fileName, mime, data: await buildXlsxRequest(doc, positions, request.dueDate) }
  const res = await exportList({
    doc, resolved, format: request.format, scope: 'selection', selectedIds: [...ids], longTexts: true, prices: false,
    loadLayout: a.loadLayout, now: a.now,
  })
  return { fileName, mime, data: res.data }
}

/* ------------------------------------------------------------------ */
/* MIME building blocks                                                */
/* ------------------------------------------------------------------ */

export function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const fold76 = (b64: string) => (b64.match(/.{1,76}/g) ?? []).join('\r\n')

/** quoted-printable (RFC 2045) of UTF-8 text; lines end in CRLF and never exceed 76 characters */
export function quotedPrintable(text: string): string {
  const bytes = new TextEncoder().encode(text.replace(/\r\n|\r/g, '\n'))
  const lines: string[] = []
  let cur = ''
  const add = (tok: string) => {
    if (cur.length + tok.length > 75) {
      lines.push(`${cur}=`)
      cur = ''
    }
    cur += tok
  }
  const flush = () => {
    // whitespace at the end of a line must be encoded
    if (/[ \t]$/.test(cur)) cur = cur.slice(0, -1) + `=${cur.endsWith(' ') ? '20' : '09'}`
    lines.push(cur)
    cur = ''
  }
  for (const b of bytes) {
    if (b === 10) flush()
    else if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) add(String.fromCharCode(b))
    else add(`=${b.toString(16).toUpperCase().padStart(2, '0')}`)
  }
  flush()
  return lines.join('\r\n')
}

/** a header value; non-ASCII text becomes RFC 2047 encoded words (UTF-8, base64) of at most 45 bytes each */
export function encodeHeader(value: string): string {
  const v = value.replace(/[\r\n]+/g, ' ').trim()
  if (/^[\x20-\x7e]*$/.test(v)) return v
  const words: string[] = []
  let chunk = ''
  const enc = new TextEncoder()
  for (const ch of v) {
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${base64(enc.encode(w))}?=`).join('\r\n ')
}

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')

/**
 * One `.eml` draft: multipart/mixed with the German text and the file as base64. `X-Unsent: 1` makes Outlook open
 * it as a draft to edit and send; Apple Mail and Thunderbird open it the same way.
 */
export function buildEml(o: { to?: string | null; subject: string; text: string; attachment: RequestFile; date?: Date; boundary?: string }): string {
  const boundary = o.boundary ?? `=_billbuild_${crypto.randomUUID().replace(/-/g, '')}`
  const to = (o.to ?? '').replace(/[\r\n,;<>]+/g, ' ').trim()
  const date = (o.date ?? new Date()).toUTCString().replace('GMT', '+0000')
  const name = o.attachment.fileName
  const head = [
    'X-Unsent: 1',
    ...(to ? [`To: ${to}`] : []),
    `Subject: ${encodeHeader(o.subject)}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ]
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(o.text),
    `--${boundary}`,
    `Content-Type: ${o.attachment.mime}; name="${asciiName(name)}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    '',
    fold76(base64(o.attachment.data)),
    `--${boundary}--`,
    '',
  ]
  return [...head, '', ...parts].join('\r\n')
}

/* ------------------------------------------------------------------ */
/* drafts and the download                                             */
/* ------------------------------------------------------------------ */

/** one draft per recipient, each with its own salutation and the same file attached */
export function buildDrafts(a: { file: RequestFile; recipients: Recipient[]; packageName: string; project: string; body: string; sender?: string; now?: Date }): Draft[] {
  const subject = emailSubject(a.packageName, a.project)
  const used = new Set<string>()
  return a.recipients.map((r) => {
    const text = composeEmail({ salutation: salutation(r.contactName), body: a.body, sender: a.sender ?? DEFAULT_SENDER })
    let base = `Anfrage_${slug(a.packageName, 40)}_${slug(r.name, 40)}`
    for (let n = 2; used.has(base); n++) base = `Anfrage_${slug(a.packageName, 40)}_${slug(r.name, 40)}_${n}`
    used.add(base)
    return { recipient: r, fileName: `${base}.eml`, eml: buildEml({ to: r.email, subject, text, attachment: a.file, date: a.now }) }
  })
}

/** one draft downloads as the `.eml`; several download as one `.zip` with the request file and the drafts */
export async function bundleDrafts(file: RequestFile, drafts: Draft[], packageName: string): Promise<ExportResult> {
  if (drafts.length === 1) {
    return { data: new TextEncoder().encode(drafts[0].eml), fileName: drafts[0].fileName, mime: 'message/rfc822', mode: 'generated' }
  }
  const { zipSync, strToU8 } = await import('fflate')
  const files: Record<string, Uint8Array> = { [file.fileName]: file.data }
  for (const d of drafts) files[d.fileName] = strToU8(d.eml)
  return { data: zipSync(files, { level: 6 }), fileName: `Anfrage_${slug(packageName, 40)}.zip`, mime: 'application/zip', mode: 'generated' }
}

export type DraftBundle = { file: RequestFile; drafts: Draft[]; download: ExportResult }

/** the whole one-click step, minus the browser download: request file, drafts, and what to download */
export async function exportAndDraft(a: {
  doc: ListDoc
  resolved: Resolved
  request: PackageRequest
  recipients: Recipient[]
  body: string
  sender?: string
  now?: Date
  loadLayout?: () => Promise<LayoutFile | null>
}): Promise<DraftBundle> {
  if (!a.recipients.length) throw new Error('Pick at least one subcontractor.')
  const file = await buildRequestFile(a)
  const drafts = buildDrafts({ file, recipients: a.recipients, packageName: a.request.name, project: projectName(a.doc), body: a.body, sender: a.sender, now: a.now })
  return { file, drafts, download: await bundleDrafts(file, drafts, a.request.name) }
}

/* ------------------------------------------------------------------ */
/* sender block, remembered in local settings                          */
/* ------------------------------------------------------------------ */

const SENDER_KEY = 'billbuild:subcontract-sender'

export function loadSender(): string {
  try {
    return localStorage.getItem(SENDER_KEY) || DEFAULT_SENDER
  } catch {
    return DEFAULT_SENDER
  }
}

export function saveSender(text: string): void {
  try {
    localStorage.setItem(SENDER_KEY, text)
  } catch {
    /* private window or blocked storage: the block just isn't remembered */
  }
}

/** copies text, falling back to a hidden textarea where the clipboard API is unavailable */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
