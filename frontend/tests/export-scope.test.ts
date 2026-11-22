import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unzipSync, strFromU8 } from 'fflate'
import { exportList } from '../src/lib/export/index'
import { parseGaebXml } from '../src/lib/gaeb'
import { readPdfPayload } from '../src/lib/import-documents'
import { DOCX_LIST_PART } from '../src/lib/list-file'
import { sumPositionTotals } from '../src/lib/money'
import type { ListDoc } from '../src/lib/types'

const written = '<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA86/3.2"><Award><DP>86</DP><BoQ><BoQBody>'
  + '<BoQCtgy RNoPart="01"><LblTx><p>Base</p></LblTx><BoQBody><Itemlist>'
  + '<Item ID="one" RNoPart="0010"><Provis>WithoutTotal</Provis><Qty>2</Qty><QU>m</QU><UP>123.45</UP><IT>246.90</IT></Item>'
  + '<Item ID="two" RNoPart="0020"><LumpSumItem>Yes</LumpSumItem><Qty>2</Qty><QU>psch</QU><UP>50</UP></Item>'
  + '</Itemlist></BoQBody></BoQCtgy>'
  + '<BoQCtgy RNoPart="02"><LblTx><p>Alternative</p></LblTx><ALNBGroupNo>1</ALNBGroupNo><ALNBSerNo>1</ALNBSerNo><BoQBody><Itemlist>'
  + '<Item ID="three" RNoPart="0010"><Qty>5</Qty><QU>m</QU><UP>100</UP></Item>'
  + '</Itemlist></BoQBody></BoQCtgy></BoQBody></BoQ></Award></GAEB>'

const list = (xml: string, fileName: string): ListDoc => {
  const parsed = parseGaebXml(xml)
  return { ...parsed, fileName, title: 'Fixture', id: 'fixture', folderId: 'folder', positionsCount: parsed.positions.length,
    pricedCount: 3, total: 796.9, categories: 2 }
}

test('phase-83 exports remove written prices and preserve optional and alternative scope', async () => {
  for (const [originalPhase, fileName] of [['86', 'fixture.X86'], ['83', 'fixture.X83']]) {
    const xml = written.replace('DA86', 'DA' + originalPhase).replace('<DP>86</DP>', '<DP>' + originalPhase + '</DP>')
    const doc = list(xml, fileName)
    const resolved = { positions: doc.positions, tree: doc.tree ?? [] }
    assert.equal(sumPositionTotals(doc.positions), 50)
    for (const scope of ['all', 'selection'] as const) {
      const output = await exportList({ doc, resolved, format: 'x83', scope,
        selectedIds: doc.positions.map(({ id }) => id), loadOriginal: async () => new TextEncoder().encode(xml) })
      const contents = new TextDecoder().decode(output.data)
      assert.match(output.fileName, /\.X83$/i)
      assert.equal(parseGaebXml(contents).phase, 'X83')
      assert.doesNotMatch(contents, /<(UP|IT)>/)
      assert.match(contents, /<Provis>WithoutTotal<\/Provis>/)
      assert.match(contents, /<ALNBSerNo>1<\/ALNBSerNo>/)
    }
  }
})

test('price-free JSON, PDF and Word strip written prices from legacy workspace rows', async () => {
  const doc = list(written, 'fixture.X86')
  doc.positions = doc.positions.map(p => ({ ...p, sourceFacts: { unitPriceRaw: '123,45', amount: 246.9 } }))
  const resolved = { positions: doc.positions, tree: doc.tree ?? [] }
  for (const format of ['json', 'pdf', 'docx'] as const) {
    const output = await exportList({ doc, resolved, format, prices: false })
    const bytes = Uint8Array.from(output.data)
    const payload = format === 'pdf' ? await readPdfPayload(new File([bytes], output.fileName))
      : format === 'docx' ? strFromU8(unzipSync(bytes)[DOCX_LIST_PART]) : new TextDecoder().decode(bytes)
    assert.ok(payload)
    assert.doesNotMatch(payload, /sourceFacts|123[,.]45|246\.9/)
  }
})
