import { useState } from 'react'
import { motion } from 'framer-motion'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { useStore, type Mode, type Overlay } from '../state/store'
import type { Theme } from '../map/styles'
import { MONTHS } from '../engine/climate'
import { HISTORY, KIND_COLOR } from '../data/history'
import { shareUrl } from '../state/hash'

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'drop', label: 'Drop', hint: 'Click anywhere: follow one raindrop to the sea' },
  { id: 'upstream', label: 'Upstream', hint: 'Click a river: climb it to its springs' },
  { id: 'rain', label: 'Storm', hint: 'Drag over the map to rain on an area' },
  { id: 'compare', label: 'Compare', hint: 'Click two rivers to compare their basins' },
]

const THEMES: { id: Theme; label: string }[] = [
  { id: 'relief', label: 'Terrain' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'satellite', label: 'Satellite' },
]

const OVERLAYS: { id: Overlay; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'precip', label: 'Rainfall' },
  { id: 'snow', label: 'Snowpack' },
  { id: 'runoff', label: 'Runoff' },
  { id: 'flowacc', label: 'Streams' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'slope', label: 'Slope' },
]

export function Rail() {
  const s = useStore()
  const [open, setOpen] = useState<string | null>('mode')
  const card = (id: string, title: string, body: React.ReactNode) => (
    <motion.div layout className="card glass" key={id}>
      <h4 style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
        onClick={() => setOpen(open === id ? null : id)}>
        {title}<span style={{ opacity: 0.6 }}>{open === id ? '−' : '+'}</span>
      </h4>
      {open === id ? body : null}
    </motion.div>
  )

  return (
    <div className="rail">
      {card('mode', 'Mode', (
        <>
          <div className="rowbtns">
            {MODES.map((m) => (
              <button key={m.id} className={`btn ${s.mode === m.id ? 'active' : ''}`}
                title={m.hint}
                onClick={() => { s.set('mode', m.id); if (m.id !== 'compare') s.set('panelOpen', true) }}>
                {m.label}
              </button>
            ))}
          </div>
          <p className="note">{MODES.find((m) => m.id === s.mode)?.hint}</p>
          {s.mode === 'rain' ? <StormControls /> : null}
          <div className="rowbtns" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => s.clearAll()}>Clear</button>
            <button className="btn" onClick={() => navigator.clipboard?.writeText(shareUrl())}>
              Copy link
            </button>
          </div>
        </>
      ))}

      {card('base', 'Basemap', (
        <>
          <div className="rowbtns">
            {THEMES.map((t) => (
              <button key={t.id} className={`btn ${s.theme === t.id ? 'active' : ''}`}
                onClick={() => s.setTheme(t.id)}>{t.label}</button>
            ))}
          </div>
          <label className="switch">
            <span>3D terrain</span>
            <input type="checkbox" checked={s.terrain3d} disabled={!s.demAvailable}
              onChange={(e) => s.set('terrain3d', e.target.checked)} />
          </label>
          <label className="switch">
            <span>Cinematic camera</span>
            <input type="checkbox" checked={s.cinematic}
              onChange={(e) => s.set('cinematic', e.target.checked)} />
          </label>
          {!s.demAvailable ? (
            <p className="note">Hillshade and 3D need the public terrain-tile
              service, which is unreachable right now. The shaded relief basemap
              is served from this site and always works.</p>
          ) : null}
        </>
      ))}

      {card('overlay', 'Overlays', (
        <>
          <div className="rowbtns">
            {OVERLAYS.map((o) => (
              <button key={o.id} className={`btn ${s.overlay === o.id ? 'active' : ''}`}
                onClick={() => s.set('overlay', o.id)}>{o.label}</button>
            ))}
          </div>
          <Legend overlay={s.overlay} />
          <label className="switch">
            <span>Watershed shading</span>
            <input type="checkbox" checked={s.showWatershed}
              onChange={(e) => {
                if (e.target.checked && !s.watershed && s.trace)
                  void s.loadWatershed(s.trace.start.lon, s.trace.start.lat)
                else s.set('showWatershed', e.target.checked)
              }} />
          </label>
          <label className="switch">
            <span>All drainage basins</span>
            <input type="checkbox" checked={s.showBasins}
              onChange={(e) => s.set('showBasins', e.target.checked)} />
          </label>
        </>
      ))}

      {card('season', 'Season', (
        <>
          <label className="switch">
            <span>Seasonal mode</span>
            <input type="checkbox" checked={s.seasonal}
              onChange={(e) => s.set('seasonal', e.target.checked)} />
          </label>
          <input type="range" min={0} max={11} step={1} value={s.month}
            style={{ width: '100%', ['--pct' as string]: `${(s.month / 11) * 100}%` }}
            onChange={(e) => s.set('month', Number(e.target.value))} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)' }}>
            <span>{MONTHS[s.month]}</span>
            <span>{s.seasonal ? 'overlays follow the month' : 'annual averages'}</span>
          </div>
          <p className="note">
            Snowpack and discharge come from a degree-day model driven by
            interpolated station normals — indicative, not a forecast.
          </p>
        </>
      ))}

      {card('history', 'Time travel', (
        <>
          <input type="range" min={1600} max={2025} step={1} value={s.year}
            style={{ width: '100%', ['--pct' as string]: `${((s.year - 1600) / 425) * 100}%` }}
            onChange={(e) => s.set('year', Number(e.target.value))} />
          <div style={{ fontSize: 18, fontWeight: 600, margin: '2px 0 8px' }}>{s.year}</div>
          <div style={{ maxHeight: 190, overflowY: 'auto' }}>
            {HISTORY.filter((h) => h.year <= s.year).slice().reverse().map((h) => (
              <button key={h.title} className="result" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }}
                onClick={() => {
                  const map = (window as unknown as { __map?: MapLibreMap }).__map
                  map?.flyTo({ center: [h.lon, h.lat], zoom: 8.4, duration: 1600 })
                }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: KIND_COLOR[h.kind], flex: 'none' }} />
                <span>
                  <div style={{ fontSize: 12 }}>{h.title}</div>
                  <div className="sub">{h.year}{h.end ? `–${h.end}` : ''} · {h.river}</div>
                </span>
              </button>
            ))}
          </div>
          <p className="note">
            Dated interventions that changed where European water goes. Points
            mark the site; historical channels are not redrawn.
          </p>
        </>
      ))}
    </div>
  )
}

