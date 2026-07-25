import { useMemo } from 'react'
import { area as d3area, line as d3line, curveMonotoneX } from 'd3-shape'
import { scaleLinear } from 'd3-scale'
import type { SerialPath } from '../engine/client'
import type { SeasonModel } from '../engine/climate'
import { MONTHS } from '../engine/climate'
import { nf } from './format'

/** Long profile of the traced route, with the drop's current position. */
export function ElevationProfile({ path, progress, marks }: {
  path: SerialPath
  progress: number
  marks?: { at: number; name?: string }[]
}) {
  const W = 340
  const H = 96
  const pad = { l: 30, r: 6, t: 8, b: 16 }

  const { areaPath, linePath, x, y, minE, maxE } = useMemo(() => {
    const n = path.lon.length
    const total = path.dist[n - 1] || 1
    let minE = Infinity
    let maxE = -Infinity
    for (let i = 0; i < n; i++) {
      if (path.elev[i] < minE) minE = path.elev[i]
      if (path.elev[i] > maxE) maxE = path.elev[i]
    }
    if (!Number.isFinite(minE)) { minE = 0; maxE = 1 }
    if (maxE - minE < 20) maxE = minE + 20
    const x = scaleLinear().domain([0, total]).range([pad.l, W - pad.r])
    const y = scaleLinear().domain([minE, maxE]).range([H - pad.b, pad.t])
    const step = Math.max(1, Math.floor(n / 420))
    const pts: [number, number][] = []
    for (let i = 0; i < n; i += step) pts.push([path.dist[i], path.elev[i]])
    pts.push([path.dist[n - 1], path.elev[n - 1]])
    const ap = d3area<[number, number]>()
      .x((d) => x(d[0])).y0(H - pad.b).y1((d) => y(d[1])).curve(curveMonotoneX)
    const lp = d3line<[number, number]>()
      .x((d) => x(d[0])).y((d) => y(d[1])).curve(curveMonotoneX)
    return { areaPath: ap(pts) ?? '', linePath: lp(pts) ?? '', x, y, minE, maxE }
  }, [path])

  const n = path.lon.length
  const total = path.dist[n - 1] || 1
  const idx = Math.min(n - 1, Math.max(0, Math.round(progress * (n - 1))))
  const cx = x(path.dist[idx])
  const cy = y(path.elev[idx])

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label="Elevation profile along the water's route">
      <defs>
        <linearGradient id="elevfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5cc8ff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#5cc8ff" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#elevfill)" />
      <path d={linePath} fill="none" stroke="#8fdcff" strokeWidth="1.4" />
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--stroke)" />
      <text x={2} y={pad.t + 8}>{nf(maxE)} m</text>
      <text x={2} y={H - pad.b}>{nf(minE)} m</text>
      <text x={W - pad.r} y={H - 3} textAnchor="end">{nf(total / 1000)} km</text>
      {marks?.map((m, i) => (
        <line key={i} x1={x(m.at)} x2={x(m.at)} y1={pad.t} y2={H - pad.b}
          stroke="rgba(255,196,107,0.45)" strokeDasharray="2 2" />
      ))}
      <line x1={cx} x2={cx} y1={pad.t} y2={H - pad.b} stroke="rgba(255,255,255,0.35)" />
      <circle cx={cx} cy={cy} r="3.5" fill="#fff" stroke="#5cc8ff" strokeWidth="1.5" />
    </svg>
  )
}

/** Monthly water balance: precipitation, snowpack and modelled discharge. */
export function Hydrograph({ model, month, onMonth }: {
  model: SeasonModel
  month: number
  onMonth?: (m: number) => void
}) {
  const W = 340
  const H = 110
  const pad = { l: 26, r: 24, t: 10, b: 18 }
  const maxP = Math.max(...model.precip, 1)
  const maxQ = Math.max(...model.discharge, 1)
  const maxS = Math.max(...model.snowpack, 1)
  const x = scaleLinear().domain([0, 12]).range([pad.l, W - pad.r])
  const yP = scaleLinear().domain([0, maxP]).range([H - pad.b, pad.t])
  const yQ = scaleLinear().domain([0, maxQ]).range([H - pad.b, pad.t])
  const yS = scaleLinear().domain([0, maxS]).range([H - pad.b, pad.t])
  const bw = (x(1) - x(0)) * 0.62

  const snowLine = d3line<number>()
    .x((_, i) => x(i + 0.5)).y((d) => yS(d)).curve(curveMonotoneX)(model.snowpack) ?? ''
  const qLine = d3line<number>()
    .x((_, i) => x(i + 0.5)).y((d) => yQ(d)).curve(curveMonotoneX)(model.discharge) ?? ''

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label="Modelled seasonal water balance">
      {model.precip.map((p, i) => (
        <rect key={i} x={x(i + 0.5) - bw / 2} y={yP(p)} width={bw} height={H - pad.b - yP(p)}
          rx="2" fill={i === month ? 'rgba(140,220,255,0.85)' : 'rgba(120,180,230,0.30)'}
          onClick={() => onMonth?.(i)} style={{ cursor: onMonth ? 'pointer' : 'default' }} />
      ))}
      <path d={snowLine} fill="none" stroke="rgba(235,245,255,0.75)" strokeWidth="1.3"
        strokeDasharray="3 2" />
      <path d={qLine} fill="none" stroke="#ffc46b" strokeWidth="1.8" />
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--stroke)" />
      {MONTHS.map((m, i) => (
        i % 2 === 0 ? <text key={m} x={x(i + 0.5)} y={H - 5} textAnchor="middle">{m[0]}</text> : null
      ))}
      <text x={2} y={pad.t + 7}>{nf(maxP)}</text>
      <text x={2} y={H - pad.b}>mm</text>
    </svg>
  )
}

/** Compact horizontal bar used for water-source shares. */
export function ShareBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, b) => a + b.value, 0) || 1
  return (
    <div>
      <div style={{ display: 'flex', height: 9, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
        {parts.map((p) => (
          <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="chips" style={{ marginTop: 8 }}>
        {parts.map((p) => (
          <span className="chip" key={p.label}>
            <span style={{
              display: 'inline-block', width: 7, height: 7, borderRadius: 2,
              background: p.color, marginRight: 6,
            }} />
            {p.label} {Math.round((p.value / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  )
}
