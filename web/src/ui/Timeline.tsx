import { motion } from 'framer-motion'
import { useStore } from '../state/store'
import * as f from './format'

export function Timeline() {
  const { trace, playing, progress, set, upstream, rainPaths } = useStore()
  const active = trace || upstream || rainPaths
  if (!active) return null

  const st = trace?.stats
  const travelled = st ? progress * st.distance : 0
  const eta = st ? progress * st.travelSeconds : 0

  return (
    <motion.div className="timeline glass" initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}>
      <button className="btn icon" onClick={() => set('playing', !playing)}
        aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button className="btn icon" onClick={() => { set('progress', 0); set('playing', true) }}
        aria-label="Replay">↺</button>
      <input type="range" min={0} max={1000} value={Math.round(progress * 1000)}
        style={{ ['--pct' as string]: `${progress * 100}%` }}
        onChange={(e) => { set('playing', false); set('progress', Number(e.target.value) / 1000) }} />
      {st ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', minWidth: 168, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {f.distance(travelled)} · {f.duration(eta)}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          {rainPaths ? `${rainPaths.length} drops` : 'upstream'}
        </div>
      )}
    </motion.div>
  )
}
