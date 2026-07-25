"""Calibrate the Budyko shape parameter against gauged European rivers.

Long-term mean discharge (m3/s) from national hydrological yearbooks and the
GRDC river catalogue.  These are the values the water-balance model has to
reproduce; `omega` is the only free parameter.
"""
from __future__ import annotations

import json
import statistics

import numpy as np

from .build import build_hydrology
from .climate import accumulate_runoff, build_climate
from .config import OUT, WORK, ZOOM
from .hydro import topo_order
from .tiles import row_cell_size

GAUGED = {
    "Volga": 8060, "Danube": 6500, "Dnipro": 1670, "Rhine": 2330, "Neva": 2490,
    "Vistula": 1080, "Elbe": 870, "Rhône": 1710, "Po": 1540, "Loire": 840,
    "Don": 900, "Pechora": 4100, "Oder": 570, "Duero": 700, "Ebro": 430,
    "Tejo": 444, "Seine": 560, "Dniester": 310, "Neman": 678, "Kura": 575,
    "Vychegda": 1160, "Tobol": 805, "Ural": 400, "Glomma": 700,
    "Kemijoki": 556, "Mezen": 890, "Onega": 505, "Garonne": 650,
    "Weser": 327, "Guadalquivir": 164, "Guadiana": 80, "Shannon": 200,
    "Severn": 107, "Thames": 66, "Dordogne": 300, "Adour": 350,
    "Charente": 50, "Somme": 35, "Ems": 80, "Sakarya": 193,
}


def _order(hyd):
    path = WORK / f"order_z{ZOOM}.npy"
    if path.exists():
        return np.load(path)
    o = topo_order(np.ascontiguousarray(hyd["dirs"]), hyd["grid"].width,
                   hyd["grid"].height)
    np.save(path, o)
    return o


def evaluate(omega: float, pet_scale: float = 1.0, hyd=None, order=None,
             basins=None) -> tuple[float, dict]:
    hyd = hyd or build_hydrology(ZOOM)
    order = _order(hyd) if order is None else order
    basins = basins or json.loads((OUT / "basins.json").read_text())
    clim = build_climate(hyd, omega=omega, pet_scale=pet_scale)
    grid = hyd["grid"]
    cs = row_cell_size(grid).astype(np.float32)
    area_row = ((cs.astype(np.float64) ** 2) / 1e6).astype(np.float32)
    q = accumulate_runoff(np.ascontiguousarray(hyd["dirs"]), order,
                          np.ascontiguousarray(clim["R"], dtype=np.float32).ravel(),
                          int(clim["factor"]), area_row, int(grid.width),
                          int(clim["w"]))
    W = grid.width
    ratios = {}
    for b in basins:
        name = b.get("river")
        if name in GAUGED:
            i = (b["py"] - grid.py0) * W + (b["px"] - grid.px0)
            ratios.setdefault(name, float(q[i]) / GAUGED[name])
    med = statistics.median(ratios.values())
    logerr = statistics.mean(abs(np.log(r)) for r in ratios.values())
    print(f"[cal] omega={omega:4.1f} pet={pet_scale:4.2f}  n={len(ratios):2d}  "
          f"median={med:5.2f}  mean|log err|={logerr:.3f}", flush=True)
    return med, ratios


def main() -> None:
    hyd = build_hydrology(ZOOM)
    order = _order(hyd)
    basins = json.loads((OUT / "basins.json").read_text())
    best = None
    for omega, k in ((2.6, 1.0), (2.6, 1.6), (2.6, 2.0), (2.6, 2.4),
                     (3.5, 2.0), (2.0, 2.0)):
        med, ratios = evaluate(omega, k, hyd, order, basins)
        score = statistics.mean(abs(np.log(r)) for r in ratios.values())
        if best is None or score < best[0]:
            best = (score, (omega, k), ratios)
    print(f"[cal] best omega/pet = {best[1]}  score={best[0]:.3f}")
    worst = sorted(best[2].items(), key=lambda kv: -abs(np.log(kv[1])))[:10]
    for name, r in worst:
        print(f"[cal]   {name:16s} ratio {r:.2f}")


if __name__ == "__main__":
    main()
