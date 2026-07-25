"""End-to-end pipeline driver.

    python -m riverrunner.cli all            # everything (needs ~6 GB RAM)
    python -m riverrunner.cli tiles rivers   # selected stages
"""
from __future__ import annotations

import sys
import time

import numpy as np

from . import export
from .basins import build_basins, export_basin_polygons
from .build import build_hydrology
from .climate import accumulate_runoff, build_climate, export_climate
from .config import OUT, ZOOM
from .hydro import topo_order
from .naturalearth import fetch_all
from .tiles import download_grid, grid_for_bbox
from .vectorize import build_rivers
from .webdata import build_web_layers

STAGES = ["fetch", "hydro", "tiles", "relief", "rivers", "basins", "climate", "web"]


def main(argv: list[str]) -> int:
    stages = [a for a in argv[1:] if not a.startswith("-")]
    if not stages or "all" in stages:
        stages = STAGES
    t0 = time.time()
    print(f"[cli] zoom={ZOOM} stages={stages}")

    if "fetch" in stages:
        fetch_all()
        for z in (ZOOM, ZOOM - 1):
            download_grid(grid_for_bbox(z))

    hyd = build_hydrology(ZOOM)
    hyd7 = None
    parts = []

    if "tiles" in stages:
        parts.append(export.export_flow(hyd))
        hyd7 = build_hydrology(ZOOM - 1)
        parts.append(export.export_elev(hyd7))
        parts.append(export.export_overviews(hyd))

    if "relief" in stages:
        hyd7 = hyd7 or build_hydrology(ZOOM - 1)
        parts.append(export.export_relief(hyd7))

    rivers = None
    if "rivers" in stages:
        rivers = build_rivers(hyd)

    basins = None
    if "basins" in stages:
        if rivers is None:
            import json
            p = OUT / "rivers-lod1.geojson"
            rivers = json.loads(p.read_text())["features"] if p.exists() else None
        basins = build_basins(hyd, rivers)
        export_basin_polygons(hyd, basins)

    if "climate" in stages:
        clim = build_climate(hyd)
        export_climate(clim)
        print("[clim] accumulating runoff over the D8 network ...")
        order = topo_order(np.asarray(hyd["dirs"]), hyd["grid"].width,
                           hyd["grid"].height)
        from .tiles import row_cell_size
        cs = row_cell_size(hyd["grid"]).astype(np.float32)
        area_row = ((cs.astype(np.float64) ** 2) / 1e6).astype(np.float32)
        q = accumulate_runoff(np.ascontiguousarray(hyd["dirs"]), order,
                              np.ascontiguousarray(clim["R"], dtype=np.float32).ravel(),
                              int(clim["factor"]), area_row,
                              int(hyd["grid"].width), int(clim["w"]))
        _attach_discharge(hyd, q, basins)
        del order, q

    if "web" in stages:
        if rivers is None:
            import json
            p = OUT / "rivers-lod1.geojson"
            rivers = json.loads(p.read_text())["features"] if p.exists() else None
        if basins is None:
            import json
            p = OUT / "basins.json"
            basins = json.loads(p.read_text()) if p.exists() else None
        build_web_layers(rivers, basins)

    if parts:
        export.write_manifest(hyd["grid"], parts)
    print(f"[cli] finished in {time.time()-t0:.0f}s")
    return 0


def _attach_discharge(hyd, q, basins):
    """Store outlet discharge + specific runoff on every basin record."""
    import json
    from .config import OUT
    from .export import _png
    path = OUT / "basins.json"
    if basins is None:
        basins = json.loads(path.read_text()) if path.exists() else []
    grid = hyd["grid"]
    W = grid.width
    for b in basins:
        i = (b["py"] - grid.py0) * W + (b["px"] - grid.px0)
        Q = float(q[i])
        b["discharge"] = round(Q, 2)
        b["runoff"] = round(Q * 31557.6 / max(b["area"], 1e-9), 1)  # mm/yr
    path.write_text(json.dumps(basins, separators=(",", ":")))
    print(f"[clim] discharge written for {len(basins)} basins; "
          f"largest {max(basins, key=lambda b: b['discharge'])['name']} "
          f"{max(b['discharge'] for b in basins):.0f} m3/s")

    # specific runoff raster (mm/yr) sampled at the wettest cell of each block
    import numpy as np
    H = grid.height
    f = 8
    h, w = H // f, W // f
    acc = np.asarray(hyd["acc"]).reshape(H, W)[:h * f, :w * f].reshape(h, f, w, f)
    qq = q.reshape(H, W)[:h * f, :w * f].reshape(h, f, w, f)
    flat_a = acc.transpose(0, 2, 1, 3).reshape(h, w, f * f)
    flat_q = qq.transpose(0, 2, 1, 3).reshape(h, w, f * f)
    k = flat_a.argmax(axis=2)
    ii, jj = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    sel_a = flat_a[ii, jj, k]
    sel_q = flat_q[ii, jj, k]
    spec = np.where(sel_a > 0, sel_q * 31557.6 / np.maximum(sel_a, 1e-9), 0)
    v = np.clip(spec, 0, 65535).astype(np.uint16)
    _png(np.dstack([(v >> 8).astype(np.uint8), (v & 255).astype(np.uint8),
                    np.zeros((h, w), np.uint8)]).copy(),
         OUT / "climate" / "specrunoff.png", mode="RGB")
    print("[clim] specrunoff.png written")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
