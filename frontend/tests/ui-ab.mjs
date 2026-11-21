// Captures every screen for the UI A/B review.
// usage: node tests/ui-ab.mjs <outDir> [baseUrl]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const out = process.argv[2] ?? 'tests/shots/ab'
const base = process.argv[3] ?? 'http://localhost:5173'
mkdirSync(out, { recursive: true })
const errors = []

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => (m.type() === 'error' && !/Failed to load resource|api\/workspace/.test(m.text()) ? errors.push(`console: ${m.text()}`) : null))

const settle = (ms = 700) => page.waitForTimeout(ms)
const shot = async (n, full = false) => {
  await page.screenshot({ path: `${out}/${n}.png`, fullPage: full })
  console.log('shot', n)
}
const step = async (name, fn) => {
  try { await fn() } catch (e) { console.log(`skip ${name}: ${e.message.split('\n')[0]}`) }
}

await page.goto(base + '/')
await page.waitForSelector('main a[href^="/folder/"]')
await settle(1200)
await shot('01-all-projects')

await step('folder', async () => {
  await page.goto(base + '/')
  await page.locator('main a[href^="/folder/"]').first().click()
  await page.waitForURL(/folder\//)
  await page.waitForSelector('main a[href^="/list/"]')
  await settle()
  await shot('02-folder')
})

await step('list', async () => {
  await page.goto(base + '/list/ort-024-lv24069-d86')
  await page.waitForSelector('table tbody tr')
  await settle()
  await shot('03-list')
  await shot('04-list-full', true)
})

await step('drawer', async () => {
  await page.locator('[data-open-detail], [title="Show full description"]').first().click()
  await settle()
  await shot('05-list-detail-drawer')
  await page.keyboard.press('Escape')
})

await step('active', async () => {
  await page.goto(base + '/active')
  await settle(900)
  await shot('06-active-budgets')
})
await step('archived', async () => { await page.goto(base + '/archived'); await settle(900); await shot('07-archived') })
await step('trash', async () => { await page.goto(base + '/trash'); await settle(900); await shot('08-trash') })

await step('palette', async () => {
  await page.goto(base + '/')
  await page.waitForSelector('main a[href^="/folder/"]')
  await page.keyboard.press('Control+k')
  await settle(300)
  await page.keyboard.type('Beton')
  await settle(1500)
  await shot('09-command-palette')
  await page.keyboard.press('Escape')
})

// phone shots run in their own fresh context so earlier steps can't leak state into them
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
{
const page = await mctx.newPage()
page.on('pageerror', (e) => errors.push(`pageerror (mobile): ${e.message}`))
const settle = (ms = 700) => page.waitForTimeout(ms)
const shot = async (n, full = false) => {
  await page.screenshot({ path: `${out}/${n}.png`, fullPage: full })
  console.log('shot', n)
}
await step('mobile home', async () => {
  await page.goto(base + '/')
  await page.waitForSelector('main a[href^="/folder/"]')
  await settle(900)
  console.log('mobile overflow px (home):', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
  await shot('11-mobile-home')
})
await step('mobile list', async () => {
  await page.goto(base + '/list/ort-024-lv24069-d86')
  await page.waitForSelector('table tbody tr, main [data-row]')
  await settle(900)
  console.log('mobile overflow px (list):', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
  await shot('12-mobile-list')
})

}

await step('empty folder', async () => {
  await page.goto(base + '/')
  await page.waitForSelector('main a[href^="/folder/"]')
  await page.getByRole('button', { name: /New (Folder|project)/i }).first().click()
  await page.locator('[role="dialog"] input').first().fill('Legal & Compliance')
  await page.locator('[role="dialog"] input').first().press('Enter')
  await page.waitForURL(/folder\/f-/)
  await settle(900)
  await shot('10-empty-folder')
})

console.log('errors:', errors.length ? errors : 'none')
await browser.close()
