"""Numba-accelerated D8 hydrology: depression filling, flow direction,
flow accumulation, Strahler order and terminal-basin labelling.

The algorithms follow the standard literature:

* Depression filling  : priority-flood + epsilon (Barnes, Lehman & Mulla 2014)
* Flow direction      : D8 steepest descent (O'Callaghan & Mark 1984)
* Flow accumulation   : topological (Kahn) traversal of the D8 tree
* Stream order        : Strahler (1957)
"""
from __future__ import annotations

import numpy as np
from numba import njit

# D8 direction codes.  0 = terminal / no flow.
#   1 E, 2 SE, 3 S, 4 SW, 5 W, 6 NW, 7 N, 8 NE
DX = np.array([0, 1, 1, 0, -1, -1, -1, 0, 1], dtype=np.int32)
DY = np.array([0, 0, 1, 1, 1, 0, -1, -1, -1], dtype=np.int32)

# terminal / cell classes (high nibble of the published R byte)
CLS_LAND = 0
CLS_OCEAN = 1
CLS_LAKE = 2
CLS_SINK = 3
CLS_EDGE = 4
CLS_ICE = 5


# ---------------------------------------------------------------------------
# binary heap on flat arrays
# ---------------------------------------------------------------------------
@njit(cache=True, inline="always")
def _hpush(hv, hi, n, val, idx):
    hv[n] = val
    hi[n] = idx
    c = n
    while c > 0:
        p = (c - 1) >> 1
        if hv[p] <= hv[c]:
            break
        hv[p], hv[c] = hv[c], hv[p]
        hi[p], hi[c] = hi[c], hi[p]
        c = p
    return n + 1


@njit(cache=True, inline="always")
def _hpop(hv, hi, n):
    top_v = hv[0]
    top_i = hi[0]
    n -= 1
    hv[0] = hv[n]
    hi[0] = hi[n]
    c = 0
    while True:
        l = 2 * c + 1
        r = l + 1
        s = c
        if l < n and hv[l] < hv[s]:
            s = l
        if r < n and hv[r] < hv[s]:
            s = r
        if s == c:
            break
        hv[s], hv[c] = hv[c], hv[s]
        hi[s], hi[c] = hi[c], hi[s]
        c = s
    return top_v, top_i, n


# ---------------------------------------------------------------------------
# priority-flood depression filling with an epsilon gradient
# ---------------------------------------------------------------------------
@njit(cache=True, nogil=True)
def priority_flood(dem, seed, W, H, eps):
    """In-place fill of `dem` (flat float32). `seed` marks fixed outlet cells."""
    N = dem.size
    visited = np.zeros(N, np.bool_)
    hv = np.empty(N, np.float32)
    hi = np.empty(N, np.int32)
    n = 0
    for i in range(N):
        if seed[i]:
            visited[i] = True
            n = _hpush(hv, hi, n, dem[i], i)
    while n > 0:
        v, i, n = _hpop(hv, hi, n)
        y = i // W
        x = i - y * W
        for k in range(1, 9):
            nx = x + DX[k]
            ny = y + DY[k]
            if nx < 0 or ny < 0 or nx >= W or ny >= H:
                continue
            j = ny * W + nx
            if visited[j]:
                continue
            visited[j] = True
            nv = dem[j]
            if nv <= v:
                nv = v + eps
            dem[j] = nv
            n = _hpush(hv, hi, n, nv, j)
    return visited


