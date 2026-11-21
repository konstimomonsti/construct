import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const out = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
mkdirSync(out, { recursive: true })
const base = 'http://localhost:5173'
const errors = []

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1024 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
page.on('console', (m) => (m.type() === 'error' ? errors.push(`console: ${m.text()}`) : null))
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('requestfailed', (r) => !/fonts\.g/.test(r.url()) && errors.push(`reqfail: ${r.url()}`))

const shot = (n) => page.screenshot({ path: `${out}${n}.png` })

await page.goto(base + '/')
await page.waitForSelector('text=All Projects')
await page.waitForTimeout(900)
await shot('01-all-projects')

// folder
await page.click('text=Maschinentechnik – Anlagenbau')
await page.waitForURL(/folder\//)
await page.waitForTimeout(700)
await shot('02-folder')

// list
await page.goto(base + '/list/ort-024-lv24069-d86')
await page.waitForSelector('table tbody tr')
await page.waitForTimeout(700)
await shot('03-list-top')
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(400)
await shot('04-list-alert')
// preview red tab
await page.click('role=tab[name=/Budget Exceeded/]')
await page.waitForTimeout(400)
await shot('05-list-alert-red')

// edit qty to push over
const row = page.locator('tbody tr').first()
await row.locator('input[aria-label^="Quantity"]').fill('40')
await row.locator('input[aria-label^="Quantity"]').press('Enter')
await page.waitForTimeout(300)
await page.evaluate(() => window.scrollTo(0, 0))
await shot('06-list-edited')

// empty folder via UI
await page.goto(base + '/')
await page.waitForSelector('text=All Projects')
await page.getByRole('button', { name: 'New Folder' }).first().click()
await page.fill('input[placeholder="e.g. Legal & Compliance"]', 'Legal & Compliance')
await page.getByRole('button', { name: 'Create folder' }).click()
await page.waitForURL(/folder\/f-/)
await page.waitForSelector('text=This folder is currently empty')
await page.waitForTimeout(500)
await shot('07-empty-folder')

// import csv via picker
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import Item Lists/ }).click()])
await chooser.setFiles({ name: 'test.csv', mimeType: 'text/csv', buffer: Buffer.from('OZ;Kurztext;Menge;Einheit;EP;Kategorie\n1.1;Aushub;12,5;m3;18,40;Erdarbeiten\n1.2;Beton C25/30;3;m3;145;Beton\n') })
await page.waitForSelector('text=test.csv', { timeout: 5000 })
await page.waitForTimeout(600)
await shot('08-folder-after-import')

// palette
await page.keyboard.press('Control+k')
await page.keyboard.type('Baustelleneinrichtung')
await page.waitForTimeout(1500)
await shot('09-palette')
await page.keyboard.press('Escape')

// other routes
for (const r of ['/active', '/archived', '/trash']) {
  await page.goto(base + r)
  await page.waitForTimeout(600)
  await shot('10' + r.replace('/', '-'))
}

// mobile
await page.setViewportSize({ width: 375, height: 800 })
await page.goto(base + '/')
await page.waitForTimeout(800)
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
console.log('mobile overflow px (home):', overflow)
await shot('11-mobile-home')
await page.goto(base + '/list/ort-024-lv24069-d86')
await page.waitForSelector('table tbody tr')
await page.waitForTimeout(500)
console.log('mobile overflow px (list):', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
await shot('12-mobile-list')

console.log('errors:', errors.length ? errors : 'none')
await browser.close()
