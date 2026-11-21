/**
 * Converts the samples in data/tenders/ into the app's static dataset:
 *   public/data/index.json        folders, list metadata, documents
 *   public/data/lists/<id>.json   positions per list
 *
 * Requires `pdftotext` + `pdfinfo` (poppler) on PATH. Run: npm run data
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import {
  decodeGaeb90, flatTree, newNode, parseGaeb90, parseGaebXml, parseLvPdfText, positionTotal,
  type CategoryNode, type ParsedList, type Position, type SourceInfo,
} from '../src/lib/gaeb.ts'

const ROOT = resolve(import.meta.dirname, '..')
const DATA = resolve(ROOT, '..', 'data', 'tenders')
const OUT = join(ROOT, 'public', 'data')

type Tone = 'indigo' | 'emerald' | 'amber' | 'blue' | 'sky' | 'violet'

interface FolderDef {
  id: string
  name: string
  description: string
  icon: string
  tone: Tone
  lists: string[]
  documents: string[]
}

/* Folder grouping — derived from project numbers / titles inside the files */
const FOLDERS: FolderDef[] = [
  {
    id: 'ausbildungszentrum-79-222',
    name: 'Ausbildungszentrum und Bürogebäude',
    description: 'Projekt 79-222 · Anfrage-LVs aller Gewerke',
    icon: 'apartment',
    tone: 'indigo',
    lists: [
      'LV_00_Roh_und_Erdauarbeiten.pdf', 'LV_01_Fertigteiltreppen.pdf', 'LV_02_PVC_Fussbodenbelag.pdf',
      'LV_03_Malerarbeiten.pdf', 'LV_04_Porenbetonfassade.pdf', 'LV_05_[FIRMA_096].pdf',
      'LV_06_Kautschukboden.pdf', 'LV_07_Teppichboden.pdf', 'LV_08_Fliesen_und_Natursteinarbeiten.pdf',
      'LV_09_Porenbetondach.pdf', 'LV_10_Stahlbetonfertigeile_Stuetzen_Binder.pdf',
      'LV_11_Stahlbetonfertigeile_Sandwichsockel.pdf', 'LV_12_Dachabdichtung.pdf', 'LV_13_ELT.pdf',
      'LV_14_Sanitaeranlage.pdf', 'LV_14a_Betonkernaktivierung.pdf', 'LV_14b_Dachentwaesserung.pdf',
      'LV_14c_Industriebodenheizung.pdf', 'LV_15_Abdichtung_Aussenwaende.pdf',
      'LV_15a_Abdichtung_Bodenplatte_Buero.pdf', 'LV_17_Trockenbau.pdf', 'LV_18_Estrich.pdf',
      'LV_19_Sektionaltore_Stahltueren.pdf', 'LV_20_Bodenbelagsarbeiten.pdf', 'LV_21_Natursteinarbeiten.pdf',
      'LV_22_Schreinerarbeiten.pdf', 'LV_23_Sanitaertrennwaende.pdf',
    ],
    documents: [],
  },
  {
    id: 'maschinentechnik-8209-003',
    name: 'Maschinentechnik – Anlagenbau',
    description: 'HEM2301-2 · Umrüstung Wasserwerk zur Arsenelimination',
    icon: 'precision_manufacturing',
    tone: 'emerald',
    lists: ['[ORT_024] LV24069.D86', '8209.003_Leistungsverzeichnis_leer.X83', '8209.003_Leistungsverzeichnis_leer.D83'],
    documents: ['HEM2301-2_Gesamt-LV.pdf'],
  },
  {
    id: 'fernleitung-2024-001',
    name: 'Fernleitung – Weinsbach',
    description: 'Projekt 2024-001 · Angebot AN24-0305 & Aufmaß',
    icon: 'conversion_path',
    tone: 'amber',
    lists: ['Angebot AN24-0305.D84', 'LV-Positionen.docx'],
    documents: ['Angebot AN24-0305.pdf', 'Leistungsverzeichnis.pdf', 'LV-Schachtbauwerk.pdf'],
  },
  {
    id: 'ringschluss-brunnenwasser',
    name: 'Ringschluss Brunnenwasser',
    description: 'Neubau Technische Chemie · Tiefbau- und Leitungsbau',
    icon: 'water_drop',
    tone: 'blue',
    lists: ['StBALV23040.D86', 'StBALV23040.D84', '[NUMMER_001]_leer.X83'],
    documents: ['Abgabe LV.pdf', 'Leistungsverzeichnis_leer.pdf'],
  },
  {
    id: 'tiefbau-501-24-01',
    name: 'Tiefbau und Verlegung',
    description: '501-24-01 · GAEB-XML Leistungsverzeichnis',
    icon: 'construction',
    tone: 'violet',
    lists: ['501-24-01_GAEB-XML_sas.x83'],
    documents: [],
  },
  {
    id: 'bachdurchlass-152516',
    name: 'Bachdurchlass Neppen',
    description: 'LV 152516 · Stahlbetonrohre, Schächte & Einlaufbauwerk',
    icon: 'water',
    tone: 'sky',
    lists: ['GAEB-[PROJEKT_004].X83'],
    documents: ['LV-Ausdruck-[PROJEKT_004].pdf'],
  },
]

