"""SPHEREx quality flags behind the blink frames, and the list of exposures.

Each blink frame is a stack of exposures. For every pixel of a frame this
module works out in what share of those exposures SPHEREx itself raised a
flag (cosmic ray, saturation, leftover charge, ghost of a bright star, ...)
and which flags they were. It also lists the exposures one by one, with the
wavelength each saw at the field centre and the flags it carries there.
"""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime, timedelta

import numpy as np
from scipy import ndimage

from . import archive, config, pipeline, spectra

FLAGS_VERSION = 1
INFO_FLAGS = ("SOURCE", "FULLSAMPLE")   # informative only: not a sign of trouble
COMMON_SHARE = 0.25                      # a flag is reported for a frame pixel if this share of its exposures has it
TARGET_RADIUS = 2.0                      # native pixels around the field centre checked in each exposure

_MJD0 = datetime(1858, 11, 17)
_lock = threading.Lock()


def _nearest(plan: archive.CutPlan, window: np.ndarray, grid: pipeline.Grid) -> tuple[np.ndarray, np.ndarray]:
    """Nearest-neighbour copy of a flag window onto the output grid (flags cannot be averaged).

    Returns the flags and a mask of the output pixels the window covers.
    """
    px_l, py_l = plan.wcs.all_world2pix(grid.lat_ra, grid.lat_dec, 0, quiet=True)
    px = ndimage.map_coordinates(px_l, [grid.up_y, grid.up_x], order=1, mode="nearest")
    py = ndimage.map_coordinates(py_l, [grid.up_y, grid.up_x], order=1, mode="nearest")
    ix = np.rint(px - plan.x0).astype(np.int64)
    iy = np.rint(py - plan.y0).astype(np.int64)
    ny, nx = window.shape
    covered = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
    out = np.zeros(ix.shape, dtype=np.int32)
    out[covered] = window[iy[covered], ix[covered]]
    return out, covered


def _flags_at_centre(plan: archive.CutPlan, window: np.ndarray) -> int:
    """All flags raised within TARGET_RADIUS pixels of the field centre in one exposure."""
    ny, nx = window.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    near = np.hypot(xx - (plan.xt - plan.x0), yy - (plan.yt - plan.y0)) <= TARGET_RADIUS
    return int(np.bitwise_or.reduce(window[near])) if near.any() else 0


def build_flags(ra: float, dec: float, fov: float, bands: list[int],
                progress: archive.Progress | None = None) -> dict:
    """Flag maps for the blink frames of (ra, dec, fov, bands), plus one row per exposure.

    ``fraction`` is uint8 [frame, row, col]: the share (0-255) of a pixel's
    exposures with a trouble flag. ``common`` is int32 [frame, row, col]: the
    flags set in at least a quarter of them. Frames are keyed by epoch index,
    rows run north to south like the blink frames.
    """
    exposures = archive.search(ra, dec)
    epochs = pipeline.cluster_epochs(e.mjd for e in exposures)
    selected = [e for e in exposures if e.band in bands]
    fingerprint = f"{len(exposures)}:{len(selected)}:{max((e.mjd for e in exposures), default=0):.4f}"
    tag = f"{ra:.5f}|{dec:.5f}|{pipeline.clamp_fov(fov):.1f}|{sorted(bands)}|{fingerprint}|v{FLAGS_VERSION}"
    key = hashlib.sha1(tag.encode()).hexdigest()[:20]
    path = config.CACHE_DIR / "flags" / f"{key}.npz"

    with _lock:
        if path.exists():
            with np.load(path, allow_pickle=False) as z:
                result = json.loads(str(z["meta"]))
                result["fraction"] = z["fraction"]
                result["common"] = z["common"]
            result["cached"] = True
            return result

        grid = pipeline.make_grid(ra, dec, fov)
        half = pipeline.cutout_half_size(grid.fov)
        headers = archive.load_headers(selected, progress)
        plans = []
        for exp, raw in zip(selected, headers):
            if raw is None:
                continue
            plan = archive.plan_cutout(exp, raw, ra, dec, half)
            if plan is not None:
                plans.append(plan)
        windows = archive.read_flags_many(plans, progress)

        names = dict(archive.flag_names)
        bits = sorted(names)
        trouble = sum(1 << b for b in bits if names[b][0] not in INFO_FLAGS)
        n = grid.n
        tally: dict[int, dict] = {}
        rows = []
        for plan, window in zip(plans, windows):
            if window is None:
                continue
            ep = pipeline.epoch_index(epochs, plan.mjd)
            flags, covered = _nearest(plan, window, grid)
            t = tally.setdefault(ep, {
                "n": 0,
                "cover": np.zeros((n, n), np.uint16),
                "any": np.zeros((n, n), np.uint16),
                "bits": np.zeros((len(bits), n, n), np.uint16),
            })
            t["n"] += 1
            t["cover"] += covered.astype(np.uint16)
            t["any"] += ((flags & trouble) != 0).astype(np.uint16)
            for k, b in enumerate(bits):
                t["bits"][k] += ((flags >> b) & 1).astype(np.uint16)
            wave, width = spectra.wavelength_at(plan.exp.band, plan.xt, plan.yt)
            rows.append({
                "uid": plan.exp.uid, "band": plan.exp.band, "epoch": ep,
                "mjd": round(plan.mjd, 5),
                "time": (_MJD0 + timedelta(days=plan.mjd)).strftime("%Y-%m-%d %H:%M"),
                "wavelength": round(wave, 4), "bandwidth": round(width, 4),
                "flags": _flags_at_centre(plan, window),
                "collection": plan.exp.collection,
                "url": plan.exp.irsa_url,
            })

        fraction, common, meta = [], [], []
        for ep in sorted(tally):
            t = tally[ep]
            if t["n"] < pipeline.MIN_EXPOSURES_PER_FRAME:
                continue
            seen = t["cover"] > 0
            share = np.zeros((n, n), np.float32)
            share[seen] = t["any"][seen] / t["cover"][seen]
            need = np.maximum(1, np.ceil(COMMON_SHARE * t["cover"]))
            mask = np.zeros((n, n), np.int32)
            for k, b in enumerate(bits):
                mask |= np.where(seen & (t["bits"][k] >= need), 1 << b, 0).astype(np.int32)
            fraction.append(np.rint(255 * share).astype(np.uint8)[::-1])      # row 0 = north
            common.append(mask[::-1])
            meta.append({"epoch": ep, "n_exposures": t["n"]})

        rows.sort(key=lambda r: r["mjd"])
        result = {
            "ra": ra, "dec": dec, "fov": grid.fov, "bands": sorted(bands), "n": n,
            "epochs": meta,
            "names": {str(b): list(names[b]) for b in bits},
            "info_bits": [b for b in bits if names[b][0] in INFO_FLAGS],
            "common_share": COMMON_SHARE,
            "exposures": rows,
            "cached": False,
        }
        fraction_cube = np.stack(fraction) if fraction else np.zeros((0, n, n), np.uint8)
        common_cube = np.stack(common) if common else np.zeros((0, n, n), np.int32)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{key}.{threading.get_ident()}.tmp.npz")
        np.savez(tmp, fraction=fraction_cube, common=common_cube, meta=np.array(json.dumps(pipeline._clean(result))))
        tmp.replace(path)
        result["fraction"] = fraction_cube
        result["common"] = common_cube
        return result
