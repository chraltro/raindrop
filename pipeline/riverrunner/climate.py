"""A transparent, station-calibrated climatology for Europe.

No gridded climate product is redistributed with this project.  Instead the
pipeline interpolates published long-term station normals (annual
precipitation, mean annual temperature, annual temperature amplitude and a
seasonal regime) with inverse-distance weighting, then applies an orographic
correction from the DEM.  Runoff comes from a Budyko water balance (Fu 1981)
driven by Oudin et al. (2005) potential evapotranspiration.

Everything produced here is an *estimate* and is labelled as such in the UI.
"""
from __future__ import annotations

import json

import numpy as np
from numba import njit
from PIL import Image

from .config import OUT
from .hydro import DX, DY
from .tiles import row_latitudes

# monthly precipitation share for each seasonal regime (Jan..Dec)
REGIMES = {
    "atlantic":      [.115, .088, .085, .066, .062, .057, .062, .076, .086, .108, .118, .127],
    "continental":   [.052, .046, .055, .062, .085, .112, .112, .096, .072, .062, .060, .056],
    "mediterranean": [.130, .110, .100, .080, .055, .025, .012, .022, .060, .110, .140, .142],
    "alpine":        [.060, .055, .070, .080, .100, .115, .115, .110, .090, .080, .075, .060],
    "arctic":        [.078, .066, .060, .050, .050, .070, .090, .102, .110, .108, .108, .108],
}

