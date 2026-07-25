# European River Runner

Click anywhere in Europe and watch a drop of rain find its way to the sea.

The drop lands on a hillside, finds the steepest way down, joins a stream, then
a river, then a bigger river, and keeps going until it reaches the Atlantic, the
North Sea, the Baltic, the Mediterranean, the Black Sea, the Arctic, the
Caspian — or an inland lake. Along the way the app names every river it joins,
counts the countries it crosses, measures the drop in elevation and estimates
how long the journey takes.

**Live:** https://chraltro.github.io/raindrop/

Everything runs in the browser. There is no backend and no API key: the drainage
network of the whole continent is precomputed into static tiles, and the routing
happens in a Web Worker on the visitor's machine. The basemap underneath comes
from public tile services (CARTO, Esri); if they cannot be reached, a shaded
relief rendered from the project's own elevation data takes over.

---

## What you can do

| | |
|---|---|
| **Drop** | Click anywhere. A glowing droplet runs downstream in real time with a cinematic camera. Shift-click snaps to the nearest river first. |
| **Upstream** | Click a river and climb it in reverse — main stem, then tributaries, then headwaters and springs. |
| **Storm** | Release up to 6,000 drops over an area and watch them merge into streams, then rivers, then one river to the sea. |
| **Compare** | Delineate two basins side by side and compare area, relief, runoff and modelled discharge. |
| **Show watershed** | Delineate the exact catchment above any point, live, by walking the flow grid upstream — up to millions of cells. |
| **Overlays** | Rainfall, snowpack, runoff, stream network, elevation, slope — all recoloured in the browser, so the seasonal slider responds instantly. |
| **Season** | January → December: snow accumulating and melting, the discharge hydrograph, frozen months. |
| **Time travel** | 1600 → today: dated river straightenings, canals, reservoirs, drainage schemes, dam removals and disasters. |
| **Search** | ~79,000 towns and villages, every named river, lakes, peaks, basins or raw coordinates — all offline. |
| **Share** | The URL carries the drop location, theme and overlay. Copy the link, send the journey. |

Installable as a PWA. On phones and in landscape the interface becomes sheets:
a compact top bar, a bottom sheet for the journey that expands, collapses and
closes, and a controls sheet behind one button — nothing sits permanently on
top of the map. The cinematic ride is opt-in there; by default a tap frames the
whole route, which keeps the map still and the frame rate high.

---

## How it works

### 1. Preprocessing (`pipeline/`, Python)

```
Terrain tiles (SRTM / ASTER / NED / EU-DEM via the AWS terrain-tiles bucket)
      ↓  assemble a 16,384 × 13,312 Web-Mercator DEM at zoom 8 (~390 m at 50°N)
Priority-flood depression filling with an epsilon gradient  (Barnes et al. 2014)
      ↓
D8 steepest-descent flow directions                         (O'Callaghan & Mark 1984)
      ↓
Topological (Kahn) traversal → flow accumulation, Strahler order, basin labels
      ↓
Static tiles + vector network + basin catalogue
```

218 million cells, a few minutes end to end, all of it numba-compiled. The
published artefacts are:

| Artefact | What it is |
|---|---|
| `flow/{x}/{y}.png` | 512² greyscale: D8 direction in the low nibble, terminal class (ocean / lake / sink / edge / ice) in the high nibble |
| `acc/{x}/{y}.png` | 256² greyscale: `area_km² = 2^(v/11) − 1` |
| `elev/{x}/{y}.png` | 512² greyscale with a per-tile base and step — adaptive precision, finer over flat ground |
| `relief/{z}/{x}/{y}.webp` | hypsometric tint + hillshade rendered from the same DEM: the offline-fallback basemap, self-hosted |
| `rivers-lod{0,1,2}.geojson` | the derived network split into reaches at every confluence, named against Natural Earth |
| `basins.json` / `basins.geojson` | 1,896 catchments with area, relief, destination sea, country shares and modelled discharge |
| `climate/*.png` | interpolated precipitation, temperature and runoff |
| `search.json` | small label/quick-search index (2.5 k prominent entries) |
| `gazetteer.json` | ~79 k towns and every named reach, fetched on first search |

