"""Delineate, describe and name the drainage basins of Europe."""
from __future__ import annotations

import json
from collections import defaultdict

import numpy as np
from numba import njit
from shapely.geometry import Point, shape, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree

from .config import OUT
from .masks import build_masks
from .naturalearth import load
from .tiles import pixel_to_lonlat

MIN_BASIN_KM2 = 250.0
POLY_BASIN_KM2 = 3000.0

# Natural Earth marine polygon -> the sea a European drop finally reaches.
SEA_GROUPS = {
    "North Atlantic Ocean": ("Atlantic Ocean", "atlantic"),
    "South Atlantic Ocean": ("Atlantic Ocean", "atlantic"),
    "Bay of Biscay": ("Atlantic Ocean", "atlantic"),
    "Celtic Sea": ("Atlantic Ocean", "atlantic"),
    "Irish Sea": ("Atlantic Ocean", "atlantic"),
    "English Channel": ("Atlantic Ocean", "atlantic"),
    "Bristol Channel": ("Atlantic Ocean", "atlantic"),
    "Inner Seas": ("Atlantic Ocean", "atlantic"),
    "North Sea": ("North Sea", "northsea"),
    "Skagerrak": ("North Sea", "northsea"),
    "Kattegat": ("Baltic Sea", "baltic"),
    "Baltic Sea": ("Baltic Sea", "baltic"),
    "Gulf of Bothnia": ("Baltic Sea", "baltic"),
    "Gulf of Finland": ("Baltic Sea", "baltic"),
    "Gulf of Riga": ("Baltic Sea", "baltic"),
    "Mediterranean Sea": ("Mediterranean Sea", "mediterranean"),
    "Adriatic Sea": ("Mediterranean Sea", "mediterranean"),
    "Aegean Sea": ("Mediterranean Sea", "mediterranean"),
    "Ionian Sea": ("Mediterranean Sea", "mediterranean"),
    "Tyrrhenian Sea": ("Mediterranean Sea", "mediterranean"),
    "Ligurian Sea": ("Mediterranean Sea", "mediterranean"),
    "Alboran Sea": ("Mediterranean Sea", "mediterranean"),
    "Balearic Sea": ("Mediterranean Sea", "mediterranean"),
    "Sea of Marmara": ("Mediterranean Sea", "mediterranean"),
    "Black Sea": ("Black Sea", "black"),
    "Sea of Azov": ("Black Sea", "black"),
    "Arctic Ocean": ("Arctic Ocean", "arctic"),
    "Barents Sea": ("Arctic Ocean", "arctic"),
    "White Sea": ("Arctic Ocean", "arctic"),
    "Greenland Sea": ("Arctic Ocean", "arctic"),
    "Norwegian Sea": ("Norwegian Sea", "arctic"),
    "Kara Sea": ("Arctic Ocean", "arctic"),
    "Caspian Sea": ("Caspian Sea", "caspian"),
    "Golfe du Lion": ("Mediterranean Sea", "mediterranean"),
    "Gulf of Lion": ("Mediterranean Sea", "mediterranean"),
    "Sea of Crete": ("Mediterranean Sea", "mediterranean"),
    "Gulf of Gabès": ("Mediterranean Sea", "mediterranean"),
    "Gulf of Sidra": ("Mediterranean Sea", "mediterranean"),
    "Strait of Gibraltar": ("Mediterranean Sea", "mediterranean"),
    "Dardanelles": ("Mediterranean Sea", "mediterranean"),
    "Bosporus": ("Black Sea", "black"),
    "Garabogaz Bay": ("Caspian Sea", "caspian"),
    "Stettiner Haff": ("Baltic Sea", "baltic"),
    "Mecklenburger Bucht": ("Baltic Sea", "baltic"),
    "Øresund": ("Baltic Sea", "baltic"),
    "Kaliningrad": ("Baltic Sea", "baltic"),
    "Waddenzee": ("North Sea", "northsea"),
    "Trondheimsfjorden": ("Norwegian Sea", "arctic"),
    "Vestfjorden": ("Norwegian Sea", "arctic"),
    "Sognefjorden": ("Norwegian Sea", "arctic"),
    "Boknafjorden": ("North Sea", "northsea"),
    "Kangertittivaq": ("Arctic Ocean", "arctic"),
    "Denmark Strait": ("Atlantic Ocean", "atlantic"),
}


