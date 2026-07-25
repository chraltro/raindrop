import { AnimatePresence, motion } from 'framer-motion'
import { useMemo } from 'react'
import { useStore } from '../state/store'
import { Climate } from '../engine/climate'
import { ElevationProfile, Hydrograph, ShareBar } from './charts'
import { RIVER_FACTS, lookupFacts } from '../data/facts'
import * as f from './format'

export function Panel() {
  const s = useStore()
  if (!s.panelOpen) return null

  return (
    <motion.aside className="panel glass" initial={{ opacity: 0, x: -18 }}
      animate={{ opacity: 1, x: 0 }} transition={{ type: 'spring', stiffness: 210, damping: 26 }}>
      <AnimatePresence mode="wait">
        {s.mode === 'compare' ? <CompareView key="cmp" />
          : s.mode === 'upstream' && s.upstream ? <UpstreamView key="up" />
          : s.trace ? <JourneyView key="jn" />
          : <EmptyView key="mt" />}
      </AnimatePresence>
    </motion.aside>
  )
}

function Frame({ title, sub, children }: {
  title: string; sub: string; children: React.ReactNode
}) {
  return (
    <motion.div style={{ display: 'contents' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}>
      <div className="panel-head">
        <h2 className="panel-title">{title}</h2>
        <p className="panel-sub">{sub}</p>
      </div>
      <div className="panel-scroll">{children}</div>
    </motion.div>
  )
}

function EmptyView() {
  return (
    <Frame title="Where does the rain go?"
      sub="Click any point in Europe to release a drop.">
      <div className="section">
        <h3>How to explore</h3>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: 'var(--muted)' }}>
          <li><b style={{ color: 'var(--text)' }}>Click</b> — a drop falls and runs to the sea.</li>
          <li><b style={{ color: 'var(--text)' }}>Shift-click</b> — snap to the nearest river first.</li>
          <li><b style={{ color: 'var(--text)' }}>Upstream</b> mode — climb a river to its springs.</li>
          <li><b style={{ color: 'var(--text)' }}>Storm</b> mode — paint rain and watch drainage form.</li>
          <li><b style={{ color: 'var(--text)' }}>Compare</b> mode — put two basins side by side.</li>
        </ul>
        <p className="note">
          Every route is computed live from a D8 flow-direction grid derived from
          public elevation data at roughly 400 m resolution — nothing is
          pre-recorded.
        </p>
      </div>
    </Frame>
  )
}

