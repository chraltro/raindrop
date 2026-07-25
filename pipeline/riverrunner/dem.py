"""Assemble downloaded terrarium tiles into a single Web-Mercator DEM array."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

from .config import TILE, WORK, Grid
from .tiles import _tile_path

Image.MAX_IMAGE_PIXELS = None


def _decode(path) -> np.ndarray:
    """Terrarium RGB -> elevation in metres (float32)."""
    with Image.open(path) as im:
        a = np.asarray(im.convert("RGB"), dtype=np.float32)
    return a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0 - 32768.0


def build_dem(grid: Grid, cache: bool = True) -> np.ndarray:
    """Return the (height, width) float32 elevation mosaic for `grid`."""
    npy = WORK / f"dem_z{grid.zoom}.npy"
    if cache and npy.exists():
        print(f"[dem] loading cached {npy.name}")
        return np.load(npy, mmap_mode=None)

    dem = np.full((grid.height, grid.width), -32768.0, dtype=np.float32)

    def load_col(ix: int) -> None:
        x = grid.x0 + ix
        for iy in range(grid.ny):
            y = grid.y0 + iy
            p = _tile_path(grid.zoom, x, y)
            if not p.exists():
                continue
            dem[iy * TILE:(iy + 1) * TILE, ix * TILE:(ix + 1) * TILE] = _decode(p)

    print(f"[dem] assembling {grid.width}x{grid.height} mosaic ...")
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(load_col, range(grid.nx)))

    # terrarium uses -32768 as nodata; treat as deep ocean
    dem[dem < -12000] = -12000.0
    if cache:
        np.save(npy, dem)
        print(f"[dem] cached -> {npy.name} ({dem.nbytes/1e6:.0f} MB)")
    return dem
