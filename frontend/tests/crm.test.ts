import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAILTO_LIMIT, duration, groupBySupplier, requestItems, rfqEml, rfqFileName, rfqMailto, rfqSubject, rfqText,
  type Sourcing, type SourcingSupplier,
} from '../src/lib/crm'
import type { Position } from '../src/lib/types'

const pos = (id: string, short: string, qty = 10, unit = 'm'): Position => ({ id, oz: `01.${id}`, short, qty, unit, up: 0, category: '' }) as Position

const supplier = (id: string, name: string, category_ids: string[], email: string | null = `${id}@example.com`): SourcingSupplier => ({
  id, name, contact_name: null, email, phone: null, category_ids, explicit_category_ids: [], product_count: 0, requested_at: null, answered: false,
})

const sourcing = (assign: Record<string, string | null>, suppliers: SourcingSupplier[]): Pick<Sourcing, 'positions' | 'suppliers' | 'categories'> => ({
  categories: [{ id: 'pipe', name: 'Rohre' }, { id: 'concrete', name: 'Beton' }, { id: 'steel', name: 'Stahl' }],
  positions: Object.entries(assign).map(([id, category_id]) => ({ id, category_id, category: null, source: category_id ? 'ai' : null, confidence: null, reason: null, product: null })),
  suppliers,
})

test('groupBySupplier gives each supplier one group with all positions of its categories', () => {
  const positions = [pos('1', 'PP-Rohr DN 110'), pos('2', 'Beton C25/30'), pos('3', 'KG-Rohr DN 150'), pos('4', 'Baustahl'), pos('5', 'Unklar')]
  const view = sourcing({ 1: 'pipe', 2: 'concrete', 3: 'pipe', 4: 'steel', 5: null }, [
    supplier('a', 'Rohrhandel', ['pipe']),
    supplier('b', 'Baustoffe Müller', ['pipe', 'concrete']),
    supplier('c', 'Holz', ['wood']),
  ])
  const { groups, uncovered, uncategorized } = groupBySupplier(positions, view)
  assert.deepEqual(groups.map((g) => g.supplier.id), ['b', 'a'], 'largest group first, suppliers without matching categories left out')
  assert.deepEqual(groups[0].positions.map((p) => p.id), ['1', '2', '3'], 'positions keep bill order')
  assert.deepEqual(groups[0].categories.map((c) => c.name), ['Rohre', 'Beton'])
  assert.deepEqual(groups[1].positions.map((p) => p.id), ['1', '3'])
  assert.deepEqual(uncovered.map((p) => p.id), ['4'], 'steel has no supplier')
  assert.deepEqual(uncategorized.map((p) => p.id), ['5'])
})

test('groupBySupplier breaks ties by name', () => {
  const view = sourcing({ 1: 'pipe' }, [supplier('z', 'Zeller', ['pipe']), supplier('a', 'Ahrens', ['pipe'])])
  assert.deepEqual(groupBySupplier([pos('1', 'Rohr')], view).groups.map((g) => g.supplier.name), ['Ahrens', 'Zeller'])
})

test('rfqText lists every position once with quantity and the due date', () => {
  const text = rfqText({
    salutation: 'Sehr geehrte Damen und Herren,',
    project: 'Kita Sonnenweg',
    positions: [pos('1', 'PP-Rohr DN 110', 120.5), pos('2', 'Beton C25/30', 3, 'm3')],
    dueDate: '2026-12-01',
    sender: 'Mit freundlichen Grüßen\nMax Bau',
  })
  assert.match(text, /^Sehr geehrte Damen und Herren,\n\nfür unser Bauvorhaben „Kita Sonnenweg“ bitten wir Sie um Ihr Angebot für die folgenden 2 Positionen:/)
  assert.match(text, /01\.1 {2}PP-Rohr DN 110 {2}– {2}120,5\d* m\n/)
  assert.match(text, /01\.2 {2}Beton C25\/30 {2}– {2}3(,0+)? m3\n/)
  assert.match(text, /bis zum 01\.12\.2026\./)
  assert.match(text, /Max Bau\n$/)
  assert.equal(rfqSubject('Kita Sonnenweg', 1), 'Preisanfrage: Kita Sonnenweg – 1 Position')
  assert.equal(rfqSubject(' ', 4), 'Preisanfrage: Bauvorhaben – 4 Positionen')
})

test('rfqMailto encodes CRLF line breaks and refuses links that mail clients would cut off', () => {
  const short = rfqMailto('einkauf@rohr.de', 'Preisanfrage', 'Zeile 1\nZeile 2')
  assert.equal(short, 'mailto:einkauf@rohr.de?subject=Preisanfrage&body=Zeile%201%0D%0AZeile%202')
  const long = rfqMailto('einkauf@rohr.de', 'Preisanfrage', 'x'.repeat(MAILTO_LIMIT))
  assert.equal(long, null)
})

test('rfqEml is an unsent plain-text draft with encoded umlauts', () => {
  const eml = rfqEml({ to: 'a@b.de, <evil>\r\nBcc: x@y.z', subject: 'Preisanfrage: Straße', text: 'Grüße\n', date: new Date('2026-11-21T10:00:00Z') })
  const [head, body] = eml.split('\r\n\r\n')
  assert.ok(head.startsWith('X-Unsent: 1\r\n'))
  assert.ok(!/\r\nBcc:/i.test(head), 'header injection is flattened into the To line')
  assert.match(head, /^To: a@b\.de/m)
  assert.match(head, /^Subject: =\?UTF-8\?/im)
  assert.match(head, /^Date: Sat, 21 Nov 2026 10:00:00 \+0000$/m)
  assert.match(body, /Gr=C3=BC=C3=9Fe/)
  assert.match(rfqFileName('Baustoffe Müller GmbH', 'Kita Sonnenweg'), /^Preisanfrage_.+_.+\.eml$/)
})

test('requestItems keeps what the log needs and drops broken quantities', () => {
  const items = requestItems([pos('1', 'Rohr', Number.NaN)], () => 'Rohre')
  assert.deepEqual(items, [{ position_id: '1', oz: '01.1', short: 'Rohr', qty: undefined, unit: 'm', category: 'Rohre' }])
})

test('duration reads in hours, then days', () => {
  assert.equal(duration(null), '–')
  assert.equal(duration(0.4), '< 1 h')
  assert.equal(duration(30), '30 h')
  assert.equal(duration(60), '2,5 d')
})
