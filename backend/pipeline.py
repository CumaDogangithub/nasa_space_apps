"""Turn a sky position into aligned, stacked SPHEREx frames, one per epoch.

SPHEREx revisits a given patch of sky roughly every six months, taking many
exposures over a couple of weeks. Each exposure sees the target through a
different part of a linear variable filter, i.e. at a different wavelength.
Here the exposures of one detector array are grouped by visit ("epoch"),
resampled onto a common north-up grid, background-subtracted and averaged.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
import warnings
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
from astropy.wcs import WCS
from scipy import ndimage

from . import archive, config

PIPELINE_VERSION = 3                # bump to invalidate cached frames
MIN_FOV, MAX_FOV = 60.0, 1800.0     # arcsec
MAX_GRID = 257                      # output pixels per side
EPOCH_GAP_DAYS = 15.0               # a longer pause starts a new epoch
EPOCH_MAX_SPAN = 45.0               # longer visits (deep fields) are split ...
EPOCH_WINDOW = 30.0                 # ... into windows of about this length
MIN_EXPOSURES_PER_FRAME = 2
SATURATION_SIGMA = 50.0             # "very bright" threshold used to recognise saturated cores

_MJD0 = datetime(1858, 11, 17)


def mjd_to_iso(mjd: float) -> str:
    return (_MJD0 + timedelta(days=float(mjd))).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------
# Output grid
# --------------------------------------------------------------------------

@dataclass
class Grid:
    """North-up, east-left tangent-plane grid centred on the target."""

    ra: float
    dec: float
    fov: float          # side length, arcsec
    n: int              # pixels per side (odd, so the target sits on a pixel)
    scale: float        # arcsec per pixel
    wcs: WCS
    lat_ra: np.ndarray  # sky coordinates of a coarse lattice over the grid
    lat_dec: np.ndarray
    up_y: np.ndarray    # lattice-index coordinates of every output pixel
    up_x: np.ndarray


def clamp_fov(fov: float) -> float:
    return float(min(max(fov, MIN_FOV), MAX_FOV))


def make_grid(ra: float, dec: float, fov: float, lattice: int = 9) -> Grid:
    fov = clamp_fov(fov)
    scale = max(config.NATIVE_SCALE / 2, fov / MAX_GRID)
    n = int(round(fov / scale))
    n += 1 - n % 2
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    wcs.wcs.cdelt = [-scale / 3600.0, scale / 3600.0]
    lat = np.linspace(0, n - 1, lattice)
    lx, ly = np.meshgrid(lat, lat)
    lat_ra, lat_dec = wcs.all_pix2world(lx, ly, 0)
    idx = np.arange(n) * (lattice - 1) / (n - 1)
    up_y, up_x = np.meshgrid(idx, idx, indexing="ij")
    return Grid(ra, dec, fov, n, scale, wcs, lat_ra, lat_dec, up_y, up_x)


def cutout_half_size(fov: float) -> int:
    """Half-width (native pixels) of the window that covers the rotated grid."""
    return int(math.ceil(fov / 2 * math.sqrt(2) / config.NATIVE_SCALE)) + 3


# --------------------------------------------------------------------------
# Resampling and statistics
# --------------------------------------------------------------------------

def saturation_mask(pixels: np.ndarray) -> np.ndarray:
    """Blank pixels that belong to the saturated core of a bright star.

    The SPHEREx pipeline blanks saturated pixels (NaN). A blank region that
    touches very bright pixels is taken to be saturated, not merely missing.
    """
    blank = ~np.isfinite(pixels)
    if not blank.any():
        return blank
    med, sig = robust_stats(pixels)
    if not np.isfinite(med) or not sig > 0:
        return np.zeros_like(blank)
    bright = np.nan_to_num(pixels, nan=-np.inf) > med + SATURATION_SIGMA * sig
    if not bright.any():
        return np.zeros_like(blank)
    eight = np.ones((3, 3), dtype=bool)
    labels, _ = ndimage.label(blank, structure=eight)
    touching = np.unique(labels[ndimage.binary_dilation(bright, structure=eight) & blank])
    return np.isin(labels, touching[touching > 0])


def resample(plan: archive.CutPlan, pixels: np.ndarray, grid: Grid) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear resampling of one pixel window onto the output grid.

    The sky -> detector mapping is evaluated on a coarse lattice and
    interpolated; over a few arcminutes it is smooth to well below 0.01 px.
    Returns the resampled image and a mask of output pixels that are saturated.
    """
    px_l, py_l = plan.wcs.all_world2pix(grid.lat_ra, grid.lat_dec, 0, quiet=True)
    px = ndimage.map_coordinates(px_l, [grid.up_y, grid.up_x], order=1, mode="nearest")
    py = ndimage.map_coordinates(py_l, [grid.up_y, grid.up_x], order=1, mode="nearest")
    coords = [py - plan.y0, px - plan.x0]
    good = np.isfinite(pixels)
    filled = np.where(good, pixels, 0.0).astype(np.float32)
    num = ndimage.map_coordinates(filled, coords, order=1, mode="constant", cval=0.0)
    den = ndimage.map_coordinates(good.astype(np.float32), coords, order=1, mode="constant", cval=0.0)
    out = np.full(den.shape, np.nan, dtype=np.float32)
    ok = den > 0.75
    out[ok] = num[ok] / den[ok]
    sat = saturation_mask(pixels)
    if sat.any():
        frac = ndimage.map_coordinates(sat.astype(np.float32), coords, order=1, mode="constant", cval=0.0)
        return out, frac > 0.3
    return out, np.zeros(out.shape, dtype=bool)


