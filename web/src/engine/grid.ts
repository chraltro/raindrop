/**
 * Web-Mercator grid geometry shared by every engine module.
 *
 * The hydrological grid is a plain XYZ pixel grid at `zoom`: one cell is one
 * Web-Mercator pixel, so a cell is `156543.03 / 2^zoom * cos(lat)` metres wide.
 */

export interface Manifest {
  zoom: number
  width: number
  height: number
  pixelX0: number
  pixelY0: number
  tileSize: number
  superTile: number
  bbox: [number, number, number, number]
  superTileX0: number
  superTileY0: number
  superTilesX: number
  superTilesY: number
  accScale: number
  accTileSize: number
  flowTiles: string[]
  accTiles: string[]
  elevZoom: number
  elevTileSize: number
  elevTiles: Record<string, [number, number]>
  overviewFactor: number
  overviewWidth: number
  overviewHeight: number
  overviewElevOffset: number
  reliefMinZoom: number
  reliefMaxZoom: number
}

export const EARTH_CIRCUMFERENCE = 40075016.686
export const MAX_LAT = 85.05112878

/** D8 neighbour offsets, index = direction code (0 = terminal). */
export const DX = [0, 1, 1, 0, -1, -1, -1, 0, 1]
export const DY = [0, 0, 1, 1, 1, 0, -1, -1, -1]

export const CLASS = {
  LAND: 0,
  OCEAN: 1,
  LAKE: 2,
  SINK: 3,
  EDGE: 4,
  ICE: 5,
} as const

export function lonToPixel(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 256 * (1 << zoom)
}

export function latToPixel(lat: number, zoom: number): number {
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * (1 << zoom)
}

export function pixelToLon(x: number, zoom: number): number {
  return (x / (256 * (1 << zoom))) * 360 - 180
}

export function pixelToLat(y: number, zoom: number): number {
  const n = Math.PI * (1 - (2 * y) / (256 * (1 << zoom)))
  return (180 / Math.PI) * Math.atan(Math.sinh(n))
}

/** Ground size of one grid cell in metres at a given raster row. */
export function cellSize(y: number, zoom: number): number {
  const lat = pixelToLat(y + 0.5, zoom)
  return (EARTH_CIRCUMFERENCE / (256 * (1 << zoom))) * Math.cos((lat * Math.PI) / 180)
}

/** Great-circle distance in metres. */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371008.8
  const p = Math.PI / 180
  const dLat = (lat2 - lat1) * p
  const dLon = (lon2 - lon1) * p
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Drainage area (km²) from the 8-bit log encoding used by the acc tiles. */
export function decodeArea(v: number, scale: number): number {
  return v === 0 ? 0 : Math.pow(2, v / scale) - 1
}
