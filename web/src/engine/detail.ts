/**
 * Fine-resolution routing for the first stretch of a drop.
 *
 * The published hydrology is a ~250-300 m grid. That is right for a river and
 * wrong for anything small: a headwater catchment is a handful of cells, a tap
 * lands up to a cell away from where the finger was, and the route wanders off
 * the real valley. So the start of every journey is re-routed here, on the
 * elevation data at 19-38 m (Terrarium tiles at zoom 12), until the water
 * reaches a river the continental network already represents well. From there
 * the existing engine carries it to the sea.
 *
 * The routing is a priority-flood (Barnes, Lehman & Mulla 2014) over a window
 * of 3x3 tiles: it fills depressions, records for each cell the neighbour that
 * water leaves by, and gives an ordering that makes local flow accumulation a
 * single pass. Long routes chain several windows.
 */
import {
  CLASS, DX, DY, EARTH_CIRCUMFERENCE, latToPixel, lonToPixel, pixelToLat, pixelToLon,
} from './grid'
import type { FlowEngine } from './flow'
import { maskToRings } from './contour'

export const DETAIL_ZOOM = 12
const TS = 256
const WIN = TS * 3
/** Elevation is bucketed to 1/SCALE m: finer than the DEM itself. */
const SCALE = 64
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

/** Hand over to the continental grid once the water is on a river this big. */
export const JOIN_AREA = 500
const MAX_STAGES = 6
const EDGE_MARGIN = 24
const MAX_STEPS = 60_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ tiles
export class DemCache {
  private tiles = new Map<string, Float32Array>()
  private pending = new Map<string, Promise<Float32Array>>()
  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  fetched = 0

  constructor(private url = TERRARIUM, private limit = 120) {}

  get(z: number, x: number, y: number): Promise<Float32Array> {
    const key = `${z}/${x}/${y}`
    const hit = this.tiles.get(key)
    if (hit) {
      this.tiles.delete(key)          // refresh recency
      this.tiles.set(key, hit)
      return Promise.resolve(hit)
    }
    const inflight = this.pending.get(key)
    if (inflight) return inflight
    const p = this.load(`${this.url}/${key}.png`)
      .then((t) => {
        this.tiles.set(key, t)
        this.pending.delete(key)
        this.fetched++
        if (this.tiles.size > this.limit) {
          const oldest = this.tiles.keys().next().value
          if (oldest !== undefined) this.tiles.delete(oldest)
        }
        return t
      })
      .catch((e) => {
        this.pending.delete(key)
        throw e
      })
    this.pending.set(key, p)
    return p
  }

  private async load(url: string, tries = 3): Promise<Float32Array> {
    let last: unknown
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`${res.status} ${url}`)
        const bmp = await createImageBitmap(await res.blob(), {
          colorSpaceConversion: 'none', premultiplyAlpha: 'none',
        })
        const w = bmp.width
        const h = bmp.height
        if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas = new OffscreenCanvas(w, h)
          this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
        }
        const ctx = this.ctx!
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(bmp, 0, 0)
        const px = ctx.getImageData(0, 0, w, h).data
        bmp.close()
        const out = new Float32Array(w * h)
        for (let k = 0; k < out.length; k++) {
          // Terrarium: metres = R*256 + G + B/256 - 32768
          out[k] = px[k * 4] * 256 + px[k * 4 + 1] + px[k * 4 + 2] / 256 - 32768
        }
        return out
      } catch (e) {
        last = e
        if (i < tries - 1) await sleep(300 * 2 ** i)
      }
    }
    throw last
  }
}

// ---------------------------------------------------------------- windows
export interface Win {
  z: number
  x0: number                // global pixel of the window's first column
  y0: number
  w: number
  h: number
  elev: Float32Array        // raw metres
  fkey: Int32Array          // depression-filled surface, in 1/SCALE m above `base`
  base: number
  dir: Uint8Array           // direction code the water leaves by; 0 = outlet
  acc: Float32Array         // km² draining through each cell, inside the window
  outlets: Uint8Array       // 1 where the cell drains to the sea
}

const cellMetres = (y: number, z: number) =>
  (EARTH_CIRCUMFERENCE / (TS * 2 ** z)) * Math.cos((pixelToLat(y + 0.5, z) * Math.PI) / 180)

