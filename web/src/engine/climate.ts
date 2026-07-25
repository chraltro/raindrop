/**
 * Client-side climatology and a small snow / runoff model.
 *
 * The rasters are the ones written by the pipeline (station-interpolated
 * precipitation and temperature, Budyko runoff).  Everything derived here —
 * monthly rainfall, snow accumulation and melt, discharge through the year —
 * is a transparent model, not an observation, and the UI says so.
 */
import type { Manifest } from './grid'
import { latToPixel, lonToPixel } from './grid'

export interface ClimateSample {
  precip: number         // mm/yr
  seasonAmp: number      // 0-1 amplitude of the first harmonic
  seasonPhase: number    // month of maximum rainfall (0-11)
  temp: number           // mean annual °C
  tempAmp: number        // half the annual temperature range (K)
  runoff: number         // mm/yr generated locally
  specRunoff: number     // mm/yr accumulated upstream (for discharge)
}

export interface SeasonModel {
  precip: number[]       // mm per month
  snowfall: number[]
  melt: number[]
  snowpack: number[]     // mm water equivalent at month end
  temp: number[]
  runoff: number[]       // mm per month leaving the cell
  discharge: number[]    // relative shape, mean = 1
  snowShare: number      // fraction of runoff that came through the snowpack
  baseflowShare: number
  frozenMonths: number[]
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const DDF = 3.0            // degree-day melt factor, mm °C⁻¹ d⁻¹
const K_STORE = 0.42       // linear reservoir constant (groundwater memory)

export class Climate {
  private precip!: Uint8ClampedArray
  private temp!: Uint8ClampedArray
  private runoff!: Uint8ClampedArray
  private spec!: Uint8ClampedArray
  w = 0
  h = 0
  ready = false

  constructor(private base: string, private m: Manifest) {}

  async load(): Promise<void> {
    const [p, t, r, s] = await Promise.all([
      readRGB(`${this.base}/climate/precip.png`),
      readRGB(`${this.base}/climate/temp.png`),
      readRGB(`${this.base}/climate/runoff.png`),
      readRGB(`${this.base}/climate/specrunoff.png`).catch(() => null),
    ])
    this.precip = p.data
    this.temp = t.data
    this.runoff = r.data
    this.spec = s?.data ?? r.data
    this.w = p.width
    this.h = p.height
    this.ready = true
  }

  index(lon: number, lat: number): number {
    const f = this.m.overviewFactor
    const x = Math.floor((lonToPixel(lon, this.m.zoom) - this.m.pixelX0) / f)
    const y = Math.floor((latToPixel(lat, this.m.zoom) - this.m.pixelY0) / f)
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1
    return (y * this.w + x) * 4
  }

  sample(lon: number, lat: number): ClimateSample | null {
    if (!this.ready) return null
    const i = this.index(lon, lat)
    if (i < 0) return null
    return {
      precip: (this.precip[i] << 8) | this.precip[i + 1],
      seasonAmp: this.precip[i + 2] / 255,
      temp: this.temp[i] / 4 - 40,
      tempAmp: this.temp[i + 1] / 6,
      seasonPhase: this.temp[i + 2] / 20,
      runoff: (this.runoff[i] << 8) | this.runoff[i + 1],
      specRunoff: (this.spec[i] << 8) | this.spec[i + 1],
    }
  }

  /** Twelve-month water balance for a point. */
  static seasons(c: ClimateSample): SeasonModel {
    const precip: number[] = []
    const temp: number[] = []
    for (let m = 0; m < 12; m++) {
      const frac = (1 / 12) * (1 + c.seasonAmp * Math.cos((2 * Math.PI * (m - c.seasonPhase)) / 12))
      precip.push(Math.max(0, c.precip * frac))
      temp.push(c.temp + c.tempAmp * Math.cos((2 * Math.PI * (m - 6)) / 12))
    }
    // spin the snowpack up over three years so it starts in equilibrium
    let pack = 0
    let snowfall: number[] = []
    let melt: number[] = []
    let snowpack: number[] = []
    for (let cycle = 0; cycle < 3; cycle++) {
      snowfall = []; melt = []; snowpack = []
      for (let m = 0; m < 12; m++) {
        const fs = Math.min(1, Math.max(0, (3 - temp[m]) / 4))
        const snow = precip[m] * fs
        pack += snow
        const potential = Math.max(0, temp[m]) * DDF * DAYS[m]
        const mm = Math.min(pack, potential)
        pack -= mm
        snowfall.push(snow)
        melt.push(mm)
        snowpack.push(pack)
      }
    }
    const gross = precip.map((p, m) => p - snowfall[m] + melt[m])
    const grossSum = gross.reduce((a, b) => a + b, 0) || 1
    // linear store: part of the water leaves this month, the rest later
    let store = 0
    let out: number[] = []
    for (let cycle = 0; cycle < 3; cycle++) {
      out = []
      for (let m = 0; m < 12; m++) {
        store += gross[m]
        const rel = store * (1 - K_STORE)
        store -= rel
        out.push(rel)
      }
    }
    const scale = c.runoff / grossSum
    const runoff = out.map((v) => v * scale)
    const mean = runoff.reduce((a, b) => a + b, 0) / 12 || 1
    const meltSum = melt.reduce((a, b) => a + b, 0)
    return {
      precip, temp, snowfall, melt, snowpack,
      runoff,
      discharge: runoff.map((v) => v / mean),
      snowShare: meltSum / grossSum,
      baseflowShare: K_STORE,
      frozenMonths: temp.map((t, m) => (t < -2 ? m : -1)).filter((m) => m >= 0),
    }
  }
}

async function readRGB(url: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const bmp = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  const cv = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const width = bmp.width
  const height = bmp.height
  const img = ctx.getImageData(0, 0, width, height)
  bmp.close()          // closing zeroes bmp.width/height, so read them first
  return { data: img.data, width, height }
}
