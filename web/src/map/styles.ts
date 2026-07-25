/**
 * Map styles are built in code from the project's own data, so the app needs
 * no tile API key and keeps working when third-party services are blocked.
 *
 * Labels are drawn as DOM elements (see ui/Labels.tsx) rather than SDF symbol
 * layers, which means no glyph server is required either.
 */
import type { StyleSpecification } from 'maplibre-gl'

export type Theme = 'relief' | 'dark' | 'light' | 'satellite'

export const AWS_TERRAIN =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
export const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

interface Palette {
  ocean: string
  land: string
  landOutline: string
  border: string
  lake: string
  lakeOutline: string
  river: string
  riverGlow: string
  urban: string
  glacier: string
  reliefOpacity: number
  reliefBrightMin: number
  reliefBrightMax: number
  reliefSaturation: number
  reliefContrast: number
  hillshadeShadow: string
  hillshadeHighlight: string
  hillshadeAccent: string
}

export const PALETTES: Record<Theme, Palette> = {
  relief: {
    ocean: '#0a1d33', land: '#101a24', landOutline: 'rgba(255,255,255,0.10)',
    border: 'rgba(255,255,255,0.16)', lake: '#123b5c', lakeOutline: 'rgba(150,210,255,0.35)',
    river: '#5cc8ff', riverGlow: 'rgba(92,200,255,0.30)',
    urban: 'rgba(255,225,180,0.10)', glacier: 'rgba(220,240,255,0.55)',
    reliefOpacity: 1, reliefBrightMin: 0.02, reliefBrightMax: 0.95,
    reliefSaturation: -0.08, reliefContrast: 0.08,
    hillshadeShadow: '#04121f', hillshadeHighlight: '#dff1ff', hillshadeAccent: '#0d2b45',
  },
  dark: {
    ocean: '#04080f', land: '#0b1119', landOutline: 'rgba(120,180,240,0.16)',
    border: 'rgba(140,190,240,0.20)', lake: '#0d2740', lakeOutline: 'rgba(120,200,255,0.30)',
    river: '#54c4ff', riverGlow: 'rgba(84,196,255,0.35)',
    urban: 'rgba(255,210,150,0.07)', glacier: 'rgba(190,225,255,0.30)',
    reliefOpacity: 0.42, reliefBrightMin: 0, reliefBrightMax: 0.55,
    reliefSaturation: -0.85, reliefContrast: 0.35,
    hillshadeShadow: '#000308', hillshadeHighlight: '#4a5f7a', hillshadeAccent: '#08131f',
  },
  light: {
    ocean: '#d9e8f5', land: '#f6f4ef', landOutline: 'rgba(30,60,90,0.16)',
    border: 'rgba(40,70,100,0.22)', lake: '#bcd9f0', lakeOutline: 'rgba(40,110,170,0.35)',
    river: '#2b8fd4', riverGlow: 'rgba(43,143,212,0.25)',
    urban: 'rgba(190,170,140,0.22)', glacier: 'rgba(255,255,255,0.85)',
    reliefOpacity: 0.55, reliefBrightMin: 0.35, reliefBrightMax: 1,
    reliefSaturation: -0.35, reliefContrast: -0.1,
    hillshadeShadow: '#7a8a99', hillshadeHighlight: '#ffffff', hillshadeAccent: '#c8d6e2',
  },
  satellite: {
    ocean: '#08131f', land: '#101a24', landOutline: 'rgba(255,255,255,0.10)',
    border: 'rgba(255,255,255,0.25)', lake: 'rgba(20,60,90,0.2)', lakeOutline: 'rgba(150,210,255,0.25)',
    river: '#7fdcff', riverGlow: 'rgba(127,220,255,0.35)',
    urban: 'rgba(0,0,0,0)', glacier: 'rgba(0,0,0,0)',
    reliefOpacity: 0, reliefBrightMin: 0, reliefBrightMax: 1,
    reliefSaturation: 0, reliefContrast: 0,
    hillshadeShadow: '#000000', hillshadeHighlight: '#ffffff', hillshadeAccent: '#000000',
  },
}

/** Width of a river line as a function of drainage area (km²) and zoom. */
const riverWidth = (scale = 1): any => [
  'interpolate', ['linear'], ['zoom'],
  3, ['*', scale, ['interpolate', ['linear'], ['sqrt', ['get', 'dn']], 20, 0.25, 300, 0.9, 1200, 2.2]],
  7, ['*', scale, ['interpolate', ['linear'], ['sqrt', ['get', 'dn']], 5, 0.4, 60, 1.1, 300, 2.4, 1200, 5]],
  11, ['*', scale, ['interpolate', ['linear'], ['sqrt', ['get', 'dn']], 5, 1.2, 60, 3, 300, 7, 1200, 14]],
]