const slug = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const companionLists: Record<string, string> = {
  'hem2301-2-gesamt-lv-pdf': '8209-003-leistungsverzeichnis-leer-x83',
  'angebot-an24-0305-pdf': 'angebot-an24-0305-d84',
  'leistungsverzeichnis-pdf': 'lv-positionen-docx',
  'lv-schachtbauwerk-pdf': 'lv-positionen-docx',
  'abgabe-lv-pdf': 'nummer-001-leer-x83',
  'leistungsverzeichnis-leer-pdf': 'nummer-001-leer-x83',
  'lv-ausdruck-projekt-004-pdf': 'gaeb-projekt-004-x83',
}

const pdfText = (f: string, raw = true) =>
  execFileSync('pdftotext', ['-enc', 'UTF-8', raw ? '-raw' : '-layout', f, '-'], { maxBuffer: 64 << 20 }).toString('utf8')

const pdfPages = (f: string) => {
  try {
    const info = execFileSync('pdfinfo', [f]).toString('utf8')
    return parseInt(info.match(/Pages:\s+(\d+)/)?.[1] ?? '0', 10)
  } catch {
    return 0
  }
}

/** minimal .docx reader: unzip word/document.xml */
function docxParagraphs(file: string): string[] {
  const buf = readFileSync(file)
  let off = 0
  while (off < buf.length - 30) {
    if (buf.readUInt32LE(off) !== 0x04034b50) { off++; continue }
    const method = buf.readUInt16LE(off + 8)
    const csize = buf.readUInt32LE(off + 18)
    const nlen = buf.readUInt16LE(off + 26)
    const xlen = buf.readUInt16LE(off + 28)
    const name = buf.subarray(off + 30, off + 30 + nlen).toString('utf8')
    const start = off + 30 + nlen + xlen
    if (name === 'word/document.xml') {
      const data = buf.subarray(start, start + csize)
      const xml = (method === 8 ? inflateRawSync(data) : data).toString('utf8')
      return xml.split('</w:p>').map((p) => p.replace(/<[^>]+>/g, '').trim())
    }
    off = start + csize
  }
  return []
}

