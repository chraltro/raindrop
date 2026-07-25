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
import { CLASS, type Manifest } from './grid'

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

const post = (id: number, payload: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage({ id, payload }, transfer)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** `true` keeps the old fixed radius; a number is the radius in flow cells. */
const snapRadius = (v: number | boolean) => (typeof v === 'number' ? v : 10)

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
    cls: p.cls, terminal: p.terminal, truncated: p.truncated,
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

async function trace(lon: number, lat: number, snap: number | boolean = 0) {
  await indexes
  await Promise.race([climateReady, sleep(2500)])
  let [px, py] = engine.cellOf(lon, lat)
  await engine.prime(px, py, true)
  if (snap) {
    const [sx, sy] = await engine.snapToRiver(px, py, snapRadius(snap))
    px = sx
    py = sy
  }
  const path = await engine.traceDown(px, py)
  const end = path.lon.length - 1
  const stats: PathStats = analysePath(path, {
    rivers: riverIx, countries: countryIx, lakes: lakeIx, basins: basinByOutlet,
  }, specRunoffAt(path.lon[end], path.lat[end]))
  const basin = stats.basinId != null ? basinById.get(stats.basinId) : null
  const start = {
    lon: path.lon[0], lat: path.lat[0],
    elev: path.elev[0], area: path.area[0],
    cls: path.cls[0],
    climate: climate.sample(lon, lat),
    sizeClass: sizeClass(path.area[0]),
  }
  return { path: serialise(path), stats, basin, start }
}

async function watershed(lon: number, lat: number, snap: number | boolean) {
  let [px, py] = engine.cellOf(lon, lat)
  if (snap) {
    const s = await engine.snapToRiver(px, py, snapRadius(snap))
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
    const s = await engine.snapToRiver(px, py, snapRadius(snap))
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
    if (payload?.paths) for (const p of payload.paths) transfer.push(p.buffer)
    post(id, payload, transfer)
  } catch (err) {
    post(id, { error: String((err as Error)?.message ?? err) })
  }
}
