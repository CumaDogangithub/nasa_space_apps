"""Find SPHEREx spectral images and read small pixel windows from them.

Two public services are used:

* IRSA's SIA2 service tells us which Level-2 spectral images cover a position.
* The same files are mirrored in a public AWS S3 bucket. They are plain,
  uncompressed FITS, so the pixels around a target can be read with HTTP
  range requests instead of downloading the 60+ MB file.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS
from requests.adapters import HTTPAdapter

from . import config

Progress = Callable[[str, int, int], None]

FITS_BLOCK = 2880
HEADER_GUESS = 12 * FITS_BLOCK
_NPIX = config.DETECTOR_SIZE

_session = requests.Session()
_session.mount("https://", HTTPAdapter(pool_connections=8, pool_maxsize=config.DOWNLOAD_THREADS * 2))
_session.headers["User-Agent"] = "spherex-blink-tree"

_stats_lock = threading.Lock()
stats = {"requests": 0, "bytes": 0}

# The IMAGE header has ~300 cards, including two alternate WCS descriptions
# ("A": raw pixels, "W": wavelength lookup table that needs another extension).
# Only the celestial WCS and a few facts are needed, so parse just those cards.
_KEEP_CARD = re.compile(
    r"^(NAXIS\d?|WCSAXES|CRPIX\d|CRVAL\d|CDELT\d|CUNIT\d|CTYPE\d|PC\d_\d|CD\d_\d|LONPOLE|LATPOLE|RADESYS|EQUINOX"
    r"|[AB]P?_ORDER|[AB]P?_\d_\d|MJD-AVG|PSF_FWHM|XPOSURE|DETECTOR)$"
)


@dataclass
class Exposure:
    """One SPHEREx spectral image (one detector of one exposure)."""

    obs_id: str
    band: int          # detector array, 1-6
    mjd: float         # mid-exposure time
    exptime: float
    collection: str
    key: str           # path below the release root; identical on IRSA and S3
    poly: list[float] | None = None   # footprint on the sky: ra1, dec1, ... ra4, dec4 (degrees)

    @property
    def s3_url(self) -> str:
        return config.S3_PREFIX + self.key

    @property
    def irsa_url(self) -> str:
        return config.IRSA_PREFIX + self.key

    @property
    def uid(self) -> str:
        return f"{self.obs_id}_D{self.band}"


@dataclass
class CutPlan:
    """Where a target falls on one image and which pixel window to read."""

    exp: Exposure
    wcs: WCS
    data_offset: int   # byte offset of the first IMAGE pixel
    xt: float          # target position on the detector (0-based pixels)
    yt: float
    x0: int
    x1: int
    y0: int
    y1: int
    mjd: float
    psf_fwhm: float    # arcsec
    pix_area: float    # arcsec^2

    @property
    def shape(self) -> tuple[int, int]:
        return (self.y1 - self.y0, self.x1 - self.x0)


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------

def get_range(url: str, start: int, end: int, tries: int = 4) -> bytes:
    """Fetch bytes ``start..end`` (inclusive) of ``url``."""
    last: Exception | None = None
    for attempt in range(tries):
        try:
            r = _session.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=(10, 90))
            if r.status_code == 206 or (r.status_code == 200 and len(r.content) == end - start + 1):
                with _stats_lock:
                    stats["requests"] += 1
                    stats["bytes"] += len(r.content)
                return r.content
            last = RuntimeError(f"HTTP {r.status_code} for {url}")
        except requests.RequestException as exc:  # network hiccup: retry
            last = exc
        time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"range request failed: {last}")


def _run_parallel(func, items: list, label: str, progress: Progress | None) -> list:
    """Run ``func`` over ``items`` in threads, keeping order. Failures become None."""
    results: list = [None] * len(items)
    if not items:
        return results
    done = 0
    with ThreadPoolExecutor(max_workers=config.DOWNLOAD_THREADS) as pool:
        futures = {pool.submit(func, item): i for i, item in enumerate(items)}
        for fut in as_completed(futures):
            i = futures[fut]
            try:
                results[i] = fut.result()
            except Exception:  # one bad file must not sink the whole query
                results[i] = None
            done += 1
            if progress:
                progress(label, done, len(items))
    return results


# --------------------------------------------------------------------------
# Image search (SIA2)
# --------------------------------------------------------------------------

def _parse_region(text: str | None) -> list[float] | None:
    """Corners of an 's_region' polygon such as 'POLYGON ICRS ra1 dec1 ra2 dec2 ...'."""
    values = re.findall(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", text or "")
    if len(values) < 8:
        return None
    return [round(float(v), 4) for v in values[:8]]


def _sia_query(collection: str, ra: float, dec: float) -> list[Exposure]:
    params = {
        "COLLECTION": collection,
        "POS": f"circle {ra:.6f} {dec:.6f} 0.0003",
        "RESPONSEFORMAT": "CSV",
    }
    r = _session.get(config.SIA_URL, params=params, timeout=(10, 120))
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    if not reader.fieldnames or "access_url" not in reader.fieldnames:
        raise RuntimeError(f"unexpected SIA response for {collection}: {r.text[:200]!r}")
    out = []
    for row in reader:
        url = row.get("access_url") or ""
        if not url.startswith(config.IRSA_PREFIX) or not url.endswith(".fits"):
            continue
        try:
            band = int(row["energy_bandpassname"].rsplit("D", 1)[-1])
            t_min, t_max = float(row["t_min"]), float(row["t_max"])
        except (KeyError, ValueError):
            continue
        out.append(
            Exposure(
                obs_id=row.get("obs_id", ""),
                band=band,
                mjd=0.5 * (t_min + t_max),
                exptime=float(row.get("t_exptime") or 0.0),
                collection=row.get("obs_collection") or collection,
                key=url[len(config.IRSA_PREFIX):],
                poly=_parse_region(row.get("s_region")),
            )
        )
    return out


def search(ra: float, dec: float, use_cache: bool = True) -> list[Exposure]:
    """All spectral images whose footprint contains (ra, dec), oldest first."""
    cache = config.CACHE_DIR / "sia" / f"{ra:.5f}_{dec:+.5f}_v2.json"
    if use_cache and cache.exists() and time.time() - cache.stat().st_mtime < config.SIA_CACHE_HOURS * 3600:
        return [Exposure(**d) for d in json.loads(cache.read_text(encoding="utf-8"))]

    found: dict[str, Exposure] = {}
    errors = []
    with ThreadPoolExecutor(max_workers=len(config.COLLECTIONS)) as pool:
        futures = {pool.submit(_sia_query, c, ra, dec): c for c in config.COLLECTIONS}
        for fut in as_completed(futures):
            try:
                for exp in fut.result():
                    found.setdefault(exp.uid, exp)
            except Exception as exc:
                errors.append(f"{futures[fut]}: {exc}")
    if errors and not found:
        raise RuntimeError("image search failed: " + "; ".join(errors))

    exposures = sorted(found.values(), key=lambda e: (e.mjd, e.band))
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps([asdict(e) for e in exposures]), encoding="utf-8")
    return exposures


# --------------------------------------------------------------------------
# FITS headers
# --------------------------------------------------------------------------

def _pad(n: int) -> int:
    return -(-n // FITS_BLOCK) * FITS_BLOCK


def _find_end(buf: bytes, start: int) -> int:
    """Offset of the END card of the header beginning at ``start``, or -1."""
    pos = start
    while pos + 80 <= len(buf):
        if buf[pos:pos + 8] == b"END     ":
            return pos
        pos += 80
    return -1


def _split_headers(buf: bytes) -> tuple[int, int, int] | None:
    """(image_header_start, image_header_end_card, data_offset) or None if incomplete."""
    e0 = _find_end(buf, 0)
    if e0 < 0:
        return None
    start1 = _pad(e0 + 80)
    e1 = _find_end(buf, start1)
    if e1 < 0:
        return None
    return start1, e1, _pad(e1 + 80)


def _header_path(exp: Exposure) -> Path:
    digest = hashlib.sha1(exp.key.encode()).hexdigest()[:16]
    return config.CACHE_DIR / "hdr" / f"{digest}.bin"


def load_header_bytes(exp: Exposure) -> bytes:
    """Primary + IMAGE header bytes of one file (cached on disk)."""
    path = _header_path(exp)
    if path.exists():
        return path.read_bytes()
    size = HEADER_GUESS
    buf = get_range(exp.s3_url, 0, size - 1)
    while _split_headers(buf) is None:
        if size > 40 * FITS_BLOCK:
            raise RuntimeError(f"no IMAGE header found in {exp.key}")
        buf += get_range(exp.s3_url, size, size + HEADER_GUESS - 1)
        size += HEADER_GUESS
    buf = buf[: _split_headers(buf)[2]]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
    tmp.write_bytes(buf)
    tmp.replace(path)
    return buf


def parse_image_header(buf: bytes) -> tuple[fits.Header, int]:
    """IMAGE extension header and the byte offset of its pixel data."""
    start1, e1, data_offset = _split_headers(buf)
    cards = []
    for pos in range(start1, e1, 80):
        card = buf[pos:pos + 80]
        key = card[:8].rstrip().decode("ascii", "replace")
        if _KEEP_CARD.match(key) or card.startswith(b"HIERARCH OMEGA_MEDIAN"):
            cards.append(card)
    text = b"".join(cards).decode("ascii", "replace")
    return fits.Header.fromstring(text), data_offset


def celestial_wcs(header: fits.Header) -> WCS:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return WCS(header)


def load_headers(exposures: list[Exposure], progress: Progress | None = None) -> list[bytes | None]:
    return _run_parallel(load_header_bytes, exposures, "headers", progress)


# --------------------------------------------------------------------------
# Pixel windows
# --------------------------------------------------------------------------

def plan_cutout(exp: Exposure, header_bytes: bytes, ra: float, dec: float, half: int) -> CutPlan | None:
    """Locate the target on the detector; None if it falls off the array."""
    header, data_offset = parse_image_header(header_bytes)
    wcs = celestial_wcs(header)
    try:
        xt, yt = (float(v) for v in wcs.all_world2pix(ra, dec, 0, quiet=True))
    except Exception:
        return None
    if not (np.isfinite(xt) and np.isfinite(yt)):
        return None
    if not (-0.5 <= xt <= _NPIX - 0.5 and -0.5 <= yt <= _NPIX - 0.5):
        return None
    xc, yc = int(round(xt)), int(round(yt))
    x0, x1 = max(0, xc - half), min(_NPIX, xc + half + 1)
    y0, y1 = max(0, yc - half), min(_NPIX, yc + half + 1)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return None
    return CutPlan(
        exp=exp, wcs=wcs, data_offset=data_offset, xt=xt, yt=yt,
        x0=x0, x1=x1, y0=y0, y1=y1,
        mjd=float(header.get("MJD-AVG", exp.mjd)),
        psf_fwhm=float(header.get("PSF_FWHM", 7.5)),
        pix_area=float(header.get("OMEGA_MEDIAN", config.NATIVE_SCALE ** 2)),
    )


def _pixel_path(plan: CutPlan) -> Path:
    tag = f"{plan.exp.key}|{plan.x0}|{plan.x1}|{plan.y0}|{plan.y1}"
    return config.CACHE_DIR / "pix" / f"{hashlib.sha1(tag.encode()).hexdigest()[:20]}.npy"


def read_pixels(plan: CutPlan) -> np.ndarray:
    """IMAGE pixels of the planned window as float32 [y, x] (cached on disk)."""
    path = _pixel_path(plan)
    if path.exists():
        return np.load(path)
    ny, nx = plan.shape
    first = plan.data_offset + (plan.y0 * _NPIX + plan.x0) * 4
    nbytes = ((ny - 1) * _NPIX + nx) * 4
    buf = get_range(plan.exp.s3_url, first, first + nbytes - 1)
    flat = np.frombuffer(buf, dtype=">f4")
    idx = np.arange(ny)[:, None] * _NPIX + np.arange(nx)[None, :]
    data = flat[idx].astype("<f4")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{threading.get_ident()}.tmp.npy")
    np.save(tmp, data)
    tmp.replace(path)
    return data


def read_pixels_many(plans: Iterable[CutPlan], progress: Progress | None = None) -> list[np.ndarray | None]:
    return _run_parallel(read_pixels, list(plans), "pixels", progress)
