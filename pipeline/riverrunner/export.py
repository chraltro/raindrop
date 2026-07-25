"""Publish the hydrology rasters as static tiles for the web client.

Everything is 8-bit PNG (lossless, canvas-safe) or WebP (relief imagery only).

flow/{sx}/{sy}.png     512x512 grey, native zoom
    value = D8 direction (low nibble, 0-8) | cell class (high nibble)
acc/{sx}/{sy}.png      256x256 grey, half of the native zoom (max-pooled)
    drainage area km2 = 2^(v / ACC_SCALE) - 1
elev/{sx}/{sy}.png     512x512 grey, one zoom coarser
    metres = base + v * step     (base/step per tile, see manifest)
relief/{z}/{x}/{y}.webp  256x256 shaded relief basemap imagery
"""
from __future__ import annotations

import json
import math

import numpy as np
from PIL import Image

from .config import OUT, SUPERTILE

ACC_SCALE = 11.0


def _png(arr: np.ndarray, path, mode="L") -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr, mode).save(path, optimize=True, compress_level=9)
    return path.stat().st_size


def export_flow(hyd, out=OUT) -> dict:
    grid = hyd["grid"]
    W, H, S = grid.width, grid.height, SUPERTILE
    dirs = np.asarray(hyd["dirs"]).reshape(H, W)
    cls = np.asarray(hyd["cls"]).reshape(H, W)
    acc = np.asarray(hyd["acc"]).reshape(H, W)
    sx0, sy0 = grid.px0 // S, grid.py0 // S
    nsx, nsy = W // S, H // S
    flow_tiles, acc_tiles = [], []
    nbytes = 0
    for j in range(nsy):
        for i in range(nsx):
            ys, xs = slice(j * S, (j + 1) * S), slice(i * S, (i + 1) * S)
            d, c, a = dirs[ys, xs], cls[ys, xs], acc[ys, xs]
            sx, sy = sx0 + i, sy0 + j
            if not (d.any() or (c != 1).any()):
                continue                        # open sea: client assumes ocean
            nbytes += _png((d | (c << 4)).astype(np.uint8),
                           out / "flow" / str(sx) / f"{sy}.png")
            flow_tiles.append(f"{sx}/{sy}")
            a8 = np.clip(np.log2(1.0 + np.maximum(a, 0)) * ACC_SCALE, 0, 255)
            a8 = a8.astype(np.uint8).reshape(S // 2, 2, S // 2, 2).max(axis=(1, 3))
            nbytes += _png(a8, out / "acc" / str(sx) / f"{sy}.png")
            acc_tiles.append(f"{sx}/{sy}")
        print(f"[tiles] flow row {j+1}/{nsy}", flush=True)
    print(f"[tiles] {len(flow_tiles)} flow+acc supertiles, {nbytes/1e6:.1f} MB")
    return {"flowTiles": flow_tiles, "accTiles": acc_tiles,
            "superTileX0": sx0, "superTileY0": sy0,
            "superTilesX": nsx, "superTilesY": nsy, "accScale": ACC_SCALE,
            "accTileSize": SUPERTILE // 2}


def export_elev(hyd7, out=OUT) -> dict:
    """Adaptive 8-bit elevation tiles (one zoom coarser than the flow grid)."""
    grid = hyd7["grid"]
    W, H, S = grid.width, grid.height, SUPERTILE
    dem = np.asarray(hyd7["dem"]).reshape(H, W)
    sx0, sy0 = grid.px0 // S, grid.py0 // S
    tiles = {}
    nbytes = 0
    for j in range(H // S):
        for i in range(W // S):
            e = dem[j * S:(j + 1) * S, i * S:(i + 1) * S]
            sx, sy = sx0 + i, sy0 + j
            lo = float(max(e.min(), -600.0))
            hi = float(e.max())
            if hi < -400:
                continue                        # deep ocean only
            step = max(0.25, (hi - lo) / 250.0)
            v = np.clip(np.round((e - lo) / step), 0, 255).astype(np.uint8)
            nbytes += _png(v, out / "elev" / str(sx) / f"{sy}.png")
            tiles[f"{sx}/{sy}"] = [round(lo, 2), round(step, 4)]
        print(f"[tiles] elev row {j+1}/{H//S}", flush=True)
    print(f"[tiles] {len(tiles)} elevation tiles, {nbytes/1e6:.1f} MB")
    return {"elevZoom": grid.zoom, "elevTileSize": S,
            "elevTileX0": sx0, "elevTileY0": sy0, "elevTiles": tiles}


# ---------------------------------------------------------------------------
# shaded relief basemap imagery
# ---------------------------------------------------------------------------
HYPSO = [
    (-8000, (10, 22, 48)), (-2000, (16, 42, 78)), (-200, (26, 68, 112)),
    (-20, (44, 100, 150)), (0, (150, 190, 214)),
    (1, (118, 148, 106)), (150, (150, 172, 116)), (400, (188, 186, 128)),
    (900, (196, 166, 118)), (1600, (172, 132, 100)), (2400, (170, 152, 148)),
    (3200, (222, 226, 232)), (5000, (255, 255, 255)),
]


def _hypsometric(e: np.ndarray) -> np.ndarray:
    stops = np.array([s[0] for s in HYPSO], float)
    cols = np.array([s[1] for s in HYPSO], float)
    out = np.empty(e.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(e, stops, cols[:, c])
    return out


def _hillshade(e: np.ndarray, cell: float, az=315.0, alt=45.0, zf=2.2):
    gy, gx = np.gradient(e.astype(np.float32), cell)
    gx *= zf
    gy *= zf
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gy, gx)
    az_r = np.radians(360.0 - az + 90.0)
    alt_r = np.radians(alt)
    hs = (np.sin(alt_r) * np.cos(slope) +
          np.cos(alt_r) * np.sin(slope) * np.cos(az_r - aspect))
    return np.clip(hs, 0, 1)


def export_relief(hyd, out=OUT, zmin=3, quality=82) -> dict:
    """Hypsometric + hillshade raster tiles from the native DEM."""
    from .tiles import row_cell_size
    grid = hyd["grid"]
    W, H = grid.width, grid.height
    dem = np.asarray(hyd["dem"]).reshape(H, W).astype(np.float32)
    cell = row_cell_size(grid).mean()

    print("[relief] rendering base imagery ...")
    rgb = _hypsometric(dem)
    hs = _hillshade(dem, cell)[..., None]
    shade = 0.55 + 0.85 * hs
    img = np.clip(rgb * shade, 0, 255).astype(np.uint8)
    sea = dem <= 0
    img[sea] = np.clip(_hypsometric(dem)[sea] * (0.92 + 0.16 * hs[sea]), 0, 255)
    base = Image.fromarray(img, "RGB")

    zoom = grid.zoom
    written = 0
    levels = []
    for z in range(zoom, zmin - 1, -1):
        f = 1 << (zoom - z)
        im = base if f == 1 else base.resize((W // f, H // f), Image.LANCZOS)
        tx0, ty0 = grid.px0 // (256 * f), grid.py0 // (256 * f)
        nx, ny = im.width // 256, im.height // 256
        for j in range(ny):
            for i in range(nx):
                t = im.crop((i * 256, j * 256, (i + 1) * 256, (j + 1) * 256))
                p = out / "relief" / str(z) / str(tx0 + i) / f"{ty0 + j}.webp"
                p.parent.mkdir(parents=True, exist_ok=True)
                t.save(p, "WEBP", quality=quality, method=4)
                written += 1
        levels.append({"z": z, "x0": tx0, "y0": ty0, "nx": nx, "ny": ny})
        print(f"[relief]   z{z}: {nx}x{ny} tiles")
    size = sum(p.stat().st_size for p in (out / "relief").rglob("*.webp"))
    print(f"[relief] {written} tiles, {size/1e6:.1f} MB")
    return {"reliefMinZoom": zmin, "reliefMaxZoom": zoom, "reliefLevels": levels}


def export_overviews(hyd, clim=None, factor=8, out=OUT) -> dict:
    grid = hyd["grid"]
    W, H = grid.width, grid.height
    f = factor
    h, w = H // f, W // f
    acc = np.asarray(hyd["acc"]).reshape(H, W)[:h * f, :w * f]
    a8 = np.clip(np.log2(1 + np.maximum(acc, 0)) * ACC_SCALE, 0, 255).astype(np.uint8)
    a8 = a8.reshape(h, f, w, f).max(axis=(1, 3))
    (out / "overview").mkdir(parents=True, exist_ok=True)
    _png(a8, out / "overview" / "flowacc.png")
    dem = np.asarray(hyd["dem"]).reshape(H, W)[:h * f, :w * f]
    d = dem.reshape(h, f, w, f).mean(axis=(1, 3))
    e16 = np.clip(np.round(d) + 1000, 0, 65535).astype(np.uint16)
    _png(np.dstack([(e16 >> 8).astype(np.uint8), (e16 & 255).astype(np.uint8),
                    np.zeros((h, w), np.uint8)]).copy(),
         out / "overview" / "elev.png", mode="RGB")
    print(f"[tiles] overviews {w}x{h}")
    return {"overviewFactor": f, "overviewWidth": w, "overviewHeight": h,
            "overviewElevOffset": 1000}


def write_manifest(grid, parts: list[dict], out=OUT) -> None:
    m = dict(grid.to_json())
    for p in parts:
        m.update(p)
    (out / "grid.json").write_text(json.dumps(m, separators=(",", ":")))
    print(f"[tiles] manifest -> grid.json ({(out/'grid.json').stat().st_size/1e3:.0f} kB)")
