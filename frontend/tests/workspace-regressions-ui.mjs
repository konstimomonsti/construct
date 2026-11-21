import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.TEST_BASE_URL ?? 'http://localhost:5173'
const browser = await chromium.launch(process.env.TEST_BROWSER_CHANNEL ? { channel: process.env.TEST_BROWSER_CHANNEL } : {})
const httpCredentials = process.env.TEST_HTTP_USER
  ? { username: process.env.TEST_HTTP_USER, password: process.env.TEST_HTTP_PASSWORD ?? '' }
  : undefined
const context = await browser.newContext({ httpCredentials, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(8000)

const bundledList = 'gaeb-projekt-004-x83'
const bundledFolder = 'ringschluss-brunnenwasser'
const fixtureId = 'u-export-search-regression'
const fixture = {
  id: fixtureId, title: 'Export scope regression', folderId: 'qa', userCreated: true,
  fileName: 'fixture.json', format: 'JSON', currency: 'EUR', total: 12, pricedCount: 2,
  positionsCount: 2, categories: 1,
  positions: [
    { id: 'wall', oz: '1.1', short: 'Retaining wall', qty: 1, unit: 'St', up: 5 },
    { id: 'roof', oz: '1.2', short: 'Roof tiles', qty: 1, unit: 'St', up: 7 },
  ],
}

const manifest = await context.request.get(base + '/data/index.json')
assert(manifest.ok())
const { lists } = await manifest.json()
const inherited = lists.find((list) => list.folderId === bundledFolder)
assert(inherited && inherited.id !== bundledList)

let ready
const delayed = new Promise((resolve) => { ready = resolve })
let requested
const started = new Promise((resolve) => { requested = resolve })
await context.route('**/api/workspace/state*', async (route) => {
  requested()
  await delayed
  await route.fulfill({ json: {
    revision: 1,
    collections: {
      userLists: { [fixtureId]: fixture },
      listPatch: { [bundledList]: { trashedAt: 'purged' } },
      folderPatch: { [bundledFolder]: { trashedAt: 'purged' } },
    },
  } })
})

try {
  const listRequests = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/data/lists/')) listRequests.push(url)
  })
  await page.goto(base + '/list/' + bundledList)
  await started
  await page.locator('main').waitFor()
  assert.deepEqual(listRequests, [])
  ready()
  for (const id of [bundledList, inherited.id]) {
    if (id !== bundledList) await page.goto(base + '/list/' + id)
    await page.getByRole('heading', { name: 'List not found' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Restore', exact: true }).count(), 0)
  }
  assert.deepEqual(listRequests, [])

  await page.goto(base + '/settings')
  const theme = page.getByLabel('Theme')
  await theme.selectOption('dark')
  await page.reload()
  assert.equal(await theme.inputValue(), 'dark')
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')

  await page.goto(base + '/list/' + fixtureId)
  const search = page.getByRole('searchbox', { name: 'Search positions' })
  await search.fill('Retaining wall')
  const exportButton = page.getByRole('button', { name: /^Export(?: \d+)?$/ })
  await exportButton.click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Table (CSV)', exact: true }).click(),
  ])
  const csv = await readFile(await download.path(), 'utf8')
  assert.match(csv, /Retaining wall/)
  assert.doesNotMatch(csv, /Roof tiles/)

  await search.fill('No matching position')
  await exportButton.click()
  assert.equal(await page.getByRole('menuitem', { name: 'Table (CSV)', exact: true }).isDisabled(), true)
  console.log('Purged list routes, theme reload, and search-scoped CSV export passed.')
} finally {
  ready()
  await browser.close()
}
