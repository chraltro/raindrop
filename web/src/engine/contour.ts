/**
 * Turn a binary raster mask into closed lon/lat rings.
 *
 * Boundary edges of the "inside" cells are collected on the integer lattice and
 * stitched head-to-tail, which gives topologically clean rings (including
 * holes) without any of the ambiguity of naive marching squares.
 */
import { pixelToLat, pixelToLon } from './grid'
import { simplify } from './geo'

export interface MaskRaster {
  mask: Uint8Array
  x0: number
  y0: number
  w: number
  h: number
}

/** Box-downsample a mask; a coarse cell is set when any fine cell is set. */
export function shrink(r: MaskRaster, f: number): MaskRaster {
  if (f <= 1) return r
  const w = Math.ceil(r.w / f)
  const h = Math.ceil(r.h / f)
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < r.h; y++) {
    const oy = ((y / f) | 0) * w
    const ry = y * r.w
    for (let x = 0; x < r.w; x++) if (r.mask[ry + x]) mask[oy + ((x / f) | 0)] = 1
  }
  return { mask, x0: Math.floor(r.x0 / f), y0: Math.floor(r.y0 / f), w, h }
}

/** Closed rings in lon/lat for a mask expressed at `zoom` (after shrinking by f). */
export function maskToRings(r: MaskRaster, zoom: number, f = 1, tol = 0.004): number[][][] {
  const { mask, w, h } = r
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x])
  // directed edges so that the inside stays on the left
  const next = new Map<number, number[]>()
  const key = (x: number, y: number) => y * (w + 2) + x
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = key(ax, ay)
    const arr = next.get(k)
    if (arr) arr.push(bx, by)
    else next.set(k, [bx, by])
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      if (!at(x, y - 1)) add(x, y, x + 1, y)
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1)
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1)
      if (!at(x - 1, y)) add(x, y + 1, x, y)
    }

  const rings: number[][][] = []
  const used = new Set<string>()
  for (const [k, v] of next) {
    for (let i = 0; i < v.length; i += 2) {
      const sig = `${k}:${i}`
      if (used.has(sig)) continue
      // walk the ring
      const pts: number[][] = []
      let cx = k % (w + 2)
      let cy = (k / (w + 2)) | 0
      let nx = v[i]
      let ny = v[i + 1]
      used.add(sig)
      pts.push([cx, cy])
      let guard = 0
      while (guard++ < 4_000_000) {
        pts.push([nx, ny])
        const kk = key(nx, ny)
        const arr = next.get(kk)
        if (!arr) break
        let picked = -1
        for (let j = 0; j < arr.length; j += 2) {
          if (used.has(`${kk}:${j}`)) continue
          picked = j
          break
        }
        if (picked < 0) break
        used.add(`${kk}:${picked}`)
        cx = nx; cy = ny
        nx = arr[picked]
        ny = arr[picked + 1]
        if (nx === pts[0][0] && ny === pts[0][1]) { pts.push([nx, ny]); break }
      }
      if (pts.length > 6) rings.push(pts)
    }
  }

  // integer lattice -> lon/lat, then simplify
  return rings
    .map((ring) => {
      const ll = ring.map(([x, y]) => [
        pixelToLon((r.x0 + x) * f, zoom),
        pixelToLat((r.y0 + y) * f, zoom),
      ])
      return simplify(ll, tol)
    })
    .filter((ring) => ring.length > 4)
    .sort((a, b) => b.length - a.length)
}

/** Pick a shrink factor that keeps ring extraction fast for huge basins. */
export function autoShrink(cells: number): number {
  if (cells > 4_000_000) return 8
  if (cells > 800_000) return 4
  if (cells > 120_000) return 2
  return 1
}
