"""Turn the D8 raster network into a named, level-of-detail river vector layer."""
from __future__ import annotations

import json
from collections import Counter, defaultdict

import numpy as np
from numba import njit
from shapely.geometry import LineString, shape
from shapely.strtree import STRtree

from .config import OUT
from .hydro import DX, DY
from .naturalearth import load
from .tiles import pixel_to_lonlat


@njit(cache=True, nogil=True)
def _extract(d, acc, W, H, thr):
    """Split the >=thr sub-network into reaches broken at confluences."""
    N = d.size
    indeg = np.zeros(N, np.uint8)
    for i in range(N):
        if acc[i] < thr:
            continue
        k = d[i]
        if k == 0:
            continue
        y = i // W
        x = i - y * W
        j = (y + DY[k]) * W + x + DX[k]
        if acc[j] >= thr and indeg[j] < 255:
            indeg[j] += 1

    cells = np.empty(N // 2 + 16, np.int32)
    starts = np.empty(N // 8 + 16, np.int32)
    nc = 0
    ns = 0
    for i in range(N):
        if acc[i] < thr:
            continue
        if indeg[i] == 1:
            continue                      # interior point of a reach
        # headwater (indeg 0) or confluence (indeg >= 2): start a new reach
        starts[ns] = nc
        ns += 1
        j = i
        while True:
            cells[nc] = j
            nc += 1
            k = d[j]
            if k == 0:
                break
            y = j // W
            x = j - y * W
            nj = (y + DY[k]) * W + x + DX[k]
            if acc[nj] < thr:
                break
            if indeg[nj] != 1:          # confluence: close the reach on it
                cells[nc] = nj
                nc += 1
                break
            j = nj
    starts[ns] = nc
    return cells[:nc], starts[:ns + 1]


def _to_lonlat(cells, grid):
    ys, xs = np.divmod(cells, grid.width)
    lon = (xs + grid.px0 + 0.5) / (256 * (1 << grid.zoom)) * 360.0 - 180.0
    n = 256 * (1 << grid.zoom)
    yy = (ys + grid.py0 + 0.5)
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * yy / n))))
    return lon, lat


# Natural Earth labels the same river in several languages along its course.
# Canonicalising keeps a journey from reading "Donau -> Dunaj -> Duna".
NAME_ALIASES = {
    "donau": "Danube", "dunaj": "Danube", "duna": "Danube", "dunav": "Danube",
    "dunarea": "Danube", "dunărea": "Danube", "dunay": "Danube",
    "rhein": "Rhine", "rijn": "Rhine", "rhin": "Rhine", "reno": "Rhine",
    "wisla": "Vistula", "wisła": "Vistula", "weichsel": "Vistula",
    "odra": "Oder", "labe": "Elbe", "vltava": "Vltava",
    "dnieper": "Dnipro", "dnepr": "Dnipro", "dnyapro": "Dnipro",
    "dnestr": "Dniester", "nistru": "Dniester",
    "tajo": "Tejo", "tagus": "Tejo", "douro": "Duero",
    "maas": "Meuse", "rhone": "Rhône", "rhône": "Rhône",
    "morava": "Morava", "mura": "Mur", "drau": "Drava", "drau/drava": "Drava",
    "theiss": "Tisza", "tisa": "Tisza", "ticino": "Ticino",
    "nemunas": "Neman", "memel": "Neman", "niemen": "Neman",
    "zapadnaya dvina": "Daugava", "western dvina": "Daugava",
    "severnaya dvina": "Severnaya Dvina", "northern dvina": "Severnaya Dvina",
    "po": "Po", "sava": "Sava", "inn": "Inn", "isar": "Isar",
    "tevere": "Tiber", "etsch": "Adige", "adige/etsch": "Adige",
    "ebre": "Ebro", "garona": "Garonne", "loira": "Loire",
    "seine": "Seine", "somme": "Somme", "escaut": "Scheldt", "schelde": "Scheldt",
    "vah": "Váh", "váh": "Váh", "waag": "Váh",
    "al furat": "Euphrates", "dijlah": "Tigris",
}


def canonical(name: str) -> str:
    return NAME_ALIASES.get(name.strip().lower(), name.strip())


def _named_reference(bbox) -> tuple[STRtree, list[str]]:
    """Spatial index of Natural Earth river centrelines that carry a name."""
    geoms, names = [], []
    for layer in ("ne_10m_rivers_europe", "ne_10m_rivers_lake_centerlines"):
        for f in load(layer)["features"]:
            p = f["properties"]
            name = p.get("name") or p.get("name_en")
            if not name or not f.get("geometry"):
                continue
            g = shape(f["geometry"])
            if g.is_empty or not g.intersects(bbox):
                continue
            geoms.append(g)
            names.append(canonical(name))
    return STRtree(geoms), names


