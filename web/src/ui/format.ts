export const nf = (v: number, d = 0) =>
  v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })

export function distance(metres: number): string {
  if (!Number.isFinite(metres)) return '—'
  return metres < 1000 ? `${nf(metres)} m` : `${nf(metres / 1000, metres < 100000 ? 1 : 0)} km`
}

export function area(km2: number): string {
  if (!Number.isFinite(km2)) return '—'
  if (km2 < 1) return `${nf(km2 * 100, 0)} ha`
  if (km2 < 1000) return `${nf(km2, km2 < 10 ? 1 : 0)} km²`
  return `${nf(km2, 0)} km²`
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const h = seconds / 3600
  if (h < 1) return `${nf(seconds / 60)} min`
  if (h < 48) return `${nf(h, 1)} h`
  const d = h / 24
  if (d < 90) return `${nf(d, d < 10 ? 1 : 0)} days`
  return `${nf(d / 30.4, 1)} months`
}

export function elevation(m: number): string {
  return Number.isFinite(m) ? `${nf(Math.round(m))} m` : '—'
}

export function coord(v: number, axis: 'lat' | 'lon'): string {
  const hemi = axis === 'lat' ? (v >= 0 ? 'N' : 'S') : v >= 0 ? 'E' : 'W'
  const a = Math.abs(v)
  const d = Math.floor(a)
  const m = Math.floor((a - d) * 60)
  const s = ((a - d) * 60 - m) * 60
  return `${d}° ${String(m).padStart(2, '0')}′ ${s.toFixed(1)}″ ${hemi}`
}

export function discharge(m3s: number): string {
  if (!Number.isFinite(m3s)) return '—'
  if (m3s < 1) return `${nf(m3s * 1000)} l/s`
  return `${nf(m3s, m3s < 10 ? 1 : 0)} m³/s`
}

export function slope(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${nf(ratio * 1000, 2)} ‰`
}