export function buildStyle(dataUrl: string, theme: Theme, opts: {
  dem: boolean
  bounds: [number, number, number, number]
  reliefMinZoom: number
  reliefMaxZoom: number
}): StyleSpecification {
  const p = PALETTES[theme]
  const sources: StyleSpecification['sources'] = {
    relief: {
      type: 'raster',
      tiles: [`${dataUrl}/relief/{z}/{x}/{y}.webp`],
      tileSize: 256,
      minzoom: opts.reliefMinZoom,
      maxzoom: opts.reliefMaxZoom,
      bounds: opts.bounds,
      attribution:
        'Relief & hydrography derived from <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (SRTM/ASTER/NED) · <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
    },
    countries: { type: 'geojson', data: `${dataUrl}/vector/countries.geojson` },
    coastline: { type: 'geojson', data: `${dataUrl}/vector/coastline.geojson` },
    lakes: { type: 'geojson', data: `${dataUrl}/vector/lakes.geojson` },
    lakesEu: { type: 'geojson', data: `${dataUrl}/vector/lakes_eu.geojson` },
    glaciers: { type: 'geojson', data: `${dataUrl}/vector/glaciers.geojson` },
    urban: { type: 'geojson', data: `${dataUrl}/vector/urban.geojson` },
    rivers0: { type: 'geojson', data: `${dataUrl}/rivers-lod0.geojson` },
    rivers1: { type: 'geojson', data: `${dataUrl}/rivers-lod1.geojson` },
    rivers2: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    basins: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    watershed: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  }
  if (opts.dem) {
    sources.dem = {
      type: 'raster-dem',
      tiles: [AWS_TERRAIN],
      tileSize: 256,
      maxzoom: 13,
      encoding: 'terrarium',
    }
  }
  if (theme === 'satellite') {
    sources.satellite = {
      type: 'raster',
      tiles: [ESRI_IMAGERY],
      tileSize: 256,
      maxzoom: 17,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    }
  }

  const layers: StyleSpecification['layers'] = [
    { id: 'bg', type: 'background', paint: { 'background-color': p.ocean } },
  ]

  if (theme !== 'satellite') {
    layers.push({
      id: 'land', type: 'fill', source: 'countries',
      paint: { 'fill-color': p.land },
    })
  }
  if (theme === 'satellite') {
    layers.push({
      id: 'satellite', type: 'raster', source: 'satellite',
      paint: { 'raster-opacity': 1 },
    })
  } else {
    layers.push({
      id: 'relief', type: 'raster', source: 'relief',
      paint: {
        'raster-opacity': p.reliefOpacity,
        'raster-brightness-min': p.reliefBrightMin,
        'raster-brightness-max': p.reliefBrightMax,
        'raster-saturation': p.reliefSaturation,
        'raster-contrast': p.reliefContrast,
        'raster-resampling': 'linear',
        'raster-fade-duration': 200,
      },
    })
  }

  if (opts.dem) {
    layers.push({
      id: 'hillshade', type: 'hillshade', source: 'dem',
      minzoom: 7,
      paint: {
        'hillshade-exaggeration': theme === 'light' ? 0.35 : 0.5,
        'hillshade-shadow-color': p.hillshadeShadow,
        'hillshade-highlight-color': p.hillshadeHighlight,
        'hillshade-accent-color': p.hillshadeAccent,
      },
    })
  }

  layers.push(
    {
      id: 'glaciers', type: 'fill', source: 'glaciers',
      paint: { 'fill-color': p.glacier, 'fill-opacity': 0.5 },
    },
    {
      id: 'urban', type: 'fill', source: 'urban', minzoom: 5,
      paint: { 'fill-color': p.urban },
    },
    {
      id: 'basins-fill', type: 'fill', source: 'basins',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.5, 0.26],
      },
    },
    {
      id: 'basins-line', type: 'line', source: 'basins',
      layout: { visibility: 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 0.8, 'line-opacity': 0.8 },
    },
    {
      id: 'rivers2-glow', type: 'line', source: 'rivers2', minzoom: 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.riverGlow, 'line-width': riverWidth(3.2), 'line-blur': 3 },
    },
    {
      id: 'rivers2', type: 'line', source: 'rivers2', minzoom: 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.river, 'line-width': riverWidth(0.85), 'line-opacity': 0.85 },
    },
    {
      id: 'rivers1-glow', type: 'line', source: 'rivers1', minzoom: 4.5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.riverGlow, 'line-width': riverWidth(3), 'line-blur': 3 },
    },
    {
      id: 'rivers1', type: 'line', source: 'rivers1', minzoom: 4.5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.river, 'line-width': riverWidth(1) },
    },
    {
      id: 'rivers0', type: 'line', source: 'rivers0', maxzoom: 5.2,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.river, 'line-width': riverWidth(1), 'line-opacity': 0.9 },
    },
    {
      id: 'lakes', type: 'fill', source: 'lakes',
      paint: { 'fill-color': p.lake, 'fill-outline-color': p.lakeOutline },
    },
    {
      id: 'lakes-eu', type: 'fill', source: 'lakesEu', minzoom: 5,
      paint: { 'fill-color': p.lake, 'fill-outline-color': p.lakeOutline },
    },
    {
      id: 'coastline', type: 'line', source: 'coastline',
      paint: {
        'line-color': p.landOutline,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 10, 1.4],
      },
    },
    {
      id: 'borders', type: 'line', source: 'countries',
      paint: {
        'line-color': p.border,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 10, 1.2],
        'line-dasharray': [3, 2],
      },
    },
    {
      id: 'watershed-fill', type: 'fill', source: 'watershed',
      paint: { 'fill-color': '#4dd0ff', 'fill-opacity': 0.14 },
    },
    {
      id: 'watershed-line', type: 'line', source: 'watershed',
      paint: {
        'line-color': '#8ae7ff', 'line-width': 1.6, 'line-opacity': 0.9,
        'line-blur': 0.4,
      },
    },
  )

  return {
    version: 8,
    name: `River Runner ${theme}`,
    sources,
    layers,
    sky: theme === 'satellite' || theme === 'relief'
      ? { 'sky-color': '#0a1626', 'horizon-color': '#1d3a55', 'fog-color': '#0a1626', 'fog-ground-blend': 0.6 }
      : undefined,
  } as StyleSpecification
}
