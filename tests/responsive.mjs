import { chromium } from 'playwright'
const b = await chromium.launch()
const out = []
for (const [w, h] of [[375, 812], [768, 1024], [1600, 1000]]) {
  const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage()
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type()==='error' && errs.push(m.text()))
  for (const [n, u] of [['projects', '/'], ['folder', '/folder/fernleitung-2024-001'], ['list', '/list/angebot-an24-0305-d84']]) {
    await p.goto('http://localhost:5173' + u, { waitUntil: 'networkidle' })
    await p.waitForTimeout(400)
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    out.push(`${w} ${n} overflowX=${ov}`)
    await p.screenshot({ path: `tests/compare/r-${w}-${n}.png` })
  }
  if (errs.length) out.push('errors: ' + errs.join(' | '))
}
console.log(out.join('\n')); await b.close()