Rebuild it all with:

```bash
python -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
PYTHONPATH=pipeline .venv/bin/python -m riverrunner.cli all
```

Individual stages: `fetch`, `hydro`, `tiles`, `relief`, `rivers`, `basins`,
`climate`, `web`. `RR_ZOOM=7` produces a quarter-size dataset for quick
iteration.

### 2. The engine (`web/src/engine/`, TypeScript in a Web Worker)

The worker fetches flow tiles on demand and walks the grid directly:

* **`traceDown`** — follow the D8 pointers to the terminal cell. A path from the
  Alps to the Black Sea is ~4,000 cells and resolves in well under a second.
* **`watershed`** — breadth-first walk *up* the flow tree. Visited cells live in
  a bitset over the whole continent (27 MB, one bit per cell) rather than a hash
  set, which is what makes a five-million-cell Danube catchment practical in a
  browser. The mask is turned into rings by an edge-stitching contour walk.
* **`upstream`** — the tributary network above a point, breadth-first, so the
  animation can run the water backwards generation by generation.
* **`analysePath`** — names, countries, lakes, tributaries, travel time.

Hot loops only `await` when a tile is genuinely missing; awaiting per cell would
add a microtask per step and turn a one-second fill into minutes.

### 3. The map (`web/src/map/`)

MapLibre GL with the style built in code: a public raster basemap (CARTO Voyager
/ Positron / Dark Matter, Esri World Imagery) underneath, and the project's own
hydrology — rivers by drainage area, basins, watershed outlines — drawn over it.
The basemap brings towns, coastlines and roads, so the only labels drawn in the
DOM are river names, and no glyph server is needed.

Every provider is probed on load and watched for tile errors; a theme whose
provider is blocked falls back to the self-hosted relief on its own, without
taking the others down with it. deck.gl draws the animated route with a
`TripsLayer`, so revealing the route is a GPU-side `currentTime` update rather
than a per-frame data upload. Optional hillshade and 3D terrain use the public
terrain-tile service and degrade quietly when it is unavailable.

---

## How accurate is it?

**Routing** is as good as a 390 m DEM allows, and at continental scale that is
quite good: the derived Danube basin is 795,730 km² against a published
801,463 km², the Volga 1.47 M km² against 1.36 M, and river mouths land within a
few kilometres of reality. What a 390 m grid cannot do is resolve a small
stream, a levee, or the exact channel through a flat delta — in the Rhine and
Danube deltas the drop picks *a* distributary, not necessarily the main one.

**Names** come from Natural Earth centrelines matched to the derived network by
proximity and drainage area. About 71 % of reaches above 1,500 km² get a name;
the rest show a size class ("Small river", "Major river"). Natural Earth stops
at fairly large rivers, so a local name like *Drammenselva* is not in the data —
place names come from a much deeper gazetteer (~79,000 settlements), rivers do
not. Fixing that needs an OpenStreetMap waterway extract.

**Basemap resolution.** The shaded relief shipped with the app is rendered from
the DEM up to zoom 7 (~1.2 km per tile pixel) and is stretched above that, so it
softens as you zoom past regional scale. Hillshade from the public terrain-tile
service adds real detail from zoom 6 upward when that service is reachable.
Rendering relief at zoom 8 needs `export_relief` to work in horizontal bands —
in one pass it allocates a 218-megapixel float image and gets killed.

**Discharge, travel time and seasonality are models, not measurements**, and the
app says so wherever it shows them:

* Precipitation and temperature are interpolated from 173 published station
  normals with an elevation lapse rate and an orographic correction.
* Runoff follows a Budyko water balance (Fu 1981) driven by Oudin PET, with the
  PET bias factor calibrated against **37 gauged European rivers**
  (`pipeline/riverrunner/calibrate.py`). Median modelled/observed discharge is
  **0.92** and the mean |log error| **0.55** — a typical error of about a factor
  of 1.7, worst in dry and heavily abstracted basins such as the Guadiana, best
  in humid temperate ones.