async function buildWindow(
  dem: DemCache, z: number, cx: number, cy: number,
): Promise<Win> {
  const tx0 = (cx >> 8) - 1
  const ty0 = (cy >> 8) - 1
  const limit = 2 ** z
  if (tx0 < 0 || ty0 < 0 || tx0 + 2 >= limit || ty0 + 2 >= limit)
    throw new Error('window outside the world')
  const jobs: Promise<Float32Array>[] = []
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) jobs.push(dem.get(z, tx0 + i, ty0 + j))
  const tiles = await Promise.all(jobs)
  const elev = new Float32Array(WIN * WIN)
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) {
      const t = tiles[j * 3 + i]
      for (let y = 0; y < TS; y++) {
        const src = y * TS
        const dst = (j * TS + y) * WIN + i * TS
        for (let x = 0; x < TS; x++) {
          // nodata (-32768) would otherwise become a bottomless pit
          const v = t[src + x]
          elev[dst + x] = v < -900 ? 0 : v
        }
      }
    }
  const n = WIN * WIN
  return {
    z, x0: tx0 * TS, y0: ty0 * TS, w: WIN, h: WIN, elev,
    fkey: new Int32Array(n), base: 0, dir: new Uint8Array(n),
    acc: new Float32Array(n), outlets: new Uint8Array(n),
  }
}

const filledAt = (win: Win, i: number) => win.base + win.fkey[i] / SCALE

/**
 * Fill depressions and derive flow directions and accumulation in one flood.
 * `isSea` says which low cells are the sea; everything else drains out through
 * the window's border or the lowest pass in it.
 *
 * This is Priority-Flood with a bucket queue: elevations are bucketed, so
 * taking the lowest cell is O(1) rather than a heap's O(log n), and a FIFO
 * within each bucket makes flat ground (lakes, filled pits) drain along the
 * shortest path to the spill point. It is several times faster than a heap on
 * the 590 000 cells of a window, which matters on a phone.
 */
function flood(win: Win, isSea: (gx: number, gy: number) => boolean) {
  const { w, h, elev, fkey, dir, outlets, z, y0, x0 } = win
  const N = w * h

  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < N; i++) {
    const e = elev[i]
    if (e < lo) lo = e
    if (e > hi) hi = e
  }
  win.base = lo
  const key = new Int32Array(N)
  for (let i = 0; i < N; i++) key[i] = Math.round((elev[i] - lo) * SCALE)
  const K = Math.round((hi - lo) * SCALE) + 1

  const heads = new Int32Array(K).fill(-1)
  const tails = new Int32Array(K)
  const next = new Int32Array(N)
  const seen = new Uint8Array(N)
  const order = new Int32Array(N)

  const push = (i: number, k: number) => {
    next[i] = -1
    if (heads[k] < 0) heads[k] = i
    else next[tails[k]] = i
    tails[k] = i
  }
  const seed = (i: number) => {
    seen[i] = 1
    fkey[i] = key[i]
    dir[i] = 0
    push(i, key[i])
  }

  // The border is where water leaves the window; low cells that the
  // continental grid also calls ocean are the sea. Both are outlets, but only
  // the sea ends a journey.
  const sea = (x: number, y: number) => {
    const i = y * w + x
    if (elev[i] <= 0.5 && isSea(x0 + x, y0 + y)) outlets[i] = 1
  }
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); sea(x, 0); sea(x, h - 1) }
  for (let y = 1; y < h - 1; y++) { seed(y * w); seed(y * w + w - 1); sea(0, y); sea(w - 1, y) }
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (elev[i] <= 0.5 && isSea(x0 + x, y0 + y)) { seed(i); outlets[i] = 1 }
    }

  // neighbour offsets by direction code, and the code that points back
  const off = new Int32Array(9)
  for (let k = 1; k <= 8; k++) off[k] = DY[k] * w + DX[k]
  const back = [0, 5, 6, 7, 8, 1, 2, 3, 4]

  let oc = 0
  let level = 0
  while (oc < N) {
    while (level < K && heads[level] < 0) level++
    if (level >= K) break
    const c = heads[level]
    heads[level] = next[c]
    order[oc++] = c
    const cy = (c / w) | 0
    const cx = c - cy * w
    const inside = cx > 0 && cy > 0 && cx < w - 1 && cy < h - 1
    for (let k = 1; k <= 8; k++) {
      if (!inside) {
        const nx = cx + DX[k]
        const ny = cy + DY[k]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      }
      const n = c + off[k]
      if (seen[n]) continue
      seen[n] = 1
      const kn = key[n] > level ? key[n] : level
      fkey[n] = kn
      dir[n] = back[k]
      // inlined push: this is the hottest line in the file
      next[n] = -1
      if (heads[kn] < 0) heads[kn] = n
      else next[tails[kn]] = n
      tails[kn] = n
    }
  }

  // accumulation: every cell was reached after the one it drains to, so
  // walking the order backwards visits upstream before downstream
  const acc = win.acc
  for (let y = 0; y < h; y++) {
    const cs = cellMetres(y0 + y, z)
    acc.fill((cs * cs) / 1e6, y * w, (y + 1) * w)
  }
  for (let i = oc - 1; i >= 0; i--) {
    const c = order[i]
    const d = dir[c]
    if (d) acc[c + off[d]] += acc[c]
  }
}