# name, lon, lat, elevation m, annual precipitation mm, T mean C, T amplitude K, regime
STATIONS = [
    ("Bergen", 5.32, 60.39, 40, 2250, 7.8, 7.5, "atlantic"),
    ("Narvik", 17.40, 68.44, 20, 830, 4.0, 9.0, "arctic"),
    ("Tromso", 18.96, 69.65, 10, 1030, 3.0, 9.5, "arctic"),
    ("Murmansk", 33.08, 68.97, 50, 500, 0.6, 11.0, "arctic"),
    ("Kiruna", 20.22, 67.85, 500, 500, -1.0, 13.5, "arctic"),
    ("Rovaniemi", 25.73, 66.50, 100, 540, 0.7, 15.0, "arctic"),
    ("Trondheim", 10.40, 63.43, 50, 900, 5.3, 9.5, "atlantic"),
    ("Oslo", 10.75, 59.91, 90, 790, 6.0, 10.5, "continental"),
    ("Stavanger", 5.73, 58.97, 20, 1180, 7.7, 7.5, "atlantic"),
    ("Stockholm", 18.07, 59.33, 30, 540, 7.4, 11.5, "continental"),
    ("Gothenburg", 11.97, 57.70, 20, 760, 8.0, 9.5, "atlantic"),
    ("Ostersund", 14.64, 63.18, 330, 480, 3.0, 13.0, "arctic"),
    ("Helsinki", 24.94, 60.17, 20, 650, 5.9, 12.5, "continental"),
    ("Tallinn", 24.75, 59.44, 20, 700, 6.5, 12.0, "continental"),
    ("Riga", 24.10, 56.95, 10, 690, 7.0, 11.5, "continental"),
    ("Vilnius", 25.28, 54.69, 150, 690, 7.0, 12.5, "continental"),
    ("Copenhagen", 12.57, 55.68, 10, 610, 9.0, 9.5, "atlantic"),
    ("Reykjavik", -21.90, 64.14, 40, 850, 5.0, 6.5, "arctic"),
    ("Kviskerjokull", -16.40, 63.95, 100, 3300, 5.0, 6.0, "arctic"),
    ("Akureyri", -18.10, 65.68, 10, 490, 3.6, 8.0, "arctic"),
    ("Edinburgh", -3.19, 55.95, 47, 700, 9.0, 6.5, "atlantic"),
    ("Fort William", -5.11, 56.82, 30, 2000, 8.5, 6.0, "atlantic"),
    ("Manchester", -2.24, 53.48, 40, 830, 10.0, 6.5, "atlantic"),
    ("London", -0.13, 51.51, 20, 620, 11.5, 7.0, "atlantic"),
    ("Cardiff", -3.18, 51.48, 30, 1150, 10.5, 6.5, "atlantic"),
    ("Galway", -9.05, 53.27, 20, 1160, 10.0, 5.5, "atlantic"),
    ("Dublin", -6.26, 53.35, 20, 730, 9.8, 5.8, "atlantic"),
    ("Brest", -4.49, 48.39, 50, 1210, 11.3, 6.0, "atlantic"),
    ("Paris", 2.35, 48.86, 35, 640, 11.8, 8.0, "atlantic"),
    ("Nantes", -1.55, 47.22, 20, 820, 12.5, 7.5, "atlantic"),
    ("Bordeaux", -0.58, 44.84, 20, 950, 13.5, 8.5, "atlantic"),
    ("Toulouse", 1.44, 43.60, 150, 640, 13.8, 8.5, "atlantic"),
    ("Lyon", 4.83, 45.76, 170, 830, 12.5, 9.5, "continental"),
    ("Marseille", 5.37, 43.30, 10, 515, 15.5, 8.5, "mediterranean"),
    ("Nice", 7.27, 43.70, 10, 800, 15.8, 8.0, "mediterranean"),
    ("Amsterdam", 4.90, 52.37, 0, 840, 10.5, 7.5, "atlantic"),
    ("Brussels", 4.35, 50.85, 60, 850, 10.8, 7.5, "atlantic"),
    ("Hamburg", 10.00, 53.55, 10, 770, 9.5, 8.5, "atlantic"),
    ("Berlin", 13.40, 52.52, 40, 590, 10.0, 9.5, "continental"),
    ("Frankfurt", 8.68, 50.11, 110, 630, 10.8, 9.0, "continental"),
    ("Munich", 11.58, 48.14, 520, 970, 9.5, 9.5, "alpine"),
    ("Zugspitze", 10.98, 47.42, 2960, 2000, -4.3, 8.0, "alpine"),
    ("Zurich", 8.54, 47.37, 410, 1050, 9.8, 9.5, "alpine"),
    ("Bern", 7.45, 46.95, 550, 1050, 9.4, 9.5, "alpine"),
    ("Sion", 7.36, 46.23, 500, 600, 10.5, 10.0, "alpine"),
    ("Locarno", 8.80, 46.17, 200, 1850, 12.5, 9.5, "alpine"),
    ("Innsbruck", 11.40, 47.27, 580, 900, 9.5, 10.0, "alpine"),
    ("Salzburg", 13.05, 47.80, 430, 1180, 9.5, 10.0, "alpine"),
    ("Vienna", 16.37, 48.21, 170, 620, 11.0, 10.5, "continental"),
    ("Prague", 14.42, 50.09, 200, 530, 9.5, 10.5, "continental"),
    ("Bratislava", 17.11, 48.15, 150, 570, 10.7, 10.5, "continental"),
    ("Budapest", 19.04, 47.50, 100, 560, 11.5, 11.5, "continental"),
    ("Szeged", 20.15, 46.25, 80, 520, 11.5, 11.5, "continental"),
    ("Krakow", 19.94, 50.06, 220, 680, 9.0, 11.0, "continental"),
    ("Warsaw", 21.01, 52.23, 100, 530, 9.0, 11.5, "continental"),
    ("Gdansk", 18.65, 54.35, 10, 600, 8.5, 10.0, "continental"),
    ("Minsk", 27.56, 53.90, 220, 690, 6.5, 12.5, "continental"),
    ("Lviv", 24.03, 49.84, 300, 740, 7.8, 11.5, "continental"),
    ("Kyiv", 30.52, 50.45, 180, 620, 8.5, 13.0, "continental"),
    ("Chisinau", 28.86, 47.00, 100, 550, 10.2, 13.0, "continental"),
    ("Odesa", 30.73, 46.48, 40, 470, 10.8, 12.5, "continental"),
    ("St Petersburg", 30.31, 59.94, 10, 660, 5.8, 13.0, "continental"),
    ("Moscow", 37.62, 55.75, 150, 700, 6.0, 14.0, "continental"),
    ("Arkhangelsk", 40.50, 64.54, 10, 600, 1.3, 14.5, "arctic"),
    ("Syktyvkar", 50.80, 61.67, 100, 570, 1.3, 15.5, "arctic"),
    ("Nizhny Novgorod", 44.00, 56.33, 100, 620, 5.0, 14.5, "continental"),
    ("Kazan", 49.10, 55.80, 100, 560, 4.5, 16.0, "continental"),
    ("Perm", 56.23, 58.01, 150, 630, 2.5, 16.0, "continental"),
    ("Ufa", 56.00, 54.73, 150, 570, 4.0, 16.5, "continental"),
    ("Samara", 50.15, 53.20, 100, 480, 6.0, 16.0, "continental"),
    ("Saratov", 46.00, 51.53, 100, 450, 7.5, 15.5, "continental"),
    ("Voronezh", 39.20, 51.67, 150, 590, 7.5, 14.5, "continental"),
    ("Volgograd", 44.50, 48.70, 50, 380, 8.7, 15.5, "continental"),
    ("Astrakhan", 48.00, 46.35, -20, 200, 10.5, 16.0, "continental"),
    ("Rostov", 39.70, 47.24, 60, 620, 10.0, 14.5, "continental"),
    ("Bucharest", 26.10, 44.43, 80, 640, 11.5, 12.5, "continental"),
    ("Belgrade", 20.46, 44.79, 100, 690, 12.5, 11.5, "continental"),
    ("Zagreb", 15.98, 45.81, 130, 880, 11.5, 11.0, "continental"),
    ("Ljubljana", 14.50, 46.05, 300, 1400, 10.9, 11.0, "alpine"),
    ("Crkvice", 18.63, 42.57, 940, 4600, 10.0, 9.0, "mediterranean"),
    ("Sarajevo", 18.41, 43.86, 550, 930, 10.0, 11.0, "continental"),
    ("Split", 16.44, 43.51, 20, 820, 16.0, 9.0, "mediterranean"),
    ("Podgorica", 19.26, 42.44, 50, 1650, 15.3, 11.0, "mediterranean"),
    ("Tirana", 19.82, 41.33, 110, 1200, 15.5, 10.0, "mediterranean"),
    ("Sofia", 23.32, 42.70, 550, 590, 10.5, 11.5, "continental"),
    ("Thessaloniki", 22.94, 40.64, 20, 450, 16.0, 10.5, "mediterranean"),
    ("Athens", 23.73, 37.98, 100, 400, 18.5, 9.5, "mediterranean"),
    ("Istanbul", 28.98, 41.01, 40, 810, 14.5, 9.5, "mediterranean"),
    ("Ankara", 32.85, 39.93, 890, 400, 12.0, 12.0, "continental"),
    ("Trabzon", 39.72, 41.00, 30, 830, 14.7, 8.5, "atlantic"),
    ("Nicosia", 33.36, 35.17, 160, 330, 20.0, 11.0, "mediterranean"),
    ("Rome", 12.50, 41.90, 20, 800, 15.7, 9.0, "mediterranean"),
    ("Milan", 9.19, 45.46, 120, 1000, 13.0, 11.0, "continental"),
    ("Bolzano", 11.35, 46.50, 260, 720, 12.5, 10.5, "alpine"),
    ("Venice", 12.33, 45.44, 2, 750, 13.5, 10.5, "continental"),
    ("Naples", 14.25, 40.85, 20, 900, 16.0, 9.0, "mediterranean"),
    ("Palermo", 13.36, 38.12, 20, 600, 18.5, 8.0, "mediterranean"),
    ("Cagliari", 9.11, 39.22, 10, 430, 17.5, 8.5, "mediterranean"),
    ("Madrid", -3.70, 40.42, 660, 420, 14.5, 10.5, "mediterranean"),
    ("Barcelona", 2.17, 41.39, 10, 590, 16.0, 8.5, "mediterranean"),
    ("Valencia", -0.38, 39.47, 15, 450, 17.5, 8.0, "mediterranean"),
    ("Sevilla", -5.98, 37.39, 10, 540, 18.6, 9.5, "mediterranean"),
    ("Almeria", -2.46, 36.84, 20, 220, 18.5, 7.5, "mediterranean"),
    ("Santiago", -8.54, 42.88, 260, 1800, 13.0, 7.0, "atlantic"),
    ("Bilbao", -2.93, 43.26, 20, 1200, 14.3, 7.5, "atlantic"),
    ("Porto", -8.61, 41.15, 90, 1250, 15.0, 6.5, "atlantic"),
    ("Lisbon", -9.14, 38.72, 50, 720, 17.0, 7.0, "mediterranean"),
    ("Faro", -7.94, 37.02, 10, 500, 18.0, 7.0, "mediterranean"),
    ("Rabat", -6.84, 34.02, 50, 520, 17.8, 7.0, "mediterranean"),
    ("Algiers", 3.06, 36.75, 30, 690, 18.0, 8.0, "mediterranean"),
    ("Tunis", 10.17, 36.80, 10, 460, 18.8, 9.0, "mediterranean"),
    ("Ouargla", 5.33, 31.95, 140, 45, 22.5, 12.0, "mediterranean"),
    ("Benghazi", 20.07, 32.12, 20, 270, 20.0, 9.0, "mediterranean"),
    ("Batumi", 41.64, 41.65, 20, 2400, 14.5, 8.5, "atlantic"),
    ("Sochi", 39.73, 43.60, 30, 1700, 14.2, 8.5, "mediterranean"),
    ("Novorossiysk", 37.77, 44.72, 30, 760, 13.0, 11.0, "mediterranean"),
    ("Tbilisi", 44.79, 41.72, 450, 500, 13.3, 12.0, "continental"),
    ("Yerevan", 44.51, 40.18, 990, 320, 12.4, 13.5, "continental"),
    ("Baku", 49.87, 40.41, -20, 300, 15.0, 11.0, "mediterranean"),
    ("Erzurum", 41.27, 39.91, 1750, 430, 5.9, 13.5, "continental"),
    ("Diyarbakir", 40.22, 37.91, 660, 480, 15.8, 13.5, "mediterranean"),
    ("Aleppo", 37.16, 36.20, 390, 330, 17.5, 12.0, "mediterranean"),
    ("Baghdad", 44.36, 33.31, 34, 120, 23.0, 13.5, "mediterranean"),
    ("Tehran", 51.39, 35.69, 1190, 230, 17.0, 13.0, "mediterranean"),
    ("Ashgabat", 58.38, 37.95, 210, 220, 16.5, 15.0, "mediterranean"),
    ("Tashkent", 69.24, 41.30, 450, 440, 14.0, 15.0, "mediterranean"),
    ("Nukus", 59.61, 42.46, 75, 110, 12.5, 17.0, "continental"),
    ("Orenburg", 55.10, 51.77, 110, 370, 5.5, 17.0, "continental"),
    ("Aktobe", 57.17, 50.28, 220, 320, 4.5, 17.5, "continental"),
    ("Atyrau", 51.88, 47.10, -20, 190, 9.5, 16.5, "continental"),
    ("Cairo", 31.24, 30.06, 20, 25, 22.0, 9.5, "mediterranean"),
    ("Marrakesh", -8.00, 31.63, 460, 250, 19.5, 10.0, "mediterranean"),
    ("Bechar", -2.22, 31.62, 770, 60, 20.5, 12.5, "mediterranean"),
    ("Vorkuta", 64.00, 67.50, 150, 520, -5.0, 15.0, "arctic"),
    ("Salekhard", 66.53, 66.53, 30, 480, -5.5, 17.0, "arctic"),
    # --- dry interiors and rain shadows: without these the interpolation
    # --- carries maritime rainfall far too deep into the continent
    ("Zaragoza", -0.88, 41.65, 200, 320, 15.5, 10.5, "mediterranean"),
    ("Badajoz", -6.97, 38.88, 185, 460, 16.8, 10.0, "mediterranean"),
    ("Ciudad Real", -3.93, 38.99, 630, 400, 15.0, 11.0, "mediterranean"),
    ("Albacete", -1.86, 38.99, 690, 330, 14.0, 11.0, "mediterranean"),
    ("Murcia", -1.13, 37.99, 40, 300, 18.0, 9.0, "mediterranean"),
    ("Valladolid", -4.72, 41.65, 700, 435, 12.3, 10.5, "mediterranean"),
    ("Salamanca", -5.66, 40.96, 800, 370, 12.0, 10.5, "mediterranean"),
    ("Burgos", -3.70, 42.34, 860, 570, 10.5, 10.0, "mediterranean"),
    ("Cordoba", -4.78, 37.89, 120, 600, 18.0, 10.0, "mediterranean"),
    ("Granada", -3.60, 37.18, 690, 360, 15.5, 10.5, "mediterranean"),
    ("Zamora", -5.75, 41.50, 650, 370, 12.8, 10.5, "mediterranean"),
    ("Lleida", 0.63, 41.62, 160, 350, 15.0, 11.0, "mediterranean"),
    ("Teruel", -1.11, 40.34, 900, 380, 11.5, 11.0, "mediterranean"),
    ("Clermont-Ferrand", 3.09, 45.78, 330, 590, 11.5, 9.5, "continental"),
    ("Perpignan", 2.90, 42.70, 30, 560, 15.8, 9.0, "mediterranean"),
    ("Foggia", 15.55, 41.46, 80, 470, 15.5, 10.0, "mediterranean"),
    ("Catania", 15.09, 37.50, 10, 480, 18.5, 8.5, "mediterranean"),
    ("Nis", 21.90, 43.32, 200, 590, 11.6, 11.5, "continental"),
    ("Skopje", 21.43, 41.99, 250, 470, 12.5, 11.5, "continental"),
    ("Larissa", 22.42, 39.64, 70, 450, 16.5, 11.0, "mediterranean"),
    ("Konya", 32.49, 37.87, 1030, 320, 11.5, 12.5, "continental"),
    ("Sanliurfa", 38.79, 37.16, 550, 460, 18.5, 13.0, "mediterranean"),
    ("Kharkiv", 36.23, 49.99, 150, 520, 8.0, 14.0, "continental"),
    ("Kherson", 32.62, 46.64, 50, 400, 10.8, 13.5, "continental"),
    ("Simferopol", 34.10, 44.95, 300, 500, 11.0, 12.0, "mediterranean"),
    ("Elista", 44.27, 46.31, 150, 340, 10.0, 15.0, "continental"),
    ("Uralsk", 51.37, 51.23, 40, 300, 6.0, 17.5, "continental"),
    ("Aralsk", 61.66, 46.79, 60, 130, 9.0, 18.0, "continental"),
    ("Debrecen", 21.63, 47.53, 120, 550, 10.7, 12.0, "continental"),
    ("Timisoara", 21.23, 45.75, 90, 590, 11.5, 11.5, "continental"),
    ("Craiova", 23.80, 44.32, 100, 530, 11.5, 12.5, "continental"),
    ("Ivalo", 27.53, 68.66, 140, 500, -0.5, 15.5, "arctic"),
    ("Jokkmokk", 19.83, 66.61, 260, 480, -0.5, 15.0, "arctic"),
    ("Roros", 11.38, 62.57, 630, 500, 0.5, 12.5, "arctic"),
    ("Finse", 7.50, 60.60, 1220, 1000, 0.0, 9.0, "alpine"),
    ("Birmingham", -1.90, 52.48, 140, 690, 10.0, 6.5, "atlantic"),
    ("Aberdeen", -2.10, 57.15, 20, 780, 8.5, 6.5, "atlantic"),
    ("Inverness", -4.22, 57.48, 10, 650, 8.7, 6.5, "atlantic"),
]

