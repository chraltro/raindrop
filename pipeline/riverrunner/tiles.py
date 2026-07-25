"""Web-Mercator tile maths and a threaded terrarium DEM downloader."""
from __future__ import annotations

import math
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests

from .config import BBOX, RAW, SUPERTILE, TERRARIUM_URL, TILE, Grid

R_EARTH = 6378137.0
ORIGIN = math.pi * R_EARTH          # 20037508.342789244


# ---------------------------------------------------------------------------
# projection helpers (pixel space at a given zoom)
# ---------------------------------------------------------------------------
def lonlat_to_pixel(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    n = TILE * (1 << zoom)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(max(-85.05112878, min(85.05112878, lat))))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def pixel_to_lonlat(x: float, y: float, zoom: int) -> tuple[float, float]:
    n = TILE * (1 << zoom)
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def grid_for_bbox(zoom: int, bbox=BBOX) -> Grid:
    w, s, e, n = bbox
    x0 = int(math.floor(lonlat_to_pixel(w, s, zoom)[0] / TILE))
    x1 = int(math.ceil(lonlat_to_pixel(e, s, zoom)[0] / TILE))
    y0 = int(math.floor(lonlat_to_pixel(w, n, zoom)[1] / TILE))
    y1 = int(math.ceil(lonlat_to_pixel(w, s, zoom)[1] / TILE))
    # snap to the published supertile lattice (SUPERTILE / TILE source tiles)
    step = SUPERTILE // TILE
    x0 -= x0 % step
    y0 -= y0 % step
    nx = x1 - x0
    ny = y1 - y0
    nx += (-nx) % step
    ny += (-ny) % step
    return Grid(zoom=zoom, x0=x0, y0=y0, nx=nx, ny=ny)


def row_latitudes(grid: Grid) -> np.ndarray:
    """Latitude of every raster row centre (degrees)."""
    rows = np.arange(grid.height, dtype=np.float64) + 0.5 + grid.py0
    n = TILE * (1 << grid.zoom)
    return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * rows / n))))


def row_cell_size(grid: Grid) -> np.ndarray:
    """Ground size (m) of one cell for every raster row (square in mercator)."""
    lat = row_latitudes(grid)
    return (2 * ORIGIN / (TILE * (1 << grid.zoom))) * np.cos(np.radians(lat))


# ---------------------------------------------------------------------------
# download
# ---------------------------------------------------------------------------
_session_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_session_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = "european-river-runner/1.0 (open data pipeline)"
        _session_local.s = s
    return s


def _tile_path(z: int, x: int, y: int) -> Path:
    return RAW / "terrarium" / str(z) / str(x) / f"{y}.png"


def fetch_tile(z: int, x: int, y: int, retries: int = 5) -> Path | None:
    path = _tile_path(z, x, y)
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    url = TERRARIUM_URL.format(z=z, x=x, y=y)
    delay = 1.0
    for attempt in range(retries):
        try:
            r = _session().get(url, timeout=60)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(r.content)
            tmp.rename(path)
            return path
        except Exception:
            if attempt == retries - 1:
                raise
            import time
            time.sleep(delay)
            delay *= 2
    return None


def download_grid(grid: Grid, workers: int = 24) -> None:
    jobs = [(grid.zoom, x, y)
            for x in range(grid.x0, grid.x0 + grid.nx)
            for y in range(grid.y0, grid.y0 + grid.ny)]
    todo = [j for j in jobs if not _tile_path(*j).exists()]
    print(f"[dem] {len(jobs)} tiles at z{grid.zoom}, {len(todo)} to download")
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for _ in ex.map(lambda j: fetch_tile(*j), todo):
            done += 1
            if done % 200 == 0:
                print(f"[dem]   {done}/{len(todo)}", flush=True)
    print("[dem] download complete")
