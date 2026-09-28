/**
 * End-to-end regression suite:  npm run e2e
 *
 * Drives the built app in a real browser, on a phone-sized screen and a desktop
 * one, and asserts the behaviours that have actually broken: routes that start
 * where you tap, follow the terrain and reach a sea; the fallback when the
 * elevation service is unreachable; a lossy network; sheets that can be closed;
 * controls that stay reachable.  Set URL=https://... to test a deployed site.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { km, launch, open, serve } from './lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { url, stop } = await serve(root)

// ONLY=lossy,desktop runs just those groups while iterating
const only = process.env.ONLY?.split(',')
const want = (g) => !only || only.includes(g)

const results = []
const test = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - t0 })
    console.log(`  PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, why: String(e.message ?? e) })
    console.log(`  FAIL  ${name}\n        ${String(e.message ?? e).split('\n')[0]}`)
  }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg) }
const noErrors = (errors) => ok(!errors.length, `page errors: ${errors.join(' | ')}`)

/**
 * Start `fn` in the page and poll for it, rather than awaiting it inside one
 * evaluate: the app rewrites the URL fragment on every tap, and Chromium can
 * drop a long-awaited evaluate across that, which looks like a hang but is not.
 */
const run = async (page, fn, arg) => {
  await page.evaluate(([src, a]) => {
    window.__job = null
    Promise.resolve((0, eval)('(' + src + ')')(a)).then(
      (v) => { window.__job = { ok: v ?? null } },
      (e) => { window.__job = { err: String(e) } })
  }, [fn.toString(), arg])
  await page.waitForFunction(() => window.__job, null, { timeout: 90000, polling: 100 })
  const r = await page.evaluate(() => window.__job)
  if (r.err) throw new Error(r.err)
  return r.ok
}

const drop = async (page, lon, lat, snap = 0) => {
  await run(page, async ([lo, la, sn]) => { await window.__store.getState().dropAt(lo, la, sn) }, [lon, lat, snap])
  return page.evaluate(() => {
    const s = window.__store.getState()
    const t = s.trace
    if (!t) return { none: true, error: s.error }
    const p = t.path
    const n = p.lon.length
    let climbs = 0
    for (let i = 1; i < n; i++) if (p.elev[i] > p.elev[i - 1] + 0.01) climbs++
    return {
      n, detail: !!p.detail, join: p.join, climbs, first: [p.lon[0], p.lat[0]],
      km: p.dist[n - 1] / 1000, dest: t.stats.destination, size: t.start.sizeClass,
      seconds: t.stats.travelSeconds, streams: t.streams ? t.streams.dn.length : 0,
      terminal: p.terminal, error: s.error,
    }
  })
}