OMEGA = 2.6            # Budyko shape parameter (Fu 1981)
# PET bias factor and Budyko shape, fitted to 37 gauged European rivers
# (see calibrate.py): median modelled/observed discharge 0.92, mean |log error|
# 0.55 -- i.e. a typical error of about a factor of 1.7.
PET_SCALE = 2.0
LAPSE = 0.0065          # K per metre
OROG = 0.00055          # relative precipitation increase per metre above the
                        # interpolated station elevation (~55 %/km)


def _harmonic(fracs: np.ndarray) -> tuple[float, float]:
    """First Fourier harmonic (amplitude, phase month) of a monthly share."""
    m = np.arange(12)
    c = np.sum(fracs * np.cos(2 * np.pi * m / 12))
    s = np.sum(fracs * np.sin(2 * np.pi * m / 12))
    amp = 2 * np.hypot(c, s) / np.sum(fracs)
    ph = (np.degrees(np.arctan2(s, c)) / 30.0) % 12.0
    return float(amp), float(ph)


def _extraterrestrial_radiation(lat_deg, doy):
    """Daily extraterrestrial radiation Re (MJ m-2 d-1), FAO-56 eq. 21."""
    phi = np.radians(lat_deg)
    dr = 1 + 0.033 * np.cos(2 * np.pi * doy / 365.0)
    dec = 0.409 * np.sin(2 * np.pi * doy / 365.0 - 1.39)
    x = np.clip(-np.tan(phi) * np.tan(dec), -1.0, 1.0)
    ws = np.arccos(x)
    return (24 * 60 / np.pi) * 0.0820 * dr * (
        ws * np.sin(phi) * np.sin(dec) + np.cos(phi) * np.cos(dec) * np.sin(ws))


