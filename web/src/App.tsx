import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MapCanvas } from './map/MapCanvas'
import { Panel } from './ui/Panel'
import { Rail } from './ui/Rail'
import { Timeline } from './ui/Timeline'
import { SearchBox } from './ui/SearchBox'
import { Labels } from './ui/Labels'
import { Intro } from './ui/Intro'
import { useStore } from './state/store'
import { DATA_URL } from './config'
import { readHash, writeHash } from './state/hash'

export function App() {
  const ready = useStore((s) => s.ready)
  const loading = useStore((s) => s.loading)
  const error = useStore((s) => s.error)
  const theme = useStore((s) => s.theme)
  const init = useStore((s) => s.init)

  useEffect(() => { void init(DATA_URL) }, [init])

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
  }, [theme])

  // restore a shared link once the engine is up
  useEffect(() => {
    if (!ready) return
    const h = readHash()
    if (h.theme) useStore.setState({ theme: h.theme })
    if (h.overlay) useStore.setState({ overlay: h.overlay })
    if (h.drop) void useStore.getState().dropAt(h.drop[0], h.drop[1])
    const unsub = useStore.subscribe(writeHash)
    return unsub
  }, [ready])

  return (
    <>
      <MapCanvas />
      <Labels />
      <div className="shell">
        <div className="topbar">
          <Brand />
          <SearchBox />
          <div className="spacer" />
        </div>
        <Panel />
        <Rail />
        <Timeline />
        <AnimatePresence>
          {(loading || error) && (
            <motion.div
              className="toast glass"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
            >
              {error ? <span>⚠︎ {error}</span> : (<><span className="spin" />{loading}</>)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <Intro />
    </>
  )
}

function Brand() {
  return (
    <div className="brand glass">
      <svg viewBox="0 0 64 64" aria-hidden>
        <defs>
          <linearGradient id="drop" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#a8ecff" />
            <stop offset="1" stopColor="#2b8fd4" />
          </linearGradient>
        </defs>
        <path d="M32 4C32 4 12 28 12 40a20 20 0 0 0 40 0C52 28 32 4 32 4z" fill="url(#drop)" />
      </svg>
      <div>
        European River Runner
        <small>click anywhere · watch the water go</small>
      </div>
    </div>
  )
}
