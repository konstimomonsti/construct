import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.TEST_BASE_URL ?? 'http://localhost:5173'
const browser = await chromium.launch(process.env.TEST_BROWSER_CHANNEL ? { channel: process.env.TEST_BROWSER_CHANNEL } : {})
const context = await browser.newContext({ acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(8000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await context.route('**/api/workspace/**', (route) => route.fulfill({ status: 200, json: { revision: 0, collections: {} } }))

const button = (name, scope = page) => scope.getByRole('button', { name, exact: true })
const dialog = (name) => page.getByRole('dialog', { name, exact: true })
const importFromHeader = async (files) => {
  const chooser = page.waitForEvent('filechooser')
  await button('Import', page.getByRole('banner')).click()
  await (await chooser).setFiles(files)
}
const createFolder = async (name, subfolder = false) => {
  await (subfolder ? button('New Subfolder', page.getByRole('banner')) : button('New Folder')).click()
  const modal = dialog(subfolder ? 'Create Subfolder' : 'New Folder')
  await modal.locator('input[data-autofocus]').fill(name)
  await button('Create folder', modal).click()
  await page.waitForURL('**/folder/*')
  return page.url()
}
const moveDialog = async (name) => {
  await button(`Options for ${name}`).click()
  await page.getByRole('menuitem', { name: 'Move…', exact: true }).click()
  return dialog('Move to folder')
}
const move = async (modal, label) => {
  await modal.locator('select').selectOption({ label })
  await button('Move', modal).click()
  await modal.waitFor({ state: 'hidden' })
}
const openList = async (name) => {
  const card = page.getByRole('region', { name: 'Lists' }).getByRole('link', { name: new RegExp(name) })
  await card.click()
  await page.waitForURL('**/list/*')
}
const listFile = (fileName, data) => ({ name: fileName, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) })

try {
  await page.goto(base)
  const site = await createFolder('Site')
  await page.goto(base)
  const staging = await createFolder('Staging')
  const bathroom = await createFolder('Bathroom', true)
  await createFolder('Flooring', true)
  await page.goto(bathroom)
  const folderMove = await moveDialog('Bathroom')
  assert(!(await folderMove.locator('option').allTextContents()).some((option) => /Bathroom|Flooring/.test(option)))
  await move(folderMove, 'Site')
  await page.reload()
  await page.getByRole('link', { name: 'Site', exact: true }).waitFor()

  const rootMove = await moveDialog('Bathroom')
  await move(rootMove, 'Workspace (top level)')
  await page.goto(base)
  await page.getByRole('link', { name: /^Bathroom,/ }).waitFor()

  await page.goto(staging)
  const bathroomPath = [{ oz: '01', label: 'Bathroom' }]
  const floorPath = [...bathroomPath, { oz: '01.01', label: 'Floor' }]
  const original = listFile('estimate.json', {
    title: 'Estimate',
    positions: [
      { id: 'shower', oz: '01.0010', short: 'Shower', long: 'First line\nSecond line', qty: 2, unit: 'St', up: 250, path: bathroomPath },
      { id: 'tile', oz: '01.01.0020', short: 'Tile assembly', qty: 5, unit: 'm²', up: 60, path: floorPath },
    ],
  })
  await importFromHeader(original)
  await openList('Estimate')
  const estimate = page.url()
  const ledger = page.locator('table')
  const mainCategory = button('Bathroom', ledger)
  const subcategory = button('Floor', ledger)
  await mainCategory.click()
  assert.equal(await mainCategory.getAttribute('aria-expanded'), 'false')
  await button('Shower', ledger).waitFor({ state: 'hidden' })
  await subcategory.waitFor({ state: 'hidden' })
  await mainCategory.click()
  await subcategory.click()
  await button('Tile assembly', ledger).waitFor({ state: 'hidden' })
  await button('Shower', ledger).waitFor()
  await subcategory.click()
  await button('Tile assembly', ledger).waitFor()

  const budget = page.getByRole('region', { name: 'Pricing budget' })
  const meter = budget.getByRole('meter')
  const cap = await meter.getAttribute('aria-valuemax')
  await button('Add pricing section').click()
  const section = dialog('Add pricing section')
  await section.getByRole('textbox', { name: 'Section name' }).fill('Installation')
  await button('Add section', section).click()
  await budget.getByRole('listitem').filter({ hasText: 'Installation' }).waitFor()
  await button('Add Item').click()
  const addItem = dialog('Add item')
  await addItem.getByRole('textbox', { name: 'Kurztext' }).fill('Fit the shower')
  await addItem.getByRole('textbox', { name: /Einheitspreis/ }).fill('180')
  await addItem.getByRole('combobox', { name: 'Kategorie' }).selectOption({ label: 'Installation' })
  await button('Add item', addItem).click()
  await button('Fit the shower', ledger).waitFor()
  assert.equal(await meter.getAttribute('aria-valuenow'), '980')
  assert.equal(await meter.getAttribute('aria-valuemax'), cap)
  assert.match(await budget.getByRole('listitem').filter({ hasText: 'Installation' }).innerText(), /€180\.00/)
  assert.notEqual(
    await meter.getByTitle('Bathroom · €800.00').evaluate((element) => element.style.backgroundColor),
    await meter.getByTitle('Installation · €180.00').evaluate((element) => element.style.backgroundColor),
  )
  assert.equal(await page.getByText(/set budget cap|request budget expansion|share with team/i).count(), 0)

  const formats = [
    'Table (CSV)', 'Excel (.xlsx)', 'PDF', 'Word (.docx)', 'JSON',
    'GAEB DA XML 3.2 (.X83)', 'GAEB DA XML 2004 (.x83)', 'GAEB 90 (.D83)',
    'GAEB 90 Angebot (.D84)', 'GAEB 90 Auftrag (.D86)',
  ]
  const exports = []
  for (const [index, format] of formats.entries()) {
    await button('Export').click()
    await page.getByRole('menuitem', { name: 'More formats…' }).click()
    const modal = dialog('Export')
    await modal.getByRole('button').filter({ hasText: format }).click()
    const [download] = await Promise.all([page.waitForEvent('download'), button('Export', modal).click()])
    exports.push({
      name: `roundtrip-${index}.${download.suggestedFilename().split('.').at(-1)}`,
      mimeType: 'application/octet-stream',
      buffer: await readFile(await download.path()),
    })
    await modal.waitFor({ state: 'hidden' })
  }
  await move(await moveDialog('Estimate'), 'Site')
  await page.goto(site)
  await page.getByRole('region', { name: 'Lists' }).getByRole('link', { name: /Estimate/ }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Documents' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Open estimate.json', exact: true }).count(), 0)
  await page.goto(estimate)
  await button('Documents (1)').click()
  await page.getByRole('menuitem', { name: 'estimate.json' }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await meter.getAttribute('aria-valuemax'), cap)
  await button('Fit the shower', ledger).waitFor()

  await page.goto(bathroom)
  const tsv = { name: 'estimate.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('OZ\tKurztext\tMenge\tME\tEP\tKategorie\n1\tTile\t2\tSt\t22,50\tBathroom › Floor\n') }
  await importFromHeader([...exports, tsv])
  await page.getByText('Imported 11 lists (31 positions)', { exact: false }).first().waitFor({ timeout: 30_000 })
  assert.equal(await page.getByText(/Could not read:/).count(), 0)
  const cards = page.getByRole('region', { name: 'Lists' })
  for (const file of exports) await cards.getByText(file.name, { exact: true }).waitFor()
  await cards.getByText('estimate.tsv', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('Folder and list moves, category toggles, fixed pricing, and 11 import formats passed.')
} finally {
  await browser.close()
}
