// Hill-climbing harness: renders our screens and the reference code.html at the
// same 1280x1024 @2x viewport and writes side-by-side PNG pairs to tests/compare/.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT = resolve('tests/compare')
mkdirSync(OUT, { recursive: true })
const DESIGN = resolve('../design')
const base = 'http://localhost:5173'
const only = process.argv[2]

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1024 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(e.message))

async function shot(name, url, prep) {
  if (only && !name.includes(only)) return
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  if (prep) await prep(page)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

// clean state
await page.goto(base)
await page.evaluate(() => localStorage.clear())

await shot('a-projects-ours', `${base}/`)
await shot('b-list-ours', `${base}/list/ort-024-lv24069-d86`)
await shot('c-empty-ours', `${base}/`, async (p) => {
  await p.getByRole('button', { name: /new folder/i }).first().click()
  await p.getByRole('dialog').locator('input').first().fill('Legal & Compliance')
  await p.getByRole('dialog').getByRole('button', { name: /create/i }).click()
  await p.waitForTimeout(400)
})
await shot('d-folder-ours', `${base}/folder/fernleitung-2024-001`)
for (const [n, d] of [['a-projects-ref', 'file_explorer_folders_lists_streamlined_header'], ['b-list-ref', 'budget_list_detail_cost_limit_meter'], ['c-empty-ref', 'empty_folder_import_files_light_mode']]) {
  await shot(n, 'file:///' + `${DESIGN}/${d}/code.html`.replace(/\\/g, '/'))
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors')
await browser.close()
