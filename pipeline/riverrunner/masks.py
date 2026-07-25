"""Rasterise Natural Earth polygons onto the Web-Mercator hydrology grid."""
from __future__ import annotations

import numpy as np
import shapely
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import shape

from .config import TILE, WORK, Grid
from .naturalearth import load
from .tiles import ORIGIN

MAX_LAT = 85.05112878


def to_mercator(geom):
    """Reproject a shapely geometry from EPSG:4326 to EPSG:3857."""
    def fn(coords):
        lon = coords[:, 0]
        lat = np.clip(coords[:, 1], -MAX_LAT, MAX_LAT)
        x = lon * (ORIGIN / 180.0)
        y = np.log(np.tan((90.0 + lat) * np.pi / 360.0)) * (ORIGIN / np.pi)
        return np.column_stack([x, y])
    return shapely.transform(geom, fn)


def grid_transform(grid: Grid) -> Affine:
    n = TILE * (1 << grid.zoom)
    res = 2 * ORIGIN / n
    x0 = -ORIGIN + grid.px0 * res
    y0 = ORIGIN - grid.py0 * res
    return Affine(res, 0.0, x0, 0.0, -res, y0)


def _shapes(layer: str, value_key=None, values=None):
    out = []
    for i, f in enumerate(load(layer)["features"]):
        g = f.get("geometry")
        if not g:
            continue
        try:
            geom = to_mercator(shape(g))
        except Exception:
            continue
        v = 1
        if value_key is not None:
            v = values(f["properties"], i)
            if v is None:
                continue
        out.append((geom.__geo_interface__, v))
    return out


def rasterize_layer(grid: Grid, layer: str, dtype="uint8", value_key=None,
                    values=None, all_touched=False) -> np.ndarray:
    tr = grid_transform(grid)
    shp = _shapes(layer, value_key, values)
    return rasterize(shp, out_shape=(grid.height, grid.width), transform=tr,
                     fill=0, dtype=dtype, all_touched=all_touched)


def build_masks(grid: Grid, cache: bool = True) -> dict[str, np.ndarray]:
    """ocean / lake / ice / country-id rasters for the grid."""
    path = WORK / f"masks_z{grid.zoom}.npz"
    if cache and path.exists():
        print(f"[mask] loading cached {path.name}")
        z = np.load(path)
        return {k: z[k] for k in z.files}

    print("[mask] rasterising ocean ...")
    ocean = rasterize_layer(grid, "ne_10m_ocean")
    print("[mask] rasterising lakes ...")
    lake = rasterize_layer(grid, "ne_10m_lakes")
    lake |= rasterize_layer(grid, "ne_10m_lakes_europe")
    print("[mask] rasterising glaciers ...")
    ice = rasterize_layer(grid, "ne_10m_glaciated_areas")

    print("[mask] rasterising countries ...")
    countries = load("ne_10m_admin_0_countries")["features"]
    iso = [f["properties"].get("ISO_A2_EH") or f["properties"].get("ISO_A2") or "??"
           for f in countries]
    codes = sorted({c for c in iso})
    lut = {c: i + 1 for i, c in enumerate(codes)}
    cid = rasterize_layer(
        grid, "ne_10m_admin_0_countries", dtype="uint16",
        value_key=True, values=lambda p, i: lut.get(
            p.get("ISO_A2_EH") or p.get("ISO_A2") or "??", 0))

    out = {"ocean": ocean, "lake": lake, "ice": ice, "country": cid,
           "country_codes": np.array(codes)}
    if cache:
        np.savez_compressed(path, **out)
        print(f"[mask] cached -> {path.name}")
    return out
