"""Quick-look spectra from SPHEREx spectral images.

SPHEREx has no prism or grating: a linear variable filter sits on each
detector, so the wavelength a source is seen at depends on where it lands.
Every exposure of a field therefore gives one point of the source's spectrum.
Measuring the same sky position in all exposures and looking up the wavelength
of each landing spot yields a spectrum from 0.75 to 5 microns, and because
the exposures are spread over several visits, a light curve as well.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from pathlib import Path

import numpy as np

from . import archive, config, pipeline

SPECTRUM_VERSION = 2
APERTURE_RADIUS = 2.0            # native pixels (12.3 arcsec)
SKY_INNER, SKY_OUTER = 4.0, 6.5  # sky annulus, native pixels
WINDOW_HALF = 8                  # pixels read around the source: a 17 x 17 window
# Stars too bright for the detector have a blank (saturated) core. The light in
# a ring just outside the core still rises and falls with the star, so it is
# measured instead; it is a relative measure, not the star's total brightness.
RING_INNER, RING_OUTER = 4.0, 7.0            # native pixels (25 to 43 arcsec)
RING_SKY_INNER, RING_SKY_OUTER = 10.0, 13.0
WINDOW_HALF_WIDE = 14
MAX_EXPOSURES = 600              # more than this (deep fields) is thinned evenly in time
ARCSEC2_TO_SR = 2.3504430539e-11

_TABLE_FILE = Path(__file__).with_name("data") / "wavelength_tables.json"
_tables: dict[int, dict] | None = None
_lock = threading.Lock()


# --------------------------------------------------------------------------
# Wavelength of a detector pixel
# --------------------------------------------------------------------------

def _load_tables() -> dict[int, dict]:
    global _tables
    if _tables is None:
        raw = json.loads(_TABLE_FILE.read_text(encoding="utf-8"))["detectors"]
        _tables = {
            int(band): {
                "x": np.array(t["x"], dtype=float),
                "y": np.array(t["y"], dtype=float),
                "wavelength": np.array(t["wavelength"], dtype=float),   # [y index, x index]
                "bandwidth": np.array(t["bandwidth"], dtype=float),
            }
            for band, t in raw.items()
        }
    return _tables


def wavelength_at(band: int, x: float, y: float) -> tuple[float, float]:
    """Central wavelength and bandwidth (microns) at 0-based detector pixel (x, y).

    Bilinear interpolation in the detector's 9 x 9 lookup table, which is how
    the SPHEREx files themselves define the spectral coordinate.
    """
    t = _load_tables()[band]
    fx, fy = x + 1.0, y + 1.0                        # the table uses FITS pixel numbers
    ix = int(np.clip(np.searchsorted(t["x"], fx) - 1, 0, len(t["x"]) - 2))
    iy = int(np.clip(np.searchsorted(t["y"], fy) - 1, 0, len(t["y"]) - 2))
    tx = (fx - t["x"][ix]) / (t["x"][ix + 1] - t["x"][ix])
    ty = (fy - t["y"][iy]) / (t["y"][iy + 1] - t["y"][iy])

    def interp(a: np.ndarray) -> float:
        top = (1 - tx) * a[iy, ix] + tx * a[iy, ix + 1]
        bottom = (1 - tx) * a[iy + 1, ix] + tx * a[iy + 1, ix + 1]
        return float((1 - ty) * top + ty * bottom)

    return interp(t["wavelength"]), interp(t["bandwidth"])


# --------------------------------------------------------------------------
# Aperture photometry on one pixel window
# --------------------------------------------------------------------------

def measure(plan: archive.CutPlan, pixels: np.ndarray) -> tuple[float | None, float | None] | None:
    """Flux density and uncertainty in mJy at the planned position.

    Returns None if the source is too close to the detector edge to measure,
    and (None, None) if pixels inside the aperture are saturated or blank.
    """
    ny, nx = pixels.shape
    xc, yc = plan.xt - plan.x0, plan.yt - plan.y0
    if min(xc, yc) < SKY_OUTER or xc > nx - 1 - SKY_OUTER or yc > ny - 1 - SKY_OUTER:
        return None
    yy, xx = np.mgrid[0:ny, 0:nx]
    dist = np.hypot(xx - xc, yy - yc)
    ring = (dist >= SKY_INNER) & (dist <= SKY_OUTER) & np.isfinite(pixels)
    if ring.sum() < 20:
        return None
    sky, scatter = pipeline.robust_stats(pixels[ring])
    if not np.isfinite(sky):
        return None

    # Fraction of each pixel inside the aperture, from 5 x 5 sub-samples.
    steps = (np.arange(5) + 0.5) / 5 - 0.5
    cover = np.zeros(pixels.shape)
    for dy in steps:
        for dx in steps:
            cover += np.hypot(xx + dx - xc, yy + dy - yc) <= APERTURE_RADIUS
    cover /= 25.0
    inside = cover > 0
    if not np.all(np.isfinite(pixels[inside])):
        return None, None

    to_mjy = plan.pix_area * ARCSEC2_TO_SR * 1e9          # MJy/sr summed over pixels -> mJy
    flux = float(((pixels[inside] - sky) * cover[inside]).sum() * to_mjy)
    error = float(scatter * math.sqrt(cover.sum()) * to_mjy)
    return flux, error


def measure_ring(plan: archive.CutPlan, pixels: np.ndarray) -> tuple[float, float] | None:
    """Light in a ring around a saturated star, in mJy, with its uncertainty.

    Uses the median surface brightness of the ring, which ignores blank pixels,
    bleed trails and faint neighbours. None if the window is too small or empty.
    """
    ny, nx = pixels.shape
    xc, yc = plan.xt - plan.x0, plan.yt - plan.y0
    if min(xc, yc) < RING_SKY_OUTER or xc > nx - 1 - RING_SKY_OUTER or yc > ny - 1 - RING_SKY_OUTER:
        return None
    yy, xx = np.mgrid[0:ny, 0:nx]
    dist = np.hypot(xx - xc, yy - yc)
    finite = np.isfinite(pixels)
    ring = (dist >= RING_INNER) & (dist <= RING_OUTER)
    far = (dist >= RING_SKY_INNER) & (dist <= RING_SKY_OUTER) & finite
    values = pixels[ring & finite]
    if values.size < 0.5 * ring.sum() or far.sum() < 40:
        return None
    sky, scatter = pipeline.robust_stats(pixels[far])
    if not np.isfinite(sky):
        return None
    area = float(ring.sum())
    to_mjy = plan.pix_area * ARCSEC2_TO_SR * 1e9
    flux = float((np.median(values) - sky) * area * to_mjy)
    error = float(scatter * math.sqrt(area) * to_mjy)
    return flux, error


# --------------------------------------------------------------------------
# Spectrum of a sky position
# --------------------------------------------------------------------------

def position_at(track: tuple[float, float, float, float, float], mjd: float) -> tuple[float, float]:
    """Where a moving object (ra, dec, epoch, pmra, pmdec) is at a given date."""
    ra0, dec0, epoch, pmra, pmdec = track
    dt = 2000.0 + (mjd - 51544.5) / 365.25 - epoch
    dec = dec0 + pmdec * dt / 3.6e6
    ra = ra0 + pmra * dt / 3.6e6 / max(1e-6, math.cos(math.radians(dec0)))
    return ra % 360.0, dec


def _thin(exposures: list[archive.Exposure]) -> list[archive.Exposure]:
    if len(exposures) <= MAX_EXPOSURES:
        return exposures
    step = len(exposures) / MAX_EXPOSURES
    return [exposures[int(i * step)] for i in range(MAX_EXPOSURES)]


def _read_windows(selected, headers, ra, dec, track, half, progress):
    """Plan and read the pixel window of every exposure; returns (plans, pixels)."""
    plans = []
    for exp, raw in zip(selected, headers):
        if raw is None:
            continue
        where = position_at(track, exp.mjd) if track else (ra, dec)
        plan = archive.plan_cutout(exp, raw, where[0], where[1], half)
        if plan is not None:
            plans.append(plan)
    return plans, archive.read_pixels_many(plans, progress)


def build_spectrum(ra: float, dec: float,
                   track: tuple[float, float, float, float, float] | None = None,
                   progress: archive.Progress | None = None,
                   bands: tuple[int, ...] | None = None,
                   wide: bool = False) -> dict:
    """Measure one sky position (or a moving object) in every exposure that covers it.

    ``bands`` limits the measurement to some detector arrays (default: all six).
    ``wide`` reads a larger window straight away so that the ring around a
    saturated star can be measured too; without it that happens in a second
    pass, and only if most exposures turn out to be saturated.

    Each point is [wavelength um, bandwidth um, flux mJy, error mJy, MJD,
    detector, epoch index, saturated]. Flux is None where the source is saturated.
    """
    t0 = time.time()
    exposures = archive.search(ra, dec)
    epochs = pipeline.cluster_epochs(e.mjd for e in exposures)
    fingerprint = f"{len(exposures)}:{max((e.mjd for e in exposures), default=0):.4f}"
    if bands:
        exposures = [e for e in exposures if e.band in bands]
    tag = f"{ra:.5f}|{dec:.5f}|{track}|{bands}|{wide}|{fingerprint}|v{SPECTRUM_VERSION}"
    key = hashlib.sha1(tag.encode()).hexdigest()[:20]
    path = config.CACHE_DIR / "spectra" / f"{key}.json"

    with _lock:                                   # one spectrum at a time keeps the downloads orderly
        if path.exists():
            try:
                result = json.loads(path.read_text(encoding="utf-8"))
                result["cached"] = True
                return result
            except (OSError, ValueError):             # removed meanwhile or cut short: measure again
                pass

        selected = _thin(exposures)
        headers = archive.load_headers(selected, progress)
        plans, pixels = _read_windows(selected, headers, ra, dec, track,
                                      WINDOW_HALF_WIDE if wide else WINDOW_HALF, progress)

        rows, saturated = [], 0
        for plan, pix in zip(plans, pixels):
            if pix is None:
                continue
            measured = measure(plan, pix)
            if measured is None:
                continue
            flux, error = measured
            wave, width = wavelength_at(plan.exp.band, plan.xt, plan.yt)
            if flux is None:
                saturated += 1
            rows.append((plan.exp.uid, [
                round(wave, 4), round(width, 4),
                None if flux is None else round(flux, 4),
                None if error is None else round(error, 4),
                round(plan.mjd, 4), plan.exp.band, pipeline.epoch_index(epochs, plan.mjd),
                1 if flux is None else 0,
            ]))

        # Mostly saturated: measure the ring of light around the star as well.
        mostly_saturated = len(rows) >= 6 and saturated > 0.5 * len(rows)
        ring: dict[str, tuple[float, float]] = {}
        if wide or mostly_saturated:
            if not wide:
                plans, pixels = _read_windows(selected, headers, ra, dec, track, WINDOW_HALF_WIDE, progress)
            for plan, pix in zip(plans, pixels):
                if pix is None:
                    continue
                got = measure_ring(plan, pix)
                if got is not None:
                    ring[plan.exp.uid] = (round(got[0], 3), round(got[1], 3))

        rows.sort(key=lambda r: r[1][0])
        points = [r[1] for r in rows]
        halo = [list(ring[r[0]]) if r[0] in ring else None for r in rows] if ring else None

        used = sorted({p[6] for p in points})
        result = {
            "ra": ra, "dec": dec, "moving": track is not None,
            "aperture_arcsec": round(APERTURE_RADIUS * config.NATIVE_SCALE, 1),
            "n_found": len(exposures), "n_read": len(plans),
            "n_points": len(points) - saturated, "n_saturated": saturated,
            "mostly_saturated": mostly_saturated,
            "ring_arcsec": [round(RING_INNER * config.NATIVE_SCALE), round(RING_OUTER * config.NATIVE_SCALE)],
            "thinned": len(selected) < len(exposures),
            "epochs": [
                {"index": i, "date": pipeline.mjd_to_iso(0.5 * (epochs[i][0] + epochs[i][1])),
                 "mjd": 0.5 * (epochs[i][0] + epochs[i][1])}
                for i in used
            ],
            "points": points,
            "ring": halo,     # per point [light in the ring around the star in mJy, its error], or None
            "seconds": round(time.time() - t0, 1),
            "cached": False,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{key}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(pipeline._clean(result)), encoding="utf-8")
        tmp.replace(path)
        return result
