"""Field test: ask the running server for fields all over the sky and report what fails.

Start the server first (see README), then

    python scripts/check_fields.py                 # every field: about 15 minutes the first time
    python scripts/check_fields.py --quick         # the five example targets only
    python scripts/check_fields.py --server http://localhost:8000

For each field the script does what a visitor would do: look the position up
(which images exist), build the blink frames of one detector, load the Gaia
stars, and measure a spectrum at the centre and at a spot off the centre, as
a click on a neighbouring star would. The first target is also tried with wide
and narrow fields of view, with all six detectors, with other limits on the
exposures per visit and with the quality flags.

The last column says where the list of images came from: "archive" (asked
just now), "cache" (asked within the last day), "stale" or "incomplete" (the
archive's search service did not answer; see backend/archive.py).
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import time

import requests

# name, ra, dec (degrees), detector to blink
EXAMPLES = [
    ("Barnard's Star (now)", 269.4462683557572, 4.76820447889019, 2),
    ("WISE 0855-0714 (now)", 133.75967, -7.24220, 6),
    ("Epsilon Indi B (now)", 331.09664, -56.80066, 2),
    ("RW Aurigae", 76.95609, 30.40113, 2),
    ("R Draconis", 248.16723, 66.75502, 2),
]
SKY = [
    ("Andromeda galaxy, centre", 10.6847, 41.2687, 2),
    ("Pleiades, Alcyone", 56.8711, 24.1051, 2),
    ("Crab Nebula", 83.6331, 22.0145, 4),
    ("Orion Nebula", 83.8221, -5.3911, 3),
    ("Galactic centre", 266.4168, -29.0078, 5),
    ("Tarantula Nebula (LMC)", 84.6767, -69.1009, 2),
    ("South ecliptic pole (deep field)", 90.0, -66.5607, 2),
    ("North ecliptic pole (deep field)", 270.0, 66.5607, 2),
    ("Polaris, near the north pole", 37.9546, 89.2641, 2),
    ("Sigma Octantis, near the south pole", 317.195, -88.9565, 2),
    ("RA just below 360", 359.9950, 0.5000, 2),
    ("RA just above 0", 0.0040, -0.3000, 2),
    ("TRAPPIST-1", 346.6223, -5.0414, 3),
    ("Vega (very bright)", 279.2347, 38.7837, 1),
    ("COSMOS field (empty sky)", 150.1163, 2.2058, 2),
    ("Proxima Centauri", 217.3694, -62.6739, 2),
]


class Server:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.http = requests.Session()

    def get(self, path: str, **params):
        """(answer, seconds, error). JSON answers are parsed; binary ones give their JSON header."""
        t = time.time()
        try:
            r = self.http.get(self.base + path, params=params, timeout=600)
        except requests.RequestException as exc:
            return None, time.time() - t, f"no answer: {exc}"
        took = time.time() - t
        if r.status_code != 200:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = r.text[:120]
            return None, took, f"HTTP {r.status_code}: {str(detail)[:160]}"
        if r.content[:4] in (b"SBT1", b"SBF1"):
            (length,) = struct.unpack("<I", r.content[4:8])
            return json.loads(r.content[8:8 + length]), took, None
        return r.json(), took, None


def check_field(server: Server, name: str, ra: float, dec: float, band: int, problems: list[str]) -> None:
    def fail(what: str, error: str) -> None:
        problems.append(f"{name}: {what}: {error}")

    line = f"{name:36s}"
    found, took, error = server.get("/api/search", ra=ra, dec=dec)
    if error:
        fail("search", error)
        print(line + f" search FAILED ({error})")
        return
    source = found.get("archive", {}).get("source", "?")
    line += f" {found['n_images']:5d} images {len(found['epochs']):3d} visits {took:5.1f}s |"

    frames, took, error = server.get("/api/frames", ra=ra, dec=dec, fov=180, bands=band)
    if error:
        fail(f"frames D{band}", error)
        line += " frames FAILED |"
    else:
        line += f" D{band}: {frames['n_frames']:2d} frames from {frames['n_used']:3d}/{frames['n_found']:3d} {took:5.1f}s |"
        if frames["n_found"] >= 4 and frames["n_used"] < 0.5 * frames["n_found"]:
            fail(f"frames D{band}", f"only {frames['n_used']} of {frames['n_found']} exposures could be read")

    stars, took, error = server.get("/api/gaia", ra=ra, dec=dec, fov=180)
    if error:
        fail("gaia", error)
        line += " gaia FAILED |"
    else:
        line += f" gaia {len(stars['sources']):3d} |"

    # a spectrum at the centre and one 70 arcsec off, as a click on a neighbouring star would ask for
    for label, dra, ddec in (("centre", 0.0, 0.0), ("off-centre", 0.0, 70 / 3600 if dec < 80 else -70 / 3600)):
        spectrum, took, error = server.get("/api/spectrum", ra=ra + dra, dec=dec + ddec)
        if error:
            fail(f"spectrum {label}", error)
            line += f" spectrum {label} FAILED |"
        else:
            line += f" {label}: {spectrum['n_points']:3d}+{spectrum['n_saturated']:3d}sat of {spectrum['n_read']:3d} {took:5.1f}s |"
            if spectrum["n_found"] and not spectrum["n_read"]:
                fail(f"spectrum {label}", "no exposure could be read")
    print(line + f" {source}", flush=True)


def check_extras(server: Server, problems: list[str]) -> None:
    """Wide fields, all detectors together and the quality flags, on the first example target."""
    name, ra, dec, band = EXAMPLES[0]
    for label, path, params in (
        ("field of view 1'", "/api/frames", dict(fov=60, bands=band)),
        ("field of view 10'", "/api/frames", dict(fov=600, bands=band)),
        ("field of view 30'", "/api/frames", dict(fov=1800, bands=band)),
        ("all six detectors", "/api/frames", dict(fov=180, bands="1,2,3,4,5,6")),
        ("at most 10 per visit", "/api/frames", dict(fov=180, bands=band, limit=10)),
        ("every exposure", "/api/frames", dict(fov=180, bands=band, limit=0)),
        ("quality flags", "/api/flags", dict(fov=180, bands=band)),
    ):
        got, took, error = server.get(path, ra=ra, dec=dec, **params)
        if error:
            problems.append(f"{name}: {label}: {error}")
            print(f"{name:36s} {label:20s} FAILED ({error})")
        elif path == "/api/flags":
            print(f"{name:36s} {label:20s} {len(got['exposures']):3d} exposures, {got['n_frames']} flag maps {took:5.1f}s")
        else:
            print(f"{name:36s} {label:20s} {got['n_frames']:2d} frames of {got['n']}x{got['n']} px from {got['n_used']:3d} exposures {took:5.1f}s")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--server", default="http://localhost:8000")
    parser.add_argument("--quick", action="store_true", help="the five example targets only")
    args = parser.parse_args()

    server = Server(args.server)
    health, _, error = server.get("/api/health")
    if error:
        print(f"The server at {args.server} does not answer ({error}). Start it first.")
        return 2

    problems: list[str] = []
    t0 = time.time()
    for name, ra, dec, band in EXAMPLES + ([] if args.quick else SKY):
        check_field(server, name, ra, dec, band, problems)
    check_extras(server, problems)

    print(f"\n{len(EXAMPLES) + (0 if args.quick else len(SKY))} fields in {(time.time() - t0) / 60:.1f} minutes")
    if problems:
        print(f"{len(problems)} problem(s):")
        for p in problems:
            print("  - " + p)
        return 1
    print("No problems.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