# ---------------------------------------------------------------------------
# D8 flow direction
# ---------------------------------------------------------------------------
@njit(cache=True, nogil=True, parallel=False)
def d8_directions(dem, terminal, W, H, cellsize):
    """Steepest-descent D8 direction for every cell.

    `terminal` (bool) marks cells that do not route further (ocean, sinks).
    `cellsize` is the ground size of a cell for every raster row (metres).
    """
    N = dem.size
    d = np.zeros(N, np.uint8)
    slope = np.zeros(N, np.float32)
    for y in range(H):
        cs = cellsize[y]
        diag = cs * 1.41421356
        base = y * W
        for x in range(W):
            i = base + x
            if terminal[i]:
                continue
            if x == 0 or y == 0 or x == W - 1 or y == H - 1:
                continue                      # drains off the grid edge
            z = dem[i]
            best = 0.0
            bk = 0
            for k in range(1, 9):
                j = (y + DY[k]) * W + x + DX[k]
                dz = z - dem[j]
                if dz <= 0.0:
                    continue
                dist = diag if (DX[k] != 0 and DY[k] != 0) else cs
                s = dz / dist
                if s > best:
                    best = s
                    bk = k
            d[i] = bk
            slope[i] = best
    return d, slope


# ---------------------------------------------------------------------------
# topological order + flow accumulation
# ---------------------------------------------------------------------------
@njit(cache=True, nogil=True)
def topo_order(d, W, H):
    """Kahn ordering of the D8 tree (upstream cells before downstream)."""
    N = d.size
    indeg = np.zeros(N, np.uint8)
    for i in range(N):
        k = d[i]
        if k == 0:
            continue
        y = i // W
        x = i - y * W
        j = (y + DY[k]) * W + x + DX[k]
        indeg[j] += 1
    order = np.empty(N, np.int32)
    head = 0
    tail = 0
    for i in range(N):
        if indeg[i] == 0:
            order[tail] = i
            tail += 1
    while head < tail:
        i = order[head]
        head += 1
        k = d[i]
        if k == 0:
            continue
        y = i // W
        x = i - y * W
        j = (y + DY[k]) * W + x + DX[k]
        indeg[j] -= 1
        if indeg[j] == 0:
            order[tail] = j
            tail += 1
    return order[:tail]


@njit(cache=True, nogil=True)
def accumulate(d, order, weight, W):
    """Accumulate `weight` (per-row cell area in km2) down the D8 tree."""
    N = d.size
    acc = np.empty(N, np.float32)
    for i in range(N):
        acc[i] = weight[i // W]
    for t in range(order.size):
        i = order[t]
        k = d[i]
        if k == 0:
            continue
        y = i // W
        x = i - y * W
        j = (y + DY[k]) * W + x + DX[k]
        acc[j] += acc[i]
    return acc


@njit(cache=True, nogil=True)
def strahler(d, order, acc, W, threshold):
    """Strahler stream order for cells whose drainage area >= threshold."""
    N = d.size
    o = np.zeros(N, np.uint8)
    for t in range(order.size):
        i = order[t]
        if acc[i] < threshold:
            continue
        if o[i] == 0:
            o[i] = 1
        k = d[i]
        if k == 0:
            continue
        y = i // W
        x = i - y * W
        j = (y + DY[k]) * W + x + DX[k]
        oi = o[i]
        oj = o[j]
        if oj == 0:
            o[j] = oi
        elif oj == oi:
            o[j] = oi + 1
        elif oj < oi:
            o[j] = oi
    return o


@njit(cache=True, nogil=True)
def terminal_labels(d, order, W):
    """For every cell, the flat index of the terminal cell it drains into."""
    N = d.size
    term = np.empty(N, np.int32)
    for t in range(order.size - 1, -1, -1):
        i = order[t]
        k = d[i]
        if k == 0:
            term[i] = i
        else:
            y = i // W
            x = i - y * W
            term[i] = term[(y + DY[k]) * W + x + DX[k]]
    return term


@njit(cache=True, nogil=True)
def trace_down(d, start, W, H, max_steps):
    """Follow the D8 tree downstream from `start`; returns the visited cells."""
    out = np.empty(max_steps, np.int32)
    i = start
    n = 0
    while n < max_steps:
        out[n] = i
        n += 1
        k = d[i]
        if k == 0:
            break
        y = i // W
        x = i - y * W
        i = (y + DY[k]) * W + x + DX[k]
    return out[:n]
