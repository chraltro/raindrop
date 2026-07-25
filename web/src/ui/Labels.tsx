/**
 * Map labels as DOM elements.
 *
 * MapLibre's symbol layers need an SDF glyph server; drawing labels in the DOM
 * instead keeps the app free of third-party services and gives proper web
 * typography.  A simple greedy collision test keeps the map uncluttered.
 *
 * The basemap already names towns, lakes and seas, so over it only the river
 * names — the part no general-purpose map bothers to draw — are added.  When
 * the basemap is unavailable this draws the full set instead.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { DATA_URL } from '../config'
import { useStore } from '../state/store'
import { useIsPhone } from './useMedia'

interface Entry { n: string; k: string; c: [number, number]; r: number; p?: number; a?: number }

const MIN_ZOOM: Record<string, number> = {
  sea: 3, river: 4.6, town: 5.0, lake: 5.0, peak: 7, basin: 99, coordinate: 99,
}

export function Labels() {
  const [index, setIndex] = useState<Entry[]>([])
  const [seas, setSeas] = useState<Entry[]>([])
  const [placed, setPlaced] = useState<{ n: string; k: string; x: number; y: number }[]>([])
  const raf = useRef(0)
  const theme = useStore((s) => s.theme)
  const panelOpen = useStore((s) => s.panelOpen)
  const online = useStore((s) => s.basemapOnline)
  const phone = useIsPhone()

  useEffect(() => {
    fetch(`${DATA_URL}/search.json`).then((r) => r.json()).then(setIndex).catch(() => {})
    if (online) return
    fetch(`${DATA_URL}/vector/marine.json`).then((r) => r.json()).then((g) => {
      const out: Entry[] = []
      for (const f of g.features) {
        if (!f.properties?.name) continue
        const c = centroid(f.geometry)
        if (c) out.push({ n: f.properties.name, k: 'sea', c, r: f.properties.rank ?? 3 })
      }
      setSeas(out)
    }).catch(() => {})
  }, [online])

  const pool = useMemo(() => {
    const byKind = (k: string, limit: number) =>
      index.filter((e) => e.k === k)
        .sort((a, b) => a.r - b.r || (b.p ?? b.a ?? 0) - (a.p ?? a.a ?? 0))
        .slice(0, limit)
    if (online) return byKind('river', 420)
    return [...seas, ...byKind('town', 900), ...byKind('river', 420), ...byKind('lake', 220), ...byKind('peak', 130)]
  }, [index, seas, online])

  useEffect(() => {
    let last = ''
    const tick = () => {
      const map = (window as unknown as { __map?: MapLibreMap }).__map
      if (map && pool.length) {
        const z = map.getZoom()
        const c = map.getCenter()
        // Placing labels means projecting hundreds of points; only redo it
        // when the view actually moved.
        const sig = `${z.toFixed(2)}|${c.lng.toFixed(3)}|${c.lat.toFixed(3)}|${map.getBearing().toFixed(0)}|${panelOpen}`
        if (sig === last) {
          raf.current = window.setTimeout(() => requestAnimationFrame(tick), phone ? 320 : 200)
          return
        }
        last = sig
        const w = map.getContainer().clientWidth
        const h = map.getContainer().clientHeight
        const wide = !phone
        const left = wide && panelOpen ? 418 : 10
        const right = wide ? 262 : 10
        const maxLabels = phone ? 22 : 62
        const taken: [number, number, number, number][] = []
        const out: { n: string; k: string; x: number; y: number }[] = []
        for (const e of pool) {
          if (!e?.n) continue
          if (out.length > maxLabels) break
          if (e.k === 'sea') {
            // Natural Earth scaleranks: only the great seas at low zoom
            if (z < 2.2 + e.r * 0.75) continue
          } else if (z < (MIN_ZOOM[e.k] ?? 6) - (e.r <= 1 ? 2 : e.r <= 3 ? 1 : 0)) continue
          if (e.k === 'town' && z < 3.2 + e.r * 0.7) continue
          if (e.k === 'river' && z < 3.8 + e.r * 0.8) continue
          const p = map.project(e.c)
          // keep clear of the panel on the left and the control rail on the right
          if (p.x < left || p.y < (phone ? 66 : 62) || p.x > w - right || p.y > h - (phone ? 120 : 70)) continue
          const tw = e.n.length * (e.k === 'sea' ? 7.4 : 5.6) + 14
          const box: [number, number, number, number] = [p.x - tw / 2, p.y - 9, p.x + tw / 2, p.y + 9]
          if (box[0] < left || box[2] > w - right) continue
          if (taken.some((t) => !(box[2] < t[0] || box[0] > t[2] || box[3] < t[1] || box[1] > t[3]))) continue
          taken.push(box)
          out.push({ n: e.n, k: e.k, x: p.x, y: p.y })
        }
        setPlaced(out)
      }
      raf.current = window.setTimeout(() => requestAnimationFrame(tick), phone ? 320 : 200)
    }
    tick()
    return () => clearTimeout(raf.current)
  }, [pool, panelOpen, phone])

  return (
    <div className="labels" data-theme={theme}
      data-base={online && (theme === 'relief' || theme === 'light') ? 'light' : 'dark'}>
      {placed.map((l) => (
        <div key={`${l.k}-${l.n}-${l.x.toFixed(0)}`} className={`label ${l.k}`}
          style={{ left: l.x, top: l.y }}>{l.n}</div>
      ))}
    </div>
  )
}

function centroid(g: { type: string; coordinates: unknown }): [number, number] | null {
  const rings: number[][][] =
    g.type === 'Polygon' ? (g.coordinates as number[][][])
    : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]).flat()
    : []
  if (!rings.length) return null
  let best: number[][] | null = null
  let bestN = 0
  for (const r of rings) if (r.length > bestN) { bestN = r.length; best = r }
  if (!best) return null
  let x = 0
  let y = 0
  for (const c of best) { x += c[0]; y += c[1] }
  return [x / best.length, y / best.length]
}
