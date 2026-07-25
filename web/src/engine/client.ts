/** Typed promise wrapper around the hydrology worker. */
import type { PathStats } from './analysis'
import type { ClimateSample } from './climate'
import type { Manifest } from './grid'

export interface SerialPath {
  lon: Float64Array
  lat: Float64Array
  elev: Float32Array
  area: Float32Array
  dist: Float64Array
  cls: Uint8Array
  x: Int32Array
  y: Int32Array
  terminal: number
  truncated: boolean
}

export interface BasinRecord {
  id: number
  px: number
  py: number
  lon: number
  lat: number
  area: number
  sea: string
  seaGroup: string
  maxElev: number
  minElev: number
  meanElev: number
  glacierPct: number
  lakePct: number
  countries: { iso: string; pct: number }[]
  river?: string
  name: string
  discharge?: number
  runoff?: number
}

export interface TraceResult {
  path: SerialPath
  stats: PathStats
  basin: BasinRecord | null
  start: {
    lon: number; lat: number; elev: number; area: number; cls: number
    climate: ClimateSample | null; sizeClass: string
  }
}

export interface WatershedResult {
  rings: number[][][]
  area: number
  cells: number
  complete: boolean
  outletArea: number
  lon: number
  lat: number
}

export interface UpstreamResult {
  paths: Float32Array[]
  depth: Int32Array
  area: Float32Array
  names: (string | undefined)[]
  root: { lon: number; lat: number; area: number }
}

export interface ProbeResult {
  lon: number; lat: number; elev: number; area: number; cls: number
  isWater: boolean; climate: ClimateSample | null
  country: string | null; lake: string | null
}

export class HydroClient {
  private worker: Worker
  private seq = 0
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  manifest: Manifest | null = null

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, payload } = e.data
      const slot = this.waiting.get(id)
      if (!slot) return
      this.waiting.delete(id)
      if (payload?.error) slot.reject(new Error(payload.error))
      else slot.resolve(payload)
    }
  }

  private call<T>(op: string, args: unknown[]): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.worker.postMessage({ id, op, args })
    })
  }

  async init(baseUrl: string) {
    const r = await this.call<{ manifest: Manifest; basins: number }>(
      'init', [baseUrl],
    )
    this.manifest = r.manifest
    return r
  }

  trace(lon: number, lat: number, snap = false) {
    return this.call<TraceResult>('trace', [lon, lat, snap])
  }

  watershed(lon: number, lat: number, snap = true) {
    return this.call<WatershedResult>('watershed', [lon, lat, snap])
  }

  upstream(lon: number, lat: number, snap = true) {
    return this.call<UpstreamResult>('upstream', [lon, lat, snap])
  }

  rain(seeds: [number, number][]) {
    return this.call<{ paths: Float32Array[] }>('rain', [seeds])
  }

  probe(lon: number, lat: number) {
    return this.call<ProbeResult>('probe', [lon, lat])
  }
}
