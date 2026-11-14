"""Record the five example targets so the page can show them without the server.

For each target in ``web/js/targets.js`` this saves exactly what the server
would answer: the blink frames of every detector, the exposure summary, the
Gaia stars, the target's spectrum and the quality flags of its default view.
The result goes to ``web/demo/<id>.js``; the page loads it when the server
cannot be reached (or with ``?demo=1``).

Run from the project root, with internet access (it takes a few minutes the
first time, because every detector of every target is read):

    python scripts/build_demo.py              # all targets
    python scripts/build_demo.py barnard      # just one
"""
from __future__ import annotations

import base64
import json
import math
import re
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

from backend import app as api  # noqa: E402
from backend import config, pipeline  # noqa: E402

SURVEY_YEAR = 2026.0                 # same date the page centres moving targets on
ALL_BANDS = "1,2,3,4,5,6"
OUT = config.WEB_DIR / "demo"


def read_targets() -> list[dict]:
    """The example targets, straight from the page's own list."""
    text = (config.WEB_DIR / "js" / "targets.js").read_text(encoding="utf-8")
    targets = []
    for block in re.findall(r"\{\s*id:.*?\n  \}", text, flags=re.S):
        def field(name: str, cast=float):
            return cast(re.search(rf"\b{name}:\s*'?([^,'\n]+)", block).group(1).strip())
        targets.append({
            "id": field("id", str), "ra": field("ra"), "dec": field("dec"), "epoch": field("epoch"),
            "pmra": field("pmra"), "pmdec": field("pmdec"), "bands": field("bands", str), "fov": field("fov"),
        })
    return targets


def centre(t: dict) -> tuple[float, float]:
    """Where the target is at SURVEY_YEAR, computed exactly as the page does."""
    dt = SURVEY_YEAR - t["epoch"]
    dec = t["dec"] + t["pmdec"] * dt / 3.6e6
    ra = t["ra"] + t["pmra"] * dt / 3.6e6 / math.cos(math.radians(t["dec"]))
    return ra % 360.0, dec


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def record(t: dict) -> dict:
    ra, dec = centre(t)
    track = ",".join(str(t[k]) for k in ("ra", "dec", "epoch", "pmra", "pmdec"))
    frames = {}
    for bands in [str(b) for b in sorted(config.BANDS)] + [ALL_BANDS]:
        started = time.time()
        frames[bands] = b64(api.frames(ra=ra, dec=dec, fov=t["fov"], bands=bands, job="").body)
        print(f"   frames {bands:<11s} {len(frames[bands]) / 1e3:7.0f} kB  {time.time() - started:5.1f}s", flush=True)
    return {
        "made": date.today().isoformat(),
        "ra": ra, "dec": dec, "fov": pipeline.clamp_fov(t["fov"]), "bands": t["bands"],
        "frames": frames,
        "search": api.search(ra=ra, dec=dec),
        "gaia": api.gaia(ra=ra, dec=dec, fov=t["fov"]),
        "spectrum": api.spectrum(ra=ra, dec=dec, track=track, wide=0, job=""),
        "flags": {t["bands"]: b64(api.quality_flags(ra=ra, dec=dec, fov=t["fov"], bands=t["bands"], job="").body)},
    }


def from_full_list(recorded: dict) -> bool:
    """False if the archive's search was down and the server worked from an older or partial list."""
    return (recorded["search"].get("archive") or {}).get("source") not in ("stale", "incomplete")


def main() -> None:
    wanted = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    skipped = []
    for t in read_targets():
        if wanted and t["id"] not in wanted:
            continue
        print(f"{t['id']}:", flush=True)
        started = time.time()
        # A recording must show the field as it is in the archive today. When the
        # archive cannot be asked, keep the file that is there and say so.
        try:
            recorded = record(t)
        except HTTPException as exc:
            print(f"   not written, the server could not answer: {exc.detail}", flush=True)
            skipped.append(t["id"])
            continue
        if not from_full_list(recorded):
            print("   not written: the archive's image search is down, so this would be a recording "
                  "of an older or partial list of images. Try again later.", flush=True)
            skipped.append(t["id"])
            continue
        bundle = pipeline._clean(recorded)
        text = ("/* Recorded answers of the SPHEREx Blink Tree server for one example target.\n"
                "   Made by scripts/build_demo.py; do not edit by hand. */\n"
                "window.BLINK_DEMO = window.BLINK_DEMO || {};\n"
                f"window.BLINK_DEMO[{json.dumps(t['id'])}] = {json.dumps(bundle, separators=(',', ':'))};\n")
        path = OUT / f"{t['id']}.js"
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"   wrote {path.name}: {path.stat().st_size / 1e6:.2f} MB in {time.time() - started:.0f}s", flush=True)
    if skipped:
        sys.exit("Not recorded: " + ", ".join(skipped))


if __name__ == "__main__":
    main()