// ----------------------------------------------------------------- streams
export interface StreamSet {
  /** lon, lat pairs of every reach, back to back */
  coords: Float32Array
  /** index into `coords` (in points, not floats) where each reach starts, plus the end */
  starts: Uint32Array
  /** km² draining through the downstream end of each reach */
  dn: Float32Array
  /** 1 in the middle of the window, fading to 0 at its edge so nothing looks cut off */
  fade: Float32Array
}

/** A cell this size or larger is a channel: about the smallest stream that shows on a map. */
const CHANNEL_AREA = 0.3
const MAX_CHANNEL_CELLS = 60_000

/**
 * The stream network inside a window, at terrain resolution.
 *
 * Every cell draining more than CHANNEL_AREA is a channel. A reach runs from a
 * headwater or a confluence down to the next confluence, so each channel cell
 * belongs to exactly one reach and none is drawn twice.
 */
export function extractStreams(win: Win, isWater: (gx: number, gy: number) => boolean): StreamSet {
  const { w, h, dir, acc, elev, fkey, z, x0, y0 } = win
  const N = w * h
  const off = new Int32Array(9)
  for (let k = 1; k <= 8; k++) off[k] = DY[k] * w + DX[k]

  // A channel drains enough land, is above the sea, and is not a lake. Water
  // "flowing" across a lake or a tidal flat is only the flood picking the
  // shortest path over level ground, which is a straight 45° line, not a stream.
  const channel = new Uint8Array(N)
  let cells = 0
  for (let c = 0; c < N; c++) {
    if (acc[c] < CHANNEL_AREA || elev[c] <= 0.5) continue
    const cy = (c / w) | 0
    if (isWater(x0 + (c - cy * w), y0 + cy)) continue
    channel[c] = 1
    cells++
  }
  if (cells > MAX_CHANNEL_CELLS)
    return { coords: new Float32Array(0), starts: new Uint32Array(1), dn: new Float32Array(0), fade: new Float32Array(0) }

  const inflow = new Uint8Array(N)
  for (let c = 0; c < N; c++) {
    if (!channel[c]) continue
    const d = dir[c]
    if (d && channel[c + off[d]] && inflow[c + off[d]] < 255) inflow[c + off[d]]++
  }

  const reaches: number[][] = []
  for (let c = 0; c < N; c++) {
    if (!channel[c] || inflow[c] === 1) continue
    const line = [c]
    let cur = c
    let flat = 0
    let turns = 0
    let last = 0
    for (;;) {
      const d = dir[cur]
      if (!d) break
      const nxt = cur + off[d]
      if (!channel[nxt]) break
      if (fkey[cur] === fkey[nxt]) flat++
      if (last && d !== last) turns++
      last = d
      line.push(nxt)
      if (inflow[nxt] !== 1) break
      cur = nxt
    }
    if (line.length < 2) continue
    // A long run over level ground is the flood crossing a plain, and a run
    // that never changes direction is the same thing: a stream that drains
    // 0.3 km² does not hold a dead-straight line for six cells.
    if (line.length >= 10 && flat / (line.length - 1) > 0.6) continue
    if (line.length >= 7 && turns === 0) continue
    reaches.push(line)
  }

  let total = 0
  for (const r of reaches) total += r.length
  const coords = new Float32Array(total * 2)
  const starts = new Uint32Array(reaches.length + 1)
  const dn = new Float32Array(reaches.length)
  const fade = new Float32Array(reaches.length)
  let at = 0
  reaches.forEach((r, k) => {
    starts[k] = at
    const mid = r[r.length >> 1]
    const my = (mid / w) | 0
    const d = Math.max(Math.abs(mid - my * w - w / 2), Math.abs(my - h / 2)) / (w / 2)
    fade[k] = Math.max(0, Math.min(1, (1 - d) / 0.3))
    for (const c of r) {
      const cy = (c / w) | 0
      const cx = c - cy * w
      coords[at * 2] = pixelToLon(x0 + cx + 0.5, z)
      coords[at * 2 + 1] = pixelToLat(y0 + cy + 0.5, z)
      at++
    }
    dn[k] = acc[r[r.length - 1]]
  })
  starts[reaches.length] = at
  return { coords, starts, dn, fade }
}

