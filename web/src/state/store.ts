import { create } from 'zustand'
import { HydroClient, type BasinRecord, type ProbeResult, type TraceResult, type UpstreamResult, type WatershedResult } from '../engine/client'
import type { Theme } from '../map/styles'

export type Mode = 'drop' | 'upstream' | 'rain' | 'compare'
export type Overlay = 'none' | 'precip' | 'snow' | 'runoff' | 'flowacc' | 'elevation' | 'slope'

export interface CompareSlot {
  basin: BasinRecord | null
  watershed: WatershedResult | null
  color: string
}

interface State {
  client: HydroClient | null
  ready: boolean
  loading: string | null
  error: string | null

  theme: Theme
  terrain3d: boolean
  demAvailable: boolean
  basemapOnline: boolean
  contours: boolean
  overlay: Overlay
  showBasins: boolean
  showWatershed: boolean
  month: number
  seasonal: boolean
  year: number
  mode: Mode
  cinematic: boolean
  panelOpen: boolean
  panelFull: boolean
  railOpen: boolean
  educational: boolean

  trace: TraceResult | null
  probe: ProbeResult | null
  watershed: WatershedResult | null
  upstream: UpstreamResult | null
  rainPaths: Float32Array[] | null
  compare: [CompareSlot, CompareSlot]

  playing: boolean
  progress: number       // 0..1 along the traced path

  init(base: string): Promise<void>
  setTheme(t: Theme): void
  set<K extends keyof State>(k: K, v: State[K]): void
  dropAt(lon: number, lat: number, snap?: boolean): Promise<void>
  exploreUpstream(lon: number, lat: number): Promise<void>
  loadWatershed(lon: number, lat: number): Promise<void>
  makeRain(seeds: [number, number][]): Promise<void>
  addCompare(lon: number, lat: number): Promise<void>
  clearAll(): void
}

export const useStore = create<State>((set, get) => ({
  client: null,
  ready: false,
  loading: null,
  error: null,

  theme: 'relief',
  terrain3d: false,
  demAvailable: true,
  basemapOnline: true,
  contours: false,
  overlay: 'none',
  showBasins: false,
  showWatershed: false,
  month: 3,
  seasonal: false,
  year: 2025,
  mode: 'drop',
  cinematic: true,
  panelOpen: typeof window === 'undefined' ||
    !window.matchMedia('(max-width: 780px), (max-height: 520px)').matches,
  panelFull: false,
  railOpen: false,
  educational: false,

  trace: null,
  probe: null,
  watershed: null,
  upstream: null,
  rainPaths: null,
  compare: [
    { basin: null, watershed: null, color: '#4dd0ff' },
    { basin: null, watershed: null, color: '#ffb74d' },
  ],

  playing: false,
  progress: 0,

  async init(base) {
    const client = new HydroClient()
    set({ loading: 'Loading the drainage network of Europe…' })
    try {
      await client.init(base)
      set({ client, ready: true, loading: null })
    } catch (e) {
      set({ error: String((e as Error).message ?? e), loading: null })
    }
  },

  setTheme(theme) { set({ theme }) },
  set(k, v) { set({ [k]: v } as Pick<State, typeof k>) },

  async dropAt(lon, lat, snap = false) {
    const { client } = get()
    if (!client) return
    set({ loading: 'Following the drop…', playing: false, progress: 0, upstream: null, rainPaths: null })
    try {
      const [trace, probe] = await Promise.all([
        client.trace(lon, lat, snap),
        client.probe(lon, lat),
      ])
      set({ trace, probe, loading: null, playing: true, progress: 0,
             panelOpen: true, railOpen: false, mode: 'drop' })
      if (get().showWatershed) void get().loadWatershed(lon, lat)
    } catch (e) {
      set({ error: String((e as Error).message ?? e), loading: null })
    }
  },

  async exploreUpstream(lon, lat) {
    const { client } = get()
    if (!client) return
    set({ loading: 'Climbing upstream…', mode: 'upstream' })
    try {
      const upstream = await client.upstream(lon, lat, true)
      set({ upstream, loading: null, playing: true, progress: 0,
             panelOpen: true, railOpen: false })
    } catch (e) {
      set({ error: String((e as Error).message ?? e), loading: null })
    }
  },

  async loadWatershed(lon, lat) {
    const { client } = get()
    if (!client) return
    set({ loading: 'Delineating the watershed…' })
    try {
      const watershed = await client.watershed(lon, lat, true)
      set({ watershed, loading: null, showWatershed: true })
    } catch (e) {
      set({ error: String((e as Error).message ?? e), loading: null })
    }
  },

  async makeRain(seeds) {
    const { client } = get()
    if (!client) return
    set({ loading: `Releasing ${seeds.length} drops…`, mode: 'rain' })
    try {
      const { paths } = await client.rain(seeds)
      set({ rainPaths: paths, loading: null, playing: true, progress: 0 })
    } catch (e) {
      set({ error: String((e as Error).message ?? e), loading: null })
    }
  },

  async addCompare(lon, lat) {
    const { client, compare } = get()
    if (!client) return
    const slot = compare[0].watershed ? 1 : 0
    set({ loading: 'Delineating basin…', mode: 'compare' })
    try {
      const ws = await client.watershed(lon, lat, true)
      const tr = await client.trace(lon, lat, true)
      const next: [CompareSlot, CompareSlot] = [...compare] as [CompareSlot, CompareSlot]
      next[slot] = { ...next[slot], basin: tr.basin, watershed: ws }
      set({ compare: next, loading: null, panelOpen: true, railOpen: false })
    } catch (e) {
      set({ error: String((e as Error).message ?? e), loading: null })
    }
  },

  clearAll() {
    set({
      trace: null, probe: null, watershed: null, upstream: null, rainPaths: null,
      playing: false, progress: 0, showWatershed: false,
      compare: [
        { basin: null, watershed: null, color: '#4dd0ff' },
        { basin: null, watershed: null, color: '#ffb74d' },
      ],
    })
  },
}))

// The map is already on the window for the search fly-to; the store joins it so
// the running app can be inspected and driven from the console or a test.
if (typeof window !== 'undefined') {
  (window as unknown as { __store: unknown }).__store = useStore
}
