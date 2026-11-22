import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.TEST_BASE_URL ?? 'http://localhost:5173'
const channel = process.env.TEST_BROWSER_CHANNEL
const browser = await chromium.launch(channel ? { channel } : {})
const page = await browser.newPage()
page.setDefaultTimeout(8000)
const errors = []
page.on('pageerror', error => errors.push(error.message))

const id = 'price-confirmation'
const original = { id: 'upload', original: true, listId: id, name: 'prices.json' }
const positions = [
  { id: 'a', oz: '10', short: 'First material', unit: 'm', qty: 2, up: null },
  { id: 'b', oz: '20', short: 'Second material', unit: 'm', qty: 3, up: null },
  { id: 'c', oz: '30', short: 'Review measurement', unit: '', qty: 1, up: null },
]
const collections = {
  userLists: { [id]: {
    id, title: 'Price confirmation', folderId: 'fixtures', fileName: original.name, format: 'JSON',
    source: { kind: 'json' }, userCreated: true, currency: 'EUR', positions,
    total: 0, pricedCount: 0, positionsCount: positions.length, categories: 0,
  } },
  userDocuments: { [original.id]: original },
}
let revision = 1
let catalogueRequests = 0
let lineTypeRequests = 0
await page.route('**/api/workspace/state*', async route => {
  if (route.request().method() === 'POST') {
    for (const [name, change] of Object.entries(route.request().postDataJSON().changes)) {
      collections[name] = { ...collections[name], ...change.set }
      for (const key of change.delete ?? []) delete collections[name][key]
    }
    revision += 1
  }
  await route.fulfill({ json: { revision, collections } })
})
await page.route('**/api/workspace/catalogue?*', route => {
  catalogueRequests += 1
  const product = { id: 'priced-product', name: 'Catalogue material', category: 'Materials' }
  return route.fulfill({ json: {
    state: 'ready',
    positions: Object.fromEntries(positions.map(p => [p.id, { state: 'matched', product, recovered: null, suggestion: null }])),
  } })
})
await page.route('**/api/catalogues/products?*', route => route.fulfill({ json: {
  id: 'priced-product', name: 'Catalogue material', unit: 'm', unit_price: '12.50', currency: 'EUR',
} }))
await page.route('**/api/workspace/line-types', route => {
  lineTypeRequests += 1
  return route.fulfill({ json: { status: 'ready', types: route.request().postDataJSON().lines.map(() => 'material') } })
})
await page.route('**/api/workspace/analysis?*', route => route.fulfill({ json: {
  state: 'ready',
  report: {
    run_id: 'original-check', assessed_revision: 1, target_revision: 1, assessed_edits: null,
    graph_valid: true, findings: [{
      id: 'unit-warning', severity: 'warning', origin: 'rule', rule_id: 'L1.UNIT.TEST',
      title: 'Upload warning', message: 'Review the unit', related_line_ids: [],
      category: 'units', target: { line_id: 'a', line_code: '10', field: 'unit' },
    }],
  },
} }))

const row = pid => page.locator(`tr[data-pid="${pid}"]`)
const search = page.getByRole('searchbox', { name: 'Search positions' })
const totalIs = amount => page.locator('dl').filter({ has: page.getByText('List total', { exact: true }) })
  .getByText(amount, { exact: true }).waitFor()
const syncEdit = async (action, matches) => {
  const synced = page.waitForResponse(response => {
    if (!response.url().includes('/api/workspace/state') || response.request().method() !== 'POST') return false
    const changes = response.request().postDataJSON().changes.edits
    return changes && matches(changes)
  })
  await action()
  await (await synced).finished()
  await page.waitForFunction(expectedRevision => {
    const state = JSON.parse(localStorage.getItem('vaultbudget:v1'))?.state
    return state?.sync?.revision >= expectedRevision
  }, revision)
}

try {
  await page.goto(base + '/list/' + id)
  const all = page.getByRole('button', { name: 'Confirm all prices', exact: true })
  await all.waitFor()
  await page.keyboard.press('e')
  const warning = row('a').getByRole('button', { name: /warning/i })
  await warning.waitFor()
  await totalIs('0,00 €')
  const initialCatalogueRequests = catalogueRequests
  const initialLineTypeRequests = lineTypeRequests
  const confirm = row('a').getByRole('button', { name: /^Confirm .* for 10$/ })
  await syncEdit(() => confirm.click(), changes => changes.set?.[id]?.up?.a === 12.5)
  await totalIs('25,00 €')
  assert.equal(await warning.isVisible(), true)
  const saved = row('a').getByRole('button', { name: /edit unit price/ })
  assert.equal(await saved.evaluate(el => el === document.activeElement), true)

  await syncEdit(() => all.click(), changes => changes.set?.[id]?.up?.b === 12.5)
  await totalIs('62,50 €')
  assert.equal(await search.evaluate(el => el === document.activeElement), true)
  assert.equal(await row('c').getByRole('button', { name: /unit needs checking/ }).isVisible(), true)
  await syncEdit(() => page.getByRole('button', { name: 'Undo', exact: true }).last().click(),
    changes => changes.set?.[id]?.up?.a === 12.5 && !('b' in changes.set[id].up))
  await totalIs('25,00 €')
  await row('b').getByRole('button', { name: /^Confirm .* for 20$/ }).waitFor()
  await row('b').getByRole('button', { name: /Second material/ }).click()
  const shortText = page.getByRole('textbox', { name: 'Kurztext' })
  await shortText.fill('Updated material')
  await syncEdit(() => shortText.press('Enter'), changes => changes.set?.[id]?.patch?.b?.short === 'Updated material')
  await page.getByRole('button', { name: 'Close details' }).click()
  await row('b').getByRole('button', { name: /Set price for 20/ }).waitFor()
  assert.equal(await warning.isVisible(), true)
  assert.equal(catalogueRequests, initialCatalogueRequests)
  assert.equal(lineTypeRequests, initialLineTypeRequests)
  assert.deepEqual(errors, [])
  console.log('Price confirmation, undo, totals, focus, and stable upload results passed.')
} finally {
  await browser.close()
}