function StormControls() {
  const s = useStore()
  const [drops, setDrops] = useState(900)
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{drops} drops</div>
      <input type="range" min={100} max={4000} step={100} value={drops}
        style={{ width: '100%', ['--pct' as string]: `${((drops - 100) / 3900) * 100}%` }}
        onChange={(e) => { setDrops(Number(e.target.value)); ;(window as any).__rainDrops = Number(e.target.value) }} />
      <button className="btn" style={{ width: '100%', justifyContent: 'center' }}
        onClick={() => {
          const map = (window as unknown as { __map?: MapLibreMap }).__map
          if (!map) return
          const b = map.getBounds()
          const seeds: [number, number][] = []
          for (let i = 0; i < drops; i++)
            seeds.push([
              b.getWest() + Math.random() * (b.getEast() - b.getWest()),
              b.getSouth() + Math.random() * (b.getNorth() - b.getSouth()),
            ])
          void s.makeRain(seeds)
        }}>
        Rain over the whole view
      </button>
    </div>
  )
}

const LEGEND_TEXT: Partial<Record<Overlay, [string, string, string]>> = {
  precip: ['dry', 'linear-gradient(90deg,#5a3c1e,#96783c,#c8c878,#78be82,#3ca0aa,#286ec8,#5a3cc8)', '4000 mm'],
  snow: ['none', 'linear-gradient(90deg,#0a1428,#28508c,#5a96d2,#aad2f0,#e6f5ff)', 'deep'],
  runoff: ['0', 'linear-gradient(90deg,#50321e,#8c7846,#6eaa82,#3296b4,#285ac8)', '1500 mm'],
  flowacc: ['creek', 'linear-gradient(90deg,#2896dc,#64d2ff,#a0f0ff)', 'great river'],
  elevation: ['sea', 'linear-gradient(90deg,#46788f,#466e46,#829b5f,#beaf6e,#aa825f,#a09696,#ebf0f5)', '4500 m'],
  slope: ['flat', 'linear-gradient(90deg,#1ec8ff,#8cb45a,#ff5028)', 'cliff'],
}

function Legend({ overlay }: { overlay: Overlay }) {
  const l = LEGEND_TEXT[overlay]
  if (!l) return null
  return (
    <div className="legend">
      <span>{l[0]}</span>
      <span className="bar" style={{ background: l[1] }} />
      <span>{l[2]}</span>
    </div>
  )
}
