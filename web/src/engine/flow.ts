/**
 * The hydrological engine: everything that walks the D8 grid.
 *
 * All routing happens against the published flow tiles, so a click is answered
 * with the same drainage network the pipeline derived from the DEM — no server
 * round-trip and no simplification of the topology.
 *
 * Hot loops avoid `await` unless a tile is genuinely missing: awaiting on every
 * cell would add a microtask per step and make a five-million-cell watershed
 * fill take minutes instead of a second.
 */
import { TileCache } from './tiles'
import {
  CLASS, DX, DY, cellSize, decodeArea, haversine,
  latToPixel, lonToPixel, pixelToLat, pixelToLon, type Manifest,
} from './grid'

export interface TracedPath {
  x: Int32Array
  y: Int32Array
  lon: Float64Array
  lat: Float64Array
  elev: Float32Array
  area: Float32Array
  dist: Float64Array
  cls: Uint8Array
  terminal: number
  truncated: boolean
}

export interface Watershed {
  mask: Uint8Array
  x0: number
  y0: number
  w: number
  h: number
  area: number
  cells: number
  complete: boolean
}

export class FlowEngine {
  readonly zoom: number
  readonly S: number
  readonly accSize: number
  private visited: Uint8Array | null = null

  constructor(public tiles: TileCache, public m: Manifest) {
    this.zoom = m.zoom
    this.S = m.superTile
    this.accSize = m.accTileSize
  }

  // ---------------------------------------------------------------- lookups
  byteAt(px: number, py: number): number {
    const t = this.tiles.get('flow', px >> 9, py >> 9)
    return t ? t[(py & 511) * this.S + (px & 511)] : CLASS.OCEAN << 4
  }

  dirAt(px: number, py: number) { return this.byteAt(px, py) & 15 }
  classAt(px: number, py: number) { return this.byteAt(px, py) >> 4 }

  areaAt(px: number, py: number): number {
    const t = this.tiles.get('acc', px >> 9, py >> 9)
    if (!t) return NaN
    return decodeArea(t[((py & 511) >> 1) * this.accSize + ((px & 511) >> 1)], this.m.accScale)
  }

  elevAt(px: number, py: number): number {
    const shift = this.zoom - this.m.elevZoom
    const ex = px >> shift
    const ey = py >> shift
    const meta = this.m.elevTiles[`${ex >> 9}/${ey >> 9}`]
    if (!meta) return NaN
    const t = this.tiles.get('elev', ex >> 9, ey >> 9)
    if (!t) return NaN
    return meta[0] + t[(ey & 511) * this.m.elevTileSize + (ex & 511)] * meta[1]
  }

  /** Make sure every raster needed for this cell is in memory. */
  async prime(px: number, py: number, withElev = false): Promise<void> {
    const sx = px >> 9, sy = py >> 9
    if (!this.tiles.has('flow', sx, sy)) await this.tiles.load('flow', sx, sy)
    if (!this.tiles.has('acc', sx, sy)) await this.tiles.load('acc', sx, sy)
    if (withElev) {
      const shift = this.zoom - this.m.elevZoom
      const ex = (px >> shift) >> 9
      const ey = (py >> shift) >> 9
      if (!this.tiles.has('elev', ex, ey)) await this.tiles.load('elev', ex, ey)
    }
  }

  cellOf(lon: number, lat: number): [number, number] {
    return [Math.floor(lonToPixel(lon, this.zoom)), Math.floor(latToPixel(lat, this.zoom))]
  }

  lonLatOf(px: number, py: number): [number, number] {
    return [pixelToLon(px + 0.5, this.zoom), pixelToLat(py + 0.5, this.zoom)]
  }

  inGrid(px: number, py: number): boolean {
    return (
      px >= this.m.pixelX0 && py >= this.m.pixelY0 &&
      px < this.m.pixelX0 + this.m.width && py < this.m.pixelY0 + this.m.height
    )
  }

  // ------------------------------------------------------------- downstream
  async traceDown(px0: number, py0: number, maxSteps = 40000): Promise<TracedPath> {
    const xs: number[] = []
    const ys: number[] = []
    let px = px0
    let py = py0
    let terminal: number = CLASS.EDGE
    let truncated = false
    // Water cannot flow in a circle. If the directions ever say it does — a bad
    // cell, a seam between tiles, a tile that answered as ocean — the walk has
    // to notice, or it ping-pongs between two cells for forty thousand steps
    // and reports a journey of tens of thousands of kilometres.
    const seen = new Set<number>()
    for (let step = 0; step < maxSteps; step++) {
      const sx = px >> 9
      const sy = py >> 9
      if (!this.tiles.has('flow', sx, sy)) await this.tiles.load('flow', sx, sy)
      if (this.tiles.failed('flow', sx, sy)) { truncated = true; break }
      const b = this.byteAt(px, py)
      xs.push(px)
      ys.push(py)
      const id = py * 0x1000000 + px
      if (seen.has(id)) { terminal = CLASS.SINK; break }
      seen.add(id)
      const dir = b & 15
      if (dir === 0) { terminal = b >> 4; break }
      px += DX[dir]
      py += DY[dir]
      if (!this.inGrid(px, py)) { terminal = CLASS.EDGE; break }
      if (step === maxSteps - 1) truncated = true
    }
    return this.decorate(xs, ys, terminal, truncated)
  }

