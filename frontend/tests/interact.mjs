import { chromium } from 'playwright'

const base = 'http://localhost:5173'
const errors = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1024 }, acceptDownloads: true })
const page = await ctx.newPage()
page.on('console', (m) => (m.type() === 'error' ? errors.push(`console: ${m.text()}`) : null))
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
const ok = (name, cond) => console.log(cond ? 'PASS' : 'FAIL', name)
const shot = (n) => page.screenshot({ path: new URL(`./shots/${n}.png`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') })

await page.goto(base + '/')
await page.waitForSelector('text=All Projects')

// palette position search
await page.keyboard.press('Control+k')
await page.keyboard.type('Baustelleneinrichtung')
await page.waitForSelector('[role=option] >> text=OZ 1.1.1', { timeout: 8000 })
await shot('20-palette-search')
await page.keyboard.press('ArrowDown')
await page.keyboard.press('Enter')
await page.waitForURL(/\/list\/.*\?pos=/)
await page.waitForTimeout(900)
ok('palette -> list with pos', page.url().includes('pos='))
await shot('21-palette-nav')

// select mode + dock
await page.goto(base + '/')
await page.waitForSelector('text=All Projects')
await page.getByRole('button', { name: 'Select', exact: true }).click()
await page.locator('[role=checkbox]').first().click()
await page.locator('[role=checkbox]').nth(1).click()
await page.waitForTimeout(400)
ok('dock shows 2 selected', await page.getByText('2 folders selected').isVisible())
await shot('22-dock')
await page.getByRole('button', { name: 'Done', exact: true }).click()

// list view toggle
await page.getByRole('button', { name: 'List view' }).click()
await page.waitForTimeout(300)
ok('table in list view', (await page.locator('table').count()) === 1)
await shot('23-list-view')
await page.getByRole('button', { name: 'Grid view' }).click()

// sidebar collapse
await page.getByRole('button', { name: 'Collapse sidebar' }).click()
await page.waitForTimeout(400)
await shot('24-collapsed')
await page.getByRole('button', { name: 'Expand sidebar' }).click()

// folder menu: archive
await page.getByRole('button', { name: /Options for Bachdurchlass/ }).click()
await page.getByRole('menuitem', { name: 'Archive' }).click()
await page.goto(base + '/archived')
await page.waitForTimeout(500)
ok('archived has folder', await page.getByText('Bachdurchlass Neppen').first().isVisible())

// list: price edit, filter, split, add item, drawer
await page.goto(base + '/list/ort-024-lv24069-d86')
await page.waitForSelector('table tbody tr[data-pid]')
await page.locator('tbody tr[data-pid]').first().getByRole('button', { name: /Edit unit price/ }).click()
await page.keyboard.press('Control+a')
await page.keyboard.type('6000,50')
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
ok('price edited', await page.locator('tbody tr[data-pid]').first().getByText('€6,000.50').first().isVisible())
await page.getByLabel('Search positions').fill('Rohrhalter')
await page.waitForTimeout(300)
const n = await page.locator('tbody tr[data-pid]').count()
ok('search filters rows', n > 0 && n < 50)
await page.getByLabel('Search positions').fill('')
await page.getByRole('button', { name: /Filter Categories/ }).click()
await page.getByRole('button', { name: 'None' }).click()
await page.locator('[role=treeitem][data-oz="1.1"]').click()
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
ok('category filter', (await page.locator('tbody tr[data-pid]').count()) < 30)
await shot('25-filtered')
await page.locator('tbody tr[data-pid]').nth(0).getByRole('checkbox').check()
await page.locator('tbody tr[data-pid]').nth(1).getByRole('checkbox').check()
await page.getByRole('button', { name: 'Split List' }).click()
await page.getByTestId('split-run').click()
ok('split toast', await page.getByText(/Moved 2 positions into/).isVisible())
await page.getByRole('button', { name: 'Add Item', exact: true }).click()
await page.getByLabel('Kurztext').fill('Testposition')
await page.getByRole('dialog').getByRole('button', { name: 'Add item' }).click()
await page.waitForTimeout(300)
ok('added toast', await page.getByText(/Added/).first().isVisible())
await page.getByRole('button', { name: 'Review Overages' }).click()
await page.waitForTimeout(600)
await page.keyboard.press('Escape')
// drawer
await page.locator('tbody tr[data-pid]').first().locator('button[title="Show full description"]').click()
await page.waitForTimeout(500)
ok('drawer open', await page.getByRole('dialog').isVisible())
await shot('26-drawer')
await page.keyboard.press('Escape')
// export
const [dl] = await Promise.all([page.waitForEvent('download'), (async () => {
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: /Table \(CSV\)/ }).click()
})()])
ok('csv download', dl.suggestedFilename().endsWith('.csv'))

// folder with docs -> viewer
await page.goto(base + '/folder/maschinentechnik-8209-003')
await page.waitForSelector('text=Documents')
await page.locator('[aria-label^="Open HEM2301"]').click()
await page.waitForTimeout(600)
ok('doc viewer iframe', (await page.locator('iframe').count()) === 1)
await shot('27-doc')
await page.keyboard.press('Escape')

// not found + trash
await page.goto(base + '/nope')
await page.getByText('Page not found').waitFor(); ok('404', true)
await page.goto(base + '/')
await page.getByRole('button', { name: /Options for Tiefbau/ }).click()
await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
await page.goto(base + '/trash')
await page.waitForTimeout(400)
ok('trash row', await page.getByText('Tiefbau und Verlegung').first().isVisible())
await page.getByRole('button', { name: 'Restore' }).first().click()
await shot('28-trash')

console.log('errors:', errors.length ? errors : 'none')
await browser.close()
