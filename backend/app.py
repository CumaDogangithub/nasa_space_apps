"""SPHEREx Blink Tree web API.

Run from the project root:

    python -m uvicorn backend.app:app --port 8000

then open http://localhost:8000
"""
from __future__ import annotations

import json
import math
import re
import struct
import threading
import time

import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import archive, catalogs, config, flags, pipeline, spectra

app = FastAPI(title="SPHEREx Blink Tree", version="0.1.0")
# The page may be opened from disk (file://) or embedded elsewhere, so the
# read-only API is open to any origin.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()

SIMBAD_TAP = [
    "https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
    "https://simbad.harvard.edu/simbad/sim-tap/sync",
]
GAIA_BIBCODES = ("2018yCat.1345", "2020yCat.1350")   # coordinates given at epoch J2000


def _track(job: str):
    if not job:
        return None

    def callback(label: str, done: int, total: int) -> None:
        with _progress_lock:
            _progress[job] = {"label": label, "fraction": done / max(total, 1), "t": time.time()}
            for old in [k for k, v in _progress.items() if time.time() - v["t"] > 600]:
                del _progress[old]

    return callback


def _parse_bands(text: str) -> list[int]:
    try:
        bands = sorted({int(b) for b in text.split(",") if b.strip()})
    except ValueError:
        raise HTTPException(400, "bands must be a comma-separated list of detector numbers 1-6")
    if not bands or any(b not in config.BANDS for b in bands):
        raise HTTPException(400, "bands must be detector numbers between 1 and 6")
    return bands


def _tidy_name(main_id: str) -> str:
    """SIMBAD identifiers carry type prefixes ("NAME ", "* ", "V* "); drop them for display."""
    return " ".join(re.sub(r"^(NAME|V\*|\*\*|\*)\s+", "", main_id.strip()).split())


def encode_frames(result: dict) -> bytes:
    """Binary payload: b'SBT1', uint32 header length, JSON header, float32 pixels."""
    frames = np.ascontiguousarray(result["frames"], dtype="<f4")
    header = {k: v for k, v in result.items() if k not in ("frames", "exposures")}
    header["n_frames"] = int(frames.shape[0])
    raw = json.dumps(pipeline._clean(header)).encode("utf-8")
    raw += b" " * (-len(raw) % 4)
    return b"SBT1" + struct.pack("<I", len(raw)) + raw + frames.tobytes()


def encode_flags(result: dict) -> bytes:
    """Binary payload: b'SBF1', uint32 header length, JSON header, uint8 shares, int32 flag masks."""
    fraction = np.ascontiguousarray(result["fraction"], dtype=np.uint8)
    common = np.ascontiguousarray(result["common"], dtype="<i4")
    header = {k: v for k, v in result.items() if k not in ("fraction", "common")}
    header["n_frames"] = int(fraction.shape[0])
    raw = json.dumps(pipeline._clean(header)).encode("utf-8")
    raw += b" " * (-len(raw) % 4)
    shares = fraction.tobytes()
    shares += b"\0" * (-len(shares) % 4)              # keep the int32 block aligned
    return b"SBF1" + struct.pack("<I", len(raw)) + raw + shares + common.tobytes()


@app.get("/api/health")
def health() -> dict:
    return {
        "name": "SPHEREx Blink Tree",
        "collections": config.COLLECTIONS,
        "bands": {str(k): v for k, v in config.BANDS.items()},
        "fov_range": [pipeline.MIN_FOV, pipeline.MAX_FOV],
    }


@app.get("/api/search")
def search(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)) -> dict:
    """Which SPHEREx images cover this position: epochs and counts per detector."""
    try:
        exposures = archive.search(ra, dec)
    except Exception as exc:
        raise HTTPException(502, f"SPHEREx image search failed: {exc}")
    out = pipeline.summarize(exposures)
    out.update(ra=ra, dec=dec, bands={str(k): v for k, v in config.BANDS.items()})
    return out


@app.get("/api/frames")
def frames(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
           fov: float = Query(240.0, ge=pipeline.MIN_FOV, le=pipeline.MAX_FOV),
           bands: str = "2", job: str = "") -> Response:
    """Aligned epoch frames around (ra, dec) for one detector array or an average of several."""
    band_list = _parse_bands(bands)
    try:
        result = pipeline.build(ra, dec, fov, band_list, _track(job))
    except Exception as exc:
        raise HTTPException(502, f"Could not build frames: {exc}")
    finally:
        with _progress_lock:
            _progress.pop(job, None)
    return Response(encode_frames(result), media_type="application/octet-stream")


@app.get("/api/progress")
def progress(job: str) -> dict:
    with _progress_lock:
        entry = _progress.get(job)
    return {"label": entry["label"], "fraction": entry["fraction"]} if entry else {"label": "", "fraction": 0}