def robust_stats(a: np.ndarray) -> tuple[float, float]:
    """Sigma-clipped median and scatter of the finite values."""
    v = a[np.isfinite(a)]
    if v.size < 16:
        return float("nan"), float("nan")
    med = float(np.median(v))
    sig = 1.4826 * float(np.median(np.abs(v - med)))
    for _ in range(3):
        if sig <= 0:
            break
        keep = v[np.abs(v - med) < 3 * sig]
        if keep.size < 16:
            break
        med = float(np.median(keep))
        sig = 1.4826 * float(np.median(np.abs(keep - med)))
    return med, sig


def robust_stack(cube: np.ndarray, clip: float = 3.5) -> np.ndarray:
    """Outlier-resistant average along the first axis (cosmic rays, hot pixels)."""
    n = cube.shape[0]
    if n == 1:
        return cube[0].astype(np.float32)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(cube, axis=0)
        if n < 4:
            return med.astype(np.float32)
        dev = np.abs(cube - med)
        sig = 1.4826 * np.nanmedian(dev, axis=0)
        floor = np.nanmedian(sig)
        if np.isfinite(floor):
            sig = np.maximum(sig, 0.5 * floor)
        kept = np.where(dev <= clip * sig, cube, np.nan)
        out = np.nanmean(kept, axis=0)
    return np.where(np.isfinite(out), out, med).astype(np.float32)


def fill_saturated(frame: np.ndarray, noise: float) -> None:
    """Mark any hole completely enclosed by very bright pixels as saturated (+inf).

    Catches what is left of a saturated core after stacking, so that a very
    bright star never shows a dark hole in its middle.
    """
    if not np.isfinite(noise) or noise <= 0:
        return
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        bright = frame > SATURATION_SIGMA * noise
    holes = ndimage.binary_fill_holes(bright) & ~bright
    frame[holes] = np.inf


# --------------------------------------------------------------------------
# Epochs
# --------------------------------------------------------------------------

def cluster_epochs(mjds) -> list[tuple[float, float]]:
    """Group observation times into visits; returns (start, end) per epoch."""
    t = np.sort(np.asarray(list(mjds), dtype=float))
    if t.size == 0:
        return []
    breaks = np.where(np.diff(t) > EPOCH_GAP_DAYS)[0]
    starts = np.r_[0, breaks + 1]
    ends = np.r_[breaks, t.size - 1]
    out: list[tuple[float, float]] = []
    for s, e in zip(starts, ends):
        t0, t1 = float(t[s]), float(t[e])
        if t1 - t0 <= EPOCH_MAX_SPAN:
            out.append((t0, t1))
            continue
        k = int(math.ceil((t1 - t0) / EPOCH_WINDOW))
        edges = np.linspace(t0, t1, k + 1)
        for i in range(k):
            upper = (t <= edges[i + 1]) if i == k - 1 else (t < edges[i + 1])
            seg = t[(t >= edges[i]) & upper]
            if seg.size:
                out.append((float(seg[0]), float(seg[-1])))
    return out


def epoch_index(epochs: list[tuple[float, float]], mjd: float) -> int:
    best, best_d = 0, float("inf")
    for i, (a, b) in enumerate(epochs):
        d = 0.0 if a - 0.01 <= mjd <= b + 0.01 else min(abs(mjd - a), abs(mjd - b))
        if d < best_d:
            best, best_d = i, d
    return best