// ----------------------------------------------------------------- tracing
export interface DetailTrace {
  x: number[]                 // global pixels at DETAIL_ZOOM
  y: number[]
  elev: number[]              // filled surface, metres
  area: number[]              // km²
  startElev: number           // raw DEM at the first cell
  end: 'join' | 'sea' | 'cap' | 'edge'
  /** Continental-grid cell to carry on from, when the water joined it. */
  join: [number, number] | null
  stages: number
  tiles: number
  ms: number
  /** The stream network around the tap, from the first window. */
  streams: StreamSet | null
}

interface Start {
  win: Win
  x: number
  y: number
}

const primeCoarse = async (engine: FlowEngine, win: Win) => {
  const sh = win.z - engine.zoom
  const xs = [win.x0, win.x0 + win.w - 1]
  const ys = [win.y0, win.y0 + win.h - 1]
  for (const y of ys)
    for (const x of xs) {
      const cx = x >> sh
      const cy = y >> sh
      if (engine.inGrid(cx, cy)) await engine.prime(cx, cy)
    }
  const mx = (win.x0 + win.w / 2) >> sh
  const my = (win.y0 + win.h / 2) >> sh
  if (engine.inGrid(mx, my)) await engine.prime(mx, my)
}

/**
 * Is this fine cell at sea, according to the continental mask? The mask is a
 * coastline rasterised onto ~300 m cells, so it can call sea-level ground land
 * just off the shore. `dilate` accepts a fine cell one continental cell away
 * from ocean too, which is what the flood wants: leaving that strip as "land"
 * turns it into a flat plain the water crosses in straight diagonals.
 */
const seaTest = (engine: FlowEngine, z: number, dilate = false) => {
  const sh = z - engine.zoom
  const r = dilate ? 1 : 0
  return (gx: number, gy: number) => {
    const cx = gx >> sh
    const cy = gy >> sh
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (engine.inGrid(cx + dx, cy + dy) && engine.classAt(cx + dx, cy + dy) === CLASS.OCEAN) return true
    return false
  }
}

const waterTest = (engine: FlowEngine, z: number) => {
  const sh = z - engine.zoom
  return (gx: number, gy: number) => {
    const cx = gx >> sh
    const cy = gy >> sh
    if (!engine.inGrid(cx, cy)) return false
    const c = engine.classAt(cx, cy)
    return c === CLASS.OCEAN || c === CLASS.LAKE
  }
}

function inWorld(engine: FlowEngine, win: Win): boolean {
  const sh = win.z - engine.zoom
  return engine.inGrid(win.x0 >> sh, win.y0 >> sh) &&
    engine.inGrid((win.x0 + win.w - 1) >> sh, (win.y0 + win.h - 1) >> sh)
}

