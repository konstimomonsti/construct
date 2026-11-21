import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.TEST_BASE_URL ?? 'http://localhost:5173'
const browser = await chromium.launch(process.env.TEST_BROWSER_CHANNEL ? { channel: process.env.TEST_BROWSER_CHANNEL } : {})
const id = 'gaeb-projekt-004-x83'
const row = (id, oz, short, qty, up, path) => ({ id, oz, short, qty, up, unit: 'St', category: path?.at(-1)?.label ?? 'Import', path })
const plumbing = { oz: '02', label: 'Plumbing' }
const pipes = { oz: '02.03', label: 'Pipes' }
const positions = [
  row('roof', '10.01.0010', 'Roof', 1, 40),
  row('pipe', '02.03.0020', 'Pipe', 2, 10, [plumbing, pipes]),
  row('fitting', '2.3.0010A', 'Fitting', 1, 15, [plumbing, pipes]),
  row('visit', 'REF-1', 'Site visit', 1, 5),
]

try {
  for (const named of [false, true]) {
    const page = await browser.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/workspace/**', (route) => route.fulfill({ json: { revision: 0, collections: {} } }))
    await page.route(`**/data/lists/${id}.json`, (route) => route.fulfill({
      json: {
        id, title: 'Number grouping test', folderId: 'test', fileName: 'positions.csv',
        format: 'CSV', currency: 'EUR', total: 80, positionsCount: 4, pricedCount: 4, categories: named ? 2 : 1,
        positions: named ? positions : positions.map((p) => ({ ...p, category: 'Import', path: undefined })),
      },
    }))
    await page.goto(`${base}/list/${id}`)
    const grouping = page.getByRole('combobox', { name: 'Group by' })
    const ledger = page.locator('table')
    const group = (name) => ledger.getByRole('button', { name })
    const shown = () => ledger.locator('tr[data-pid]').evaluateAll((rows) => rows.map((r) => r.dataset.pid))
    const filter = page.getByRole('button', { name: /OZ groups/i })
    assert.equal(await grouping.inputValue(), named ? 'category' : 'oz')

    if (named) {
      await group(/02 Plumbing/).waitFor()
      await grouping.selectOption('oz')
    }
    const section = group(named ? /0?2 · Plumbing/ : /^(02|2) 2 positions/)
    await section.click()
    const subgroup = group(named ? /0?2\.0?3 · Pipes/ : /^(02\.03|2\.3) 2 positions/)
    assert.match(await subgroup.locator('xpath=ancestor::tr').innerText(), /35,00/)
    await subgroup.click()
    assert.deepEqual(await shown(), ['fitting', 'pipe'])

    await filter.click()
    await page.getByRole('button', { name: 'None', exact: true }).click()
    await page.getByRole('treeitem', { name: named ? /0?2 · Plumbing, 2 positions/ : /^(02|2), 2 positions$/ }).click()
    await page.keyboard.press('Escape')
    assert.deepEqual(await shown(), ['fitting', 'pipe'])

    await group('Fitting').click()
    const code = page.getByRole('textbox', { name: 'OZ', exact: true })
    await code.fill('10.01.0030')
    await code.press('Enter')
    await page.getByRole('button', { name: 'Close details' }).click()
    assert.deepEqual(await shown(), ['pipe'])
    assert.match(await group(/^0?2\.0?3(?: · Pipes)?$/).locator('xpath=ancestor::tr').innerText(), /20,00/)

    await grouping.selectOption('category')
    await group(named ? /02 Plumbing/ : /Import/).waitFor()
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('OZ grouping, filters, subtotals and renumbering passed with and without named source categories.')
} finally {
  await browser.close()
}
