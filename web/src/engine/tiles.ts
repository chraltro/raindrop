/**
 * Tile cache for the published hydrology rasters.
 *
 * Tiles are 8-bit greyscale PNGs; they are decoded with `createImageBitmap`
 * into an OffscreenCanvas so that the raw byte values survive untouched
 * (no colour management, no premultiplied alpha).
 */
import type { Manifest } from './grid'
import { CLASS } from './grid'

type Layer = 'flow' | 'acc' | 'elev'

const OCEAN_BYTE = CLASS.OCEAN << 4

export class TileCache {
  private cache = new Map<string, Uint8Array>()
  private pending = new Map<string, Promise<Uint8Array>>()
  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  private available: Record<Layer, Set<string> | null> = { flow: null, acc: null, elev: null }
  bytesLoaded = 0
  tilesLoaded = 0

  constructor(private baseUrl: string, public manifest: Manifest) {
    this.available.flow = new Set(manifest.flowTiles)
    this.available.acc = new Set(manifest.accTiles)
    this.available.elev = new Set(Object.keys(manifest.elevTiles))
  }

  key(layer: Layer, sx: number, sy: number): string {
    return `${layer}/${sx}/${sy}`
  }

  has(layer: Layer, sx: number, sy: number): boolean {
    return this.cache.has(this.key(layer, sx, sy))
  }

  exists(layer: Layer, sx: number, sy: number): boolean {
    const set = this.available[layer]
    return set ? set.has(`${sx}/${sy}`) : true
  }

  get(layer: Layer, sx: number, sy: number): Uint8Array | undefined {
    return this.cache.get(this.key(layer, sx, sy))
  }

  /** Load a tile, returning a filled "all ocean" tile when none was published. */
  async load(layer: Layer, sx: number, sy: number): Promise<Uint8Array> {
    const key = this.key(layer, sx, sy)
    const hit = this.cache.get(key)
    if (hit) return hit
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const size = layer === 'acc' ? this.manifest.accTileSize : this.manifest.superTile
    if (!this.exists(layer, sx, sy)) {
      const empty = new Uint8Array(size * size)
      if (layer === 'flow') empty.fill(OCEAN_BYTE)
      this.cache.set(key, empty)
      return empty
    }

    const p = this.fetchTile(`${this.baseUrl}/${key}.png`, size)
      .then((data) => {
        this.cache.set(key, data)
        this.pending.delete(key)
        this.tilesLoaded++
        this.bytesLoaded += data.length
        return data
      })
      .catch(() => {
        const empty = new Uint8Array(size * size)
        if (layer === 'flow') empty.fill(OCEAN_BYTE)
        this.cache.set(key, empty)
        this.pending.delete(key)
        return empty
      })
    this.pending.set(key, p)
    return p
  }

  private async fetchTile(url: string, size: number): Promise<Uint8Array> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${url}`)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    })
    if (!this.canvas || this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
      this.canvas = new OffscreenCanvas(bmp.width, bmp.height)
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    }
    const ctx = this.ctx!
    ctx.clearRect(0, 0, bmp.width, bmp.height)
    ctx.drawImage(bmp, 0, 0)
    const w = bmp.width
    const h = bmp.height
    const img = ctx.getImageData(0, 0, w, h).data
    bmp.close()
    const out = new Uint8Array(size * size)
    const n = Math.min(out.length, (w * h) | 0)
    for (let i = 0; i < n; i++) out[i] = img[i * 4]
    return out
  }

  /** Number of bytes held in memory (rough). */
  get memory(): number {
    let n = 0
    for (const v of this.cache.values()) n += v.length
    return n
  }

  evictIfLarge(limit = 220 * 1024 * 1024) {
    if (this.memory < limit) return
    const keys = [...this.cache.keys()]
    for (let i = 0; i < keys.length / 2; i++) this.cache.delete(keys[i])
  }
}
