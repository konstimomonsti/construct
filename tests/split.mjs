import { chromium } from 'playwright'

const base = 'http://localhost:5173'
const LIST = 'ort-024-lv24069-d86'
const errors = []
let failed = 0
const ok = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(cond ? 'PASS' : 'FAIL', name, extra)
}
const num = (s) => Number(s.replace(/[^\d.-]/g, ''))

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1024 } })
const page = await ctx.newPage()
page.on('console', (m) => (m.type() === 'error' ? errors.push(`console: ${m.text()}`) : null))
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

const doc = await (await fetch(`${base}/data/lists/${LIST}.json`)).json()
const total = (p) => (p.up ?? 0) * p.qty
const origTotal = Math.round(doc.positions.reduce((s, p) => s + total(p), 0) * 100) / 100
const leaf = (p) => p.path[p.path.length - 1].oz
const catPositions = doc.positions.filter((p) => leaf(p) === '1.2')
const extra = doc.positions.find((p) => leaf(p) === '1.1')
const moveTarget = '1.3'
const sib = doc.positions.filter((p) => leaf(p) === moveTarget).map((p) => Number(p.oz.split('.').pop()))
const steps = sib.slice(1).map((v, i) => v - sib[i]).filter((d) => d > 0)
const expectedOz = sib.length ? `1.3.${Math.max(...sib) + (steps.length ? Math.min(...steps) : 10)}` : '1.3.10'
console.log(`source: ${doc.positions.length} positions, total ${origTotal}; 1.2 has ${catPositions.length}; expect ${extra.oz} -> ${expectedOz}`)

/* ---------------- split flow ---------------- */
await page.goto(`${base}/list/${LIST}`)
await page.waitForSelector('table tbody tr')
await page.getByRole('button', { name: 'Split List' }).click()
const dlg = page.getByRole('dialog', { name: 'Split list' })
await dlg.waitFor()
ok('overlay opens', await dlg.isVisible())
await dlg.getByRole('button', { name: 'Expand all' }).click()
await page.screenshot({ path: 'tests/shots/30-split-open.png' })
// sub-category
await dlg.locator('[role=treeitem][data-oz="1.2"]').first().click()
// one extra position from another category
await dlg.locator(`[role=treeitem][data-key="p:${extra.id}"]`).click()
const want = catPositions.length + 1
await page.waitForFunction((n) => document.querySelector('[data-testid=split-count]')?.textContent?.startsWith(String(n)), want)
ok('preview count', (await dlg.getByTestId('split-count').innerText()).startsWith(String(want)), await dlg.getByTestId('split-count').innerText())
ok('two groups in preview', (await dlg.getByTestId('preview-group').count()) === 2)
await page.screenshot({ path: 'tests/shots/31-split-selected.png' })

// move the extra item to another category → renumbered
await dlg.getByRole('button', { name: `Move ${extra.oz} to another category` }).click()
const picker = page.getByRole('dialog', { name: 'Move to category' })
await picker.waitFor()
await picker.locator(`[role=treeitem][data-oz="${moveTarget}"]`).click()
const shown = await picker.getByTestId('renumber-to').first().innerText()
ok('picker shows renumbered OZ', shown === expectedOz, `${shown} vs ${expectedOz}`)
await page.screenshot({ path: 'tests/shots/32-split-move-picker.png' })
await picker.getByRole('button', { name: /^Move 1 position/ }).click()
await page.getByTestId('new-oz').waitFor()
ok('preview shows new OZ', (await page.getByTestId('new-oz').first().innerText()) === expectedOz)
await page.screenshot({ path: 'tests/shots/33-split-moved.png' })

// split (move mode)
await dlg.getByLabel('New list name').fill('Test Teil')
await dlg.getByTestId('split-run').click()
await page.waitForURL(/\/list\/u-/)
await page.waitForSelector('table tbody tr')
await page.waitForTimeout(500)
const rowsNew = await page.locator('tbody tr').count()
ok('new list has the selected positions', rowsNew === want, `${rowsNew} rows`)
const newFooter = await page.getByText(/Total €/).first().innerText()
const newTotal = num(newFooter.match(/Total (€[\d,.]+)/)[1])
ok('new list shows moved item with new OZ', (await page.locator(`tbody tr:has-text("OZ: ${expectedOz}")`).count()) === 1)
await page.screenshot({ path: 'tests/shots/34-split-result.png' })

// source list lost them
await page.goto(`${base}/list/${LIST}`)
await page.waitForSelector('table tbody tr')
await page.waitForTimeout(500)
const srcInfo = await page.getByText(/positions ·/).first().innerText()
const srcCount = Number(srcInfo.match(/(\d+) positions/)[1])
ok('source list lost the positions', srcCount === doc.positions.length - want, srcInfo)
const srcTotalText = await page.getByText(/Total €/).first().innerText()
const srcTotal = num(srcTotalText.match(/Total (€[\d,.]+)/)[1])
const sum = Math.round((srcTotal + newTotal) * 100) / 100
ok('totals add up to the original', Math.abs(sum - origTotal) < 0.011, `${srcTotal} + ${newTotal} = ${sum} vs ${origTotal}`)

/* ---------------- drawer move persists after reload ---------------- */
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 1024 } })
const p2 = await ctx2.newPage()
p2.on('console', (m) => (m.type() === 'error' ? errors.push(`console2: ${m.text()}`) : null))
p2.on('pageerror', (e) => errors.push(`pageerror2: ${e.message}`))
const mover = doc.positions.find((p) => leaf(p) === '1.1')
await p2.goto(`${base}/list/${LIST}`)
await p2.waitForSelector('table tbody tr')
await p2.getByLabel('Search positions').fill(mover.short.slice(0, 30))
await p2.locator(`tbody tr:has-text("OZ: ${mover.oz}")`).first().locator('button[title="Show full description"]').click()
const drawer = p2.getByRole('dialog', { name: `Position ${mover.oz}` })
await drawer.waitFor()
await drawer.getByRole('button', { name: /Change category/ }).click()
const pick2 = p2.getByRole('dialog', { name: 'Move to category' })
await pick2.waitFor()
await pick2.locator(`[role=treeitem][data-oz="${moveTarget}"]`).click()
const to2 = await pick2.getByTestId('renumber-to').first().innerText()
ok('drawer picker preview', to2 === expectedOz, to2)
await pick2.getByRole('button', { name: /^Move 1 position/ }).click()
await p2.getByRole('dialog', { name: `Position ${expectedOz}` }).waitFor()
ok('drawer shows edited badge + new OZ', (await p2.getByTestId('edited-badge').count()) === 1)
await p2.keyboard.press('Escape')
await p2.reload()
await p2.waitForSelector('table tbody tr')
await p2.getByLabel('Search positions').fill(mover.short.slice(0, 30))
await p2.waitForTimeout(300)
ok('move persists after reload', (await p2.locator(`tbody tr:has-text("OZ: ${expectedOz}")`).count()) >= 1)
await p2.screenshot({ path: 'tests/shots/35-after-reload.png' })

ok('no console errors', errors.length === 0, errors.join(' | '))
await browser.close()
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