* Travel time uses Manning's equation with hydraulic geometry
  (`v = R^{2/3}·√S / n`, `R ≈ 0.3·Q^{0.3}`, `n = 0.04`) and a slower sheet-flow
  velocity on the hillslope before a channel forms.
* The snow model is a degree-day model spun up over three years.

None of this accounts for dams, abstraction, irrigation or inter-basin
transfers, so on regulated rivers the modelled numbers describe the landscape
rather than what a gauge would record today.

**Coverage** is the box 25°W–62°E, 33°N–72°N: Iceland, Scandinavia to the North
Cape, Britain and Ireland, Iberia, the Alps, the Balkans, the Baltics, and
European Russia out to the Volga and the Caspian. Basins that leave the box
(Amu Darya, Euphrates, Ob headwaters) are reported as draining "beyond the
mapped area" instead of being given an invented outlet.

---

## Data sources

All open, all credited in the map attribution:

* **[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)** on AWS Open
  Data — SRTM, ASTER GDEM, NED, EU-DEM and national datasets, terrarium-encoded.
  The DEM behind every route, the relief basemap and the hillshade.
* **[Natural Earth](https://www.naturalearthdata.com/)** (public domain) —
  coastlines, countries, lakes, glaciers, urban areas, marine names, populated
  places, elevation points, and the river centrelines used for naming.
* **Station climate normals** from published national records, listed with
  coordinates and values in `pipeline/riverrunner/climate.py`.
* **Gauged discharges** from national hydrological yearbooks and the GRDC river
  catalogue, listed in `pipeline/riverrunner/calibrate.py`.
* Optional at runtime: Esri World Imagery for the satellite basemap.

Methods cited in the code: Barnes, Lehman & Mulla (2014) priority-flood;
O'Callaghan & Mark (1984) D8; Strahler (1957) stream order; Fu (1981) Budyko
form; Oudin et al. (2005) PET; FAO-56 extraterrestrial radiation.

---

## Repository layout

```
pipeline/riverrunner/   DEM download, D8 hydrology, vectorisation, basins,
                        climate, tile export, calibration
web/                    React + TypeScript + MapLibre + deck.gl front end
  src/engine/           flow grid, tile cache, worker, path analysis
  src/map/              style, overlays, animated canvas
  src/ui/               panel, charts, controls, search, labels
  public/data/          the published artefacts — committed, because they are
                        the application
server/                 optional FastAPI service for scripted / batch tracing
.github/workflows/      CI and GitHub Pages deployment
```

## Development

```bash
cd web
npm install
npm run dev          # http://localhost:5173/raindrop/
npm run build        # static site in web/dist
npm run typecheck
```

The optional API:

```bash
pip install -r server/requirements.txt
uvicorn server.app:app --reload    # /api/trace?lon=11.58&lat=48.14
```

Or with Docker: `docker compose up` → site on :8080, API on :8000.

## Deployment

Pushing to `main` builds the site and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`). The workflow sets `BASE_PATH` from the
repository name, so a project site at `/raindrop/` works with no configuration.
For a custom domain or a root-level site, set `BASE_PATH=/`.

**One-time setup, which only the repository owner can do:** open
*Settings → Pages* and set **Source** to **GitHub Actions**. Until that switch
is flipped the deploy job fails at `actions/configure-pages` with
`Resource not accessible by integration` — the workflow token is not allowed to
create the Pages site itself. Note that Pages on a **private** repository needs
a paid plan; on the free plan, make the repository public first. Once Pages is
enabled, re-run the workflow (Actions → Deploy to GitHub Pages → Re-run) and
the site appears at `https://<owner>.github.io/<repo>/`.

The published data is ~110 MB and lives in `web/public/data`, which is why it is
committed rather than regenerated in CI: the DEM download and the hydrology run
need several GB of RAM and a few hundred megabytes of source tiles.

## Licence

Code: MIT. Data: Natural Earth is public domain; the terrain tiles carry the
licences of their source datasets (mostly public domain or CC-BY); the derived
hydrology published in this repository is released under CC-BY 4.0.
