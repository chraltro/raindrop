/// <reference lib="webworker" />
/**
 * All hydrology runs here so that a five-million-cell watershed fill never
 * blocks the map.  The protocol is a plain request/response with an id.
 */
import { FlowEngine, type TracedPath } from './flow'
import { TileCache } from './tiles'
import { Climate } from './climate'
import { LineIndex, PolygonIndex, type Feat } from './geo'
import { analysePath, sizeClass, type PathStats } from './analysis'
import { autoShrink, maskToRings, shrink } from './contour'
import { CLASS, cellSize, haversine, pixelToLat, pixelToLon, type Manifest } from './grid'
import { DemCache, DETAIL_ZOOM, traceDetail, watershedDetail, type DetailTrace, type StreamSet } from './detail'

let base = ''
let manifest: Manifest
let engine: FlowEngine
let climate: Climate
let riverIx: LineIndex
let countryIx: PolygonIndex
let lakeIx: PolygonIndex
let basinByOutlet = new Map<string, any>()
let basinById = new Map<number, any>()
let indexes: Promise<void> = Promise.resolve()
let climateReady: Promise<void> = Promise.resolve()
let basinList: { px: number; py: number; sea: string }[] = []
const dem = new DemCache()
// If the elevation service is unreachable every tap would otherwise pay for its
// retries. After two failures in a row detail mode rests for a minute.
let detailFailures = 0
let detailRestUntil = 0

