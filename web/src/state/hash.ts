/** Share links: the whole exploration state lives in the URL fragment. */
import { useStore, type Overlay } from './store'
import type { Theme } from '../map/styles'

export interface HashState {
  drop?: [number, number]
  theme?: Theme
  overlay?: Overlay
}

export function readHash(): HashState {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''))
  const out: HashState = {}
  const d = h.get('d')
  if (d) {
    const [lon, lat] = d.split(',').map(Number)
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.drop = [lon, lat]
  }
  const t = h.get('t')
  if (t === 'relief' || t === 'dark' || t === 'light' || t === 'satellite') out.theme = t
  const o = h.get('o')
  if (o) out.overlay = o as Overlay
  return out
}

let last = ''
export function writeHash() {
  const s = useStore.getState()
  const p = new URLSearchParams()
  if (s.probe) p.set('d', `${s.probe.lon.toFixed(4)},${s.probe.lat.toFixed(4)}`)
  if (s.theme !== 'relief') p.set('t', s.theme)
  if (s.overlay !== 'none') p.set('o', s.overlay)
  const next = p.toString()
  if (next === last) return
  last = next
  history.replaceState(null, '', next ? `#${next}` : location.pathname + location.search)
}

export function shareUrl(): string {
  writeHash()
  return location.href
}