// ------------------------------------------------------------------ phone
console.log('\nphone (390x844), real terrain data')
if (want('phone')) {
  const { browser, ctx } = await launch({ phone: true })
  const page = await ctx.newPage()
  const errors = await open(page, url)

  await test('boots with the search bar and controls', async () => {
    ok(await page.locator('.search input').count(), 'no search box')
    ok(await page.locator('.fab').count(), 'no controls button')
  })

  await test('a tap starts the route where the finger was and follows the terrain', async () => {
    await page.evaluate(() => window.__map.jumpTo({ center: [10.4123, 59.3318], zoom: 12 }))
    await page.waitForTimeout(1500)
    const tapped = await page.evaluate(() => window.__map.unproject([195, 420]).toArray())
    await page.touchscreen.tap(195, 420)
    await page.waitForFunction(() => window.__store.getState().trace, null, { timeout: 30000 })
    const r = await page.evaluate(() => {
      const t = window.__store.getState().trace, p = t.path, n = p.lon.length
      let climbs = 0
      for (let i = 1; i < n; i++) if (p.elev[i] > p.elev[i - 1] + 0.01) climbs++
      return { detail: !!p.detail, first: [p.lon[0], p.lat[0]], climbs, km: p.dist[n - 1] / 1000, dest: t.stats.destination }
    })
    ok(r.detail, 'fine routing did not run')
    const off = km(tapped, r.first) * 1000
    ok(off < 80, `route starts ${off.toFixed(0)} m from the tap`)
    ok(r.climbs === 0, `${r.climbs} steps go uphill`)
    ok(r.km > 3 && r.km < 80, `implausible length ${r.km.toFixed(1)} km`)
    ok(/Sea|Ocean/.test(r.dest), `ended at "${r.dest}"`)
  })

  await test('the real local stream network is drawn around the tap', async () => {
    await page.waitForTimeout(1200)
    const n = await page.evaluate(() => window.__map.querySourceFeatures('streams').length)
    ok(n >= 20, `only ${n} stream reaches drawn`)
  })

  await test('the panel says how the route was made', async () => {
    const txt = await page.locator('.panel').innerText()
    ok(/20.40 m terrain/.test(txt), 'no note about terrain-resolution routing')
  })

  await test('a tap on the coast, where the coarse mask says ocean, still routes', async () => {
    const r = await drop(page, 10.28, 59.53)
    ok(!r.none && r.n >= 2, 'no route from a coastal tap')
    ok(r.climbs === 0, 'coastal route goes uphill')
  })

  await test('a big river still runs the whole way (Munich to the Black Sea)', async () => {
    const r = await drop(page, 11.58, 48.14)
    ok(/Black Sea/.test(r.dest), `ended at ${r.dest}`)
    ok(r.km > 1900 && r.km < 2500, `${r.km.toFixed(0)} km`)
    ok(Number.isFinite(r.seconds) && r.seconds > 86400, 'travel time is not a real number')
  })

  await test('the catchment of a headwater is a real, closed outline', async () => {
    await drop(page, 10.4123, 59.3318)
    const w = await run(page, async () => {
      await window.__store.getState().loadWatershed(10.4123, 59.3318)
      const w = window.__store.getState().watershed
      return w && { area: w.area, complete: w.complete, rings: w.rings.length }
    })
    ok(w && w.complete && w.rings >= 1, 'no complete catchment')
    ok(w.area > 0.05 && w.area < 300, `catchment ${w.area} km²`)
  })

  await test('sheets can be closed and reopened, and nothing overlaps', async () => {
    await drop(page, 10.4123, 59.3318)
    await page.waitForTimeout(800)
    const box = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom] }, sel)
    const hit = (a, b) => a && b && !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3])
    let tl = await box('.timeline'), pn = await box('.panel')
    ok(pn && tl && !hit(tl, pn), 'timeline overlaps the sheet')
    await page.locator('.panel .iconbtn').last().click()
    await page.waitForTimeout(500)
    ok(!(await page.locator('.panel').count()), 'the sheet did not close')
    tl = await box('.timeline')
    const rp = await box('.reopen')
    ok(rp && tl && !hit(rp, tl), 'the reopen pill covers the timeline')
    const covered = await page.evaluate(() => {
      const a = document.querySelector('.maplibregl-ctrl-attrib')
      if (!a) return 'missing'
      const b = a.getBoundingClientRect()
      const el = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)
      return a.contains(el) ? 'clear' : 'covered by ' + (el?.className || el?.tagName)
    })
    ok(covered === 'clear', `attribution button ${covered}`)
    await page.locator('.reopen').click()
    await page.waitForTimeout(400)
    ok(await page.locator('.panel').count(), 'the sheet did not reopen')
  })

  await test('every basemap button works', async () => {
    await page.locator('.fab').click()
    await page.waitForTimeout(400)
    const card = page.locator('.card:has(h4:text("Basemap"))')
    if ((await card.locator('h4 span').innerText()).trim() === '+') await card.locator('h4').click()
    for (const name of ['Dark', 'Light', 'Satellite', 'Terrain']) {
      await page.locator(`.rail .btn:text-is("${name}")`).click()
      await page.waitForTimeout(1500)
      ok(await page.locator('.brand').count(), `UI gone after ${name}`)
    }
    await page.locator('.backdrop').click({ force: true })
  })

  await test('all six overlays render', async () => {
    for (const o of ['precip', 'snow', 'runoff', 'flowacc', 'elevation', 'slope']) {
      await page.evaluate((o) => window.__store.setState({ overlay: o }), o)
      await page.waitForTimeout(500)
    }
    await page.evaluate(() => window.__store.setState({ overlay: 'none' }))
  })

  await test('storm mode rains inside a dragged box', async () => {
    await page.evaluate(() => {
      window.__store.getState().clearAll()
      window.__map.jumpTo({ center: [11, 47.6], zoom: 7 })
      window.__store.setState({ mode: 'rain', rainDrops: 300, panelOpen: false, railOpen: false })
    })
    await page.waitForTimeout(600)
    const cursor = await page.evaluate(() => window.__map.getCanvasContainer().style.cursor)
    ok(cursor === 'crosshair', `storm brush not armed (cursor "${cursor}")`)
    await page.mouse.move(100, 300); await page.mouse.down(); await page.mouse.move(280, 520, { steps: 6 })
    ok(await page.locator('.brush').count(), 'no brush rectangle while dragging')
    await page.mouse.up()
    await page.waitForFunction(() => window.__store.getState().rainPaths?.length > 0, null, { timeout: 30000 })
    await page.evaluate(() => window.__store.setState({ mode: 'drop' }))
  })

  await test('search finds Holmestrand', async () => {
    await page.evaluate(() => window.__store.getState().clearAll())
    await page.fill('.search input', 'Holmestrand')
    // the first row is a spinner while the 80 000-place gazetteer downloads
    await page.waitForFunction(() => {
      const r = document.querySelector('.results')
      return r && !r.querySelector('.spin') && r.querySelectorAll('.result').length > 0
    }, null, { timeout: 30000 })
    ok(/Holmestrand/.test(await page.locator('.results .result').first().innerText()), 'wrong first result')
    await page.fill('.search input', '')
  })

  await test('a shared link restores the journey', async () => {
    await drop(page, 11.58, 48.14)
    const hash = await page.evaluate(() => location.hash)
    ok(hash.includes('d='), 'no drop in the link')
    const p2 = await ctx.newPage()
    const errs2 = await open(p2, url + hash)
    await p2.waitForFunction(() => window.__store.getState().trace, null, { timeout: 30000 })
    noErrors(errs2)
    await p2.close()
  })

  await test('no page errors on the phone', () => noErrors(errors))
  await browser.close()
}