  private async decorate(
    xs: number[], ys: number[], terminal: number, truncated: boolean,
  ): Promise<TracedPath> {
    const n = xs.length
    const X = Int32Array.from(xs)
    const Y = Int32Array.from(ys)
    // prefetch every acc / elev tile the path touches
    const want = new Set<string>()
    for (let i = 0; i < n; i++) want.add(`${X[i] >> 9}/${Y[i] >> 9}`)
    await Promise.all(
      [...want].map((k) => {
        const [sx, sy] = k.split('/').map(Number)
        return this.tiles.load('acc', sx, sy)
      }),
    )
    const shift = this.zoom - this.m.elevZoom
    const wantE = new Set<string>()
    for (let i = 0; i < n; i++) wantE.add(`${(X[i] >> shift) >> 9}/${(Y[i] >> shift) >> 9}`)
    await Promise.all(
      [...wantE].map((k) => {
        const [sx, sy] = k.split('/').map(Number)
        return this.tiles.load('elev', sx, sy)
      }),
    )

    const lon = new Float64Array(n)
    const lat = new Float64Array(n)
    const elev = new Float32Array(n)
    const area = new Float32Array(n)
    const dist = new Float64Array(n)
    const cls = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const [lo, la] = this.lonLatOf(X[i], Y[i])
      lon[i] = lo
      lat[i] = la
      cls[i] = this.classAt(X[i], Y[i])
      area[i] = this.areaAt(X[i], Y[i])
      elev[i] = this.elevAt(X[i], Y[i])
      dist[i] = i === 0 ? 0 : dist[i - 1] + haversine(lon[i - 1], lat[i - 1], lo, la)
    }
    // Water cannot climb: clamp the profile to its running minimum. Seeding the
    // running value from elev[0] meant one missing elevation tile at the start
    // made every elevation NaN, and from there the slope, the speed and the
    // travel time were all NaN too.
    let first = 0
    while (first < n && !Number.isFinite(elev[first])) first++
    let run = first < n ? elev[first] : 0
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(elev[i])) elev[i] = run
      if (elev[i] < run) run = elev[i]
      else elev[i] = run
    }
    // A missing accumulation tile must not poison the discharge either.
    let lastArea = 0
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(area[i])) lastArea = area[i]
      else area[i] = lastArea
    }
    return { x: X, y: Y, lon, lat, elev, area, dist, cls, terminal, truncated }
  }

  // --------------------------------------------------------------- snapping
  /** Highest-accumulation cell within `radius` cells — used to grab a river. */
  /**
   * Move a tap onto the nearest real watercourse — but only if there is one.
   * A hillside click has to stay a hillside click, so the winner must drain
   * several times more land than the cell that was actually tapped; near a
   * river that is always true, on open ground it never is.
   */
  async snapToRiver(px: number, py: number, radius = 8): Promise<[number, number, number]> {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        await this.prime(px + dx * 512, py + dy * 512)
    const here = this.areaAt(px, py) || 0
    const floor = Math.max(4, here * 5)
    let best: [number, number, number] = [px, py, here]
    let bestScore = -1
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = px + dx
        const y = py + dy
        if (!this.inGrid(x, y)) continue
        const a = this.areaAt(x, y)
        if (!(a >= floor)) continue
        // prefer the biggest river, but not one far away over one underfoot
        const score = Math.log10(a + 1) - Math.hypot(dx, dy) / (radius + 1)
        if (score > bestScore) { bestScore = score; best = [x, y, a] }
      }
    return best
  }

  // -------------------------------------------------------------- watershed
  /**
   * Every cell that drains into (px,py). A bitset over the whole grid keeps the
   * visited test to one bit per cell (27 MB for the whole of Europe) instead of
   * a hash set with millions of entries.
   */
  async watershed(
    px: number, py: number,
    onProgress?: (cells: number) => void,
    maxCells = 14_000_000,
  ): Promise<Watershed> {
    const W = this.m.width
    const H = this.m.height
    const ox = this.m.pixelX0
    const oy = this.m.pixelY0
    if (!this.visited) this.visited = new Uint8Array(Math.ceil((W * H) / 8))
    const bits = this.visited
    bits.fill(0)

    let queue = new Int32Array(1 << 18)
    let qn = 0
    let head = 0
    const push = (x: number, y: number) => {
      if (qn + 2 > queue.length) {
        const q = new Int32Array(Math.min(queue.length * 2, 40_000_000))
        q.set(queue.subarray(0, qn))
        queue = q
      }
      queue[qn++] = x
      queue[qn++] = y
    }
    const mark = (x: number, y: number) => {
      const i = (y - oy) * W + (x - ox)
      bits[i >> 3] |= 1 << (i & 7)
    }
    const seen = (x: number, y: number) => {
      const i = (y - oy) * W + (x - ox)
      return (bits[i >> 3] >> (i & 7)) & 1
    }

    push(px, py)
    mark(px, py)
    let x0 = px, y0 = py, x1 = px, y1 = py
    let count = 0
    let area = 0
    let complete = true
    while (head < qn) {
      if (count >= maxCells) { complete = false; break }
      const x = queue[head++]
      const y = queue[head++]
      count++
      const cs = cellSize(y, this.zoom)
      area += (cs * cs) / 1e6
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
      if (!this.tiles.has('flow', x >> 9, y >> 9)) await this.tiles.load('flow', x >> 9, y >> 9)
      for (let k = 1; k <= 8; k++) {
        const nx = x - DX[k]
        const ny = y - DY[k]
        if (!this.inGrid(nx, ny) || seen(nx, ny)) continue
        if (!this.tiles.has('flow', nx >> 9, ny >> 9)) await this.tiles.load('flow', nx >> 9, ny >> 9)
        if (this.dirAt(nx, ny) !== k) continue
        mark(nx, ny)
        push(nx, ny)
      }
      if (onProgress && (count & 0x3ffff) === 0) onProgress(count)
    }

    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const mask = new Uint8Array(w * h)
    for (let y = y0; y <= y1; y++) {
      const row = (y - oy) * W - ox
      const out = (y - y0) * w - x0
      for (let x = x0; x <= x1; x++) {
        const i = row + x
        if ((bits[i >> 3] >> (i & 7)) & 1) mask[out + x] = 1
      }
    }
    return { mask, x0, y0, w, h, area, cells: count, complete }
  }

  // ---------------------------------------------------------------- upstream
  /**
   * The tributary network above a point, breadth-first so that the client can
   * animate it in reverse: main stem, then tributaries, then headwaters.
   */
  async upstream(
    px: number, py: number, minArea: number, maxSegments = 3000,
  ): Promise<{ paths: Float32Array[]; depth: Int32Array; area: Float32Array }> {
    const paths: Float32Array[] = []
    const depth: number[] = []
    const areas: number[] = []
    const jobs: { x: number; y: number; d: number }[] = [{ x: px, y: py, d: 0 }]
    let guard = 0
    while (jobs.length && paths.length < maxSegments && guard++ < 200000) {
      const job = jobs.shift()!
      const pts: number[] = []
      let x = job.x
      let y = job.y
      let a0 = 0
      for (let step = 0; step < 40000; step++) {
        await this.prime(x, y)
        const [lo, la] = this.lonLatOf(x, y)
        pts.push(lo, la)
        if (a0 === 0) a0 = this.areaAt(x, y)
        const ups: [number, number, number][] = []
        for (let k = 1; k <= 8; k++) {
          const nx = x - DX[k]
          const ny = y - DY[k]
          if (!this.inGrid(nx, ny)) continue
          if (!this.tiles.has('flow', nx >> 9, ny >> 9)) await this.tiles.load('flow', nx >> 9, ny >> 9)
          if (this.dirAt(nx, ny) !== k) continue
          if (!this.tiles.has('acc', nx >> 9, ny >> 9)) await this.tiles.load('acc', nx >> 9, ny >> 9)
          const a = this.areaAt(nx, ny)
          if (a >= minArea) ups.push([nx, ny, a])
        }
        if (!ups.length) break
        ups.sort((p, q) => q[2] - p[2])
        for (let i = 1; i < ups.length; i++)
          jobs.push({ x: ups[i][0], y: ups[i][1], d: job.d + 1 })
        x = ups[0][0]
        y = ups[0][1]
      }
      if (pts.length >= 4) {
        paths.push(Float32Array.from(pts))
        depth.push(job.d)
        areas.push(a0)
      }
    }
    return { paths, depth: Int32Array.from(depth), area: Float32Array.from(areas) }
  }

  // --------------------------------------------------------------- rainfall
  /**
   * Trace many drops at once for the rainfall simulation.
   *
   * Storm paths are only ever drawn, never measured, so they are subsampled
   * and capped: thousands of full-resolution continental routes would be tens
   * of millions of vertices and would stall the page.
   */
  async rain(
    seeds: [number, number][], maxSteps = 30000, stride = 3, maxPoints = 1200,
  ): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (const [lon, lat] of seeds) {
      let [x, y] = this.cellOf(lon, lat)
      if (!this.inGrid(x, y)) continue
      const pts: number[] = []
      for (let s = 0; s < maxSteps && pts.length < maxPoints * 2; s++) {
        if (!this.tiles.has('flow', x >> 9, y >> 9)) await this.tiles.load('flow', x >> 9, y >> 9)
        const b = this.byteAt(x, y)
        if (s % stride === 0) {
          const [lo, la] = this.lonLatOf(x, y)
          pts.push(lo, la)
        }
        if ((b & 15) === 0) break
        x += DX[b & 15]
        y += DY[b & 15]
        if (!this.inGrid(x, y)) break
      }
      if (pts.length >= 4) out.push(Float32Array.from(pts))
    }
    return out
  }
}
