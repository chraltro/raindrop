/**
 * Smoke test: build, `npm run preview`, then `node test-e2e.mjs`.
 * Verifies the map loads, a click routes a drop to the sea, and the journey
 * panel names the rivers it passes through.
 */
import { chromium } from 'playwright'

const URL = process.env.URL ?? 'http://localhost:4173/raindrop/'
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.intro .btn.active:not([disabled])', { timeout: 60000 })
await page.locator('.intro .btn.active').click()
await page.waitForSelector('.intro-wrap', { state: 'detached' })
await page.waitForTimeout(1200)

const box = await page.locator('.map-root').boundingBox()
const at = await page.evaluate(([x, y]) => {
  const c = window.__map.unproject([x, y])
  return `${c.lng.toFixed(3)}, ${c.lat.toFixed(3)}`
}, [box.width * 0.52, box.height * 0.55])
console.log('clicking at :', at)
await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * 0.55)
await page.waitForSelector('.journey-label', { timeout: 30000 })
await page.waitForTimeout(3000)

const title = await page.locator('.panel-title').first().textContent()
const steps = await page.locator('.journey-label').allTextContents()
console.log('destination :', title)
console.log('journey     :', steps.join(' → '))
console.log('page errors :', errors.length ? errors : 'none')
await browser.close()
if (errors.length || !steps.length) process.exit(1)
