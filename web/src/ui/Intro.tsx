import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../state/store'
import { REPO_URL } from '../config'

const SUGGESTIONS: [string, number, number][] = [
  ['A field near Munich', 11.58, 48.14],
  ['The Matterhorn', 7.66, 45.98],
  ['Snowdonia', -3.99, 53.07],
  ['Sierra de Gredos', -5.28, 40.25],
  ['Tatra Mountains', 20.0, 49.23],
  ['Icelandic highlands', -18.5, 64.7],
]

export function Intro() {
  const ready = useStore((s) => s.ready)
  const dropAt = useStore((s) => s.dropAt)
  const [dismissed, setDismissed] = useState(false)
  const open = !dismissed

  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="intro-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}>
          <motion.div className="intro glass" initial={{ scale: 0.96, y: 12 }}
            animate={{ scale: 1, y: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 24 }}>
            <svg viewBox="0 0 64 64" width="52" height="52" aria-hidden>
              <defs>
                <linearGradient id="d2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#a8ecff" /><stop offset="1" stopColor="#2b8fd4" />
                </linearGradient>
              </defs>
              <path d="M32 4C32 4 12 28 12 40a20 20 0 0 0 40 0C52 28 32 4 32 4z" fill="url(#d2)" />
            </svg>
            <h1>Follow a raindrop across Europe</h1>
            <p>
              Click anywhere on the map. A drop lands, finds the steepest way
              down, joins a stream, then a river, and keeps going until it
              reaches the sea — with every name, every border and every metre of
              descent along the way.
            </p>
            <div className="cta">
              {SUGGESTIONS.map(([label, lon, lat]) => (
                <button key={label} className="btn" disabled={!ready}
                  onClick={() => { setDismissed(true); void dropAt(lon, lat) }}>
                  {label}
                </button>
              ))}
            </div>
            <div className="cta">
              <button className="btn active" disabled={!ready} onClick={() => setDismissed(true)}>
                {ready ? 'Explore the map' : 'Loading the drainage network…'}
              </button>
            </div>
            <p className="legal">
              Routing is computed live in your browser from a D8 flow grid built
              from public elevation data (~400 m cells). Rivers, basins and
              names are derived from that grid and Natural Earth. Climate,
              discharge and travel times are transparent models, not gauge
              records. <a href={REPO_URL} style={{ color: 'var(--accent)' }}>Source & method</a>.
            </p>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