def build_climate(hyd, factor: int = 8, omega: float = OMEGA,
                  pet_scale: float = PET_SCALE):
    """Interpolate the climatology onto a coarse grid; returns dict of fields."""
    grid = hyd["grid"]
    W, H = grid.width, grid.height
    h, w = H // factor, W // factor
    dem = np.asarray(hyd["dem"]).reshape(H, W)
    demc = dem[:h * factor, :w * factor].reshape(h, factor, w, factor).mean(axis=(1, 3))

    lat = row_latitudes(grid)[:h * factor].reshape(h, factor).mean(axis=1)
    n = 256 * (1 << grid.zoom)
    colx = (np.arange(w) * factor + factor / 2 + grid.px0)
    lon = colx / n * 360.0 - 180.0
    LON, LAT = np.meshgrid(lon, lat)

    sx = np.array([s[1] for s in STATIONS])
    sy = np.array([s[2] for s in STATIONS])
    sz = np.array([s[3] for s in STATIONS], float)
    sp = np.array([s[4] for s in STATIONS], float)
    st = np.array([s[5] for s in STATIONS], float)
    sa = np.array([s[6] for s in STATIONS], float)
    sh = np.array([_harmonic(np.array(REGIMES[s[7]])) for s in STATIONS])

    print(f"[clim] interpolating {len(STATIONS)} stations onto {w}x{h}")
    coslat = np.cos(np.radians(LAT))
    P = np.zeros((h, w)); T = np.zeros((h, w)); A = np.zeros((h, w))
    Z = np.zeros((h, w)); HA = np.zeros((h, w)); HC = np.zeros((h, w))
    HS = np.zeros((h, w)); Wt = np.zeros((h, w))
    for k in range(len(STATIONS)):
        dx = (LON - sx[k]) * coslat
        dy = LAT - sy[k]
        d2 = dx * dx + dy * dy + 0.02
        wgt = 1.0 / d2 ** 1.6
        Wt += wgt
        P += wgt * sp[k]
        T += wgt * (st[k] + LAPSE * sz[k])       # reduce to sea level first
        A += wgt * sa[k]
        Z += wgt * sz[k]
        HA += wgt * sh[k, 0]
        HC += wgt * np.cos(np.radians(sh[k, 1] * 30))
        HS += wgt * np.sin(np.radians(sh[k, 1] * 30))
    P /= Wt; T /= Wt; A /= Wt; Z /= Wt; HA /= Wt; HC /= Wt; HS /= Wt
    phase = (np.degrees(np.arctan2(HS, HC)) / 30.0) % 12.0

    elev = np.maximum(demc, 0.0)
    P = P * np.clip(1.0 + OROG * (elev - Z), 0.35, 3.2)
    P = np.clip(P, 20, 6000)
    T = T - LAPSE * elev

    # ---- water balance -------------------------------------------------
    # Potential evapotranspiration: Oudin et al. (2005), a temperature and
    # radiation formula that behaves far better than Turc in dry continental
    # climates.  Actual evapotranspiration then follows the Budyko framework
    # in Fu's (1981) closed form with omega = 2.6.
    months = np.arange(12)
    pet = np.zeros_like(P)
    for m in months:
        Tm = T + A * np.cos(2 * np.pi * (m - 6) / 12.0)
        Re = _extraterrestrial_radiation(LAT, 15 + 30 * m)
        daily = np.where(Tm > -5, Re * (Tm + 5) / 245.0, 0.0)
        pet += np.maximum(daily, 0.0) * 30.44
    pet *= pet_scale
    phi = pet / np.maximum(P, 1.0)
    w = omega
    et_ratio = 1.0 + phi - np.power(1.0 + np.power(phi, w), 1.0 / w)
    ET = np.clip(et_ratio, 0.0, 1.0) * P
    R = np.maximum(P - ET, 2.0)
    # glaciated / permafrost cells lose almost nothing to evaporation
    R = np.where(T < -2, np.maximum(R, 0.85 * P), R)

    print(f"[clim] precip {P.min():.0f}-{P.max():.0f} mm, "
          f"runoff {R.min():.0f}-{R.max():.0f} mm")
    return {"P": P, "T": T, "A": A, "amp": HA, "phase": phase, "R": R,
            "w": w, "h": h, "factor": factor}