def build_rivers(hyd, thresholds=(20000.0, 1500.0, 250.0), simplify=(0.02, 0.005, 0.0025)):
    """Write one GeoJSON per level of detail; returns the LOD1 features."""
    from shapely.geometry import box

    grid = hyd["grid"]
    d = np.asarray(hyd["dirs"])
    acc = np.asarray(hyd["acc"])
    st = np.asarray(hyd["strahler"])
    W, H = grid.width, grid.height
    tree, names = _named_reference(box(*[-30, 30, 65, 75]))

    out_features = None
    for lod, (thr, tol) in enumerate(zip(thresholds, simplify)):
        print(f"[vec] extracting reaches with drainage >= {thr:.0f} km2")
        cells, starts = _extract(d, acc, W, H, np.float32(thr))
        lon, lat = _to_lonlat(cells, grid)
        feats = []
        for s in range(len(starts) - 1):
            a, b = starts[s], starts[s + 1]
            if b - a < 2:
                continue
            coords = np.column_stack([lon[a:b], lat[a:b]])
            line = LineString(coords).simplify(tol, preserve_topology=False)
            if line.length == 0:
                continue
            i0, i1 = cells[a], cells[b - 1]
            feats.append({
                "type": "Feature",
                "properties": {
                    "id": int(s),
                    "up": round(float(acc[i0]), 1),
                    "dn": round(float(acc[i1]), 1),
                    "so": int(st[i1]),
                    "dsx": int(i1 % W), "dsy": int(i1 // W),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[round(x, 5), round(y, 5)]
                                    for x, y in line.coords],
                },
            })
        print(f"[vec]   {len(feats)} reaches")
        _assign_names(feats, tree, names)
        _propagate_names(feats)
        if lod >= 2:            # detail level: keep only what the map needs
            for f in feats:
                p = f["properties"]
                f["properties"] = {k: v for k, v in
                                   (("name", p.get("name")), ("dn", p["dn"]),
                                    ("so", p["so"])) if v is not None}
                f["geometry"]["coordinates"] = [
                    [round(x, 4), round(y, 4)]
                    for x, y in f["geometry"]["coordinates"]]
        path = OUT / f"rivers-lod{lod}.geojson"
        path.write_text(json.dumps({"type": "FeatureCollection",
                                    "features": feats}, separators=(",", ":")))
        print(f"[vec]   -> {path.name} ({path.stat().st_size/1e6:.1f} MB)")
        if lod == 1:
            out_features = feats
    return out_features


def _assign_names(feats, tree, names, tol_deg=0.06):
    """Modal nearest Natural Earth river name for every reach."""
    from shapely.geometry import Point
    geoms = tree.geometries
    for f in feats:
        cs = f["geometry"]["coordinates"]
        probe = cs[:: max(1, len(cs) // 8)][:8] or cs
        votes = Counter()
        for x, y in probe:
            pt = Point(x, y)
            idx = tree.query_nearest(pt, max_distance=tol_deg,
                                     exclusive=False, all_matches=False)
            for i in np.atleast_1d(idx):
                if geoms[int(i)].distance(pt) <= tol_deg:
                    votes[names[int(i)]] += 1
        if votes:
            name, n = votes.most_common(1)[0]
            if n >= max(2, len(probe) // 3):
                f["properties"]["name"] = name


def _propagate_names(feats):
    """Unnamed reaches inherit the mainstem name of their neighbours."""
    by_ds = defaultdict(list)
    for f in feats:
        by_ds[(f["properties"]["dsx"], f["properties"]["dsy"])].append(f)
    head = {}
    for f in feats:
        c = f["geometry"]["coordinates"][0]
        head[(round(c[0], 5), round(c[1], 5))] = f
    # downstream continuation: match reach outlet to the reach starting there
    for _ in range(4):
        changed = 0
        for f in feats:
            if f["properties"].get("name"):
                continue
            c = f["geometry"]["coordinates"][-1]
            nxt = head.get((round(c[0], 5), round(c[1], 5)))
            if nxt is None or not nxt["properties"].get("name"):
                continue
            if f["properties"]["dn"] >= 0.55 * nxt["properties"]["up"]:
                f["properties"]["name"] = nxt["properties"]["name"]
                changed += 1
        if not changed:
            break
