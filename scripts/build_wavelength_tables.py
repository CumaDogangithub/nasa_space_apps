"""Extract the wavelength lookup table of each SPHEREx detector array.

Every spectral image carries a small ``WCS-WAVE`` table: the wavelength and
bandwidth seen at a 9x9 grid of control points across the detector. The linear
variable filter is fixed to the detector, so the table is the same for every
exposure of a detector. The viewer interpolates in these tables to know at
which wavelength a source was observed in each exposure.

Run from the project root (only needed again if the calibration changes):

    python scripts/build_wavelength_tables.py
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

import numpy as np
from astropy.io import fits

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import archive, config, remote  # noqa: E402

OUT = config.ROOT / "backend" / "data" / "wavelength_tables.json"
# Any well-covered position will do: it only selects which files to read.
RA, DEC = 269.44627, 4.76820


def read_table(exp: archive.Exposure) -> dict:
    with fits.open(remote.open_remote(exp.s3_url), lazy_load_hdus=True, memmap=False) as hdul:
        row = hdul["WCS-WAVE"].data[0]
        values = np.asarray(row["VALUES"], dtype=float)        # [y index, x index, (wavelength, bandwidth)]
        history = "\n".join(str(v) for v in hdul["IMAGE"].header.get("HISTORY", []))
        calibration = re.search(r"spectral_wcs\s+(\S+)", history)
        return {
            "x": [float(v) for v in row["X"]],                 # FITS pixel coordinates (first pixel = 1)
            "y": [float(v) for v in row["Y"]],
            "wavelength": np.round(values[:, :, 0], 5).tolist(),   # microns
            "bandwidth": np.round(values[:, :, 1], 5).tolist(),
            "file": exp.key,
            "calibration": calibration.group(1) if calibration else None,
        }


def main() -> None:
    exposures = archive.search(RA, DEC)
    detectors = {}
    for band in sorted(config.BANDS):
        mine = [e for e in exposures if e.band == band]
        first, last = read_table(mine[0]), read_table(mine[-1])
        drift = float(np.max(np.abs(np.array(first["wavelength"]) - np.array(last["wavelength"]))))
        w = np.array(first["wavelength"])
        print(f"D{band}: {w.min():.3f}-{w.max():.3f} um, calibration {first['calibration']}, "
              f"difference between first and last exposure {drift:.5f} um")
        detectors[str(band)] = first
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"created": date.today().isoformat(), "detectors": detectors}, indent=1), encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