/** Move a tap onto a nearby channel, but only if one really is there. */
function snapCell(win: Win, x: number, y: number, radius: number): [number, number] {
  const lx = x - win.x0
  const ly = y - win.y0
  const here = win.acc[ly * win.w + lx]
  const floor = Math.max(0.15, here * 5)
  let best: [number, number] = [x, y]
  let bestScore = -1
  const r = Math.max(1, Math.round(radius))
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const xx = lx + dx
      const yy = ly + dy
      if (xx < 1 || yy < 1 || xx >= win.w - 1 || yy >= win.h - 1) continue
      const a = win.acc[yy * win.w + xx]
      if (!(a >= floor)) continue
      const score = Math.log10(a + 1) - Math.hypot(dx, dy) / (r + 1)
      if (score > bestScore) { bestScore = score; best = [x + dx, y + dy] }
    }
  return best
}

let lastStart: { key: string; s: Start } | null = null

/** The window around a tap, flooded — shared by the route and the catchment. */
export async function openStart(
  engine: FlowEngine, dem: DemCache, lon: number, lat: number, snapMetres: number,
): Promise<Start | null> {
  const z = DETAIL_ZOOM
  const px = Math.floor(lonToPixel(lon, z))
  const py = Math.floor(latToPixel(lat, z))
  const key = `${px},${py},${Math.round(snapMetres)}`
  if (lastStart?.key === key) return lastStart.s
  const win = await buildWindow(dem, z, px, py)
  if (!inWorld(engine, win)) return null
  await primeCoarse(engine, win)
  flood(win, seaTest(engine, z, true))
  let [x, y] = [px, py]
  if (snapMetres > 0) {
    const cs = cellMetres(py, z)
    ;[x, y] = snapCell(win, px, py, snapMetres / cs)
  }
  const s = { win, x, y }
  lastStart = { key, s }
  return s
}

export async function traceDetail(
  engine: FlowEngine, dem: DemCache, lon: number, lat: number, snapMetres: number,
): Promise<DetailTrace | null> {
  const t0 = performance.now()
  const z = DETAIL_ZOOM
  const sh = z - engine.zoom
  const fetched0 = dem.fetched
  const isSea = seaTest(engine, z)            // strict: is the tap itself at sea
  const seedSea = seaTest(engine, z, true)    // generous: where the flood drains to

  const first = await openStart(engine, dem, lon, lat, snapMetres)
  if (!first) return null
  // The continental mask is wider than the land at the coast, so "ocean" there
  // is not proof of water. The terrain is: a tap only counts as being at sea if
  // the ground is at sea level too, and then there is nothing to route.
  {
    const w0 = first.win
    const e0 = w0.elev[(first.y - w0.y0) * w0.w + first.x - w0.x0]
    if (e0 <= 0.5 && isSea(first.x, first.y)) return null
  }

  const xs: number[] = []
  const ys: number[] = []
  const el: number[] = []
  const ar: number[] = []
  const startElev = first.win.elev[(first.y - first.win.y0) * first.win.w + first.x - first.win.x0]

  let win = first.win
  let cx = first.x
  let cy = first.y
  let carried = 0
  let end: DetailTrace['end'] = 'cap'
  let join: [number, number] | null = null
  let stages = 0

  for (let stage = 0; stage < MAX_STAGES; stage++) {
    stages++
    if (stage > 0) {
      win = await buildWindow(dem, z, cx, cy)
      if (!inWorld(engine, win)) { end = 'edge'; break }
      await primeCoarse(engine, win)
      flood(win, seedSea)
    }
    const idx = (x: number, y: number) => (y - win.y0) * win.w + (x - win.x0)
    const offset = stage === 0 ? 0 : Math.max(0, carried - win.acc[idx(cx, cy)])
    let stageEnd: 'exit' | 'join' | 'sea' | 'edge' = 'exit'
    let x = cx
    let y = cy
    let lastArea = 0

    for (let step = 0; step < MAX_STEPS; step++) {
      const i = idx(x, y)
      const px8 = x >> sh
      const py8 = y >> sh
      if (!engine.inGrid(px8, py8)) { stageEnd = 'edge'; break }

      // how big the continental grid thinks the river here is
      let m3 = engine.areaAt(px8, py8)
      const a8 = m3
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const a = engine.areaAt(px8 + dx, py8 + dy)
          if (a > m3 || Number.isNaN(m3)) m3 = a
        }
      let a = win.acc[i] + offset
      if (m3 >= 20 && a >= 1) a = Math.max(a, 0.8 * m3)
      lastArea = a

      // a hand-over between windows starts on the cell the last one ended on
      if (!(xs.length && xs[xs.length - 1] === x && ys[ys.length - 1] === y)) {
        xs.push(x); ys.push(y); el.push(filledAt(win, i)); ar.push(a)
      }

      if (a8 >= JOIN_AREA) { stageEnd = 'join'; join = [px8, py8]; break }
      const d = win.dir[i]
      if (d === 0) { stageEnd = win.outlets[i] ? 'sea' : 'exit'; break }
      const lx = x - win.x0
      const ly = y - win.y0
      if (lx < EDGE_MARGIN || ly < EDGE_MARGIN ||
          lx >= win.w - EDGE_MARGIN || ly >= win.h - EDGE_MARGIN) { stageEnd = 'exit'; break }
      x += DX[d]
      y += DY[d]
    }

    if (stageEnd === 'join') { end = 'join'; break }
    if (stageEnd === 'sea') { end = 'sea'; break }
    if (stageEnd === 'edge') { end = 'edge'; break }
    // ran out of window: open the next one where this one stopped
    carried = lastArea
    cx = x
    cy = y
    end = 'cap'
  }

  if (end === 'cap' && xs.length) {
    // stopped without meeting a river: carry on from the biggest coarse cell
    // nearby, provided it is clearly a channel and not just the hillside
    const x = xs[xs.length - 1] >> sh
    const y = ys[ys.length - 1] >> sh
    let bx = x
    let by = y
    let ba = engine.areaAt(x, y) || 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const a = engine.areaAt(x + dx, y + dy)
        if (a > ba * 4) { ba = a; bx = x + dx; by = y + dy }
      }
    join = [bx, by]
  }

  return {
    x: xs, y: ys, elev: el, area: ar, startElev, end, join,
    stages, tiles: dem.fetched - fetched0, ms: performance.now() - t0,
    streams: extractStreams(first.win, waterTest(engine, z)),
  }
}

