import { useEffect, useRef, useState } from 'react'
import { AttributionControl, Map as MapLibreMap, NavigationControl, ScaleControl } from 'maplibre-gl'
import type { GeoJSONSource, IControl, MapMouseEvent } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { BitmapLayer, COORDINATE_SYSTEM, PathLayer, ScatterplotLayer, TripsLayer } from 'deck.gl'
import { useStore } from '../state/store'
import { buildStyle, AWS_TERRAIN } from './styles'
import { Overlays } from './overlays'
import { DATA_URL } from '../config'
import { isCompact } from '../ui/useMedia'

const START_VIEW = { center: [10.5, 50.2] as [number, number], zoom: 4.1, pitch: 0, bearing: 0 }

/** Small screens and metered connections wait longer for the 13 MB detail layer. */
function detailZoom(): number {
  const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection
  if (conn?.saveData) return 99
  return isCompact() ? 9 : 7.6
}

/** Animation duration in seconds for a path of the given length. */
const durationFor = (metres: number) => Math.min(95, Math.max(11, 9 + metres / 55000))

export function MapCanvas() {
  const holder = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const deckRef = useRef<MapboxOverlay | null>(null)
  const overlaysRef = useRef<Overlays | null>(null)
  const raf = useRef(0)
  const anim = useRef({ t0: 0, duration: 20, playing: false, progress: 0, speed: 1 })
  const dirty = useRef(true)
  const camSkip = useRef(false)
  const lastPush = useRef(0)
  const [styleReady, setStyleReady] = useState(false)

  const s = useStore()

  // ---------------------------------------------------------------- map init
  useEffect(() => {
    if (!holder.current || mapRef.current) return
    const map = new MapLibreMap({
      container: holder.current,
      style: buildStyle(DATA_URL, 'relief', {
        dem: true, bounds: [-25, 33, 62, 72], reliefMinZoom: 3, reliefMaxZoom: 7,
      }),
      center: START_VIEW.center,
      zoom: START_VIEW.zoom,
      maxZoom: 14,
      minZoom: 2.6,
      attributionControl: false,
      hash: false,
      dragRotate: !isCompact(),
      pitchWithRotate: !isCompact(),
      maxPitch: isCompact() ? 60 : 75,
    })
    if (isCompact()) map.touchZoomRotate.disableRotation()
    mapRef.current = map
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right')
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')

    const deck = new MapboxOverlay({ interleaved: false, layers: [] })
    deckRef.current = deck
    map.addControl(deck as unknown as IControl)

    // A phone repaints the entire map on every camera change, so the
    // cinematic ride is opt-in there and the route is framed instead.
    if (isCompact()) useStore.setState({ cinematic: false })
    map.on('load', () => {
      setStyleReady(true)
      const ov = new Overlays(DATA_URL, useStore.getState().client!.manifest!)
      overlaysRef.current = ov
      ov.load().then(() => useStore.setState({}))
    })
    map.on('error', (e: unknown) => {
      const url = (e as unknown as { sourceId?: string }).sourceId
      if (url === 'dem') useStore.setState({ demAvailable: false })
    })
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // ------------------------------------------------------------ style swap
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const style = buildStyle(DATA_URL, s.theme, {
      dem: s.demAvailable, bounds: [-25, 33, 62, 72], reliefMinZoom: 3, reliefMaxZoom: 7,
    })
    map.setStyle(style, { diff: false })
    map.once('styledata', () => {
      applyWatershed()
      applyBasins()
      applyDetailRivers()
      if (s.terrain3d && s.demAvailable) {
        map.setTerrain({ source: 'dem', exaggeration: 1.35 })
      }
    })
  }, [s.theme, s.demAvailable])

  // ------------------------------------------------------------- 3d terrain
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    if (s.terrain3d && s.demAvailable) {
      if (!map.getSource('dem')) {
        map.addSource('dem', {
          type: 'raster-dem', tiles: [AWS_TERRAIN], tileSize: 256, maxzoom: 13,
          encoding: 'terrarium',
        })
      }
      map.setTerrain({ source: 'dem', exaggeration: 1.35 })
      if (map.getPitch() < 30) map.easeTo({ pitch: 58, duration: 900 })
    } else {
      map.setTerrain(null)
      if (!s.cinematic) map.easeTo({ pitch: 0, duration: 700 })
    }
  }, [s.terrain3d, s.demAvailable, styleReady])

  // ------------------------------------------------------- click behaviour
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const onClick = (e: MapMouseEvent) => {
      const { lng, lat } = e.lngLat
      const st = useStore.getState()
      if (!st.ready) return
      if (st.mode === 'upstream') void st.exploreUpstream(lng, lat)
      else if (st.mode === 'compare') void st.addCompare(lng, lat)
      else void st.dropAt(lng, lat, e.originalEvent.shiftKey)
    }
    map.on('click', onClick)
    return () => { map.off('click', onClick) }
  }, [])

  // --------------------------------------------------- detail river source
  const applyDetailRivers = () => {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource('rivers2') as GeoJSONSource | undefined
    if (!src || detailLoaded.current) return
    if (map.getZoom() < detailZoom()) return
    detailLoaded.current = true
    fetch(`${DATA_URL}/rivers-lod2.geojson`)
      .then((r) => r.json())
      .then((geo) => {
        const s2 = map.getSource('rivers2') as GeoJSONSource | undefined
        s2?.setData(geo)
        detailData.current = geo
      })
      .catch(() => { detailLoaded.current = false })
  }
  const detailLoaded = useRef(false)
  const detailData = useRef<unknown>(null)

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const onZoom = () => {
      if (map.getZoom() >= detailZoom()) {
        if (detailData.current) {
          const src = map.getSource('rivers2') as GeoJSONSource | undefined
          const cur = src as unknown as { _data?: unknown }
          if (src && (!cur._data || (cur._data as { features?: [] }).features?.length === 0))
            src.setData(detailData.current as never)
        } else applyDetailRivers()
      }
    }
    map.on('zoomend', onZoom)
    return () => { map.off('zoomend', onZoom) }
  }, [styleReady])

  // ------------------------------------------------------------- watershed
  const applyWatershed = () => {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource('watershed') as GeoJSONSource | undefined
    if (!src) return
    const st = useStore.getState()
    const feats: GeoJSON.Feature[] = []
    const add = (rings: number[][][], color: string) => {
      if (!rings?.length) return
      feats.push({
        type: 'Feature',
        properties: { color },
        geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) },
      })
    }
    if (st.showWatershed && st.watershed) add(st.watershed.rings, '#8ae7ff')
    for (const slot of st.compare) if (slot.watershed) add(slot.watershed.rings, slot.color)
    src.setData({ type: 'FeatureCollection', features: feats })
    const vis = feats.length ? 'visible' : 'none'
    if (map.getLayer('watershed-fill')) map.setLayoutProperty('watershed-fill', 'visibility', vis)
    if (map.getLayer('watershed-line')) map.setLayoutProperty('watershed-line', 'visibility', vis)
  }
  useEffect(() => { applyWatershed() },
    [s.watershed, s.showWatershed, s.compare, styleReady])

  // ---------------------------------------------------------------- basins
  const applyBasins = () => {
    const map = mapRef.current
    if (!map || !map.getLayer('basins-fill')) return
    const vis = s.showBasins ? 'visible' : 'none'
    map.setLayoutProperty('basins-fill', 'visibility', vis)
    map.setLayoutProperty('basins-line', 'visibility', vis)
    if (!s.showBasins || basinsLoaded.current) return
    basinsLoaded.current = true
    fetch(`${DATA_URL}/basins.geojson`).then((r) => r.json()).then((geo) => {
      for (const f of geo.features) f.properties.color = SEA_COLORS[f.properties.seaGroup] ?? '#6cf'
      ;(map.getSource('basins') as GeoJSONSource | undefined)?.setData(geo)
    })
  }
  const basinsLoaded = useRef(false)
  useEffect(() => { applyBasins() }, [s.showBasins, styleReady])

  // -------------------------------------------------------------- overlays
  const overlayImage = useRef<{ data: ImageData; key: string } | null>(null)
  useEffect(() => {
    const ov = overlaysRef.current
    if (!ov?.ready) return
    if (s.overlay === 'none') { overlayImage.current = null; dirty.current = true; render(); return }
    const key = `${s.overlay}:${s.seasonal ? s.month : 'y'}`
    if (overlayImage.current?.key === key) return
    const data = ov.render(s.overlay, s.month, s.seasonal, isCompact() ? 2 : 1)
    overlayImage.current = data ? { data, key } : null
    dirty.current = true
    render()
  }, [s.overlay, s.month, s.seasonal, overlaysRef.current?.ready])

  // ---------------------------------------------------- memoised layer data
  // deck.gl detects changes by data identity, so these arrays are built once
  // per result and reused every frame; rebuilding them at 60 fps would stall
  // the page for a storm of several thousand drops.
  const routeData = useRef<{ path: [number, number][]; timestamps: number[] }[]>([])
  const upstreamData = useRef<{ path: [number, number][]; timestamps: number[]; w: number }[]>([])
  const upstreamMaxT = useRef(1)
  const rainData = useRef<any>(null)
  const rainMaxT = useRef(1)

  useEffect(() => {
    const path = s.trace?.path
    if (!path) { routeData.current = []; return }
    const n = path.lon.length
    const coords: [number, number][] = new Array(n)
    const timestamps: number[] = new Array(n)
    for (let i = 0; i < n; i++) {
      coords[i] = [path.lon[i], path.lat[i]]
      timestamps[i] = i
    }
    routeData.current = [{ path: coords, timestamps }]
  }, [s.trace])

  useEffect(() => {
    const up = s.upstream
    if (!up) { upstreamData.current = []; return }
    let maxT = 1
    upstreamData.current = up.paths.map((p, k) => {
      const pts: [number, number][] = []
      for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]])
      const base = up.depth[k] * 60
      const timestamps = pts.map((_, i) => base + i * 0.8)
      maxT = Math.max(maxT, timestamps[timestamps.length - 1] ?? 0)
      return {
        path: pts, timestamps,
        w: Math.max(1.2, Math.min(8, Math.log10(Math.max(up.area[k], 1)) * 2.2)),
      }
    })
    upstreamMaxT.current = maxT
  }, [s.upstream])

  // Storm drops go to deck.gl in its binary layout: one flat coordinate
  // buffer plus start indices, instead of millions of small JS arrays.
  useEffect(() => {
    const paths = s.rainPaths
    if (!paths?.length) { rainData.current = null; return }
    let total = 0
    let maxT = 2
    for (const p of paths) {
      total += p.length / 2
      maxT = Math.max(maxT, p.length / 2)
    }
    const positions = new Float32Array(total * 2)
    const timestamps = new Float32Array(total)
    const startIndices = new Uint32Array(paths.length + 1)
    let at = 0
    paths.forEach((p, k) => {
      startIndices[k] = at
      for (let i = 0; i < p.length; i += 2) {
        positions[at * 2] = p[i]
        positions[at * 2 + 1] = p[i + 1]
        timestamps[at] = i / 2
        at++
      }
    })
    startIndices[paths.length] = at
    rainData.current = {
      length: paths.length,
      startIndices,
      attributes: {
        getPath: { value: positions, size: 2 },
        getTimestamps: { value: timestamps, size: 1 },
      },
    }
    rainMaxT.current = maxT
  }, [s.rainPaths])

  // ------------------------------------------------------------- animation
  useEffect(() => {
    if (!s.rainPaths) return
    anim.current.duration = 26
    anim.current.t0 = performance.now()
    anim.current.progress = 0
    anim.current.playing = true
  }, [s.rainPaths])

  useEffect(() => {
    const path = s.trace?.path
    if (!path) { anim.current.playing = false; return }
    if (!useStore.getState().cinematic) fitRoute(path)
    anim.current.duration = durationFor(path.dist[path.dist.length - 1])
    anim.current.t0 = performance.now()
    anim.current.progress = 0
    anim.current.playing = s.playing
  }, [s.trace])

  useEffect(() => {
    anim.current.playing = s.playing
    if (s.playing) anim.current.t0 = performance.now() - anim.current.progress * anim.current.duration * 1000
  }, [s.playing])

  // The frame loop only touches deck.gl when the scene actually changed.
  // Re-uploading layers 60 times a second while nothing moves is what made
  // phones crawl.
  useEffect(() => {
    const tick = () => {
      const a = anim.current
      if (a.playing) {
        const looping = !!useStore.getState().rainPaths
        const raw = (performance.now() - a.t0) / (a.duration * 1000)
        const p = looping ? raw % 1 : Math.min(1, raw)
        a.progress = p
        if (!looping && raw >= 1) { a.playing = false; useStore.setState({ playing: false }) }
        // The panel, the profile chart and the timeline only need ~10 Hz.
        // Pushing progress into the store every frame re-rendered the whole
        // journey list sixty times a second.
        const now = performance.now()
        if (now - lastPush.current > 100 && Math.abs(p - useStore.getState().progress) > 0.004) {
          lastPush.current = now
          useStore.setState({ progress: p })
        }
        follow(p)
        dirty.current = true
      }
      if (dirty.current) {
        dirty.current = false
        render()
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  // scrubbing from the UI
  useEffect(() => {
    if (!anim.current.playing) anim.current.progress = s.progress
    dirty.current = true
  }, [s.progress])

  useEffect(() => { dirty.current = true },
    [s.trace, s.upstream, s.rainPaths, s.probe, s.overlay, s.month, s.seasonal, s.theme])

  /** Frame the whole journey — the default view when not riding the drop. */
  const fitRoute = (path: { lon: Float64Array; lat: Float64Array }) => {
    const map = mapRef.current
    if (!map || !path.lon.length) return
    let w = 180, e = -180, s0 = 90, n = -90
    const step = Math.max(1, Math.floor(path.lon.length / 400))
    for (let i = 0; i < path.lon.length; i += step) {
      if (path.lon[i] < w) w = path.lon[i]
      if (path.lon[i] > e) e = path.lon[i]
      if (path.lat[i] < s0) s0 = path.lat[i]
      if (path.lat[i] > n) n = path.lat[i]
    }
    const phone = isCompact()
    map.fitBounds([[w, s0], [e, n]], {
      padding: phone
        ? { top: 90, bottom: Math.round(window.innerHeight * 0.5), left: 24, right: 24 }
        : { top: 90, bottom: 110, left: 420, right: 280 },
      duration: 1100,
      maxZoom: 11,
    })
  }

  const follow = (p: number) => {
    const map = mapRef.current
    const st = useStore.getState()
    if (!map || !st.cinematic || !st.trace) return
    const path = st.trace.path
    const n = path.lon.length
    const total = path.dist[n - 1]
    const d = p * total
    let i = binarySearch(path.dist, d)
    i = Math.min(n - 2, Math.max(0, i))
    const t = (d - path.dist[i]) / Math.max(1, path.dist[i + 1] - path.dist[i])
    const lon = path.lon[i] + (path.lon[i + 1] - path.lon[i]) * t
    const lat = path.lat[i] + (path.lat[i + 1] - path.lat[i]) * t
    const ahead = Math.min(n - 1, i + Math.max(3, Math.floor(n / 120)))
    const bearing = bearingBetween(path.lon[i], path.lat[i], path.lon[ahead], path.lat[ahead])
    const area = path.area[i]
    const small = isCompact()
    const zoom = Math.max(small ? 5.6 : 6.2, Math.min(small ? 10.4 : 11.6,
      (small ? 11.1 : 11.9) - Math.log10(Math.max(area, 0.2)) * 0.95))
    // a phone repaints the whole map on every camera change, so move it at
    // half the rate and keep the pitch shallow
    if (small) {
      camSkip.current = !camSkip.current
      if (camSkip.current) return
    }
    map.jumpTo({
      center: [lon, lat],
      zoom: map.getZoom() + (zoom - map.getZoom()) * (small ? 0.06 : 0.03),
      bearing: map.getBearing() + shortestAngle(map.getBearing(), bearing) * (small ? 0.09 : 0.05),
      pitch: st.terrain3d ? 62 : small ? 0 : 48,
    })
  }

  // ---------------------------------------------------------------- render
  const render = () => {
    const deck = deckRef.current
    if (!deck) return
    const st = useStore.getState()
    const layers: any[] = []
    const ov = overlaysRef.current

    if (overlayImage.current && ov) {
      layers.push(new BitmapLayer({
        id: 'overlay',
        bounds: ov.bounds,
        image: overlayImage.current.data,
        _imageCoordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        opacity: 0.66,
        textureParameters: { minFilter: 'linear', magFilter: 'linear' },
      }))
    }

    if (st.trace && routeData.current.length) {
      const path = st.trace.path
      const n = path.lon.length
      const p = anim.current.progress
      const now = p * n

      layers.push(new PathLayer({
        id: 'route-ghost',
        data: routeData.current,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: [120, 200, 255, 55],
        getWidth: 3,
        widthUnits: 'pixels',
        widthMinPixels: 1.5,
        capRounded: true,
        jointRounded: true,
      }))

      layers.push(new TripsLayer({
        id: 'route-trip',
        data: routeData.current,
        getPath: (d: { path: [number, number][] }) => d.path,
        getTimestamps: (d: { timestamps: number[] }) => d.timestamps,
        getColor: [140, 230, 255],
        getWidth: 5,
        widthUnits: 'pixels',
        widthMinPixels: 2.5,
        capRounded: true,
        jointRounded: true,
        opacity: 0.95,
        trailLength: n,
        currentTime: now,
        shadowEnabled: false,
      }))

      const i = Math.min(n - 1, Math.max(0, Math.floor(now)))
      const head: [number, number] = [path.lon[i], path.lat[i]]
      layers.push(new ScatterplotLayer({
        id: 'drop-glow',
        data: [{ p: head }],
        getPosition: (d: { p: [number, number] }) => d.p,
        getRadius: 26,
        radiusUnits: 'pixels',
        getFillColor: [90, 200, 255, 60],
        stroked: false,
      }))
      layers.push(new ScatterplotLayer({
        id: 'drop',
        data: [{ p: head }],
        getPosition: (d: { p: [number, number] }) => d.p,
        getRadius: 7,
        radiusUnits: 'pixels',
        getFillColor: [255, 255, 255, 245],
        stroked: true,
        getLineColor: [120, 220, 255, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
      }))
      // where the biggest tributaries arrive
      if (st.trace?.stats?.tributaries?.length) {
        layers.push(new ScatterplotLayer({
          id: 'tribs',
          data: st.trace.stats.tributaries,
          getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
          getRadius: 5,
          radiusUnits: 'pixels',
          getFillColor: [255, 205, 120, 210],
          stroked: false,
        }))
      }
    }

    if (st.upstream && upstreamData.current.length) {
      const maxT = upstreamMaxT.current
      layers.push(new TripsLayer({
        id: 'upstream',
        data: upstreamData.current,
        getPath: (d: { path: [number, number][] }) => d.path,
        getTimestamps: (d: { timestamps: number[] }) => d.timestamps,
        getColor: (d: { w: number }) => [120 + d.w * 12, 235 - d.w * 8, 255],
        getWidth: (d: { w: number }) => d.w,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        trailLength: maxT,
        currentTime: anim.current.progress * maxT,
      }))
    }

    if (st.rainPaths && rainData.current) {
      const maxT = rainMaxT.current
      layers.push(new TripsLayer({
        id: 'rain',
        data: rainData.current,
        _pathType: 'open',
        getColor: [130, 220, 255],
        getWidth: 2,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        opacity: 0.75,
        trailLength: 260,
        currentTime: anim.current.progress * maxT,
      }))
    }

    if (st.probe) {
      layers.push(new ScatterplotLayer({
        id: 'origin',
        data: [st.probe],
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getRadius: 6,
        radiusUnits: 'pixels',
        getFillColor: [255, 255, 255, 0],
        stroked: true,
        getLineColor: [255, 255, 255, 220],
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
      }))
    }

    deck.setProps({ layers })
  }

  // expose the map for other components (search fly-to, share links)
  useEffect(() => { (window as unknown as { __map: unknown }).__map = mapRef.current },
    [styleReady])

  return <div ref={holder} className="map-root" />
}

const SEA_COLORS: Record<string, string> = {
  atlantic: '#4aa3ff', northsea: '#2ee6c8', baltic: '#7c7cff', mediterranean: '#ff9d5c',
  black: '#ff6b9d', arctic: '#9ee8ff', caspian: '#ffd166', endorheic: '#c9a0ff',
  lake: '#66e0ff', offmap: '#8a94a6',
}

function binarySearch(arr: Float64Array, v: number): number {
  let lo = 0
  let hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (arr[mid] <= v) lo = mid
    else hi = mid - 1
  }
  return lo
}

function bearingBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const p = Math.PI / 180
  const y = Math.sin((lon2 - lon1) * p) * Math.cos(lat2 * p)
  const x = Math.cos(lat1 * p) * Math.sin(lat2 * p) -
    Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos((lon2 - lon1) * p)
  return (Math.atan2(y, x) * 180) / Math.PI
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}
