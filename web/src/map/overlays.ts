/**
 * Continental overlays are colour-mapped in the browser from the small
 * overview rasters, which means the seasonal slider can recolour precipitation
 * or snowpack for any month without downloading anything new.
 */
import { Climate, type ClimateSample } from '../engine/climate'
import { decodeArea, pixelToLat, pixelToLon, type Manifest } from '../engine/grid'
import type { Overlay } from '../state/store'

type Ramp = [number, [number, number, number]][]

// Tuned for the range most of Europe actually sits in (300-1500 mm), where a
// smooth blue ramp would show almost no contrast at all.
const RAMP_PRECIP: Ramp = [
  [0, [120, 60, 25]], [200, [190, 140, 60]], [400, [228, 214, 118]],
  [600, [150, 205, 108]], [800, [64, 180, 140]], [1200, [38, 138, 202]],
  [1800, [48, 78, 210]], [2800, [122, 58, 200]], [4500, [220, 90, 190]],
]
const RAMP_SNOW: Ramp = [
  [0, [10, 20, 40]], [20, [40, 80, 140]], [80, [90, 150, 210]],
  [250, [170, 210, 240]], [600, [230, 245, 255]], [1500, [255, 255, 255]],
]
const RAMP_RUNOFF: Ramp = [
  [0, [80, 50, 30]], [50, [140, 120, 70]], [150, [110, 170, 130]],
  [350, [50, 150, 180]], [700, [40, 90, 200]], [1500, [120, 70, 210]],
]
const RAMP_ELEV: Ramp = [
  [-500, [12, 30, 55]], [0, [70, 120, 150]], [1, [70, 110, 70]],
  [250, [130, 155, 95]], [700, [190, 175, 110]], [1400, [170, 130, 95]],
  [2200, [160, 150, 150]], [3200, [235, 240, 245]], [4500, [255, 255, 255]],
]

function rampAt(r: Ramp, v: number): [number, number, number] {
  if (v <= r[0][0]) return r[0][1]
  for (let i = 1; i < r.length; i++) {
    if (v <= r[i][0]) {
      const t = (v - r[i - 1][0]) / (r[i][0] - r[i - 1][0] || 1)
      const a = r[i - 1][1]
      const b = r[i][1]
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    }
  }
  return r[r.length - 1][1]
}

interface Raster { data: Uint8ClampedArray; width: number; height: number }

async function readRGB(url: string): Promise<Raster> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const bmp = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none', premultiplyAlpha: 'none',
  })
  const cv = document.createElement('canvas')
  cv.width = bmp.width
  cv.height = bmp.height
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const width = bmp.width
  const height = bmp.height
  const img = ctx.getImageData(0, 0, width, height)
  bmp.close()          // closing zeroes bmp.width/height, so read them first
  return { data: img.data, width, height }
}

export class Overlays {
  private precip?: Raster
  private temp?: Raster
  private runoff?: Raster
  private flowacc?: Raster
  private elev?: Raster
  ready = false

  constructor(private base: string, private m: Manifest) {}

  /** lon/lat bounds of the overview raster (also the bounds of every overlay). */
  get bounds(): [number, number, number, number] {
    const z = this.m.zoom
    const x0 = this.m.pixelX0
    const y0 = this.m.pixelY0
    const f = this.m.overviewFactor
    const x1 = x0 + this.m.overviewWidth * f
    const y1 = y0 + this.m.overviewHeight * f
    return [pixelToLon(x0, z), pixelToLat(y1, z), pixelToLon(x1, z), pixelToLat(y0, z)]
  }

  async load() {
    const [p, t, r, f, e] = await Promise.all([
      readRGB(`${this.base}/climate/precip.png`),
      readRGB(`${this.base}/climate/temp.png`),
      readRGB(`${this.base}/climate/runoff.png`),
      readRGB(`${this.base}/overview/flowacc.png`),
      readRGB(`${this.base}/overview/elev.png`),
    ])
    this.precip = p; this.temp = t; this.runoff = r; this.flowacc = f; this.elev = e
    this.ready = true
  }

