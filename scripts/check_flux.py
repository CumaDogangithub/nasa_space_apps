"""Check the brightness scale of the quick-look spectra against 2MASS.

Takes ordinary stars near a position, measures them with the same routine the
viewer uses, and compares the result in the J, H and Ks wavelength ranges with
the brightness the 2MASS survey catalogued. Run from the project root:

    python scripts/check_flux.py                      # stars near RW Aurigae
    python scripts/check_flux.py 133.7597 -7.2422     # stars near another position
"""
from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import spectra  # noqa: E402

GAIA_ARCHIVE = "https://gea.esac.esa.int/tap-server/tap/sync"   # also hosts the 2MASS catalogue
# band: (shortest wavelength, longest wavelength in microns, flux of a zero-magnitude star in Jy)
BANDS = {"J": (1.17, 1.33, 1594.0), "H": (1.51, 1.63, 1024.0), "Ks": (2.03, 2.28, 666.7)}
COLUMNS = {"J": "j_m", "H": "h_m", "Ks": "ks_m"}


def twomass_stars(ra: float, dec: float, radius_deg: float) -> list[dict]:
    """Well-measured 2MASS stars that are bright enough to measure but not saturated in SPHEREx."""
    query = (
        "SELECT TOP 8 ra, dec, j_m, h_m, ks_m FROM gaiadr1.tmass_original_valid "
        f"WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg})) "
        "AND j_m BETWEEN 9.5 AND 13.0 AND ph_qual LIKE 'AAA' ORDER BY j_m"
    )
    r = requests.get(GAIA_ARCHIVE, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
                     timeout=90)
    r.raise_for_status()
    return list(csv.DictReader(io.StringIO(r.text)))


def main() -> None:
    ra0, dec0 = (float(sys.argv[1]), float(sys.argv[2])) if len(sys.argv) >= 3 else (76.956, 30.4011)
    stars = twomass_stars(ra0, dec0, 0.07)[:5]
    print(f"{len(stars)} 2MASS stars near {ra0:.4f} {dec0:+.4f}")
    ratios: dict[str, list[float]] = {name: [] for name in BANDS}
    for star in stars:
        ra, dec = float(star["ra"]), float(star["dec"])
        result = spectra.build_spectrum(ra, dec, bands=(2, 3))     # the detectors that cover J, H and Ks
        points = [p for p in result["points"] if p[2] is not None]
        parts = []
        for name, (lo, hi, zero_point) in BANDS.items():
            flux = [p[2] for p in points if lo <= p[0] <= hi]
            if len(flux) < 3:
                continue
            expected = zero_point * 10 ** (-0.4 * float(star[COLUMNS[name]])) * 1000.0     # mJy
            ratio = float(np.median(flux)) / expected
            ratios[name].append(ratio)
            parts.append(f"{name} {np.median(flux):7.1f} vs {expected:7.1f} mJy (x{ratio:.2f})")
        print(f"  star {ra:.4f} {dec:+.4f}: " + "; ".join(parts))
    for name, values in ratios.items():
        if values:
            print(f"{name}: SPHEREx / 2MASS = {np.median(values):.2f} (median of {len(values)} stars, "
                  f"range {min(values):.2f}-{max(values):.2f})")


if __name__ == "__main__":
    main()
