import { useEffect, useState } from 'react'

/** Reactive media query, so layout decisions survive rotation and resizing. */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    mq.addEventListener('change', on)
    on()
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

/**
 * "Compact" covers phones in portrait *and* in landscape, where the screen is
 * wide but far too short for a full-height side panel.
 */
export const COMPACT_QUERY = '(max-width: 780px), (max-height: 520px)'

export const useIsPhone = () => useMedia(COMPACT_QUERY)

/** Same test outside React (map camera, tile budgets). */
export const isCompact = () =>
  typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches

/** True when the device asks for less motion or the connection is metered. */
export function useIsLight(): boolean {
  const reduced = useMedia('(prefers-reduced-motion: reduce)')
  const [saveData, setSaveData] = useState(false)
  useEffect(() => {
    const c = (navigator as unknown as { connection?: { saveData?: boolean } }).connection
    setSaveData(Boolean(c?.saveData))
  }, [])
  return reduced || saveData
}
