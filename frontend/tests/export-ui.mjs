// Browser test: every export format downloads a non-empty file from the list page.
import { chromium } from 'playwright'
import { statSync } from 'node:fs'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1280, height: 1024 }, acceptDownloads: true })
const p = await ctx.newPage()
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()))
const ok = (c, n) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) process.exitCode = 1 }
await p.goto('http://localhost:5173/'); await p.evaluate(() => localStorage.clear())
await p.goto('http://localhost:5173/list/gaeb-projekt-004-x83', { waitUntil: 'networkidle' })
const open = async () => { await p.getByRole('button', { name: /^Export/ }).first().click(); await p.waitForTimeout(250) }
// quick menu
await open()
const items = await p.getByRole('menuitem').allInnerTexts()
console.log('menu:', items.map(s => s.replace(/\s+/g, ' ').trim()).join(' | '))
await p.keyboard.press('Escape')
// dialog: try every format card
await open(); await p.getByRole('menuitem', { name: /More formats/ }).click(); await p.waitForTimeout(300)
const dlg = p.getByRole('dialog')
const cardSel = dlg.locator('button[aria-pressed]')
const cards = await cardSel.count()
ok(cards >= 10, `dialog lists ${cards} formats`)
for (let i = 0; i < cards; i++) {
  const r = cardSel.nth(i)
  const name = (await r.innerText()).split('\n').filter(Boolean).slice(0, 2).join(' ')
  await r.click()
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), dlg.getByRole('button', { name: /^(Export|Download)/ }).last().click()])
  const path = await dl.path(); const size = statSync(path).size
  ok(size > 200, `${name.trim()} -> ${dl.suggestedFilename()} (${size} B)`)
  await p.waitForTimeout(600)
  if (!(await dlg.count())) { await open(); await p.getByRole('menuitem', { name: /More formats/ }).click(); await p.waitForTimeout(300) }
}
// edit then export same format -> "-bearbeitet"
await p.keyboard.press('Escape')
const row = p.locator('tbody tr[data-pid]').first()
await row.getByRole('button', { name: /increase|\+/i }).first().click()
await open()
const [dl2] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.getByRole('menuitem', { name: /original format/ }).click()])
ok(/bearbeitet/.test(dl2.suggestedFilename()), 'edited export filename ' + dl2.suggestedFilename())
ok(errs.length === 0, 'no console errors ' + errs.join(' | '))
await b.close()
// byte-identity through the real UI (fresh state)
{
  const { readFileSync } = await import('node:fs')
  const b2 = await chromium.launch(); const c2 = await b2.newContext({ acceptDownloads: true }); const q = await c2.newPage()
  await q.goto('http://localhost:5173/'); await q.evaluate(() => localStorage.clear())
  for (const [id, file] of [['gaeb-projekt-004-x83', 'GAEB-[PROJEKT_004].X83'], ['stbalv23040-d86', 'StBALV23040.D86'], ['lv-03-malerarbeiten-pdf', 'LV_03_Malerarbeiten.pdf']]) {
    await q.goto('http://localhost:5173/list/' + id, { waitUntil: 'networkidle' })
    await q.getByRole('button', { name: /^Export/ }).first().click(); await q.waitForTimeout(250)
    await q.getByRole('menuitem', { name: /More formats/ }).click(); await q.waitForTimeout(300)
    const [d] = await Promise.all([q.waitForEvent('download', { timeout: 60000 }), q.getByRole('dialog').getByRole('button', { name: /^(Export|Download)/ }).last().click()])
    const same = Buffer.compare(readFileSync(await d.path()), readFileSync('../data/tenders/' + file)) === 0
    ok(same, `UI dialog export of unedited ${file} is byte-identical`)
  }
  await b2.close()
}