  sampleAt(i: number): ClimateSample {
    const p = this.precip!.data
    const t = this.temp!.data
    const r = this.runoff!.data
    return {
      precip: (p[i] << 8) | p[i + 1],
      seasonAmp: p[i + 2] / 255,
      temp: t[i] / 4 - 40,
      tempAmp: t[i + 1] / 6,
      seasonPhase: t[i + 2] / 20,
      runoff: (r[i] << 8) | r[i + 1],
      specRunoff: 0,
    }
  }

  /** Colour-mapped RGBA image for the requested overlay. */
  render(kind: Overlay, month: number, seasonal: boolean): ImageData | null {
    if (!this.ready || kind === 'none') return null
    const w = this.precip!.width
    const h = this.precip!.height
    const out = new ImageData(w, h)
    const o = out.data
    const elev = this.elev!.data
    const acc = this.flowacc!.data

    for (let i = 0, px = 0; px < w * h; px++, i += 4) {
      const e = ((elev[i] << 8) | elev[i + 1]) - this.m.overviewElevOffset
      let rgb: [number, number, number] = [0, 0, 0]
      let alpha = 205

      if (kind === 'elevation' || kind === 'slope') {
        if (kind === 'slope') {
          const x = px % w
          const y = (px / w) | 0
          const gx = this.elevAtPx(Math.min(w - 1, x + 1), y) - this.elevAtPx(Math.max(0, x - 1), y)
          const gy = this.elevAtPx(x, Math.min(h - 1, y + 1)) - this.elevAtPx(x, Math.max(0, y - 1))
          const cell = (40075016.686 / (256 * (1 << this.m.zoom))) * this.m.overviewFactor
          const s = Math.atan(Math.hypot(gx, gy) / (2 * cell)) * (180 / Math.PI)
          const t = Math.min(1, s / 32)
          rgb = [30 + 225 * t, 200 - 150 * t, 255 - 200 * t]
          alpha = e <= 0 ? 0 : 60 + 190 * t
        } else {
          rgb = rampAt(RAMP_ELEV, e)
          alpha = 215
        }
      } else if (kind === 'flowacc') {
        const a = decodeArea(acc[i], this.m.accScale)
        if (a < 3 || e < -20) { o[i + 3] = 0; continue }
        const t = Math.min(1, Math.log10(a) / 6)
        rgb = [40 + 60 * t, 150 + 90 * t, 220 + 35 * t]
        alpha = 60 + 195 * Math.min(1, Math.log10(a) / 3.2)
      } else {
        const c = this.sampleAt(i)
        if (e < -20) { o[i + 3] = 0; continue }
        if (kind === 'precip') {
          const v = seasonal
            ? c.precip * (1 / 12) * (1 + c.seasonAmp * Math.cos((2 * Math.PI * (month - c.seasonPhase)) / 12)) * 12
            : c.precip
          rgb = rampAt(RAMP_PRECIP, v)
        } else if (kind === 'runoff') {
          rgb = rampAt(RAMP_RUNOFF, c.runoff)
        } else {
          const s = Climate.seasons(c)
          const pack = s.snowpack[month]
          if (pack < 2) { o[i + 3] = 0; continue }
          rgb = rampAt(RAMP_SNOW, pack)
          alpha = Math.min(235, 60 + pack)
        }
      }
      o[i] = rgb[0]
      o[i + 1] = rgb[1]
      o[i + 2] = rgb[2]
      o[i + 3] = alpha
    }
    return out
  }

  private elevAtPx(x: number, y: number): number {
    const i = (y * this.precip!.width + x) * 4
    const d = this.elev!.data
    return ((d[i] << 8) | d[i + 1]) - this.m.overviewElevOffset
  }
}