// ---------------------------------------------------------------- fallback
console.log('\nelevation service unreachable')
if (want('fallback')) {
  const { browser, ctx } = await launch({ phone: true, elevation: 'blocked' })
  const page = await ctx.newPage()
  const errors = await open(page, url)
  await test('routes fall back to the continental grid and say so', async () => {
    const r = await drop(page, 10.4123, 59.3318)
    ok(!r.none && !r.detail, 'expected the coarse fallback')
    ok(/Sea|Ocean/.test(r.dest) && r.n > 5, 'the fallback route is broken')
    await page.waitForTimeout(600)
    ok(/could not be loaded/.test(await page.locator('.panel').innerText()), 'no note about the fallback')
  })
  await test('and keeps working on the next taps', async () => {
    for (const [lo, la] of [[9.95, 59.85], [11.58, 48.14], [7.0, 46.5]]) {
      const r = await drop(page, lo, la)
      ok(!r.none && r.n > 5, `no route at ${lo},${la}`)
    }
  })
  await test('no page errors without elevation data', () => noErrors(errors))
  await browser.close()
}

// ------------------------------------------------------------ lossy network
console.log('\n35% of data requests dropped')
if (want('lossy')) {
  const { browser, ctx } = await launch({ phone: true, lossy: 0.35 })
  const page = await ctx.newPage()
  const errors = await open(page, url)
  await test('every tap still gets a sane answer', async () => {
    for (const [lo, la] of [[9.95, 59.85], [10.4123, 59.3318], [11.58, 48.14], [2.35, 48.85], [7.0, 46.5]]) {
      const r = await drop(page, lo, la)
      ok(!r.none, `no route at ${lo},${la}`)
      ok(Number.isFinite(r.seconds) && r.km < 3000, `nonsense answer at ${lo},${la}: ${r.km.toFixed(0)} km, ${r.seconds}`)
    }
  })
  await test('no page errors on a bad connection', () => noErrors(errors))
  await browser.close()
}

// ---------------------------------------------------------------- desktop
console.log('\ndesktop (1440x900)')
if (want('desktop')) {
  const { browser, ctx } = await launch()
  const page = await ctx.newPage()
  const errors = await open(page, url)
  await test('panel, controls and timeline do not overlap', async () => {
    await drop(page, 10.4123, 59.3318)
    await page.waitForTimeout(800)
    const r = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null; const x = e.getBoundingClientRect(); return [x.left, x.top, x.right, x.bottom] }
      const hit = (a, c) => a && c && !(a[2] <= c[0] || a[0] >= c[2] || a[3] <= c[1] || a[1] >= c[3])
      const o = { panel: b('.panel'), rail: b('.rail'), timeline: b('.timeline'), topbar: b('.topbar') }
      const bad = []
      const k = Object.keys(o)
      for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) if (hit(o[k[i]], o[k[j]])) bad.push(`${k[i]}×${k[j]}`)
      return bad
    })
    ok(!r.length, `overlaps: ${r.join(', ')}`)
  })
  await test('desktop click starts at the cursor', async () => {
    await page.evaluate(() => { window.__store.getState().clearAll(); window.__map.jumpTo({ center: [9.95, 59.85], zoom: 11 }) })
    await page.waitForTimeout(1200)
    const tapped = await page.evaluate(() => window.__map.unproject([900, 450]).toArray())
    await page.mouse.click(900, 450)
    await page.waitForFunction(() => window.__store.getState().trace, null, { timeout: 30000 })
    await page.waitForTimeout(500)
    const first = await page.evaluate(() => { const p = window.__store.getState().trace.path; return [p.lon[0], p.lat[0]] })
    // a tap may be pulled onto a river within about ten screen pixels
    const metresPerPixel = (156543.03392 * Math.cos((59.85 * Math.PI) / 180)) / 2 ** 11
    const off = km(tapped, first) * 1000
    ok(off < metresPerPixel * 11, `route starts ${off.toFixed(0)} m from the click (limit ${(metresPerPixel * 11).toFixed(0)})`)
  })
  await test('no page errors on desktop', () => noErrors(errors))
  await browser.close()
}

stop()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
