import { useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { DATA_URL } from '../config'
import { useStore } from '../state/store'

interface Entry {
  n: string      // name
  k: string      // kind
  c: [number, number]
  s: string      // searchable, accent-free
  r: number      // rank
  d?: string     // detail
  p?: number     // population
  a?: number     // basin area for rivers
}

const strip = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[°,\s]\s*(-?\d+(?:\.\d+)?)\s*$/

export function SearchBox() {
  const [q, setQ] = useState('')
  const [index, setIndex] = useState<Entry[] | null>(null)
  const [sel, setSel] = useState(0)
  const [focus, setFocus] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const dropAt = useStore((s) => s.dropAt)

  useEffect(() => {
    fetch(`${DATA_URL}/search.json`).then((r) => r.json()).then(setIndex).catch(() => setIndex([]))
  }, [])

  const results = useMemo(() => {
    const term = strip(q.trim())
    if (!term || !index) return []
    const m = q.match(COORD_RE)
    const out: Entry[] = []
    if (m) {
      const lat = Number(m[1])
      const lon = Number(m[2])
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        out.push({ n: `${lat}, ${lon}`, k: 'coordinate', c: [lon, lat], s: '', r: -1, d: 'go there' })
    }
    const starts: Entry[] = []
    const contains: Entry[] = []
    for (const e of index) {
      const i = e.s.indexOf(term)
      if (i === 0) starts.push(e)
      else if (i > 0) contains.push(e)
      if (starts.length > 40) break
    }
    const rank = (a: Entry, b: Entry) => a.r - b.r || (b.p ?? b.a ?? 0) - (a.p ?? a.a ?? 0)
    return [...out, ...starts.sort(rank).slice(0, 8), ...contains.sort(rank).slice(0, 4)]
  }, [q, index])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setFocus(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const go = (e: Entry) => {
    const map = (window as unknown as { __map?: MapLibreMap }).__map
    const zoom = e.k === 'river' || e.k === 'basin' ? 7.2 : e.k === 'town' ? 10 : 9
    map?.flyTo({ center: e.c, zoom, duration: 1800, essential: true })
    setQ('')
    setFocus(false)
    if (e.k === 'river' || e.k === 'basin') {
      setTimeout(() => void dropAt(e.c[0], e.c[1], true), 1900)
    }
  }

  return (
    <div className="search" ref={box}>
      <span className="icon" aria-hidden>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        value={q}
        placeholder="Search a river, town, lake, peak or 48.14, 11.58"
        onFocus={() => setFocus(true)}
        onChange={(e) => { setQ(e.target.value); setSel(0); setFocus(true) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
          else if (e.key === 'Enter' && results[sel]) go(results[sel])
          else if (e.key === 'Escape') setFocus(false)
        }}
      />
      {focus && results.length ? (
        <div className="results glass">
          {results.map((e, i) => (
            <div key={`${e.n}-${i}`} className={`result ${i === sel ? 'sel' : ''}`}
              onMouseEnter={() => setSel(i)} onClick={() => go(e)}>
              <span className="kind" style={{ width: 52 }}>{e.k}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.n}</div>
                {e.d ? <div className="sub">{e.d}</div> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
