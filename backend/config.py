"""Central configuration.

A new SPHEREx data release only needs its collection name added to
``releases.json``; nothing else in the code depends on a specific release.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "cache"
WEB_DIR = ROOT / "web"

_RELEASES = json.loads(Path(__file__).with_name("releases.json").read_text(encoding="utf-8"))
SIA_URL: str = _RELEASES["sia_url"]
IRSA_PREFIX: str = _RELEASES["irsa_prefix"]
S3_PREFIX: str = _RELEASES["s3_prefix"]
COLLECTIONS: list[str] = list(_RELEASES["collections"])

DETECTOR_SIZE = 2040      # pixels per side
NATIVE_SCALE = 6.15       # arcsec per pixel

# Wavelength range of each detector array, in microns.
BANDS: dict[int, tuple[float, float]] = {
    1: (0.75, 1.10),
    2: (1.10, 1.63),
    3: (1.63, 2.42),
    4: (2.42, 3.82),
    5: (3.82, 4.42),
    6: (4.42, 5.00),
}

SIA_CACHE_HOURS = 6       # how long a position search is reused
DOWNLOAD_THREADS = 32