function JourneyView() {
  const { trace, probe, progress, month, watershed } = useStore()
  const st = trace!.stats
  const basin = trace!.basin
  const start = trace!.start
  const climate = start.climate
  const seasons = useMemo(() => (climate ? Climate.seasons(climate) : null), [climate])
  const facts = lookupFacts(basin?.river ?? st.steps.find((x) => x.name)?.name)

  const doneAt = progress * st.distance
  const place = probe?.lake ?? probe?.country ?? 'Europe'

  return (
    <Frame
      title={basin?.river ? `To the ${st.destination}` : st.destination === 'the sea' ? 'To the sea' : `To the ${st.destination}`}
      sub={`${place} · ${f.coord(start.lat, 'lat')}, ${f.coord(start.lon, 'lon')}`}
    >
      <div className="section">
        <h3>Where the drop landed</h3>
        <div className="stat-grid">
          <Stat k="Elevation" v={f.elevation(start.elev)} />
          <Stat k="At this point" v={start.sizeClass} small />
          <Stat k="Drains" v={f.area(start.area)} />
          <Stat k="Rainfall here" v={climate ? `${f.nf(climate.precip)} mm` : '—'} sub="per year" />
        </div>
      </div>

      <div className="section">
        <h3>Watershed</h3>
        <div className="stat-grid">
          <Stat k="Basin" v={basin?.name ?? 'Coastal catchment'} small />
          <Stat k="Basin area" v={f.area(basin?.area ?? st.finalArea)} />
          <Stat k="Main river" v={basin?.river ?? '—'} small />
          <Stat k="Reaches" v={st.destination} small />
        </div>
        {basin?.countries?.length ? (
          <div className="chips" style={{ marginTop: 8 }}>
            {basin.countries.slice(0, 6).map((c) => (
              <span className="chip" key={c.iso}>{c.iso} {Math.round(c.pct)}%</span>
            ))}
          </div>
        ) : null}
        <WatershedButton />
        {watershed ? (
          <p className="note">
            Delineated live from {f.nf(watershed.cells)} flow cells ·
            {' '}{f.area(watershed.area)} drains past that point.
            {!watershed.complete && ' (truncated — basin larger than the search limit)'}
          </p>
        ) : null}
      </div>

      <div className="section">
        <h3>Water path</h3>
        <Journey steps={st.steps} doneAt={doneAt} />
      </div>

      <div className="section">
        <h3>Long profile</h3>
        <ElevationProfile path={trace!.path} progress={progress}
          marks={st.tributaries.map((t) => ({ at: t.at, name: t.name }))} />
      </div>

      <div className="section">
        <h3>Statistics</h3>
        <div className="stat-grid">
          <Stat k="Distance travelled" v={f.distance(st.distance)} />
          <Stat k="Travel time" v={f.duration(st.travelSeconds)} sub="modelled" />
          <Stat k="Highest point" v={f.elevation(st.maxElev)} />
          <Stat k="Lowest point" v={f.elevation(st.minElev)} />
          <Stat k="Elevation drop" v={f.elevation(st.drop)} />
          <Stat k="Average slope" v={f.slope(st.slope)} />
          <Stat k="Mean velocity" v={`${f.nf(st.velocityMean, 2)} m/s`} sub="modelled" />
          <Stat k="Flow at the mouth" v={f.discharge(basin?.discharge ?? st.dischargeAtEnd)} sub="modelled" />
        </div>
        <div className="chips" style={{ marginTop: 10 }}>
          {st.countries.map((c) => <span className="chip" key={c}>{c}</span>)}
        </div>
        {st.lakes.length ? (
          <p className="note">Flows through <b>{st.lakes.join(', ')}</b>.</p>
        ) : null}
      </div>

      {st.tributaries.length ? (
        <div className="section">
          <h3>Largest tributaries joined</h3>
          {st.tributaries.slice(0, 5).map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0' }}>
              <span>{t.name ?? `Unnamed inflow at ${f.distance(t.at)}`}</span>
              <span style={{ color: 'var(--muted)' }}>+{f.area(t.area)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {seasons ? (
        <div className="section">
          <h3>Through the year</h3>
          <Hydrograph model={seasons} month={month}
            onMonth={(m) => useStore.setState({ month: m, seasonal: true })} />
          <div className="chips" style={{ marginTop: 6 }}>
            <span className="chip">bars: rainfall</span>
            <span className="chip">dashes: snowpack</span>
            <span className="chip">line: discharge</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <ShareBar parts={[
              { label: 'Snowmelt', value: seasons.snowShare, color: '#cfe9ff' },
              { label: 'Direct rain', value: (1 - seasons.snowShare) * (1 - seasons.baseflowShare), color: '#5cc8ff' },
              { label: 'Groundwater', value: (1 - seasons.snowShare) * seasons.baseflowShare, color: '#3c7fb0' },
            ]} />
          </div>
          {seasons.frozenMonths.length ? (
            <p className="note">Mean monthly temperature stays below −2 °C for
              {' '}{seasons.frozenMonths.length} month(s) — the river ices over in winter.</p>
          ) : null}
          <p className="note">
            Modelled from station-interpolated climate normals with a degree-day
            snow model — an estimate, not a gauge record.
          </p>
        </div>
      ) : null}

      {facts ? <FactCard name={facts.name} /> : null}
    </Frame>
  )
}

function WatershedButton() {
  const { trace, showWatershed, loadWatershed, set, watershed } = useStore()
  if (!trace) return null
  return (
    <button
      className={`btn ${showWatershed ? 'active' : ''}`}
      style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
      onClick={() => {
        if (watershed) set('showWatershed', !showWatershed)
        else void loadWatershed(trace.start.lon, trace.start.lat)
      }}
    >
      {showWatershed && watershed ? 'Hide watershed' : 'Show watershed'}
    </button>
  )
}

function Journey({ steps, doneAt }: { steps: ReturnType<typeof Object>[] | any[]; doneAt: number }) {
  return (
    <div className="journey">
      {steps.map((s: any, i: number) => {
        const done = doneAt >= s.from
        return (
          <div key={i}
            className={`journey-row ${s.kind === 'sea' ? 'is-sea' : ''} ${s.kind === 'rain' ? 'is-rain' : ''} ${done ? 'is-done' : 'is-pending'}`}>
            <div className="journey-rail">
              <div className="journey-dot" />
              {i < steps.length - 1 && <div className="journey-line" />}
            </div>
            <div className="journey-body">
              <div className="journey-label">{s.label}</div>
              <div className="journey-meta">
                {s.kind === 'rain' ? 'the drop lands'
                  : s.kind === 'sea' ? 'journey ends'
                  : `${f.distance(s.to - s.from)} · ${f.area(s.area)} upstream${s.drop > 5 ? ` · −${f.elevation(s.drop)}` : ''}`}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function UpstreamView() {
  const { upstream } = useStore()
  const up = upstream!
  const named = useMemo(() => {
    const m = new Map<string, number>()
    up.names.forEach((n, i) => {
      if (!n) return
      m.set(n, Math.max(m.get(n) ?? 0, up.area[i]))
    })
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  }, [up])
  const maxDepth = Math.max(...Array.from(up.depth), 0)
  return (
    <Frame title="Upstream" sub={`${f.area(up.root.area)} of land drains past this point`}>
      <div className="section">
        <h3>The network above</h3>
        <div className="stat-grid">
          <Stat k="Branches traced" v={f.nf(up.paths.length)} />
          <Stat k="Branching depth" v={String(maxDepth)} />
        </div>
        <p className="note">
          The animation runs the water backwards: main stem first, then each
          tributary generation, out to the headwaters and springs.
        </p>
      </div>
      {named.length ? (
        <div className="section">
          <h3>Rivers feeding this point</h3>
          {named.map(([n, a]) => (
            <div key={n} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0' }}>
              <span>{n}</span><span style={{ color: 'var(--muted)' }}>{f.area(a)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Frame>
  )
}

function CompareView() {
  const { compare } = useStore()
  const [a, b] = compare
  return (
    <Frame title="Compare basins" sub="Click two rivers to put their catchments side by side">
      {[a, b].map((slot, i) => (
        <div className="section" key={i}>
          <h3 style={{ color: slot.color }}>{slot.basin?.name ?? `Basin ${i + 1} — click a river`}</h3>
          {slot.basin ? (
            <div className="stat-grid">
              <Stat k="Area" v={f.area(slot.watershed?.area ?? slot.basin.area)} />
              <Stat k="Flows to" v={slot.basin.sea} small />
              <Stat k="Mean elevation" v={f.elevation(slot.basin.meanElev)} />
              <Stat k="Highest point" v={f.elevation(slot.basin.maxElev)} />
              <Stat k="Discharge" v={f.discharge(slot.basin.discharge ?? NaN)} sub="modelled" />
              <Stat k="Runoff" v={slot.basin.runoff ? `${f.nf(slot.basin.runoff)} mm` : '—'} sub="per year" />
              <Stat k="Glaciated" v={`${f.nf(slot.basin.glacierPct, 2)} %`} />
              <Stat k="Lakes" v={`${f.nf(slot.basin.lakePct, 2)} %`} />
            </div>
          ) : null}
          {slot.basin?.countries?.length ? (
            <div className="chips" style={{ marginTop: 8 }}>
              {slot.basin.countries.slice(0, 6).map((c) => (
                <span className="chip" key={c.iso}>{c.iso} {Math.round(c.pct)}%</span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      {a.basin && b.basin ? (
        <div className="section">
          <h3>Difference</h3>
          <p className="note">
            {a.basin.name} is <b>{f.nf((a.watershed?.area ?? a.basin.area) / (b.watershed?.area ?? b.basin.area), 2)}×</b>
            {' '}the area of {b.basin.name} and carries{' '}
            <b>{f.nf((a.basin.discharge ?? 1) / (b.basin.discharge ?? 1), 2)}×</b> the modelled flow.
          </p>
        </div>
      ) : null}
    </Frame>
  )
}

function FactCard({ name }: { name: string }) {
  const fact = RIVER_FACTS[name]
  if (!fact) return null
  return (
    <div className="section">
      <h3>About the {name}</h3>
      <p className="note" style={{ marginTop: 0 }}>{fact.summary}</p>
      <div className="stat-grid" style={{ marginTop: 10 }}>
        {fact.length ? <Stat k="Length" v={`${f.nf(fact.length)} km`} /> : null}
        {fact.basin ? <Stat k="Basin" v={f.area(fact.basin)} /> : null}
        {fact.discharge ? <Stat k="Mean flow (gauged)" v={f.discharge(fact.discharge)} /> : null}
        {fact.source ? <Stat k="Source" v={fact.source} small /> : null}
      </div>
      {fact.tributaries?.length ? (
        <div className="chips" style={{ marginTop: 10 }}>
          {fact.tributaries.map((t) => <span className="chip" key={t}>{t}</span>)}
        </div>
      ) : null}
      {fact.floods ? <p className="note"><b>Flood history.</b> {fact.floods}</p> : null}
      {fact.ecology ? <p className="note"><b>Ecology.</b> {fact.ecology}</p> : null}
    </div>
  )
}

function Stat({ k, v, sub, small }: { k: string; v: string; sub?: string; small?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v" style={small ? { fontSize: 13, fontWeight: 560 } : undefined}>
        {v}{sub ? <small>{sub}</small> : null}
      </div>
    </div>
  )
}