/** OZ → text lines recovered from the Angebot PDF (clean layout blocks only) */
function offerPdfTexts(file: string): Map<string, string[]> {
  const t = pdfText(file, false)
  const NOISE = /^(Übertrag|Seite:|Bauvorhaben|Projekt-Nr|Pos-Nr|Summe|Zusammenstellung|Sparkasse|VR-Bank|IBAN|\[FIRMA|\[BILD|\[ADRESSE|Tel\.|Bereich|Abschnitt|Hinweistext|Druck)/
  const out = new Map<string, string[]>()
  let cur: string[] | null = null
  for (const raw of t.split(/\r?\n/)) {
    const l = raw.trim()
    const m = l.match(/^(\d+(?:\.\d+)+)\s{2,}[\d.]*\d,\d+\s+\S+(?:\s|$)/)
    if (m) {
      cur = []
      out.set(m[1], cur)
      continue
    }
    if (!l) continue
    if (NOISE.test(l) || /^[\d.,\s-]+$/.test(l)) {
      if (/^(Summe|Zusammenstellung|Seite|Bauvorhaben|Pos-Nr)/.test(l)) cur = null
      continue
    }
    if (/^\d+(?:\.\d+)+\s/.test(l)) {
      cur = null
      continue
    }
    if (/^[\d.]+,\d+\s+\S+$/.test(l)) continue
    if (cur) cur.push(l.replace(/\s{2,}[\d.,\s-]+$/, ''))
  }
  for (const [k, v] of out) if (v.length === 0 || v.length > 4) out.delete(k)
  return out
}

const firstLine = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 110) ?? ''

type Template = NonNullable<SourceInfo['pdfTemplate']>
const TEMPLATE: Record<string, Template> = {
  'Angebot AN24-0305.D84': 'C_angebot',
  'LV-Positionen.docx': 'B_kurz_langtext',
  'StBALV23040.D84': 'E_courier',
  'StBALV23040.D86': 'E_courier',
  '[NUMMER_001]_leer.X83': 'E_courier',
  'GAEB-[PROJEKT_004].X83': 'D_lv_ausdruck',
}
const clean = (h: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(h).filter(([, v]) => v != null && v !== '')) as Record<string, string>

const layout = (f: string, pages = 1) =>
  execFileSync('pdftotext', ['-enc', 'UTF-8', '-layout', '-l', String(pages), join(DATA, f), '-'], { maxBuffer: 64 << 20 }).toString('utf8').split(/\r?\n/)

function headerFor(name: string, parsed: ParsedList, tpl: Template): Record<string, string> {
  if (tpl === 'A_anfrage') return clean({ ...parsed.source?.header, project: parsed.project, projectLabel: parsed.projectLabel, lvLabel: parsed.title })
  if (tpl === 'C_angebot') {
    const L = layout('Angebot AN24-0305.pdf')
    const find = (re: RegExp) => L.map((l) => l.match(re)?.[1]?.trim()).find(Boolean)
    const bv = L.findIndex((l) => /^\s*Bauvorhaben:/.test(l))
    return clean({
      bauvorhaben: bv >= 0 ? L[bv].replace(/^\s*Bauvorhaben:\s*/, '').trim() : undefined,
      bauvorhaben2: bv >= 0 ? L[bv + 1]?.trim() : undefined,
      angebotNr: find(/Angebot-Nr\.:\s+(\S+)/),
      datum: find(/Datum:\s+(\d{1,2}\.\d{1,2}\.\d{4})/),
      kundenNr: find(/Kunden-Nr\.:\s+(\S+)/),
      firm: L.map((l) => l.trim()).find((l) => /^\[FIRMA_\d+\] \|/.test(l))?.replace(/\s{2,}.*$/, ''),
    })
  }
  if (tpl === 'D_lv_ausdruck') {
    const L = layout('LV-Ausdruck-[PROJEKT_004].pdf', 2)
    const find = (re: RegExp) => L.map((l) => l.match(re)?.[1]?.trim()).find(Boolean)
    return clean({
      office: L[0]?.trim(),
      title: L.map((l) => l.trim()).find((l) => /^Leistungsverzeichnis \d+/.test(l)),
      projekt: find(/^Projekt:\s+(\S.*?)\s{2,}Seite/),
      bauherr: find(/^Bauherr:\s+(.*?)\s+Datum/),
      dvNrAg: find(/^DV-Nr\. AG:\s+(\S+)/),
      datum: find(/Datum\s+(\d{1,2}\.\d{1,2}\.\d{4})/),
    })
  }
  if (tpl === 'E_courier') {
    const L = layout('Leistungsverzeichnis_leer.pdf')
    const find = (re: RegExp) => L.map((l) => l.match(re)?.[1]?.trim()).find(Boolean)
    return clean({
      lvLabel: find(/^LV:\s+(.*?)\s{2,}Seite/),
      datum: find(/^\s*Datum:\s+(\d{1,2}\.\d{1,2}\.\d{4})/),
      lvDatum: find(/LV-Datum:\s+(\d{1,2}\.\d{1,2}\.\d{4})/),
    })
  }
  // B_kurz_langtext
  if (name === 'Angebot AN24-0305.D84' || name === 'LV-Positionen.docx') {
    const L = layout('Leistungsverzeichnis.pdf')
    const pj = L.map((l) => l.match(/^Projekt:\s+(\S+)\s+(.*?)\s{2,}Währung:\s*(\S+)/)).find(Boolean)
    const lv = L.map((l) => l.match(/^LV:\s+(\S+)\s+(.*)$/)).find(Boolean)
    return clean({ project: pj?.[1], projectLabel: pj?.[2], currency: pj?.[3], lv: lv?.[1], lvLabel: lv?.[2]?.trim() })
  }
  return clean({ project: parsed.project, projectLabel: parsed.projectLabel, lvLabel: parsed.title, currency: parsed.currency })
}

const EXT_FORMAT: Record<string, string> = {}

function parseFile(name: string): ParsedList {
  const f = join(DATA, name)
  const ext = name.split('.').pop()!.toLowerCase()
  if (ext.startsWith('x8')) return parseGaebXml(readFileSync(f, 'utf8'))
  if (ext.startsWith('d8')) return parseGaeb90(decodeGaeb90(new Uint8Array(readFileSync(f))))
  if (ext === 'pdf') return parseLvPdfText(pdfText(f))
  throw new Error('unsupported ' + name + EXT_FORMAT[ext])
}

/* ------------------------------------------------------------------ */

rmSync(join(OUT, 'lists'), { recursive: true, force: true }) // data/layout is generated by scripts/pdf-layout.py and kept
rmSync(join(OUT, 'index.json'), { force: true })
mkdirSync(join(OUT, 'lists'), { recursive: true })
mkdirSync(join(OUT, 'layout'), { recursive: true })

const parsedCache = new Map<string, ParsedList>()
const get = (n: string) => {
  if (!parsedCache.has(n)) parsedCache.set(n, parseFile(n))
  return parsedCache.get(n)!
}

const listsMeta: unknown[] = []
const folders: unknown[] = []
const report: string[] = []
const pathReport: string[] = []
const countNodes = (t: { children: unknown[] }[]): number => t.reduce((n, c) => n + 1 + countNodes(c.children as { children: unknown[] }[]), 0)

for (const fd of FOLDERS) {
  const listIds: string[] = []
  for (const name of fd.lists) {
    let parsed: ParsedList
    if (name === 'LV-Positionen.docx') {
      // Aufmaß-Gruppierung: headings + OZ references → positions from the offer
      const offer = get('Angebot AN24-0305.D84')
      const byOz = new Map(offer.positions.map((p) => [p.oz, p]))
      const paras = docxParagraphs(join(DATA, name)).filter(Boolean)
      let heading = 'Allgemein'
      const positions: Position[] = []
      let i = 0
      for (const p of paras) {
        const m = p.match(/^(\d+(?:\.\d+)+)\s+[–-]\s+(.+?)\s*\[([^\]]+)\]$/)
        if (m) {
          const src = byOz.get(m[1])
          positions.push({
            id: `p${i++}`,
            oz: m[1],
            short: m[2],
            long: src?.long,
            qty: src?.qty ?? 0,
            unit: src?.unit || m[3].replace(/\.$/, ''),
            up: src?.up ?? null,
            category: heading,
            group: heading,
          })
        } else if (!/^(…|oder|mit)$/.test(p)) {
          heading = p
        }
      }
      const tree = flatTree(positions)
      parsed = { format: 'Word · Aufmaß-Gruppierung', phase: 'Aufmaß', currency: 'EUR', title: 'LV-Positionen nach Aufmaß-Gruppen', positions, tree, source: { kind: 'docx' } }
    } else {
      parsed = get(name)
    }

    // Enrich Angebot positions with short texts from the docx grouping
    if (name === 'Angebot AN24-0305.D84') {
      const paras = docxParagraphs(join(DATA, 'LV-Positionen.docx'))
      const shortByOz = new Map<string, string>()
      for (const p of paras) {
        const m = p.match(/^(\d+(?:\.\d+)+)\s+[–-]\s+(.+?)\s*\[/)
        if (m) shortByOz.set(m[1], m[2])
      }
      // first long-text line is the short text in this export
      const pdfTexts = offerPdfTexts(join(DATA, 'Angebot AN24-0305.pdf'))
      let missing = 0
      const offerLayout: Record<string, { lines: { t: string; s: 1 }[] }> = {}
      let changed = 0
      parsed.positions = parsed.positions.map((p) => {
        let short = shortByOz.get(p.oz) ?? p.short
        let long = p.long
        const lines = pdfTexts.get(p.oz)
        if (lines?.length) {
          // the offer printout carries exactly this text per position: keep all of its lines
          const joined = lines.join(' ').replace(/\s+/g, ' ').trim()
          if (joined !== short) changed++
          short = joined
          offerLayout[p.oz] = { lines: lines.map((t) => ({ t, s: 1 as const })) }
        }
        if (!short) short = firstLine(p.long ?? '') || ''
        if (!short) missing++
        return { ...p, short: short || '(ohne Kurztext)', long }
      })
      writeFileSync(join(OUT, 'layout', 'angebot-an24-0305-d84.json'), JSON.stringify({ positions: offerLayout }))
      console.log(`Angebot AN24-0305: ${changed} short texts taken from the PDF printout`)
      console.log(`Angebot AN24-0305: ${missing} of ${parsed.positions.length} positions still without text`)
      parsed.title = 'Angebot AN24-0305'
      // the D84 carries no category records → rebuild Bereich/Abschnitt tree from the Kurz-/Langtext LV printout
      const labels = new Map<string, string>()
      for (const l of layout('Leistungsverzeichnis.pdf', 9999)) {
        const m = l.match(/^\s*(\d+(?:\.\d+)?)\.\s{2,}(\S.*?)\s*$/)
        if (m && !labels.has(m[1]) && !/\.{3,}/.test(m[2])) labels.set(m[1], m[2])
      }
      const tree: CategoryNode[] = []
      const nodes = new Map<string, CategoryNode>()
      const ensure = (oz: string, parent?: CategoryNode) => {
        let n = nodes.get(oz)
        if (!n) {
          n = newNode(oz, labels.get(oz) ?? (parent ? `Abschnitt ${oz}` : `Bereich ${oz}`))
          nodes.set(oz, n)
          ;(parent ? parent.children : tree).push(n)
        }
        return n
      }
      parsed.positions = parsed.positions.map((p) => {
        const parts = p.oz.split('.')
        const path: { oz: string; label: string }[] = []
        if (parts.length >= 2) {
          const c1 = ensure(parts[0])
          path.push({ oz: c1.oz, label: c1.label })
          if (parts.length >= 3) {
            const c2 = ensure(`${parts[0]}.${parts[1]}`, c1)
            path.push({ oz: c2.oz, label: c2.label })
          }
        }
        const leaf = path[path.length - 1]
        return { ...p, path, category: leaf?.label ?? p.category, group: path[0]?.label ?? p.group }
      })
      parsed.tree = tree
    }
    // Price-only D84: borrow texts/quantities from its D86 sibling
    if (name === 'StBALV23040.D84') {
      const d86 = get('StBALV23040.D86')
      const byOz = new Map(d86.positions.map((p) => [p.oz, p]))
      parsed.positions = parsed.positions.map((p) => {
        const s = byOz.get(p.oz)
        return s ? { ...p, short: s.short, long: s.long, unit: s.unit, qty: p.qty || s.qty, category: s.category, group: s.group, path: s.path } : p
      })
      parsed.title = parsed.title || d86.title
      parsed.tree = d86.tree
    }

    {
      const tpl: Template = name.startsWith('LV_') && name.endsWith('.pdf') ? 'A_anfrage' : (TEMPLATE[name] ?? 'B_kurz_langtext')
      const src: SourceInfo = parsed.source ?? { kind: 'json' }
      parsed.source = { ...src, pdfTemplate: tpl, header: headerFor(name, { ...parsed, source: src }, tpl) }
    }

    const id = slug(name.replace(/\.[^.]+$/, '')) + '-' + name.split('.').pop()!.toLowerCase()
    const total = parsed.positions.reduce((s, p) => s + positionTotal(p), 0)
    const priced = parsed.positions.filter((p) => p.up != null && p.up > 0).length
    const categories = [...new Set(parsed.positions.map((p) => p.category))]
    const meta = {
      id,
      folderId: fd.id,
      fileName: name,
      file: `files/${encodeURIComponent(name)}`,
      title: parsed.title || name,
      format: parsed.format,
      phase: parsed.phase,
      project: parsed.project,
      projectLabel: parsed.projectLabel,
      date: parsed.date,
      currency: parsed.currency,
      positionsCount: parsed.positions.length,
      pricedCount: priced,
      total: Math.round(total * 100) / 100,
      categories: categories.length,
      pages: name.endsWith('.pdf') ? pdfPages(join(DATA, name)) : undefined,
    }
    listsMeta.push(meta)
    listIds.push(id)
    writeFileSync(join(OUT, 'lists', `${id}.json`), JSON.stringify({ ...meta, notes: parsed.notes, positions: parsed.positions, tree: parsed.tree, source: parsed.source }))
    {
      const withCats = (parsed.tree?.length ?? 0) > 0
      const noPath = parsed.positions.filter((p) => !p.path?.length).length
      const noRef = parsed.positions.filter((p) => !p.srcRef).length
      if (withCats && noPath) console.warn(`PATH CHECK ${name}: ${noPath} of ${parsed.positions.length} positions without path`)
      pathReport.push(`${name.padEnd(46)} cats=${String(countNodes(parsed.tree ?? [])).padStart(3)} noPath=${noPath} noSrcRef=${noRef} tpl=${parsed.source?.pdfTemplate}`)
    }
    report.push(`${name.padEnd(48)} ${String(parsed.positions.length).padStart(4)} pos  ${String(priced).padStart(4)} priced  ${total.toFixed(2).padStart(14)} ${parsed.currency}  "${meta.title}"`)
  }

  const documents = fd.documents.map((name) => {
    const f = join(DATA, name)
    const text = pdfText(f, false)
    const excerpt = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && !/^\[(BILD|FIRMA|ADRESSE|TELEFON|EMAIL)/.test(l)).slice(0, 14).join('\n')
    const id = slug(name)
    const listId = companionLists[id]
    if (!listIds.includes(listId)) throw new Error(`Missing list association for ${name}`)
    return { id, listId, name, file: `files/${encodeURIComponent(name)}`, pages: pdfPages(f), excerpt }
  })

  folders.push({ id: fd.id, name: fd.name, description: fd.description, icon: fd.icon, tone: fd.tone, lists: listIds, documents })
}

// sanity: every data file is used
const used = new Set(FOLDERS.flatMap((f) => [...f.lists, ...f.documents]))
const all = readdirSync(DATA).filter((name) => !name.startsWith('.'))
const unused = all.filter((f) => !used.has(f))
if (unused.length) console.warn('UNUSED data files:', unused)

writeFileSync(join(OUT, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), folders, lists: listsMeta }, null, 1))
console.log(report.join('\n'))
console.log('\nPath check:\n' + pathReport.join('\n'))
console.log(`\n${listsMeta.length} lists, ${folders.length} folders → ${OUT}`)
if (!existsSync(join(OUT, 'index.json'))) process.exit(1)
