"""Global configuration for the European River Runner preprocessing pipeline."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
RAW = DATA / "raw"              # downloaded source data (git-ignored)
WORK = DATA / "work"            # intermediate arrays (git-ignored)
OUT = ROOT / "web" / "public" / "data"   # published artifacts (committed)

for _p in (RAW, WORK, OUT):
    _p.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Study area
# ---------------------------------------------------------------------------
# Europe incl. Iceland, Svalbard-free north cape, the Balkans, the Baltics,
# Anatolian fringe and European Russia out to the Volga / Caspian.
BBOX = (-25.0, 33.0, 62.0, 72.0)   # west, south, east, north (WGS84)

# Native Web-Mercator zoom level of the hydrological grid.
#   z7  -> 1223 m / px at the equator (~790 m at 50N)   ~53 M cells
#   z8  ->  611 m / px at the equator (~393 m at 50N)  ~211 M cells
ZOOM = int(os.environ.get("RR_ZOOM", "8"))

TILE = 256                     # source tile size (terrarium)
SUPERTILE = 512                # published tile size for flow/terrain rasters

# Terrain tiles (AWS Open Data registry, Mapzen/Tilezen terrarium encoding)
TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# Natural Earth (public domain) vector data
NE_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
          "master/geojson/{name}.geojson")

# ---------------------------------------------------------------------------
# Hydrology parameters
# ---------------------------------------------------------------------------
SEA_LEVEL = 0.0                # m, used together with the ocean polygon mask
MIN_RIVER_CELLS = {            # accumulation thresholds for the vector network
    "lod0": 4000,              # continental view: only the big rivers
    "lod1": 400,
    "lod2": 40,                # zoomed in: creeks and streams
}
EPS = 1e-3                     # epsilon gradient used to drain filled flats


@dataclass(frozen=True)
class Grid:
    """A Web-Mercator aligned raster grid described in tile space."""
    zoom: int
    x0: int
    y0: int
    nx: int          # width in tiles
    ny: int          # height in tiles

    @property
    def width(self) -> int:
        return self.nx * TILE

    @property
    def height(self) -> int:
        return self.ny * TILE

    @property
    def px0(self) -> int:
        return self.x0 * TILE

    @property
    def py0(self) -> int:
        return self.y0 * TILE

    def to_json(self) -> dict:
        return {
            "zoom": self.zoom,
            "tileX0": self.x0,
            "tileY0": self.y0,
            "tilesX": self.nx,
            "tilesY": self.ny,
            "width": self.width,
            "height": self.height,
            "pixelX0": self.px0,
            "pixelY0": self.py0,
            "tileSize": TILE,
            "superTile": SUPERTILE,
            "bbox": list(BBOX),
        }
