import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setWorkerUrl } from 'maplibre-gl'
// MapLibre finds its worker with `new URL('./maplibre-gl-worker.mjs',
// import.meta.url)`. Once the library is bundled, import.meta.url points at our
// own chunk, so it asked for a file that had never been emitted: the request
// 404ed, the worker died on the spot, and every GeoJSON source then waited
// forever without raising a single error. Rivers, basins, borders, lakes and
// watersheds were all silently missing. Telling Vite to build the worker gives
// it a URL that exists.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles/global.css'
import { App } from './App'

setWorkerUrl(maplibreWorkerUrl)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
