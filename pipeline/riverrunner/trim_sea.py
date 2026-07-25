"""Remove drawn river geometry that lies in the sea.

The ocean mask is Natural Earth's 1:10m coastline rasterised onto 250 m cells,
so a reach can carry on for a cell or two past the real shoreline.  Over
satellite imagery that reads as a river drawn across open water.  This trims
any vertex whose cell is classified ocean and splits a line that crosses one,
which leaves the network ending at the coast instead of in it.

Run against the published data:  python -m riverrunner.trim_sea web/public/data
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

MAX_LAT = 85.05112878
OCEAN = 1


def _loader(base: Path, manifest: dict):
    n = 256 * (1 << manifest["zoom"])
    size = manifest["superTile"]
    cache: dict[tuple[int, int], np.ndarray | None] = {}

    def tile(sx: int, sy: int):
        if (sx, sy) not in cache:
            path = base / "flow" / str(sx) / f"{sy}.png"
            cache[(sx, sy)] = (
                np.asarray(Image.open(path).convert("L")) if path.exists() else None
            )
        return cache[(sx, sy)]

    def is_sea(lon: float, lat: float) -> bool:
        px = int((lon + 180) / 360 * n)
        s = math.sin(math.radians(max(-MAX_LAT, min(MAX_LAT, lat))))
        py = int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n)
        t = tile(px // size, py // size)
        return t is not None and int(t[py % size, px % size]) >> 4 == OCEAN

    return is_sea


def trim(base: Path) -> None:
    manifest = json.loads((base / "grid.json").read_text())
    is_sea = _loader(base, manifest)

    for lod in (0, 1, 2):
        path = base / f"rivers-lod{lod}.json"
        if not path.exists():
            continue
        geo = json.loads(path.read_text())
        out = []
        kept = dropped = 0
        for feat in geo["features"]:
            geom = feat["geometry"]
            lines = (
                geom["coordinates"]
                if geom["type"] == "MultiLineString"
                else [geom["coordinates"]]
            )
            runs: list[list[list[float]]] = []
            for line in lines:
                run: list[list[float]] = []
                for c in line:
                    if is_sea(c[0], c[1]):
                        if len(run) >= 2:
                            runs.append(run)
                        run = []
                    else:
                        run.append(c)
                if len(run) >= 2:
                    runs.append(run)
            kept += sum(len(r) for r in runs)
            dropped += sum(len(l) for l in lines) - sum(len(r) for r in runs)
            if not runs:
                continue
            out.append({
                "type": "Feature",
                "properties": feat["properties"],
                "geometry": (
                    {"type": "LineString", "coordinates": runs[0]}
                    if len(runs) == 1
                    else {"type": "MultiLineString", "coordinates": runs}
                ),
            })
        geo["features"] = out
        path.write_text(json.dumps(geo, separators=(",", ":")))
        print(f"lod{lod}: kept {kept} vertices, removed {dropped} in the sea, "
              f"{len(out)} reaches")


if __name__ == "__main__":
    trim(Path(sys.argv[1] if len(sys.argv) > 1 else "web/public/data"))