def summarize(exposures: list[archive.Exposure]) -> dict:
    """What the archive holds for a position: epochs and exposure counts per band."""
    epochs = cluster_epochs(e.mjd for e in exposures)
    rows = [
        {"index": i, "mjd_start": a, "mjd_end": b, "date_start": mjd_to_iso(a),
         "date_end": mjd_to_iso(b), "counts": {str(d): 0 for d in config.BANDS}}
        for i, (a, b) in enumerate(epochs)
    ]
    collections: dict[str, int] = {}
    footprints = []          # [detector, epoch, ra1, dec1, ... ra4, dec4] per exposure
    for e in exposures:
        idx = epoch_index(epochs, e.mjd)
        rows[idx]["counts"][str(e.band)] += 1
        collections[e.collection] = collections.get(e.collection, 0) + 1
        if e.poly:
            footprints.append([e.band, idx] + e.poly)
    return {
        "n_images": len(exposures),
        "epochs": rows,
        "footprints": footprints,
        "collections": collections,
        "latest_date": mjd_to_iso(max(e.mjd for e in exposures)) if exposures else None,
    }


# --------------------------------------------------------------------------
# One detector array
# --------------------------------------------------------------------------

def _frame_stats(cube: np.ndarray, meta: list[dict]) -> dict:
    finite = cube[np.isfinite(cube)]
    noises = [m["noise"] for m in meta if m["noise"] and np.isfinite(m["noise"])]
    if not finite.size:
        return {"noise": 0.0, "p50": 0.0, "p99": 1.0, "p999": 1.0, "max": 1.0}
    return {
        "noise": float(np.median(noises)) if noises else float(np.std(finite)),
        "p50": float(np.percentile(finite, 50)),
        "p99": float(np.percentile(finite, 99)),
        "p999": float(np.percentile(finite, 99.9)),
        "max": float(finite.max()),
    }


def _compute_band(ra: float, dec: float, fov: float, band: int,
                  exposures: list[archive.Exposure], progress: archive.Progress | None) -> dict:
    timing: dict[str, float] = {}
    epochs = cluster_epochs(e.mjd for e in exposures)
    selected = [e for e in exposures if e.band == band]
    grid = make_grid(ra, dec, fov)
    half = cutout_half_size(grid.fov)

    t = time.time()
    headers = archive.load_headers(selected, progress)
    plans = []
    for exp, raw in zip(selected, headers):
        if raw is None:
            continue
        plan = archive.plan_cutout(exp, raw, ra, dec, half)
        if plan is not None:
            plans.append(plan)
    timing["headers"] = time.time() - t

    t = time.time()
    pixels = archive.read_pixels_many(plans, progress)
    timing["pixels"] = time.time() - t

    t = time.time()
    layers: list[tuple[int, np.ndarray, archive.CutPlan, np.ndarray]] = []
    exposure_rows = []
    for plan, pix in zip(plans, pixels):
        if pix is None:
            continue
        img, sat = resample(plan, pix, grid)
        sky, sig = robust_stats(img)
        if not np.isfinite(sky):
            continue
        ep = epoch_index(epochs, plan.mjd)
        layers.append((ep, img - sky, plan, sat))
        exposure_rows.append({
            "uid": plan.exp.uid, "key": plan.exp.key, "collection": plan.exp.collection,
            "band": band, "epoch": ep, "mjd": plan.mjd,
            "x": round(plan.xt, 2), "y": round(plan.yt, 2),
            "window": [plan.x0, plan.x1, plan.y0, plan.y1],
            "data_offset": plan.data_offset,
            "sky": sky, "noise": sig, "psf_fwhm": plan.psf_fwhm, "pix_area": plan.pix_area,
        })

    frames, meta = [], []
    for i in range(len(epochs)):
        members = [l for l in layers if l[0] == i]
        if len(members) < MIN_EXPOSURES_PER_FRAME:
            continue
        frame = robust_stack(np.stack([m[1] for m in members]))
        noise = robust_stats(frame)[1]
        # Saturated pixels are stored as +inf: "brighter than can be measured".
        frame[np.mean([m[3] for m in members], axis=0) >= 0.5] = np.inf
        fill_saturated(frame, noise)
        saturated = int(np.isinf(frame).sum())
        mjds = [m[2].mjd for m in members]
        meta.append({
            "epoch": i,
            "mjd": float(np.mean(mjds)),
            "date": mjd_to_iso(float(np.mean(mjds))),
            "date_start": mjd_to_iso(min(mjds)),
            "date_end": mjd_to_iso(max(mjds)),
            "n_exposures": len(members),
            "bands": [band],
            "noise": noise,
            "saturated_pixels": saturated,
        })
        frames.append(frame[::-1])           # row 0 = north
    timing["stack"] = time.time() - t

    cube = np.stack(frames).astype(np.float32) if frames else np.zeros((0, grid.n, grid.n), np.float32)
    return {
        "ra": ra, "dec": dec, "fov": grid.fov, "bands": [band],
        "wavelength": list(config.BANDS[band]),
        "n": grid.n, "scale": grid.scale,
        "frames": cube,
        "epochs": meta,
        "stats": _frame_stats(cube, meta),
        "n_found": len(selected),
        "n_used": len(layers),
        "timing": timing,
        "exposures": exposure_rows,
        "cached": False,
    }


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def build_band(ra: float, dec: float, fov: float, band: int,
               progress: archive.Progress | None = None) -> dict:
    """Aligned epoch stacks of one detector array around (ra, dec), cached on disk.

    Frames are float32 [epoch, row, col] in MJy/sr with the local sky level
    removed; row 0 is north, column 0 is east. NaN means no data and +inf
    means saturated.
    """
    t = time.time()
    exposures = archive.search(ra, dec)
    search_time = time.time() - t
    mine = [e for e in exposures if e.band == band]
    fingerprint = f"{len(exposures)}:{len(mine)}:{max((e.mjd for e in exposures), default=0):.4f}"
    tag = f"{ra:.5f}|{dec:.5f}|{clamp_fov(fov):.1f}|{band}|{fingerprint}|v{PIPELINE_VERSION}"
    key = hashlib.sha1(tag.encode()).hexdigest()[:20]
    path = config.CACHE_DIR / "frames" / f"{key}.npz"

    with _lock_for(key):
        if path.exists():
            with np.load(path, allow_pickle=False) as z:
                result = json.loads(str(z["meta"]))
                result["frames"] = z["frames"]
            result["cached"] = True
            result["timing"] = {"search": search_time}
            return result
        result = _compute_band(ra, dec, fov, band, exposures, progress)
        result["timing"]["search"] = search_time
        meta = {k: v for k, v in result.items() if k != "frames"}
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{key}.{threading.get_ident()}.tmp.npz")
        np.savez(tmp, frames=result["frames"], meta=np.array(json.dumps(_clean(meta))))
        tmp.replace(path)
        return result