def _group_by_position(lon: float, lat: float) -> str:
    """Fallback for a marine name that is not in the table above."""
    if lon > 45 and 36 < lat < 48:
        return "caspian"
    if 26 < lon < 42 and 40 < lat < 48:
        return "black"
    if lat > 66 or (lon > 20 and lat > 62):
        return "arctic"
    if lat < 46 and lon > -6:
        return "mediterranean"
    if 9 < lon < 31 and 53 < lat < 66:
        return "baltic"
    if -5 < lon < 10 and 51 < lat < 61:
        return "northsea"
    return "atlantic"


@njit(cache=True, nogil=True)
def _basin_stats(term, basin_of, dem, country, ice, lake, nb, ncountry):
    count = np.zeros(nb, np.int64)
    sum_e = np.zeros(nb, np.float64)
    max_e = np.full(nb, -9999.0, np.float32)
    min_e = np.full(nb, 9999.0, np.float32)
    ice_n = np.zeros(nb, np.int64)
    lake_n = np.zeros(nb, np.int64)
    chist = np.zeros((nb, ncountry), np.int32)
    for i in range(term.size):
        b = basin_of[term[i]]
        if b < 0:
            continue
        count[b] += 1
        e = dem[i]
        sum_e[b] += e
        if e > max_e[b]:
            max_e[b] = e
        if e < min_e[b]:
            min_e[b] = e
        if ice[i]:
            ice_n[b] += 1
        if lake[i]:
            lake_n[b] += 1
        c = country[i]
        if c > 0 and c < ncountry:
            chist[b, c] += 1
    return count, sum_e, max_e, min_e, ice_n, lake_n, chist


def _marine_index():
    geoms, names = [], []
    for f in load("ne_10m_geography_marine_polys")["features"]:
        n = f["properties"].get("name")
        if not n or not f.get("geometry"):
            continue
        geoms.append(shape(f["geometry"]))
        names.append(n)
    return STRtree(geoms), names, geoms


def build_basins(hyd, rivers=None) -> list[dict]:
    grid = hyd["grid"]
    W, H = grid.width, grid.height
    dirs = np.asarray(hyd["dirs"])
    acc = np.asarray(hyd["acc"])
    term = np.asarray(hyd["term"])
    cls = np.asarray(hyd["cls"])
    dem = np.asarray(hyd["dem"]).ravel()
    masks = build_masks(grid)
    country = masks["country"].ravel()
    codes = list(masks["country_codes"])
    ice = masks["ice"].ravel().astype(bool)
    lake = masks["lake"].ravel().astype(bool)

    outlets = np.flatnonzero((dirs == 0) & (acc >= MIN_BASIN_KM2))
    print(f"[basin] {len(outlets)} outlets with >= {MIN_BASIN_KM2:.0f} km2")

    basin_of = np.full(dirs.size, -1, np.int32)
    basin_of[outlets] = np.arange(len(outlets), dtype=np.int32)

    print("[basin] aggregating statistics ...")
    (count, sum_e, max_e, min_e, ice_n, lake_n,
     chist) = _basin_stats(term, basin_of, dem, country, ice, lake,
                           len(outlets), len(codes) + 1)

    tree, names, geoms = _marine_index()
    # spatial index for naming from the vector river network
    river_names = []
    if rivers:
        for f in rivers:
            nm = f["properties"].get("name")
            if nm:
                river_names.append((f["properties"]["dn"], nm,
                                    f["geometry"]["coordinates"][-1]))
        river_names.sort(reverse=True)

    out = []
    for b, i in enumerate(outlets):
        px, py = int(i % W) + grid.px0, int(i // W) + grid.py0
        lon, lat = pixel_to_lonlat(px + 0.5, py + 0.5, grid.zoom)
        area = float(acc[i])
        c = int(cls[i])
        sea, group = "Inland sink", "endorheic"
        if c == 1:
            pt = Point(lon, lat)
            best, bestd = None, 1e9
            for gi in tree.query(pt.buffer(1.5)):
                dd = geoms[int(gi)].distance(pt)
                if dd < bestd:
                    bestd, best = dd, names[int(gi)]
            if best:
                sea, group = SEA_GROUPS.get(
                    best, (best, _group_by_position(lon, lat)))
        elif c == 4:
            sea, group = "Beyond the map edge", "offmap"
        elif c == 2:
            sea, group = "Inland lake", "lake"

        n = max(1, int(count[b]))
        cc = chist[b]
        top = np.argsort(cc)[::-1][:6]
        countries = [{"iso": codes[k - 1], "pct": round(100 * cc[k] / n, 1)}
                     for k in top if cc[k] > 0 and 100 * cc[k] / n >= 0.4]
        out.append({
            "id": b,
            "px": px, "py": py,
            "lon": round(lon, 4), "lat": round(lat, 4),
            "area": round(area, 1),
            "sea": sea, "seaGroup": group,
            "maxElev": round(float(max_e[b])),
            "minElev": round(float(min_e[b])),
            "meanElev": round(float(sum_e[b] / n)),
            "glacierPct": round(100 * ice_n[b] / n, 2),
            "lakePct": round(100 * lake_n[b] / n, 2),
            "countries": countries,
        })

    # Name each basin after its main stem: the river that both reaches the
    # outlet with the largest drainage area *and* owns the most reaches, so a
    # short delta distributary cannot outrank the river that feeds it.
    if rivers:
        cand: dict[int, dict[str, list[float]]] = defaultdict(
            lambda: defaultdict(lambda: [0.0, 0]))
        for f in rivers:
            nm = f["properties"].get("name")
            if not nm:
                continue
            cell = f["properties"]["dsy"] * W + f["properties"]["dsx"]
            b = int(basin_of[int(term[cell])])
            if b < 0:
                continue
            rec = cand[b][nm]
            rec[0] = max(rec[0], f["properties"]["dn"])
            rec[1] += 1
        for b, names in cand.items():
            best = max(r[0] for r in names.values())
            pool = [(n, r) for n, r in names.items() if r[0] >= 0.6 * best]
            out[b]["river"] = max(pool, key=lambda kv: (kv[1][1], kv[1][0]))[0]
    for rec in out:
        rec["name"] = (f"{rec['river']} basin" if rec.get("river")
                       else f"Coastal basin ({rec['sea']})")

    out.sort(key=lambda r: -r["area"])
    path = OUT / "basins.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"[basin] -> {path.name}: {len(out)} basins, "
          f"largest {out[0]['name']} {out[0]['area']:.0f} km2")
    return out


def export_basin_polygons(hyd, basins, factor=4) -> None:
    """Simplified polygons for the major basins (continental watershed view)."""
    from rasterio.features import shapes
    from .masks import grid_transform
    from affine import Affine
    import shapely

    grid = hyd["grid"]
    W, H = grid.width, grid.height
    term = np.asarray(hyd["term"]).reshape(H, W)
    big = {b["py"] - grid.py0 << 32 | (b["px"] - grid.px0): b
           for b in basins if b["area"] >= POLY_BASIN_KM2}
    lut = {}
    for b in basins:
        if b["area"] >= POLY_BASIN_KM2:
            lut[(b["py"] - grid.py0) * W + (b["px"] - grid.px0)] = b["id"]
    print(f"[basin] vectorising {len(lut)} major basins at 1/{factor} scale")

    sub = term[::factor, ::factor]
    keys = np.array(sorted(lut.keys()), dtype=np.int64)
    vals = np.array([lut[int(k)] for k in keys], dtype=np.int32)
    idx = np.searchsorted(keys, sub.astype(np.int64))
    idx = np.clip(idx, 0, len(keys) - 1)
    ok = keys[idx] == sub
    ids = np.where(ok, vals[idx], -1).astype(np.int32)

    tr = grid_transform(grid)
    tr = Affine(tr.a * factor, 0, tr.c, 0, tr.e * factor, tr.f)
    polys = defaultdict(list)
    for geom, val in shapes(ids, mask=(ids >= 0), transform=tr, connectivity=4):
        polys[int(val)].append(shape(geom))

    def to_wgs(g):
        from .masks import ORIGIN
        def fn(coords):
            x = coords[:, 0] / ORIGIN * 180.0
            y = np.degrees(2 * np.arctan(np.exp(coords[:, 1] / ORIGIN * np.pi))
                           - np.pi / 2)
            return np.column_stack([x, y])
        return shapely.transform(g, fn)

    by_id = {b["id"]: b for b in basins}
    feats = []
    for bid, ps in polys.items():
        g = unary_union(ps).simplify(2000)
        g = to_wgs(g).simplify(0.004)
        if g.is_empty:
            continue
        b = by_id[bid]
        feats.append({"type": "Feature",
                      "properties": {"id": bid, "name": b["name"],
                                     "area": b["area"], "sea": b["sea"],
                                     "seaGroup": b["seaGroup"],
                                     "river": b.get("river")},
                      "geometry": mapping(g)})
    feats.sort(key=lambda f: -f["properties"]["area"])
    path = OUT / "basins.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                               separators=(",", ":")))
    print(f"[basin] -> {path.name} ({path.stat().st_size/1e6:.1f} MB, "
          f"{len(feats)} polygons)")
