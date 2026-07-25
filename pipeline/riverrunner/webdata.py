"""Derive the light-weight vector layers and search index used by the client."""
from __future__ import annotations

import json
import unicodedata

from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

from .config import BBOX, OUT, RAW
from .naturalearth import load

CLIP = box(BBOX[0] - 2, BBOX[1] - 2, BBOX[2] + 2, BBOX[3] + 2)


def _round(obj, nd=4):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, list):
        return [_round(o, nd) for o in obj]
    return obj


def _write(name: str, feats: list[dict]) -> None:
    path = OUT / "vector" / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                               separators=(",", ":")))
    print(f"[web] {name}.json  {path.stat().st_size/1e6:.2f} MB "
          f"({len(feats)} features)")


def subset(layer: str, name: str, keep: dict, simplify=0.0, min_area=0.0,
           where=None) -> list[dict]:
    feats = []
    for f in load(layer)["features"]:
        g = f.get("geometry")
        p = f["properties"]
        if not g or (where and not where(p)):
            continue
        try:
            geom = shape(g)
        except Exception:
            continue
        if geom.is_empty or not geom.intersects(CLIP):
            continue
        geom = geom.intersection(CLIP)
        if min_area and geom.area < min_area:
            continue
        if simplify:
            geom = geom.simplify(simplify, preserve_topology=True)
        if geom.is_empty:
            continue
        props = {}
        for src, dst in keep.items():
            v = p.get(src)
            if v not in (None, ""):
                props[dst] = round(v, 2) if isinstance(v, float) else v
        feats.append({"type": "Feature", "properties": props,
                      "geometry": _round_geom(mapping(geom))})
    _write(name, feats)
    return feats


def _round_geom(g, nd=4):
    g = dict(g)
    g["coordinates"] = _round(g["coordinates"], nd)
    return g


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s)
                   if unicodedata.category(c) != "Mn").lower()


GAZETTEER_URL = ("https://raw.githubusercontent.com/lutangar/cities.json/"
                 "master/cities.json")