# --------------------------------------------------------------------------
# Several detector arrays combined
# --------------------------------------------------------------------------

def combine(results: list[dict]) -> dict:
    """Average the band stacks of each epoch into one broad-band frame."""
    first = results[0]
    epoch_ids = sorted({m["epoch"] for r in results for m in r["epochs"]})
    frames, meta = [], []
    for ep in epoch_ids:
        parts = [(r["frames"][i], m) for r in results for i, m in enumerate(r["epochs"]) if m["epoch"] == ep]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            frame = np.nanmean(np.stack([p[0] for p in parts]), axis=0).astype(np.float32)
        ms = [p[1] for p in parts]
        total = sum(m["n_exposures"] for m in ms)
        mjd = sum(m["mjd"] * m["n_exposures"] for m in ms) / total
        meta.append({
            "epoch": ep, "mjd": mjd, "date": mjd_to_iso(mjd),
            "date_start": min(m["date_start"] for m in ms),
            "date_end": max(m["date_end"] for m in ms),
            "n_exposures": total,
            "bands": sorted(b for m in ms for b in m["bands"]),
            "noise": robust_stats(frame)[1],
            "saturated_pixels": max(m["saturated_pixels"] for m in ms),
        })
        frames.append(frame)
    cube = np.stack(frames) if frames else np.zeros((0, first["n"], first["n"]), np.float32)
    bands = sorted(b for r in results for b in r["bands"])
    timing: dict[str, float] = {}
    for r in results:
        for k, v in r["timing"].items():
            timing[k] = timing.get(k, 0.0) + v
    return {
        "ra": first["ra"], "dec": first["dec"], "fov": first["fov"], "bands": bands,
        "wavelength": [config.BANDS[bands[0]][0], config.BANDS[bands[-1]][1]],
        "n": first["n"], "scale": first["scale"],
        "frames": cube,
        "epochs": meta,
        "stats": _frame_stats(cube, meta),
        "n_found": sum(r["n_found"] for r in results),
        "n_used": sum(r["n_used"] for r in results),
        "timing": timing,
        "exposures": [row for r in results for row in r["exposures"]],
        "cached": all(r["cached"] for r in results),
    }


def build(ra: float, dec: float, fov: float, bands: list[int],
          progress: archive.Progress | None = None) -> dict:
    """Epoch frames for one detector array, or the average of several."""
    results = []
    for i, band in enumerate(bands):
        def sub(label, done, total, i=i, band=band):
            if progress:
                # headers are quick; weight them as a fifth of a band's work
                part = (0.2 * done / total) if label == "headers" else (0.2 + 0.8 * done / total)
                progress(f"D{band} {label}", int(1000 * (i + part) / len(bands)), 1000)
        results.append(build_band(ra, dec, fov, band, sub))
    return results[0] if len(results) == 1 else combine(results)


def _clean(obj):
    """Make a structure JSON-safe (NaN/inf -> None, numpy scalars -> Python)."""
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        v = float(obj)
        return v if math.isfinite(v) else None
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj
