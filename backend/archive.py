"""Find SPHEREx spectral images and read small pixel windows from them.

Two public services are used:

* IRSA's SIA2 service tells us which Level-2 spectral images cover a position.
  It is sometimes down; answers are stored so that the tool keeps working then.
* The same files are mirrored in a public AWS S3 bucket. They are plain,
  uncompressed FITS, so the pixels around a target can be read with HTTP
  range requests instead of downloading the 60+ MB file.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import threading
import time
import warnings
from collections import OrderedDict
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


SIA_TRIES = 6          # the service sometimes refuses every other request, and refuses quickly: ask again
SIA_PAUSE = 0.3        # seconds before the second attempt; each later pause is longer by as much
SIA_REST = 30.0        # after all attempts failed the service is left alone for this long
NEARBY_DEG = 3.6       # earlier searches this close can share images (a footprint is 3.5 degrees wide)


class ArchiveUnavailable(RuntimeError):
    """The image search does not answer and nothing stored earlier covers the position."""


STORED_LISTS = 12      # image lists kept parsed in memory; one of a deep field has 30,000 rows

_search_lock = threading.Lock()
_search_info: OrderedDict[str, dict] = OrderedDict()   # position -> how its image list was obtained
_resting_until = 0.0                                    # the service failed completely: do not ask before this time
_stored: OrderedDict[str, tuple[float, list[dict]]] = OrderedDict()   # parsed lists: file name -> (mtime, rows)
_position_locks = [threading.Lock() for _ in range(64)]              # one question to the archive per position at a time


def _ask_archive(ra: float, dec: float) -> list[Exposure]:
    """Every image, of all collections, whose footprint contains the position.

    One request names all collections, so the answer is either complete or
    missing: there is no such thing as half a list.
    """
    params = [("COLLECTION", c) for c in config.COLLECTIONS]
    params += [("POS", f"circle {ra:.6f} {dec:.6f} 0.0003"), ("RESPONSEFORMAT", "CSV")]
    last: Exception | None = None
    for attempt in range(SIA_TRIES):
        if attempt:
            time.sleep(SIA_PAUSE * attempt)
        try:
            r = _session.get(config.SIA_URL, params=params, timeout=(8, 90))
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            reader = csv.DictReader(io.StringIO(r.text))
            if not reader.fieldnames or "access_url" not in reader.fieldnames:
                raise RuntimeError(f"unexpected answer {r.text[:80]!r}")
            return _read_rows(reader)
        except (requests.RequestException, RuntimeError) as exc:
            last = exc
    raise RuntimeError(f"{last} ({SIA_TRIES} attempts)")


def _read_rows(reader: csv.DictReader) -> list[Exposure]:
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
                collection=row.get("obs_collection") or "",
                key=url[len(config.IRSA_PREFIX):],
                poly=_parse_region(row.get("s_region")),
            )
        )
    return out


def _unit(ra: float, dec: float) -> tuple[float, float, float]:
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def footprint_contains(poly: list[float] | None, ra: float, dec: float) -> bool:
    """Is a sky position inside an image footprint? Corners in order; the shape is convex."""
    if not poly or len(poly) < 8:
        return False
    p = _unit(ra, dec)
    corners = [_unit(poly[i], poly[i + 1]) for i in range(0, 8, 2)]
    middle = [sum(c[k] for c in corners) for k in range(3)]
    norm = math.sqrt(sum(v * v for v in middle))
    if sum(p[k] * middle[k] for k in range(3)) < 0.99 * norm:      # more than 8 degrees away
        return False
    sides = []
    for a, b in zip(corners, corners[1:] + corners[:1]):
        normal = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
        sides.append(sum(normal[k] * p[k] for k in range(3)))
    return all(s >= 0 for s in sides) or all(s <= 0 for s in sides)


def _stored_rows(path: Path) -> list[dict]:
    """A stored search, parsed once and then kept in memory."""
    mtime = path.stat().st_mtime
    with _search_lock:
        hit = _stored.get(path.name)
        if hit and hit[0] == mtime:
            _stored.move_to_end(path.name)
            return hit[1]
    rows = json.loads(path.read_text(encoding="utf-8"))
    with _search_lock:
        _stored[path.name] = (mtime, rows)
        _stored.move_to_end(path.name)
        while len(_stored) > STORED_LISTS:
            _stored.popitem(last=False)
    return rows


def _from_earlier_searches(ra: float, dec: float) -> dict[str, Exposure]:
    """Images found by earlier searches close by whose footprint contains this position.

    Every image returned really covers the position; images that no earlier
    search happened to find are missing, more of them the further away the
    earlier searches were.
    """
    out: dict[str, Exposure] = {}
    folder = config.CACHE_DIR / "sia"
    if not folder.exists():
        return out
    here = _unit(ra, dec)
    reach = math.cos(math.radians(NEARBY_DEG))
    for path in folder.glob("*_v2.json"):
        try:
            pra, pdec = (float(v) for v in path.name[: -len("_v2.json")].split("_"))
            there = _unit(pra, pdec)
            if sum(here[k] * there[k] for k in range(3)) < reach:
                continue
            for row in _stored_rows(path):
                uid = f"{row['obs_id']}_D{row['band']}"
                if uid not in out and footprint_contains(row.get("poly"), ra, dec):
                    out[uid] = Exposure(**row)
        except (KeyError, ValueError, TypeError, OSError):
            continue
    return out


def _note(ra: float, dec: float, source: str) -> None:
    with _search_lock:
        _search_info[f"{ra:.5f}_{dec:+.5f}"] = {"source": source}
        while len(_search_info) > 5000:
            _search_info.popitem(last=False)


def search_info(ra: float, dec: float) -> dict:
    """How the image list of the last search at this position was obtained.

    ``source`` is "archive" (asked just now), "cache" (asked within the last
    SIA_CACHE_HOURS), "stale" (the search service does not answer, so an older
    answer is used) or "incomplete" (it does not answer and this position was
    never asked before: the list was put together from earlier searches nearby).
    """
    with _search_lock:
        return dict(_search_info.get(f"{ra:.5f}_{dec:+.5f}", {"source": "archive"}))


def _position_lock(name: str) -> threading.Lock:
    return _position_locks[int(hashlib.sha1(name.encode()).hexdigest()[:8], 16) % len(_position_locks)]


def _recent(cache: Path) -> list[Exposure] | None:
    """The stored answer for a position, if it is recent enough to be used as it is."""
    if cache.exists() and time.time() - cache.stat().st_mtime < config.SIA_CACHE_HOURS * 3600:
        return [Exposure(**d) for d in _stored_rows(cache)]
    return None


def search(ra: float, dec: float, use_cache: bool = True) -> list[Exposure]:
    """All spectral images whose footprint contains (ra, dec), oldest first.

    An answer of the archive is stored and reused for SIA_CACHE_HOURS. The
    archive's search service is sometimes down, for a moment or for hours.
    Then an older stored answer is used, or else the images of earlier
    searches nearby whose footprint contains the position. ``search_info``
    tells which of these happened.
    """
    name = f"{ra:.5f}_{dec:+.5f}"
    cache = config.CACHE_DIR / "sia" / f"{name}_v2.json"
    recent = _recent(cache) if use_cache else None
    if recent is None:
        # The page asks for the images, the frames and the flags of a new field at the same
        # moment: the first request asks the archive, the others wait and use its answer.
        with _position_lock(name):
            recent = _recent(cache) if use_cache else None
            if recent is None:
                return _ask_or_fall_back(ra, dec, cache)
    _note(ra, dec, "cache")
    return recent


def _ask_or_fall_back(ra: float, dec: float, cache: Path) -> list[Exposure]:
    global _resting_until
    answer: list[Exposure] | None = None
    error = ""
    if time.time() < _resting_until:
        error = "it did not answer a moment ago"
    else:
        try:
            answer = _ask_archive(ra, dec)
        except Exception as exc:
            error = str(exc)
            _resting_until = time.time() + SIA_REST

    if answer is not None:
        unique: dict[str, Exposure] = {}
        for exp in answer:
            unique.setdefault(exp.uid, exp)
        exposures = sorted(unique.values(), key=lambda e: (e.mjd, e.band))
        cache.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_name(f"{cache.name}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps([asdict(e) for e in exposures]), encoding="utf-8")
        tmp.replace(cache)
        _note(ra, dec, "archive")
        return exposures

    # The service is down: work from what earlier searches stored.
    print(f"[archive] no image search at {ra:.5f} {dec:+.5f}: {error}", flush=True)
    if cache.exists():
        exposures = [Exposure(**d) for d in _stored_rows(cache)]
        source = "stale"
    else:
        exposures = sorted(_from_earlier_searches(ra, dec).values(), key=lambda e: (e.mjd, e.band))
        source = "incomplete"
    if not exposures:
        raise ArchiveUnavailable("the SPHEREx image search (IRSA) is not answering")
    _note(ra, dec, source)
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
        try:
            return path.read_bytes()
        except OSError:                                  # removed by the cache keeper meanwhile: fetch it again
            pass
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
        try:
            return np.load(path)
        except (OSError, ValueError):                    # removed meanwhile or cut short: fetch it again
            pass
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


# --------------------------------------------------------------------------
# Quality flags
# --------------------------------------------------------------------------
#
# Every spectral image carries a FLAGS extension: a 32-bit mask per pixel that
# records cosmic-ray hits, saturation, persistence, ghosts of bright stars and
# so on. Unlike the image it is stored compressed, as a FITS tile-compressed
# image with one Rice-compressed tile per detector row. So a window is read in
# two steps: the extension header with its tile directory (cached per file),
# then just the compressed bytes of the rows needed, which are decoded here.

IMAGE_BYTES = _NPIX * _NPIX * 4
FLAGS_HEAD_GUESS = 48 * 1024           # header (about 17 kB) plus tile directory (16 kB)

# Names and meanings of the flag bits, as written in the files (filled in from
# the first FLAGS header read; these are the DR1 definitions).
flag_names: dict[int, tuple[str, str]] = {
    0: ("TRANSIENT", "Transient detected during SUR"),
    1: ("OVERFLOW", "Overflow detected during SUR"),
    2: ("SUR_ERROR", "Error in onboard processing"),
    6: ("NONFUNC", "Permanently unusable"),
    7: ("DICHROIC", "Low efficiency due to dichroic"),
    9: ("MISSING_DATA", "Onboard data lost"),
    10: ("HOT", "Hot pixel"),
    11: ("COLD", "Anomalously low signal"),
    12: ("FULLSAMPLE", "Pixel full sample history is available"),
    14: ("PHANMISS", "Phantom correction was not applied"),
    15: ("NONLINEAR", "Nonlinearity correction cannot be applied reliably"),
    17: ("PERSIST", "Persistent charge above threshold"),
    19: ("OUTLIER", "Pixel flagged by Detect Outliers"),
    20: ("CROSSTALK", "Pixel affected by crosstalk"),
    21: ("SOURCE", "Pixel mapped to a known source"),
    22: ("GHOST", "Affected by a bright source inside the exposure"),
    23: ("GHOST_FPA", "Affected by a bright source on another detector"),
    24: ("GHOST_EXT", "Pixel affected by a bright source outside FOV"),
    25: ("STREAK", "Pixel affected by a streak"),
    26: ("BLOOM", "Pixel part of a bloom artifact"),
    27: ("SNOWBALL", "Pixel part of a snowball artifact"),
    28: ("HALO", "Pixel part of a transient halo"),
}


def _rice_codec(blocksize: int, bytepix: int, tilesize: int):
    try:
        from astropy.io.fits.hdu.compressed import _codecs as codecs
    except ImportError:                                  # older astropy
        from astropy.io.fits._tiled_compression import codecs
    return codecs.Rice1(blocksize=blocksize, bytepix=bytepix, tilesize=tilesize)


def _flags_directory_path(exp: Exposure) -> Path:
    digest = hashlib.sha1(exp.key.encode()).hexdigest()[:16]
    return config.CACHE_DIR / "fhdr" / f"{digest}.bin"


def load_flags_directory(plan: CutPlan) -> dict:
    """Header and tile directory of one file's FLAGS extension (cached on disk).

    Returns the absolute byte offset of the compressed data ("heap"), the
    directory as an array of (length, offset) per detector row, and the codec
    parameters.
    """
    start = plan.data_offset + IMAGE_BYTES               # FLAGS follows the IMAGE pixels
    path = _flags_directory_path(plan.exp)
    buf = b""
    if path.exists():
        try:
            buf = path.read_bytes()
        except OSError:                                  # removed by the cache keeper meanwhile
            pass
    if not buf:
        buf = get_range(plan.exp.s3_url, start, start + FLAGS_HEAD_GUESS - 1)
    end = _find_end(buf, 0)
    if end < 0:
        raise RuntimeError(f"no FLAGS header found in {plan.exp.key}")
    header_len = _pad(end + 80)
    header = fits.Header.fromstring(buf[: end + 80].decode("ascii", "replace"))
    if header.get("ZCMPTYPE") != "RICE_1" or header.get("ZTILE2", 1) != 1 or header.get("ZTILE1") != _NPIX:
        raise RuntimeError(f"unexpected FLAGS layout in {plan.exp.key}: "
                           f"{header.get('ZCMPTYPE')} tiles {header.get('ZTILE1')}x{header.get('ZTILE2')}")
    row_bytes, n_rows = int(header["NAXIS1"]), int(header["NAXIS2"])
    need = header_len + row_bytes * n_rows
    if len(buf) < need:
        buf += get_range(plan.exp.s3_url, start + len(buf), start + need - 1)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
        tmp.write_bytes(buf[:need])
        tmp.replace(path)
    for key in header:                                   # keep the bit names as the files define them
        if key.startswith("MSKN"):
            bit = int(key[4:])
            flag_names[bit] = (str(header[key]).strip(), str(header.get(f"MSKD{bit:04d}", "")).strip())
    dtype = ">i8" if "Q" in str(header.get("TFORM1", "")) else ">i4"
    directory = np.frombuffer(buf[header_len:need], dtype=dtype).reshape(n_rows, 2)
    return {
        "heap": start + header_len + int(header.get("THEAP", row_bytes * n_rows)),
        "directory": directory,
        "blocksize": int(header.get("ZVAL1", 32)),
        "bytepix": int(header.get("ZVAL2", 4)),
    }


def _flags_path(plan: CutPlan) -> Path:
    tag = f"{plan.exp.key}|{plan.x0}|{plan.x1}|{plan.y0}|{plan.y1}"
    return config.CACHE_DIR / "flg" / f"{hashlib.sha1(tag.encode()).hexdigest()[:20]}.npy"


def read_flags(plan: CutPlan) -> np.ndarray:
    """FLAGS bit mask of the planned window as int32 [y, x] (cached on disk)."""
    path = _flags_path(plan)
    if path.exists():
        try:
            return np.load(path)
        except (OSError, ValueError):                    # removed meanwhile or cut short: fetch it again
            pass
    info = load_flags_directory(plan)
    directory = info["directory"]
    first = int(directory[plan.y0, 1])
    last = int(directory[plan.y1 - 1, 1] + directory[plan.y1 - 1, 0])
    blob = get_range(plan.exp.s3_url, info["heap"] + first, info["heap"] + last - 1)
    codec = _rice_codec(info["blocksize"], info["bytepix"], _NPIX)
    out = np.empty(plan.shape, dtype=np.int32)
    for i, y in enumerate(range(plan.y0, plan.y1)):
        a, n = int(directory[y, 1]) - first, int(directory[y, 0])
        row = np.asarray(codec.decode(np.frombuffer(blob[a:a + n], dtype=np.uint8)))
        out[i] = row.astype(np.int32)[plan.x0:plan.x1]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{threading.get_ident()}.tmp.npy")
    np.save(tmp, out)
    tmp.replace(path)
    return out


def read_flags_many(plans: Iterable[CutPlan], progress: Progress | None = None) -> list[np.ndarray | None]:
    return _run_parallel(read_flags, list(plans), "flags", progress)
