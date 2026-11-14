"""Quick checks of the server's own logic. No network, no stored data, a few seconds.

    python scripts/check_logic.py

Covers what the other check scripts cannot see from outside: how exposures
are grouped into visits and thinned, the download budget of a request, the
footprint test used when the archive's search is down, and the cache keeper.
(check_fields.py tests a running server against the real archive.)
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import archive, config, housekeeping, pipeline, spectra  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("ok    " if ok else "FAIL  ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


class Exposure:
    def __init__(self, mjd: float, band: int = 2):
        self.mjd, self.band = mjd, band


# ---------------------------------------------------------------- visits
visits = pipeline.cluster_epochs([1, 2, 3, 30, 31, 200])
check("a gap of more than 15 days starts a new visit", len(visits) == 3 and visits[0] == (1.0, 3.0), str(visits))
long_visit = pipeline.cluster_epochs(range(0, 100))
check("a visit longer than 45 days is split", len(long_visit) > 1 and long_visit[0][0] == 0 and long_visit[-1][1] == 99, str(long_visit))
check("every date belongs to exactly one visit", [pipeline.epoch_index(visits, m) for m in (2, 30.5, 200)] == [0, 1, 2])

# ---------------------------------------------------------------- thinning and the download budget
epochs = [(i * 100.0, i * 100.0 + 20) for i in range(18)]
deep = [Exposure(i * 100.0 + k * 20 / 299) for i in range(18) for k in range(300)]
normal = [Exposure(i * 100.0 + k) for i in range(3) for k in range(20)]

kept = pipeline.thin_per_epoch(deep, epochs, 40)
first = sorted(e.mjd for e in kept if e.mjd < 50)
check("at most the asked number per visit", len(kept) == 18 * 40)
check("the ones kept span the whole visit", first[0] == 0 and abs(first[-1] - 20) < 1e-9)
check("the choice is the same every time", [e.mjd for e in kept] == [e.mjd for e in pipeline.thin_per_epoch(deep, epochs, 40)])
check("0 means all of them", len(pipeline.thin_per_epoch(deep, epochs, 0)) == len(deep))
check("limits are kept sensible", [pipeline.clamp_per_epoch(v) for v in (-5, 0, 1, 40, 10 ** 9)] == [0, 0, 2, 40, pipeline.MAX_PER_EPOCH])

selected, found, used = pipeline.select_exposures(normal, epochs, 2, 180, 40)
check("an ordinary field is read whole", len(selected) == len(found) == 60 and used == 40)
for label, fov, limit, share in (("3' field, all exposures", 180, 0, 1.0), ("30' field", 1800, 40, 1.0), ("30' field, six detectors", 1800, 40, 1 / 6)):
    selected, found, used = pipeline.select_exposures(deep, epochs, 2, fov, limit, share)
    megabytes = len(selected) * (2 * pipeline.cutout_half_size(fov) + 1) * config.DETECTOR_SIZE * 4 / 1e6
    least = 2 * 18 * (2 * pipeline.cutout_half_size(fov) + 1) * config.DETECTOR_SIZE * 4 / 1e6   # two per visit
    check(f"a deep field stays within the download budget: {label}",
          megabytes <= max(pipeline.REQUEST_BUDGET_MB * share, least) and len(selected) < len(found), f"{megabytes:.0f} MB")

# ---------------------------------------------------------------- geometry
square = [10.0, 10.0, 13.5, 10.0, 13.5, 13.5, 10.0, 13.5]             # a 3.5 degree footprint
check("a point inside a footprint is found", archive.footprint_contains(square, 11.7, 11.7))
check("a point outside is not", not archive.footprint_contains(square, 14.0, 11.7) and not archive.footprint_contains(square, 11.7, 9.5))
check("nor is the opposite side of the sky", not archive.footprint_contains(square, 191.7, -11.7))
polar = [0.0, 88.5, 90.0, 88.5, 180.0, 88.5, 270.0, 88.5]              # a footprint over the north pole
check("footprints over a pole work", archive.footprint_contains(polar, 45.0, 89.8) and not archive.footprint_contains(polar, 45.0, 85.0))
check("a footprint without corners matches nothing", not archive.footprint_contains(None, 11.7, 11.7))

grid = pipeline.make_grid(120.0, -30.0, 180)
check("the grid has an odd number of pixels, target in the middle", grid.n % 2 == 1 and abs(grid.scale - 3.075) < 1e-6)
wave, width = spectra.wavelength_at(2, 1020.0, 1020.0)
check("the middle of detector 2 lies in its wavelength range", 1.10 < wave < 1.63 and width > 0, f"{wave:.3f}")
ra, dec = spectra.position_at((100.0, 20.0, 2016.0, 3600.0, -3600.0), 51544.5 + 365.25 * 26)   # ten years at 3.6 arcsec/yr
check("a moving object is where its proper motion puts it", abs(dec - (20.0 - 0.01)) < 1e-9 and abs(ra - (100.0 + 0.01 / 0.9396926)) < 1e-6)

# ---------------------------------------------------------------- the cache keeper
real = config.CACHE_DIR
with tempfile.TemporaryDirectory() as tmp:
    config.CACHE_DIR = Path(tmp)
    now = time.time()
    for folder, count in (("pix", 30), ("frames", 10), ("sia", 5)):
        (config.CACHE_DIR / folder).mkdir()
        for i in range(count):
            path = config.CACHE_DIR / folder / f"{i:03d}.bin"
            path.write_bytes(b"x" * 100_000)                          # 0.1 MB each, 4.5 MB in all
            os.utime(path, (now - 1000 + i, now - 1000 + i))          # a higher number is newer
    report = housekeeping.trim(limit_mb=100)
    check("under its limit the cache is left alone", report["removed"] == 0 and report["files"] == 45, str(report))
    report = housekeeping.trim(limit_mb=3)
    left = {f: sorted(p.name for p in (config.CACHE_DIR / f).iterdir()) for f in ("pix", "frames", "sia")}
    check("over its limit it shrinks to four fifths", report["removed"] == 21 and abs(report["mb"] - 2.4) < 0.01, str(report))
    check("the oldest files go first, the image lists stay", left["pix"][0] == "011.bin" and not left["frames"] and len(left["sia"]) == 5, str(left))
    housekeeping.trim(limit_mb=0.3)
    left = {f: sorted(p.name for p in (config.CACHE_DIR / f).iterdir()) for f in ("pix", "frames", "sia")}
    check("the image lists go last", not left["pix"] and left["sia"] == ["003.bin", "004.bin"], str(left))
    check("a limit of 0 switches the clean-up off", housekeeping.trim(limit_mb=0)["removed"] == 0)
config.CACHE_DIR = real

print()
print(f"{len(failures)} failure(s)" if failures else "All checks passed.")
sys.exit(1 if failures else 0)
