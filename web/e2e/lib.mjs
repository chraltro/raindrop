/**
 * Shared plumbing for the end-to-end suite.
 *
 * The suite never depends on a third-party tile service being up: the basemaps
 * are answered with a flat tile, and the elevation tiles — which the fine
 * routing genuinely needs — are either fetched for real or, in a sandbox that
 * can only reach the network through a proxy, fetched with curl and cached.
 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { chromium } from 'playwright'

const T = []
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0 }
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

/** A flat 256x256 PNG: enough to stand in for any basemap tile. */
function flatTile(rgb = [242, 239, 233]) {
  const w = 256
  const raw = Buffer.alloc((w * 3 + 1) * w)
  for (let y = 0; y < w; y++) {
    const o = y * (w * 3 + 1)
    for (let x = 0; x < w; x++) { raw[o + 1 + x * 3] = rgb[0]; raw[o + 2 + x * 3] = rgb[1]; raw[o + 3 + x * 3] = rgb[2] }
  }
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length)
    const b = Buffer.concat([Buffer.from(t), d])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b))
    return Buffer.concat([l, b, c])
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(w, 4); ih[8] = 8; ih[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const TILE = flatTile()

const CACHE = path.join(os.tmpdir(), 'river-runner-e2e-tiles')
fs.mkdirSync(CACHE, { recursive: true })

/** Terrain tiles, once, through curl (which honours the sandbox proxy) and cached on disk. */
function fetchThroughCurl(url) {
  const f = path.join(CACHE, url.replace(/[^a-z0-9]+/gi, '_'))
  if (fs.existsSync(f)) return Promise.resolve(fs.readFileSync(f))
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '-f', '-m', '30', '-o', f, url], (err) => {
      if (err) { try { fs.unlinkSync(f) } catch { /* nothing written */ } reject(err) }
      else resolve(fs.readFileSync(f))
    })
  })
}

function chromePath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers'))
      if (/^chromium-\d+$/.test(d)) return `/opt/pw-browsers/${d}/chrome-linux/chrome`
  } catch { /* not in the sandbox */ }
  return undefined
}

/**
 * Build the app if needed and serve it. Resolves to `{ url, stop }`.
 * Set URL to test something that is already running (a deployed site, say).
 */
export async function serve(root) {
  if (process.env.URL) return { url: process.env.URL, stop: () => {} }
  const port = 4190 + Math.floor(Math.random() * 50)
  if (!fs.existsSync(path.join(root, 'dist/index.html')) || process.env.REBUILD)
    await new Promise((res, rej) => {
      const p = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error('build failed'))))
    })
  const child = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' })
  const url = `http://localhost:${port}/raindrop/`
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) break } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return { url, stop: () => child.kill() }
}

/**
 * A browser context. `elevation: 'real' | 'blocked'` decides whether the
 * terrain-tile service answers; `lossy` drops that fraction of data requests.
 */
export async function launch({ phone = false, width, height, elevation = 'real', lossy = 0 } = {}) {
  const browser = await chromium.launch({ executablePath: chromePath() })
  const ctx = await browser.newContext({
    viewport: { width: width ?? (phone ? 390 : 1440), height: height ?? (phone ? 844 : 900) },
    deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block',
  })
  const stub = (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE })
  await ctx.route('**basemaps.cartocdn.com/**', stub)
  await ctx.route('**arcgisonline.com/**', stub)
  await ctx.route('**elevation-tiles-prod**', async (r) => {
    if (elevation === 'blocked') return r.abort()
    const url = r.request().url()
    try {
      if (process.env.HTTPS_PROXY || process.env.https_proxy) {
        const body = await fetchThroughCurl(url)
        return r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body })
      }
      return r.continue()
    } catch { return r.abort() }
  })
  if (lossy > 0)
    await ctx.route('**/data/**', (r) => {
      const u = r.request().url()
      if (/grid\.json|basins\.json|climate\//.test(u)) return r.continue()
      return Math.random() < lossy ? r.abort() : r.continue()
    })
  return { browser, ctx }
}

/** Open the app and wait until a drop can be routed. */
export async function open(page, url) {
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__store?.getState().ready, null, { timeout: 60000 })
  await page.evaluate(() => document.querySelector('.intro-close')?.click())
  await page.waitForTimeout(300)
  return errors
}

export const km = (a, b) => {
  const r = Math.PI / 180
  return 6371 * Math.hypot((b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r), (b[1] - a[1]) * r)
}
