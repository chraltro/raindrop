/** Turning a traced path into the story the information panel tells. */
import type { TracedPath } from './flow'
import { CLASS } from './grid'
import { LineIndex, PolygonIndex, type Feat } from './geo'

export interface JourneyStep {
  label: string
  kind: 'rain' | 'overland' | 'stream' | 'river' | 'lake' | 'sea'
  name?: string
  from: number        // metres along the path
  to: number
  area: number        // drainage area at the end of the step (km²)
  drop: number        // metres of elevation lost in this step
  countries: string[]
}

export interface Tributary {
  name?: string
  at: number          // metres along the path
  area: number        // km² the tributary contributes
  lon: number
  lat: number
}

export interface PathStats {
  distance: number            // m
  travelSeconds: number
  maxElev: number
  minElev: number
  drop: number
  slope: number               // m/m
  countries: string[]
  lakes: string[]
  destination: string
  destinationKind: string
  finalArea: number
  dischargeAtEnd: number      // m³/s (modelled)
  velocityMean: number        // m/s
  steps: JourneyStep[]
  tributaries: Tributary[]
  basinId: number | null
}

export const SIZE_CLASSES: [number, string][] = [
  [0.5, 'Overland flow'],
  [5, 'Headwater stream'],
  [50, 'Stream'],
  [500, 'Small river'],
  [5000, 'River'],
  [50000, 'Major river'],
  [Infinity, 'Great river'],
]

export function sizeClass(area: number): string {
  for (const [lim, label] of SIZE_CLASSES) if (area < lim) return label
  return 'Great river'
}

/**
 * Channel velocity from Manning's equation with hydraulic geometry:
 * R ≈ 0.30 · Q^0.30 (m) and n ≈ 0.040, i.e. v = R^(2/3)·√S / n.
 * Below one square kilometre the water is still moving over the hillslope,
 * which is far slower than channel flow.
 */
export function velocity(area: number, slope: number, specificRunoff = 300): number {
  const s = Math.max(slope, 1e-5)
  if (area < 1) return Math.min(0.6, Math.max(0.03, 1.2 * Math.sqrt(s)))
  const q = (area * specificRunoff) / 31557.6            // m³/s
  const r = 0.3 * Math.pow(Math.max(q, 0.01), 0.3)
  return Math.min(4, Math.max(0.05, (Math.pow(r, 2 / 3) * Math.sqrt(s)) / 0.04))
}

interface Indexes {
  rivers: LineIndex
  countries: PolygonIndex
  lakes: PolygonIndex
  basins: Map<string, { id: number; name: string; sea: string; seaGroup: string; runoff: number }>
}

const nameOf = (f: Feat | null) => (f?.properties?.name as string) ?? undefined

