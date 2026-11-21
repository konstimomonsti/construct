// quick GAEB roundtrip checks: npx tsx tests/export-gaeb.ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseGaeb90, parseGaebXml, decodeGaeb90 } from '../src/lib/gaeb.ts'
import { generateGaebXml, patchGaebXml, type XmlVariant } from '../src/lib/export/gaeb-xml.ts'
import { generateGaeb90, patchGaeb90 } from '../src/lib/export/gaeb90.ts'
import { normOz } from '../src/lib/export/util.ts'
import { dosFold } from '../src/lib/export/gaeb90.ts'
const ws = (t: string) => t.replace(/\s+/g, ' ').trim()
const fold = (t: string) => ws(dosFold(t))
import type { ListDoc } from '../src/lib/types.ts'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const lists = readdirSync(join(root, 'public/data/lists')).map((f) => JSON.parse(readFileSync(join(root, 'public/data/lists', f), 'utf8')) as ListDoc)
const gaeb = lists.filter((d) => /\.(x83|d83|d84|d86)$/i.test(d.fileName))

let bad = 0
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    bad++
    console.log('  FAIL', msg)
  }
}

for (const d of gaeb) {
  const orig = new Uint8Array(readFileSync(join(root, 'public/files', d.fileName)))
  console.log(d.fileName, d.positions.length)
  const dxml = (v: XmlVariant) => generateGaebXml({ doc: d, positions: d.positions, variant: v, longTexts: true, prices: false, now: new Date('2026-01-01T10:00:00Z') })
  for (const v of ['3.2', '2004'] as XmlVariant[]) {
    const x = dxml(v)
    const p = parseGaebXml(x)
    check(p.positions.length === d.positions.length, `${v} count ${p.positions.length} vs ${d.positions.length}`)
    let m = 0
    d.positions.forEach((a, i) => {
      const b = p.positions[i]
      if (!b) return
      if (normOz(a.oz) !== normOz(b.oz) || ws(a.short) !== ws(b.short) || Math.abs(a.qty - b.qty) > 1e-6 || fold(a.unit) !== b.unit) {
        if (m++ < 3) console.log('   diff', i, JSON.stringify([a.oz, a.short, a.qty, a.unit]), JSON.stringify([b.oz, b.short, b.qty, b.unit]))
      }
    })
    check(m === 0, `${v} mismatches ${m}`)
  }
  for (const ph of ['83', '84', '86'] as const) {
    const bytes = generateGaeb90({ doc: d, positions: d.positions, phase: ph, longTexts: true, prices: true, now: new Date() })
    const p = parseGaeb90(decodeGaeb90(bytes))
    check(p.positions.length === d.positions.length, `D${ph} count ${p.positions.length} vs ${d.positions.length}`)
    let m = 0
    d.positions.forEach((a, i) => {
      const b = p.positions[i]
      if (!b) return
      const upBad = ph !== '83' && a.up != null && a.qty > 0 && Math.abs((a.up ?? 0) - (b.up ?? -1)) > 0.006
      if (normOz(a.oz) !== normOz(b.oz) || fold(a.short) !== b.short || Math.abs(a.qty - b.qty) > 1e-6 || fold(a.unit) !== b.unit || upBad) {
        if (m++ < 3) console.log('   diff', i, JSON.stringify([a.oz, a.short, a.qty, a.unit, a.up]), JSON.stringify([b.oz, b.short, b.qty, b.unit, b.up]))
      }
    })
    check(m === 0, `D${ph} mismatches ${m}`)
  }
  void orig
  void patchGaebXml
  void patchGaeb90
}
console.log(bad ? `${bad} failures` : 'OK')
