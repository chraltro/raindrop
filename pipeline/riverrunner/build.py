"""Full hydrological build: DEM -> filled DEM -> D8 -> accumulation -> basins."""
from __future__ import annotations

import gc
import json
import time

import numpy as np

from . import hydro
from .config import EPS, WORK, Grid
from .dem import build_dem
from .masks import build_masks
from .tiles import grid_for_bbox, row_cell_size


class Timer:
    def __init__(self, label: str):
        self.label = label

    def __enter__(self):
        self.t = time.time()
        print(f"[hydro] {self.label} ...", flush=True)
        return self

    def __exit__(self, *a):
        print(f"[hydro] {self.label} done in {time.time()-self.t:.1f}s", flush=True)


def build_hydrology(zoom: int, cache: bool = True) -> dict:
    """Compute (or load) the full D8 hydrology stack for a zoom level."""
    grid = grid_for_bbox(zoom)
    print(f"[hydro] grid {grid} -> {grid.width}x{grid.height} "
          f"({grid.width*grid.height/1e6:.1f} M cells)")

    files = {n: WORK / f"{n}_z{zoom}.npy"
             for n in ("dirs", "acc", "strahler", "term", "cls", "dem")}
    if cache and all(p.exists() for p in files.values()):
        print("[hydro] loading cached rasters")
        return {"grid": grid, **{k: np.load(p, mmap_mode="r")
                                 for k, p in files.items()}}

    W, H = grid.width, grid.height
    dem = build_dem(grid)
    masks = build_masks(grid)

    ocean = masks["ocean"].astype(bool)
    lake = masks["lake"].astype(bool)
    ice = masks["ice"].astype(bool)

    # Cells that terminate flow: sea/large endorheic water bodies (the Natural
    # Earth ocean layer includes the Caspian) plus the raster border.
    seed = ocean.copy()
    seed[0, :] = True
    seed[-1, :] = True
    seed[:, 0] = True
    seed[:, -1] = True

    np.save(files["dem"], dem)          # keep the true elevations

    filled = dem.astype(np.float32).ravel().copy()
    with Timer("priority-flood depression filling"):
        hydro.priority_flood(filled, seed.ravel(), W, H, np.float32(EPS))

    terminal = seed.ravel().copy()
    cs = row_cell_size(grid).astype(np.float32)
    with Timer("D8 flow directions"):
        dirs, _slope = hydro.d8_directions(filled, terminal, W, H, cs)
    del filled, _slope
    gc.collect()

    with Timer("topological order"):
        order = hydro.topo_order(dirs, W, H)

    # per-row cell area in km2
    area_row = (cs.astype(np.float64) ** 2) / 1e6
    with Timer("flow accumulation"):
        acc = hydro.accumulate(dirs, order, area_row.astype(np.float32), W)

    with Timer("Strahler order"):
        st = hydro.strahler(dirs, order, acc, W, np.float32(2.0))

    with Timer("terminal basin labels"):
        term = hydro.terminal_labels(dirs, order, W)
    del order
    gc.collect()

    cls = np.zeros(W * H, np.uint8)
    cls[ice.ravel()] = hydro.CLS_ICE
    cls[lake.ravel()] = hydro.CLS_LAKE
    cls[ocean.ravel()] = hydro.CLS_OCEAN
    edge = np.zeros((H, W), bool)
    edge[0, :] = edge[-1, :] = True
    edge[:, 0] = edge[:, -1] = True
    cls[(edge & ~ocean).ravel()] = hydro.CLS_EDGE

    for k, arr in (("dirs", dirs), ("acc", acc), ("strahler", st),
                   ("term", term), ("cls", cls)):
        np.save(files[k], arr)
    print("[hydro] rasters cached")

    return {"grid": grid, "dem": dem, "dirs": dirs, "acc": acc,
            "strahler": st, "term": term, "cls": cls}
