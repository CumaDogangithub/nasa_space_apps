"""Check that blink frames sit at the right place on the sky.

For a few fields, take Gaia DR3 stars, predict where each should fall in the
blink frame from the frame's own geometry, and measure where the star really
is. Run from the project root:

    python scripts/check_astrometry.py
"""
from __future__ import annotations

import csv
import io
import math
import sys
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import pipeline  # noqa: E402

GAIA = "https://gea.esac.esa.int/tap-server/tap/sync"


def gaia_stars(ra: float, dec: float, radius_deg: float, gmax: float) -> list[dict]:
    query = (
        "SELECT ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaiadr3.gaia_source "
        f"WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{radius_deg})) "
        f"AND phot_g_mean_mag < {gmax} ORDER BY phot_g_mean_mag"
    )
    r = requests.get(GAIA, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}, timeout=60)
    r.raise_for_status()
    return list(csv.DictReader(io.StringIO(r.text)))


def check(name: str, ra: float, dec: float, fov: float, band: int, gmax: float) -> None:
    res = pipeline.build(ra, dec, fov, [band])
    grid = pipeline.make_grid(ra, dec, fov)
    n, scale = res["n"], res["scale"]
    frame = res["frames"][0]                     # row 0 = north
    year = 2000 + (res["epochs"][0]["mjd"] - 51544.5) / 365.25
    noise = res["stats"]["noise"]
    sky = float(np.median(frame[np.isfinite(frame)]))
    east, north = [], []
    for s in gaia_stars(ra, dec, fov / 3600 / 2 * 0.85, gmax):
        d = float(s["dec"]) + float(s["pmdec"] or 0) * (year - 2016.0) / 3.6e6
        a = float(s["ra"]) + float(s["pmra"] or 0) * (year - 2016.0) / 3.6e6 / math.cos(math.radians(d))
        x, y = grid.wcs.all_world2pix(a, d, 0)
        col, row = float(x), n - 1 - float(y)    # predicted position in the displayed frame
        c0, r0 = int(round(col)), int(round(row))
        if not (4 <= c0 < n - 4 and 4 <= r0 < n - 4):
            continue
        box = frame[r0 - 3:r0 + 4, c0 - 3:c0 + 4].astype(float)
        if not np.all(np.isfinite(box)) or box.max() < 15 * noise:
            continue                              # saturated, blank or too faint to centre on
        w = np.clip(box - sky, 0, None)
        yy, xx = np.mgrid[-3:4, -3:4]
        cx = c0 + (w * xx).sum() / w.sum()
        cy = r0 + (w * yy).sum() / w.sum()
        # east is left and north is up: +column is west, +row is south
        east.append((col - cx) * scale)
        north.append((row - cy) * scale)
    print(f"{name}: detector D{band}, {fov:.0f} arcsec field, epoch {res['epochs'][0]['date']}, "
          f"{len(east)} Gaia stars measured")
    if not east:
        return
    de, dn = np.array(east), np.array(north)
    sep = np.hypot(de, dn)
    print(f"  measured minus predicted: {de.mean():+.2f} arcsec east, {dn.mean():+.2f} arcsec north on average")
    print(f"  median distance {np.median(sep):.2f} arcsec, worst {sep.max():.2f} arcsec "
          f"(frame pixel {scale:.2f} arcsec, SPHEREx pixel 6.15 arcsec)")


if __name__ == "__main__":
    check("RW Aurigae field", 76.95600, 30.40114, 360, 2, 15.0)
    check("Proxima Centauri field", 217.36943, -62.67393, 360, 2, 13.5)
    check("WISE 0855 field", 133.795129, -7.245147, 360, 2, 16.0)
