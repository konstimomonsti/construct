// node tests/quick-shot.mjs <outDir> <path> [w] [h] [full]
import { chromium } from 'playwright'
const [out, path, w = 1440, h = 900, full] = process.argv.slice(2)
const b = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
const p = await b.newPage({ viewport: { width: +w, height: +h }, reducedMotion: 'reduce' })
p.on('console', (m) => m.type() === 'error' && !/api\/workspace|Failed to load resource/.test(m.text()) && console.log('ERR', m.text()))
p.on('pageerror', (e) => console.log('PAGEERR', e.message))
await p.goto('http://localhost:5181' + path, { waitUntil: 'load' })
await p.waitForSelector('main h1', { timeout: 15000 }).catch(() => {})
await p.waitForTimeout(1200)
const name = path.replace(/\W+/g, '_') + `_${w}.png`
await p.screenshot({ path: `${out}/${name}`, fullPage: !!full })
console.log(`${out}/${name}`)
await b.close()