// --------------------------------------------------------------- catchment
export interface DetailWatershed {
  rings: number[][][]
  area: number
  cells: number
  complete: boolean
  outletArea: number
  lon: number
  lat: number
}

/**
 * The land draining to a tap, at terrain resolution. If it runs into the edge
 * of the window the catchment is larger than what was loaded, and the caller
 * falls back to the continental grid.
 */
export async function watershedDetail(
  engine: FlowEngine, dem: DemCache, lon: number, lat: number, snapMetres: number,
): Promise<DetailWatershed | null> {
  const start = await openStart(engine, dem, lon, lat, snapMetres)
  if (!start) return null
  const { win, x, y } = start
  const { w, h, dir, z, x0, y0 } = win
  const N = w * h
  const mask = new Uint8Array(N)
  const queue = new Int32Array(N)
  let qh = 0
  let qt = 0
  const s = (y - y0) * w + (x - x0)
  mask[s] = 1
  queue[qt++] = s
  let touches = false
  let minX = w, minY = h, maxX = 0, maxY = 0
  let area = 0
  while (qh < qt) {
    const c = queue[qh++]
    const cx = c % w
    const cy = (c - cx) / w
    if (cx < minX) minX = cx
    if (cx > maxX) maxX = cx
    if (cy < minY) minY = cy
    if (cy > maxY) maxY = cy
    if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touches = true
    const cs = cellMetres(y0 + cy, z)
    area += (cs * cs) / 1e6
    for (let k = 1; k <= 8; k++) {
      const nx = cx - DX[k]
      const ny = cy - DY[k]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const n = ny * w + nx
      if (mask[n] || dir[n] !== k) continue
      mask[n] = 1
      queue[qt++] = n
    }
  }
  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const crop = new Uint8Array(bw * bh)
  for (let yy = minY; yy <= maxY; yy++)
    for (let xx = minX; xx <= maxX; xx++)
      if (mask[yy * w + xx]) crop[(yy - minY) * bw + (xx - minX)] = 1
  const rings = maskToRings({ mask: crop, x0: x0 + minX, y0: y0 + minY, w: bw, h: bh }, z, 1, 0.0004)
  return {
    rings, area, cells: qt, complete: !touches,
    outletArea: win.acc[s],
    lon, lat,
  }
}
