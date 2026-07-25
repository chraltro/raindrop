"""Optional FastAPI service for the European River Runner.

The web app is deliberately self-contained: it routes drops in a Web Worker
directly against the static tiles, which is what makes GitHub Pages hosting
possible.  This service is here for the cases a static site cannot cover:

* server-side tracing for scripts, notebooks and other clients
* batch queries (many points at once)
* serving the published data with sensible cache headers behind nginx

Run it with:  uvicorn server.app:app --reload
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image

DATA = Path(__file__).resolve().parents[1] / "web" / "public" / "data"

DX = [0, 1, 1, 0, -1, -1, -1, 0, 1]
DY = [0, 0, 1, 1, 1, 0, -1, -1, -1]
CLASS_NAMES = {0: "land", 1: "ocean", 2: "lake", 3: "sink", 4: "edge", 5: "ice"}

app = FastAPI(
    title="European River Runner API",
    version="1.0.0",
    description="Trace a drop of rain downstream anywhere in Europe.",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"],
                   allow_headers=["*"])


@lru_cache(maxsize=1)
def manifest() -> dict:
    path = DATA / "grid.json"
    if not path.exists():
        raise HTTPException(503, "data not built yet - run the pipeline first")
    return json.loads(path.read_text())


@lru_cache(maxsize=1)
def basins() -> dict:
    path = DATA / "basins.json"
    if not path.exists():
        return {}
    return {f"{b['px']},{b['py']}": b for b in json.loads(path.read_text())}


@lru_cache(maxsize=4096)
def tile(layer: str, sx: int, sy: int) -> np.ndarray | None:
    path = DATA / layer / str(sx) / f"{sy}.png"
    if not path.exists():
        return None
    with Image.open(path) as im:
        return np.asarray(im.convert("L"))


def lonlat_to_cell(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    n = 256 * (1 << zoom)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(max(-85.05112878, min(85.05112878, lat))))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return int(x), int(y)


def cell_to_lonlat(px: int, py: int, zoom: int) -> tuple[float, float]:
    n = 256 * (1 << zoom)
    lon = (px + 0.5) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (py + 0.5) / n))))
    return lon, lat


def flow_byte(px: int, py: int) -> int:
    t = tile("flow", px >> 9, py >> 9)
    return 1 << 4 if t is None else int(t[py & 511, px & 511])


def drainage_km2(px: int, py: int, scale: float) -> float:
    t = tile("acc", px >> 9, py >> 9)
    if t is None:
        return 0.0
    v = int(t[(py & 511) >> 1, (px & 511) >> 1])
    return 0.0 if v == 0 else 2.0 ** (v / scale) - 1.0


@app.get("/api/health")
def health() -> dict:
    m = manifest()
    return {"ok": True, "zoom": m["zoom"], "bbox": m["bbox"],
            "flowTiles": len(m["flowTiles"])}


@app.get("/api/trace")
def trace(
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
    max_steps: int = Query(80000, ge=10, le=200000),
) -> dict:
    """Follow a drop of rain downstream from a coordinate."""
    m = manifest()
    z = m["zoom"]
    px, py = lonlat_to_cell(lon, lat, z)
    x0, y0 = m["pixelX0"], m["pixelY0"]
    if not (x0 <= px < x0 + m["width"] and y0 <= py < y0 + m["height"]):
        raise HTTPException(400, "outside the mapped area")

    coords: list[list[float]] = []
    terminal = 4
    for _ in range(max_steps):
        b = flow_byte(px, py)
        coords.append([round(c, 5) for c in cell_to_lonlat(px, py, z)])
        d = b & 15
        if d == 0:
            terminal = b >> 4
            break
        px += DX[d]
        py += DY[d]
        if not (x0 <= px < x0 + m["width"] and y0 <= py < y0 + m["height"]):
            break

    basin = basins().get(f"{px},{py}")
    return {
        "start": {"lon": lon, "lat": lat},
        "cells": len(coords),
        "terminal": CLASS_NAMES.get(terminal, "unknown"),
        "destination": basin["sea"] if basin else None,
        "basin": basin,
        "drainageAtEnd": round(drainage_km2(px, py, m["accScale"]), 2),
        "geometry": {"type": "LineString", "coordinates": coords},
    }


@app.get("/api/point")
def point(lon: float, lat: float) -> dict:
    m = manifest()
    px, py = lonlat_to_cell(lon, lat, m["zoom"])
    b = flow_byte(px, py)
    return {
        "lon": lon, "lat": lat,
        "class": CLASS_NAMES.get(b >> 4, "unknown"),
        "direction": b & 15,
        "drainageKm2": round(drainage_km2(px, py, m["accScale"]), 3),
    }


@app.get("/api/basins")
def basin_list(limit: int = Query(50, ge=1, le=2000)) -> list[dict]:
    return sorted(basins().values(), key=lambda b: -b["area"])[:limit]


@app.get("/data/{path:path}")
def data(path: str) -> FileResponse:
    """Serve the published artefacts (nginx does this in production)."""
    target = (DATA / path).resolve()
    if not str(target).startswith(str(DATA.resolve())) or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(target, headers={"Cache-Control": "public, max-age=604800"})
