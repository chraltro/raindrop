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
import { useIsPhone } from './ui/useMedia'

export function App() {
  const phone = useIsPhone()
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
          {phone ? <ControlsButton /> : <div className="spacer" />}
        </div>
        <Panel />
        <Rail />
        <Timeline />
        {phone ? <ReopenPanel /> : null}
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

function ControlsButton() {
  const railOpen = useStore((s) => s.railOpen)
  const set = useStore((s) => s.set)
  return (
    <button className={`btn fab glass ${railOpen ? 'active' : ''}`}
      aria-label="Map controls" aria-expanded={railOpen}
      onClick={() => set('railOpen', !railOpen)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" />
      </svg>
    </button>
  )
}

/** When the sheet is dismissed, one tap brings the current journey back. */
function ReopenPanel() {
  const panelOpen = useStore((s) => s.panelOpen)
  const hasResult = useStore((s) => Boolean(s.trace || s.upstream || s.compare[0].basin))
  // the timeline owns the bottom of the screen whenever there is something
  // playing, so the pill sits above it rather than on top of it
  const timeline = useStore((s) => Boolean(s.trace || s.upstream || s.rainPaths))
  const set = useStore((s) => s.set)
  if (panelOpen || !hasResult) return null
  return (
    <button className={`btn glass reopen ${timeline ? 'stacked' : ''}`}
      onClick={() => set('panelOpen', true)}>
      Show the journey
    </button>
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
