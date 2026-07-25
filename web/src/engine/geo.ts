/** Tiny spatial indexes: point-in-polygon lookup and nearest-vertex search. */

type Ring = number[][]
export interface Feat {
  properties: Record<string, unknown>
  geometry: { type: string; coordinates: unknown }
}

function bboxOfRings(rings: Ring[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rings)
    for (const [x, y] of r) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  return [x0, y0, x1, y1]
}

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Uniform-grid index over polygon features for fast point lookup. */
export class PolygonIndex {
  private cells = new Map<number, number[]>()
  private polys: { rings: Ring[]; bbox: [number, number, number, number]; f: Feat }[] = []
  constructor(features: Feat[], private step = 1) {
    for (const f of features) {
      const g = f.geometry
      if (!g) continue
      const parts: Ring[][] =
        g.type === 'Polygon' ? [g.coordinates as Ring[]]
        : g.type === 'MultiPolygon' ? (g.coordinates as Ring[][])
        : []
      for (const rings of parts) {
        const bbox = bboxOfRings(rings)
        const id = this.polys.push({ rings, bbox, f }) - 1
        for (let x = Math.floor(bbox[0] / step); x <= Math.floor(bbox[2] / step); x++)
          for (let y = Math.floor(bbox[1] / step); y <= Math.floor(bbox[3] / step); y++) {
            const k = x * 100000 + y
            const arr = this.cells.get(k)
            if (arr) arr.push(id)
            else this.cells.set(k, [id])
          }
      }
    }
  }

  query(lon: number, lat: number): Feat | null {
    const k = Math.floor(lon / this.step) * 100000 + Math.floor(lat / this.step)
    const ids = this.cells.get(k)
    if (!ids) return null
    for (const id of ids) {
      const p = this.polys[id]
      const b = p.bbox
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue
      if (!pointInRing(lon, lat, p.rings[0])) continue
      let hole = false
      for (let i = 1; i < p.rings.length; i++)
        if (pointInRing(lon, lat, p.rings[i])) { hole = true; break }
      if (!hole) return p.f
    }
    return null
  }
}

/** Nearest-vertex index over line features (used to name a traced path). */
export class LineIndex {
  private cells = new Map<number, number[]>()
  private xs: Float32Array
  private ys: Float32Array
  private owner: Int32Array
  features: Feat[]

  constructor(features: Feat[], private step = 0.1) {
    this.features = features
    let n = 0
    for (const f of features) n += (f.geometry?.coordinates as number[][])?.length ?? 0
    this.xs = new Float32Array(n)
    this.ys = new Float32Array(n)
    this.owner = new Int32Array(n)
    let i = 0
    features.forEach((f, fi) => {
      const cs = f.geometry?.coordinates as number[][] | undefined
      if (!cs) return
      for (const c of cs) {
        this.xs[i] = c[0]
        this.ys[i] = c[1]
        this.owner[i] = fi
        const k = Math.floor(c[0] / step) * 100000 + Math.floor(c[1] / step)
        const arr = this.cells.get(k)
        if (arr) arr.push(i)
        else this.cells.set(k, [i])
        i++
      }
    })
  }

  /** Index of the closest vertex within `maxDeg`, or -1. */
  nearest(lon: number, lat: number, maxDeg: number): number {
    const cx = Math.floor(lon / this.step)
    const cy = Math.floor(lat / this.step)
    const r = Math.max(1, Math.ceil(maxDeg / this.step))
    let best = -1
    let bestD = maxDeg * maxDeg
    const kx = Math.cos((lat * Math.PI) / 180)
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++) {
        const ids = this.cells.get(x * 100000 + y)
        if (!ids) continue
        for (const id of ids) {
          const dx = (this.xs[id] - lon) * kx
          const dy = this.ys[id] - lat
          const d = dx * dx + dy * dy
          if (d < bestD) { bestD = d; best = id }
        }
      }
    return best
  }

  featureOf(vertex: number): Feat | null {
    return vertex < 0 ? null : this.features[this.owner[vertex]]
  }

  /**
   * Nearest reach that also *carries about the right amount of water*.
   *
   * At a confluence the closest vertex often belongs to the tributary rather
   * than to the river the drop is actually in, so candidates are scored by
   * distance multiplied by how far their drainage area is from the expected
   * one.  Without this a journey down the Danube reads as a list of every
   * stream that joins it.
   */
  bestNear(lon: number, lat: number, maxDeg: number, targetArea: number): Feat | null {
    const cx = Math.floor(lon / this.step)
    const cy = Math.floor(lat / this.step)
    const r = Math.max(1, Math.ceil(maxDeg / this.step))
    const kx = Math.cos((lat * Math.PI) / 180)
    let best: Feat | null = null
    let bestScore = Infinity
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++) {
        const ids = this.cells.get(x * 100000 + y)
        if (!ids) continue
        for (const id of ids) {
          const dx = (this.xs[id] - lon) * kx
          const dy = this.ys[id] - lat
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d > maxDeg) continue
          const f = this.features[this.owner[id]]
          const up = (f.properties.up as number) ?? 0
          const dn = (f.properties.dn as number) ?? up
          const mid = Math.max(1, (up + dn) / 2)
          const penalty = 1 + Math.abs(Math.log(mid / Math.max(targetArea, 1))) * 1.6
          const score = (d + maxDeg * 0.08) * penalty
          if (score < bestScore) { bestScore = score; best = f }
        }
      }
    return best
  }
}

/** Ramer–Douglas–Peucker simplification for lon/lat rings. */
export function simplify(points: number[][], tol: number): number[][] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let maxD = 0
    let idx = -1
    const [ax, ay] = points[a]
    const [bx, by] = points[b]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy || 1e-12
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
      const qx = ax + t * dx
      const qy = ay + t * dy
      const d = (px - qx) ** 2 + (py - qy) ** 2
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > tol * tol && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  const out: number[][] = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}
