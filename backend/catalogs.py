"""Catalogue overlays: Gaia DR3 stars around a field.

Gaia measured the position, proper motion and parallax of nearly two billion
stars. Drawing them over the blink frames shows at a glance which sources are
already known, and which of them are expected to move.
"""
from __future__ import annotations

import csv
import io
import json

import requests

from . import config

GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
GAIA_EPOCH = 2016.0          # reference epoch of Gaia DR3 positions
GAIA_LIMIT = 600             # brightest stars kept per field
# Gaia positions are for 2016. A star moving 15"/yr is 150" away from there ten
# years later, so search that much beyond the field to catch fast movers.
PM_MARGIN_ARCSEC = 150.0

_COLUMNS = ("ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag", "bp_rp")
_DIGITS = (7, 7, 3, 3, 3, 3, 3)


def gaia_cone(ra: float, dec: float, radius_deg: float) -> dict:
    """Gaia DR3 stars within ``radius_deg`` of (ra, dec), brightest first.

    Each source is [source_id, ra, dec, pmra, pmdec, parallax, G, BP-RP] with
    positions in degrees at epoch 2016.0, proper motions in mas/yr (pmra
    includes cos(dec)), parallax in mas. Missing values are None.
    """
    cache = config.CACHE_DIR / "gaia" / f"{ra:.5f}_{dec:+.5f}_{radius_deg:.4f}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))

    query = (
        f"SELECT TOP {GAIA_LIMIT} source_id, {', '.join(_COLUMNS)} FROM gaiadr3.gaia_source "
        f"WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {radius_deg:.5f})) "
        "ORDER BY phot_g_mean_mag"
    )
    r = requests.get(
        GAIA_TAP,
        params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
        timeout=(8, 60),
    )
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    if not reader.fieldnames or "source_id" not in reader.fieldnames:
        raise RuntimeError(f"unexpected Gaia response: {r.text[:200]!r}")

    sources = []
    for row in reader:
        values = []
        for name, digits in zip(_COLUMNS, _DIGITS):
            text = row.get(name)
            values.append(round(float(text), digits) if text not in (None, "") else None)
        if values[0] is None or values[1] is None:
            continue
        sources.append([row["source_id"]] + values)

    out = {"epoch": GAIA_EPOCH, "sources": sources, "truncated": len(sources) >= GAIA_LIMIT}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out), encoding="utf-8")
    return out