const post = (id: number, payload: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage({ id, payload }, transfer)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * How far a tap may be moved onto a river, in metres: a number is the radius,
 * `true` is the generous one used when the user asked to snap.
 */
const snapMetres = (v: number | boolean) => (typeof v === 'number' ? v : v ? 3000 : 0)
const snapCells = (v: number | boolean, py: number) =>
  Math.max(1, Math.round(snapMetres(v) / cellSize(py, engine.zoom)))

const detailAllowed = () => performance.now() >= detailRestUntil
const detailFailed = () => {
  if (++detailFailures >= 2) { detailRestUntil = performance.now() + 60_000; detailFailures = 0 }
}

/**
 * A phone on a train drops requests. Without a retry, one lost response used to
 * be permanent: the naming indexes never resolved, and because every trace
 * awaits them, tracing stayed dead for the rest of the session.
 */
async function getJSON<T>(path: string, tries = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/${path}`)
      if (!r.ok) throw new Error(`${r.status} ${path}`)
      return (await r.json()) as T
    } catch (e) {
      last = e
      if (i < tries - 1) await sleep(300 * 2 ** i)
    }
  }
  throw last
}

async function init(url: string) {
  base = url.replace(/\/$/, '')
  manifest = await getJSON<Manifest>('grid.json')
  engine = new FlowEngine(new TileCache(base, manifest), manifest)
  climate = new Climate(base, manifest)

  // Only the small, essential pieces block "ready" — the map becomes usable
  // as soon as a drop can be routed. The naming indexes are several megabytes
  // and load in the background; a trace waits for them only if one arrives
  // first.
  // Rainfall, snow and runoff are 5.5 MB of rasters that only decorate an
  // answer. Waiting for them before the first click meant a phone on a weak
  // connection sat on the loading screen for a minute with a working engine.
  climateReady = climate.load().catch(() => {})
  const basins = await getJSON<any[]>('basins.json')
  for (const b of basins) {
    basinByOutlet.set(`${b.px},${b.py}`, b)
    basinById.set(b.id, b)
  }
  basinList = basins.map((b) => ({ px: b.px, py: b.py, sea: b.sea }))

  // Names are a garnish: if an index cannot be fetched the routing still has to
  // work, so each one falls back to empty and the promise never rejects.
  const none = { features: [] as Feat[] }
  indexes = (async () => {
    const [rivers, countries, lakes, lakesEu] = await Promise.all([
      getJSON<{ features: Feat[] }>('rivers-lod1.json').catch(() => none),
      getJSON<{ features: Feat[] }>('vector/countries.json').catch(() => none),
      getJSON<{ features: Feat[] }>('vector/lakes.json').catch(() => none),
      getJSON<{ features: Feat[] }>('vector/lakes_eu.json').catch(() => none),
    ])
    riverIx = new LineIndex(rivers.features, 0.08)
    countryIx = new PolygonIndex(countries.features, 1)
    lakeIx = new PolygonIndex([...lakes.features, ...lakesEu.features], 0.5)
  })().catch(() => {
    riverIx = new LineIndex([], 0.08)
    countryIx = new PolygonIndex([], 1)
    lakeIx = new PolygonIndex([], 0.5)
  })

  return { manifest, basins: basins.length }
}

function serialise(p: TracedPath) {
  return {
    lon: p.lon, lat: p.lat, elev: p.elev, area: p.area, dist: p.dist,
    cls: p.cls, terminal: p.terminal, truncated: p.truncated, seaAt: p.seaAt,
    detail: p.detail, join: p.join, startElev: p.startElev,
    x: p.x, y: p.y,
  }
}

const transferOf = (p: TracedPath) =>
  [p.lon.buffer, p.lat.buffer, p.elev.buffer, p.area.buffer, p.dist.buffer,
   p.cls.buffer, p.x.buffer, p.y.buffer] as Transferable[]

function specRunoffAt(lon: number, lat: number): number {
  const c = climate.sample(lon, lat)
  return c && c.specRunoff > 0 ? c.specRunoff : 300
}

/** The sea nearest a continental-grid cell: names a coast the basins do not reach. */
function nearestSea(px: number, py: number): string | null {
  let best: string | null = null
  let bd = Infinity
  for (const b of basinList) {
    const d = (b.px - px) ** 2 + (b.py - py) ** 2
    if (d < bd) { bd = d; best = b.sea }
  }
  return best
}

/**
 * Join the fine-resolution start of a route to the continental trace that
 * carries it the rest of the way.
 */
async function assemble(det: DetailTrace): Promise<TracedPath> {
  const z = DETAIL_ZOOM
  const sh = z - engine.zoom
  const hn = det.x.length
  let coarse: TracedPath | null = null
  if (det.join) {
    await engine.prime(det.join[0], det.join[1], true)
    coarse = await engine.traceDown(det.join[0], det.join[1])
  }
  const cn = coarse ? coarse.lon.length : 0
  const n = hn + cn

  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  const elev = new Float32Array(n)
  const area = new Float32Array(n)
  const dist = new Float64Array(n)
  const cls = new Uint8Array(n)
  const X = new Int32Array(n)
  const Y = new Int32Array(n)
  for (let i = 0; i < hn; i++) {
    lon[i] = pixelToLon(det.x[i] + 0.5, z)
    lat[i] = pixelToLat(det.y[i] + 0.5, z)
    elev[i] = det.elev[i]
    area[i] = det.area[i]
    X[i] = det.x[i] >> sh
    Y[i] = det.y[i] >> sh
    cls[i] = engine.classAt(X[i], Y[i])
  }
  if (coarse) {
    for (let j = 0; j < cn; j++) {
      const i = hn + j
      lon[i] = coarse.lon[j]; lat[i] = coarse.lat[j]
      elev[i] = coarse.elev[j]; area[i] = coarse.area[j]
      cls[i] = coarse.cls[j]; X[i] = coarse.x[j]; Y[i] = coarse.y[j]
    }
  }
  for (let i = 1; i < n; i++)
    dist[i] = dist[i - 1] + haversine(lon[i - 1], lat[i - 1], lon[i], lat[i])

  // The two elevation sources disagree by a few metres to a few tens. Left
  // alone, the profile shows a long flat shelf wherever the coarse one sits
  // higher, so the difference at the seam is faded out over the next 15 km.
  if (coarse && hn) {
    const offset = elev[hn - 1] - elev[hn]
    for (let j = 0; j < cn; j++) {
      const f = 1 - (dist[hn + j] - dist[hn]) / 15000
      if (f <= 0) break
      elev[hn + j] += offset * f
    }
  }
  let run = elev[0]
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(elev[i])) elev[i] = run
    if (elev[i] < run) run = elev[i]
    else elev[i] = run
  }

  return {
    x: X, y: Y, lon, lat, elev, area, dist, cls,
    terminal: coarse ? coarse.terminal : det.end === 'sea' ? CLASS.OCEAN : CLASS.EDGE,
    truncated: coarse ? coarse.truncated : det.end === 'edge',
    seaAt: coarse ? hn + coarse.seaAt : n,
    detail: true, join: coarse ? hn : n, startElev: det.startElev,
  }
}

async function trace(lon: number, lat: number, snap: number | boolean = 0) {
  await indexes
  await Promise.race([climateReady, sleep(2500)])
  let [px, py] = engine.cellOf(lon, lat)
  await engine.prime(px, py, true)

  let path: TracedPath | null = null
  let streams: StreamSet | null = null
  if (detailAllowed() && engine.inGrid(px, py)) {
    try {
      const det = await traceDetail(engine, dem, lon, lat, snapMetres(snap))
      if (det && det.x.length) {
        path = await assemble(det)
        streams = det.streams
      }
      detailFailures = 0
    } catch {
      detailFailed()
    }
  }
  if (!path) {
    if (snap) {
      const [sx, sy] = await engine.snapToRiver(px, py, snapCells(snap, py))
      px = sx
      py = sy
    }
    path = await engine.traceDown(px, py)
  }

  const end = path.lon.length - 1
  const stats: PathStats = analysePath(path, {
    rivers: riverIx, countries: countryIx, lakes: lakeIx, basins: basinByOutlet, nearestSea,
  }, specRunoffAt(path.lon[end], path.lat[end]))
  const basin = stats.basinId != null ? basinById.get(stats.basinId) : null
  const start = {
    lon: path.lon[0], lat: path.lat[0],
    elev: path.startElev ?? path.elev[0], area: path.area[0],
    cls: path.cls[0],
    climate: climate.sample(lon, lat),
    sizeClass: sizeClass(path.area[0], path.detail),
  }
  return { path: serialise(path), stats, basin, start, streams }
}

async function watershed(lon: number, lat: number, snap: number | boolean) {
  let [px, py] = engine.cellOf(lon, lat)
  // A small catchment is a few dozen continental cells and reads as a smear;
  // on terrain data it is an outline. If it runs off the loaded window the
  // basin is big enough for the continental grid, which then answers instead.
  if (detailAllowed() && engine.inGrid(px, py)) {
    try {
      const fine = await watershedDetail(engine, dem, lon, lat, snapMetres(snap))
      if (fine && fine.complete && fine.rings.length) return fine
    } catch { /* fall through to the continental grid */ }
  }
  if (snap) {
    const s = await engine.snapToRiver(px, py, snapCells(snap, py))
    px = s[0]; py = s[1]
  }
  await engine.prime(px, py)
  const ws = await engine.watershed(px, py)
  const f = autoShrink(ws.cells)
  const rings = maskToRings(shrink(ws, f), engine.zoom, f, f > 2 ? 0.01 : 0.004)
  return {
    rings, area: ws.area, cells: ws.cells, complete: ws.complete,
    outletArea: engine.areaAt(px, py),
    lon: engine.lonLatOf(px, py)[0], lat: engine.lonLatOf(px, py)[1],
  }
}

async function upstream(lon: number, lat: number, snap: number | boolean) {
  await indexes
  let [px, py] = engine.cellOf(lon, lat)
  if (snap) {
    const s = await engine.snapToRiver(px, py, snapCells(snap, py))
    px = s[0]; py = s[1]
  }
  await engine.prime(px, py)
  const area = engine.areaAt(px, py)
  const minArea = Math.max(1.5, area / 700)
  const up = await engine.upstream(px, py, minArea)
  const names: (string | undefined)[] = up.paths.map((p) => {
    const v = riverIx.nearest(p[0], p[1], 0.05)
    return (riverIx.featureOf(v)?.properties?.name as string) ?? undefined
  })
  return {
    paths: up.paths, depth: up.depth, area: up.area, names,
    root: { lon: engine.lonLatOf(px, py)[0], lat: engine.lonLatOf(px, py)[1], area },
  }
}

async function rain(seeds: [number, number][]) {
  const paths = await engine.rain(seeds)
  return { paths }
}

async function probe(lon: number, lat: number) {
  await indexes
  await Promise.race([climateReady, sleep(2500)])
  const [px, py] = engine.cellOf(lon, lat)
  await engine.prime(px, py, true)
  const cls = engine.classAt(px, py)
  return {
    lon, lat,
    elev: engine.elevAt(px, py),
    area: engine.areaAt(px, py),
    cls,
    isWater: cls === CLASS.OCEAN || cls === CLASS.LAKE,
    climate: climate.sample(lon, lat),
    country: (countryIx.query(lon, lat)?.properties?.name as string) ?? null,
    lake: (lakeIx.query(lon, lat)?.properties?.name as string) ?? null,
  }
}

const handlers: Record<string, (...a: any[]) => Promise<any>> = {
  init: (url: string) => init(url),
  trace: (lon: number, lat: number, snap: number | boolean) => trace(lon, lat, snap),
  watershed: (lon: number, lat: number, snap: number | boolean) => watershed(lon, lat, snap),
  upstream: (lon: number, lat: number, snap: number | boolean) => upstream(lon, lat, snap),
  rain: (seeds: [number, number][]) => rain(seeds),
  probe: (lon: number, lat: number) => probe(lon, lat),
}

self.onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data
  try {
    const payload = await handlers[op](...args)
    const transfer: Transferable[] = []
    if (payload?.path) transfer.push(...transferOf(payload.path as any))
    if (payload?.streams) {
      const st = payload.streams as StreamSet
      transfer.push(st.coords.buffer, st.starts.buffer, st.dn.buffer, st.fade.buffer)
    }
    if (payload?.paths) for (const p of payload.paths) transfer.push(p.buffer)
    post(id, payload, transfer)
  } catch (err) {
    post(id, { error: String((err as Error)?.message ?? err) })
  }
}