def build_gazetteer(rivers=None) -> None:
    """Every populated place in the study area, plus every named reach.

    Natural Earth only carries a few thousand large towns, so searching for
    somewhere like Holmestrand found nothing.  This adds the GeoNames-derived
    city list (~78,000 places inside the bounding box) as a separate file the
    search box fetches on the first keystroke, keeping the initial load small.
    """
    import requests

    cache = RAW / "cities.json"
    if not cache.exists():
        print("[web] downloading gazetteer ...")
        cache.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(GAZETTEER_URL, timeout=300)
        r.raise_for_status()
        cache.write_bytes(r.content)

    iso_names = {}
    for f in load("ne_10m_admin_0_countries")["features"]:
        p = f["properties"]
        code = p.get("ISO_A2_EH") or p.get("ISO_A2")
        if code and code != "-99":
            iso_names.setdefault(code, p.get("NAME"))

    out = []
    seen = set()
    for c in json.loads(cache.read_text()):
        try:
            lon = float(c["lng"])
            lat = float(c["lat"])
        except (TypeError, ValueError):
            continue
        if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
            continue
        name = (c.get("name") or "").strip()
        if not name:
            continue
        key = (name, round(lon, 2), round(lat, 2))
        if key in seen:
            continue
        seen.add(key)
        # kept deliberately terse: this file is ~80,000 entries
        out.append({"n": name, "c": [round(lon, 4), round(lat, 4)],
                    "d": c.get("country")})

    # every named reach, including the small ones the label index leaves out
    if rivers:
        best: dict[str, tuple[float, list]] = {}
        for f in rivers:
            nm = f["properties"].get("name")
            if not nm:
                continue
            a = f["properties"].get("up", f["properties"]["dn"])
            cs = f["geometry"]["coordinates"]
            if a > best.get(nm, (0, None))[0]:
                best[nm] = (a, cs[len(cs) // 2])
        for nm, (a, c) in best.items():
            out.append({"n": nm, "k": "river", "c": [round(c[0], 4), round(c[1], 4)],
                        "a": round(a)})

    path = OUT / "gazetteer.json"
    path.write_text(json.dumps({"countries": iso_names, "entries": out},
                               separators=(",", ":"), ensure_ascii=False))
    print(f"[web] gazetteer.json {path.stat().st_size/1e6:.2f} MB ({len(out)} entries)")


def build_web_layers(rivers=None, basins=None) -> None:
    subset("ne_10m_coastline", "coastline", {}, simplify=0.002)
    subset("ne_10m_admin_0_countries", "countries",
           {"NAME": "name", "ISO_A2_EH": "iso", "POP_EST": "pop"},
           simplify=0.008)
    subset("ne_10m_lakes", "lakes", {"name": "name"}, simplify=0.003,
           min_area=0.0006)
    subset("ne_10m_lakes_europe", "lakes_eu", {"name": "name"}, simplify=0.002,
           min_area=0.0004)
    subset("ne_10m_glaciated_areas", "glaciers", {"name": "name"},
           simplify=0.004, min_area=0.0004)
    subset("ne_10m_urban_areas", "urban", {}, simplify=0.006, min_area=0.0012)
    subset("ne_10m_geography_marine_polys", "marine",
           {"name": "name", "scalerank": "rank"}, simplify=0.05)
    subset("ne_10m_populated_places", "places",
           {"NAME": "name", "ADM0NAME": "country", "POP_MAX": "pop",
            "SCALERANK": "rank"},
           where=lambda p: (p.get("POP_MAX") or 0) > 25000)
    subset("ne_10m_geography_regions_elevation_points", "peaks",
           {"name": "name", "elevation": "elev", "region": "region"},
           where=lambda p: p.get("featurecla", "").lower().startswith(("range", "peak", "mount")) or True)

    # ---------------- search index -------------------------------------
    idx = []

    def add(name, lon, lat, kind, extra=None, rank=5):
        if not name:
            return
        e = {"n": name, "k": kind, "c": [round(lon, 4), round(lat, 4)],
             "s": strip_accents(name), "r": rank}
        if extra:
            e.update(extra)
        idx.append(e)

    for f in load("ne_10m_populated_places")["features"]:
        p = f["properties"]
        pop = p.get("POP_MAX") or 0
        if pop < 20000:
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
            continue
        add(p.get("NAME"), lon, lat, "town",
            {"d": p.get("ADM0NAME"), "p": int(pop)},
            rank=max(0, 8 - int((pop / 1e6) ** 0.3 * 4)))

    for f in load("ne_10m_geography_regions_elevation_points")["features"]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
            continue
        add(p.get("name"), lon, lat, "peak",
            {"d": f"{p.get('elevation')} m", "e": p.get("elevation")}, rank=4)

    for layer in ("ne_10m_lakes", "ne_10m_lakes_europe"):
        for f in load(layer)["features"]:
            p = f["properties"]
            if not p.get("name"):
                continue
            g = shape(f["geometry"])
            if not g.intersects(CLIP):
                continue
            c = g.representative_point()
            add(p["name"], c.x, c.y, "lake", {"d": "Lake"}, rank=4)

    if rivers:
        seen = {}
        for f in rivers:
            nm = f["properties"].get("name")
            if not nm:
                continue
            # "up" is the area where the reach starts, so a tributary that
            # ends on a great river is not credited with the great river's size
            a = f["properties"].get("up", f["properties"]["dn"])
            if a > seen.get(nm, (0,))[0]:
                seen[nm] = (a, f["geometry"]["coordinates"][len(f["geometry"]["coordinates"]) // 2])
        for nm, (a, c) in seen.items():
            import math
            add(nm, c[0], c[1], "river",
                {"d": f"{a:,.0f} km² basin", "a": round(a)},
                rank=max(0, min(7, round(8.6 - math.log10(max(a, 1)) * 1.55))))

    if basins:
        for b in basins[:400]:
            if b.get("river"):
                add(b["name"], b["lon"], b["lat"], "basin",
                    {"d": f"drains to the {b['sea']}", "a": b["area"]}, rank=3)

    idx.sort(key=lambda e: (e["r"], -(e.get("p", 0) or 0)))
    path = OUT / "search.json"
    path.write_text(json.dumps(idx, separators=(",", ":"), ensure_ascii=False))
    print(f"[web] search.json {path.stat().st_size/1e6:.2f} MB ({len(idx)} entries)")