@app.get("/api/flags")
def quality_flags(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                  fov: float = Query(240.0, ge=pipeline.MIN_FOV, le=pipeline.MAX_FOV),
                  bands: str = "2", job: str = "") -> Response:
    """SPHEREx quality flags behind each blink frame, and the list of exposures."""
    band_list = _parse_bands(bands)
    report = _track(job)

    def progress(label: str, done: int, total: int) -> None:
        if report:
            part = 0.2 * done / total if label == "headers" else 0.2 + 0.8 * done / total
            report(label, int(1000 * part), 1000)

    try:
        result = flags.build_flags(ra, dec, fov, band_list, progress)
    except Exception as exc:
        raise HTTPException(502, f"Could not read the quality flags: {exc}")
    finally:
        with _progress_lock:
            _progress.pop(job, None)
    return Response(encode_flags(result), media_type="application/octet-stream")


@app.get("/api/spectrum")
def spectrum(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
             track: str = "", wide: int = 0, job: str = "") -> dict:
    """Quick-look spectrum and light curve of one sky position, measured in every exposure.

    ``track`` (ra,dec,epoch,pmra,pmdec) follows a moving object instead of a fixed position.
    ``wide=1`` says the star is known to be saturated, so the ring of light around it is measured too.
    """
    moving = None
    if track:
        try:
            moving = tuple(float(v) for v in track.split(","))
        except ValueError:
            moving = ()
        if len(moving) != 5:
            raise HTTPException(400, "track must be ra,dec,epoch,pmra,pmdec")
    report = _track(job)

    def progress(label: str, done: int, total: int) -> None:
        if report:                       # reading headers is quick: count it as 30% of the job
            part = 0.3 * done / total if label == "headers" else 0.3 + 0.7 * done / total
            report(label, int(1000 * part), 1000)

    try:
        return spectra.build_spectrum(ra, dec, moving, progress, wide=bool(wide))
    except Exception as exc:
        raise HTTPException(502, f"Could not measure the spectrum: {exc}")
    finally:
        with _progress_lock:
            _progress.pop(job, None)


@app.get("/api/gaia")
def gaia(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
         fov: float = Query(240.0, ge=pipeline.MIN_FOV, le=pipeline.MAX_FOV)) -> dict:
    """Gaia DR3 stars in and just around a field, for the overlay."""
    radius = (fov * math.sqrt(2) / 2 + catalogs.PM_MARGIN_ARCSEC) / 3600
    try:
        return catalogs.gaia_cone(ra, dec, radius)
    except Exception as exc:
        raise HTTPException(502, f"The Gaia archive did not answer: {exc}")


@app.get("/api/resolve")
def resolve(name: str = Query(..., min_length=1, max_length=80)) -> dict:
    """Look an object name up in SIMBAD: position, proper motion and parallax."""
    safe = name.strip().replace("'", "''")
    query = ("SELECT main_id, ra, dec, pmra, pmdec, plx_value, coo_bibcode FROM basic "
             f"JOIN ident ON oidref = oid WHERE id = '{safe}'")
    last = "no SIMBAD server answered"
    for url in SIMBAD_TAP:
        try:
            r = requests.get(url, params={"request": "doQuery", "lang": "adql", "format": "json", "query": query},
                             timeout=(6, 20))
            if r.status_code != 200:
                last = f"HTTP {r.status_code}"
                continue
            rows = r.json().get("data") or []
        except (requests.RequestException, ValueError) as exc:
            last = str(exc)
            continue
        if not rows:
            raise HTTPException(404, f"'{name}' was not found in SIMBAD")
        main_id, ra, dec, pmra, pmdec, plx, bib = rows[0]
        if ra is None or dec is None:
            raise HTTPException(404, f"SIMBAD has no coordinates for '{name}'")
        # SIMBAD lists Gaia-based positions at epoch J2000; for other sources the
        # epoch is not recorded, so proper motion cannot be applied safely.
        from_gaia = bool(bib) and str(bib).startswith(GAIA_BIBCODES)
        return {
            "name": _tidy_name(str(main_id)), "ra": ra, "dec": dec,
            "pmra": pmra if from_gaia else None, "pmdec": pmdec if from_gaia else None,
            "parallax": plx, "epoch": 2000.0 if from_gaia else None,
        }
    raise HTTPException(502, f"Name lookup failed: {last}")


class FreshStaticFiles(StaticFiles):
    """Static files the browser must revalidate on every visit.

    Without this a browser may pair a cached, older index.html with newer
    scripts (or the reverse) after the tool is updated.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


if config.WEB_DIR.exists():
    app.mount("/", FreshStaticFiles(directory=config.WEB_DIR, html=True), name="web")
