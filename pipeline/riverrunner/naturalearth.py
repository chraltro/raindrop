"""Download and cache Natural Earth (public domain) vector layers."""
from __future__ import annotations

import json
from pathlib import Path

import requests

from .config import NE_URL, RAW

LAYERS = [
    "ne_10m_ocean",
    "ne_10m_coastline",
    "ne_10m_lakes",
    "ne_10m_lakes_europe",
    "ne_10m_rivers_lake_centerlines",
    "ne_10m_rivers_europe",
    "ne_10m_admin_0_countries",
    "ne_10m_populated_places",
    "ne_10m_geography_marine_polys",
    "ne_10m_geography_regions_polys",
    "ne_10m_geography_regions_elevation_points",
    "ne_10m_glaciated_areas",
    "ne_10m_urban_areas",
    "ne_50m_admin_0_countries",
    "ne_50m_land",
]


def fetch(name: str) -> Path:
    path = RAW / "naturalearth" / f"{name}.geojson"
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    url = NE_URL.format(name=name)
    print(f"[ne] downloading {name}")
    r = requests.get(url, timeout=180)
    r.raise_for_status()
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(r.content)
    tmp.rename(path)
    return path


def load(name: str) -> dict:
    return json.loads(fetch(name).read_text())


def fetch_all() -> None:
    for name in LAYERS:
        try:
            fetch(name)
        except Exception as exc:            # pragma: no cover - network guard
            print(f"[ne] !! {name}: {exc}")