export function analysePath(path: TracedPath, ix: Indexes, specificRunoff: number): PathStats {
  const n = path.lon.length
  const dist = path.dist[n - 1]

  // --- per-point names ------------------------------------------------
  const riverName: (string | undefined)[] = new Array(n)
  const country: (string | undefined)[] = new Array(n)
  const lake: (string | undefined)[] = new Array(n)
  let lastCountry: string | undefined
  const stride = Math.max(1, Math.floor(n / 900))
  for (let i = 0; i < n; i++) {
    if (path.area[i] > 120 && (i % 2 === 0 || i === n - 1)) {
      riverName[i] = nameOf(ix.rivers.bestNear(path.lon[i], path.lat[i], 0.045, path.area[i]))
    }
    if (i % stride === 0 || i === n - 1) {
      const c = ix.countries.query(path.lon[i], path.lat[i])
      lastCountry = (c?.properties?.name as string) ?? lastCountry
      if (path.cls[i] === CLASS.LAKE) lake[i] = nameOf(ix.lakes.query(path.lon[i], path.lat[i]))
    }
    country[i] = lastCountry
  }
  // fill gaps so a reach is not broken by a missed probe, then drop
  // single-point flips (a tributary label caught right at its confluence)
  for (let i = 1; i < n; i++)
    if (!riverName[i] && riverName[i - 1] && path.area[i] >= path.area[i - 1] * 0.9)
      riverName[i] = riverName[i - 1]
  for (let pass = 0; pass < 2; pass++)
    for (let i = 1; i < n - 1; i++)
      if (riverName[i] !== riverName[i - 1] && riverName[i - 1] === riverName[i + 1])
        riverName[i] = riverName[i - 1]
  // A tributary's name sometimes wins for a short run around its confluence.
  // Any run shorter than 25 km whose neighbours agree is that river, not this
  // one, so hand the stretch back to the main stem.
  for (let i = 0; i < n; ) {
    let j = i
    while (j < n && riverName[j] === riverName[i]) j++
    const before = i > 0 ? riverName[i - 1] : undefined
    const after = j < n ? riverName[j] : undefined
    if (i > 0 && j < n && before === after && before !== riverName[i] &&
        path.dist[j - 1] - path.dist[i] < 25000) {
      for (let k = i; k < j; k++) riverName[k] = before
    }
    i = j
  }

  // A river threading between small unnamed ponds should not read as a chain
  // of lakes: only runs of at least 2 km count as passing through one.
  const inLake = new Uint8Array(n)
  for (let i = 0; i < n; ) {
    let j = i
    while (j < n && path.cls[j] === CLASS.LAKE) j++
    if (j > i && path.dist[j - 1] - path.dist[i] >= 2000)
      for (let k = i; k < j; k++) inLake[k] = 1
    i = j > i ? j : i + 1
  }
  // Generalised lake outlines let the routed line slip in and out of the
  // polygon, so a single lake can appear as three. Bridge a gap when the same
  // lake is named on both sides (up to 40 km) or the gap is very short.
  for (let i = 0; i < n; i++) {
    if (!inLake[i]) continue
    let j = i + 1
    while (j < n && !inLake[j] && path.dist[j] - path.dist[i] < 40000) j++
    if (j < n && inLake[j]) {
      const same = lake[i] && lake[j] && lake[i] === lake[j]
      if (same || path.dist[j] - path.dist[i] < 8000)
        for (let k = i; k < j; k++) inLake[k] = 1
    }
    i = j - 1
  }
  for (let i = 1; i < n; i++)
    if (inLake[i] && !lake[i] && lake[i - 1]) lake[i] = lake[i - 1]
  for (let i = n - 2; i >= 0; i--)
    if (inLake[i] && !lake[i] && lake[i + 1]) lake[i] = lake[i + 1]

  // --- travel time -----------------------------------------------------
  // Slope has to be measured over a window: the published elevation is
  // quantised, so adjacent cells are often identical and a cell-to-cell
  // gradient would report a flat, and therefore near-motionless, river.
  const WIN = 12
  let seconds = 0
  let vSum = 0
  for (let i = 1; i < n; i++) {
    const d = path.dist[i] - path.dist[i - 1]
    if (d <= 0) continue
    const a = Math.max(0, i - WIN)
    const b = Math.min(n - 1, i + WIN)
    const run = path.dist[b] - path.dist[a]
    const slope = run > 0
      ? Math.max(3e-5, (path.elev[a] - path.elev[b]) / run)
      : 3e-5
    const v = velocity(path.area[i], slope, specificRunoff)
    seconds += d / v
    vSum += v * d
  }

  // --- journey steps ---------------------------------------------------
  const steps: JourneyStep[] = []
  const push = (s: JourneyStep) => {
    const prev = steps[steps.length - 1]
    if (prev && prev.label === s.label) {
      prev.to = s.to
      prev.area = s.area
      prev.drop += s.drop
      for (const c of s.countries) if (!prev.countries.includes(c)) prev.countries.push(c)
    } else steps.push(s)
  }
  steps.push({
    label: 'Rainfall', kind: 'rain', from: 0, to: 0, area: path.area[0], drop: 0,
    countries: country[0] ? [country[0]] : [],
  })
  for (let i = 0; i < n; i++) {
    const isLake = inLake[i] === 1
    const nm = isLake ? lake[i] : riverName[i]
    const label = isLake ? (nm ?? 'Lake') : (nm ?? sizeClass(path.area[i]))
    push({
      label,
      kind: isLake ? 'lake' : path.area[i] < 0.5 ? 'overland' : path.area[i] < 50 ? 'stream' : 'river',
      name: nm,
      from: i ? path.dist[i - 1] : 0,
      to: path.dist[i],
      area: path.area[i],
      drop: i ? Math.max(0, path.elev[i - 1] - path.elev[i]) : 0,
      countries: country[i] ? [country[i]!] : [],
    })
  }

  // --- destination -----------------------------------------------------
  const term = path.terminal
  const key = `${path.x[n - 1]},${path.y[n - 1]}`
  const basin = ix.basins.get(key)
  let destination = 'the sea'
  let destinationKind = 'sea'
  if (basin) destination = basin.sea
  else if (term === CLASS.LAKE) { destination = lake[n - 1] ?? 'an inland lake'; destinationKind = 'lake' }
  else if (term === CLASS.EDGE) { destination = 'beyond the mapped area'; destinationKind = 'edge' }
  else if (term === CLASS.SINK) { destination = 'an endorheic sink'; destinationKind = 'sink' }
  if (basin?.seaGroup === 'caspian') destinationKind = 'endorheic'
  steps.push({
    label: destination, kind: destinationKind === 'lake' ? 'lake' : 'sea',
    from: dist, to: dist, area: path.area[n - 1], drop: 0,
    countries: country[n - 1] ? [country[n - 1]!] : [],
  })

  // --- tributaries -----------------------------------------------------
  const tributaries: Tributary[] = []
  for (let i = 1; i < n; i++) {
    const gain = path.area[i] - path.area[i - 1]
    if (gain > Math.max(25, path.area[i - 1] * 0.08)) {
      tributaries.push({ at: path.dist[i], area: gain, lon: path.lon[i], lat: path.lat[i] })
    }
  }
  tributaries.sort((a, b) => b.area - a.area)
  const top = tributaries.slice(0, 6)
  for (const t of top) {
    const f = ix.rivers.bestNear(t.lon, t.lat, 0.07, t.area)
    if (f && Math.abs(((f.properties.dn as number) ?? 0) - t.area) / Math.max(t.area, 1) < 3)
      t.name = nameOf(f)
  }

  const countries: string[] = []
  for (const c of country) if (c && !countries.includes(c)) countries.push(c)
  const lakes: string[] = []
  for (const l of lake) if (l && !lakes.includes(l)) lakes.push(l)

  let maxElev = -Infinity
  let minElev = Infinity
  for (let i = 0; i < n; i++) {
    if (path.elev[i] > maxElev) maxElev = path.elev[i]
    if (path.elev[i] < minElev) minElev = path.elev[i]
  }
  const finalArea = path.area[n - 1]

  return {
    distance: dist,
    travelSeconds: seconds,
    maxElev, minElev,
    drop: maxElev - minElev,
    slope: dist > 0 ? (maxElev - minElev) / dist : 0,
    countries, lakes,
    destination, destinationKind,
    finalArea,
    dischargeAtEnd: (finalArea * (basin?.runoff ?? specificRunoff)) / 31557.6,
    velocityMean: dist > 0 ? vSum / dist : 0,
    steps: compress(steps),
    tributaries: top,
    basinId: basin?.id ?? null,
  }
}

/** Collapse micro-steps so the panel shows a readable chain of ~4-12 stages. */
function compress(steps: JourneyStep[]): JourneyStep[] {
  const out: JourneyStep[] = []
  for (const s of steps) {
    const prev = out[out.length - 1]
    const len = s.to - s.from
    if (prev && prev.label === s.label) {
      prev.to = s.to
      prev.area = s.area
      prev.drop += s.drop
      continue
    }
    if (prev && len < 1500 && s.kind !== 'sea' && s.kind !== 'rain' && !s.name) {
      prev.to = s.to
      prev.area = s.area
      prev.drop += s.drop
      continue
    }
    out.push({ ...s })
  }
  // drop tiny named fragments that would clutter the chain
  return out.filter(
    (s, i) => i === 0 || i === out.length - 1 || s.to - s.from > 2500 || s.kind === 'lake',
  )
}