@njit(cache=True, nogil=True)
def accumulate_runoff(d, order, runoff, factor, area_row, W, w):
    """Accumulate annual runoff volume (m3/s) down the D8 tree."""
    N = d.size
    q = np.empty(N, np.float32)
    for i in range(N):
        y = i // W
        x = i - y * W
        r = runoff[(y // factor) * w + (x // factor)]
        # km2 * mm/yr -> m3/s   (1 km2 * 1 mm/yr = 1000 m3/yr)
        q[i] = area_row[y] * r * 1000.0 / 31557600.0
    for t in range(order.size):
        i = order[t]
        k = d[i]
        if k == 0:
            continue
        y = i // W
        x = i - y * W
        q[(y + DY[k]) * W + x + DX[k]] += q[i]
    return q


def export_climate(clim, out=OUT) -> None:
    (out / "climate").mkdir(parents=True, exist_ok=True)
    P = np.clip(clim["P"], 0, 65535).astype(np.uint16)
    amp = np.clip(clim["amp"] * 255, 0, 255).astype(np.uint8)
    rgb = np.dstack([(P >> 8).astype(np.uint8), (P & 255).astype(np.uint8), amp])
    Image.fromarray(rgb, "RGB").save(out / "climate" / "precip.png",
                                     optimize=True, compress_level=9)
    T = np.clip((clim["T"] + 40) * 4, 0, 255).astype(np.uint8)
    A = np.clip(clim["A"] * 6, 0, 255).astype(np.uint8)
    ph = np.clip(clim["phase"] * 20, 0, 255).astype(np.uint8)
    Image.fromarray(np.dstack([T, A, ph]), "RGB").save(
        out / "climate" / "temp.png", optimize=True, compress_level=9)
    R = np.clip(clim["R"], 0, 65535).astype(np.uint16)
    Image.fromarray(np.dstack([(R >> 8).astype(np.uint8), (R & 255).astype(np.uint8),
                               np.zeros_like(amp)]), "RGB").save(
        out / "climate" / "runoff.png", optimize=True, compress_level=9)
    meta = {"width": clim["w"], "height": clim["h"], "factor": clim["factor"],
            "tempOffset": 40, "tempScale": 4, "ampScale": 6, "phaseScale": 20,
            "regimes": REGIMES,
            "stations": [{"name": s[0], "lon": s[1], "lat": s[2], "elev": s[3],
                          "precip": s[4], "temp": s[5], "amp": s[6],
                          "regime": s[7]} for s in STATIONS]}
    (out / "climate" / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    print("[clim] exported precip/temp/runoff rasters")
