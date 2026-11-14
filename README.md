# SPHEREx Blink Tree

A web tool that shows how any patch of sky changes over time in NASA's SPHEREx infrared survey.
Enter a position (or an object name), and the tool lines up every SPHEREx visit of that spot and
plays them like a short film, so anything that moves or changes brightness stands out.

Built for the NASA Space Apps Challenge.

## What it does

- **Blink**: aligned images of the same field, one per SPHEREx visit ("epoch"), played in a loop.
- **Difference**: subtract one epoch from another. Stars that do not change cancel out; a moving
  object leaves a dark spot where it was and a bright spot where it went.
- **Sum**: all epochs averaged for a deeper image.
- **Six detector arrays**: view each of SPHEREx's six wavelength ranges (0.75–5.0 µm) separately, or all combined.
  Each frame is a stack of all exposures of one detector in one visit, which improves the signal-to-noise.
- **Selectable field of view** from 1′ to 30′.
- **Coordinates or names**: decimal degrees, `08h55m10.8s -07d14m42.5s`, or a name looked up in SIMBAD.
  For objects with a known proper motion the field is centred where the object is *now*, and a marker
  shows its predicted position in every frame.
- **Shareable, embeddable links**: the whole view is in the URL.
- **Always current**: nothing is pre-computed. Every query asks the archive what exists, so new
  weekly SPHEREx releases show up without any change to the tool.

## Run it

Requires Python 3.10 or newer.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # Windows
# .venv/bin/python -m pip install -r requirements.txt       # macOS / Linux
.venv/Scripts/python -m uvicorn backend.app:app --port 8000
```

Then open <http://localhost:8000>.

The first view of a new field takes roughly 5–30 seconds, depending on the field of view and how
many detectors are read. Results are cached in `cache/`, so repeat views are instant.

## URL parameters

| Parameter | Meaning |
|---|---|
| `target` | A built-in example: `barnard`, `wise0855`, `epsindb`, `rwaur`, `rdra` |
| `ra`, `dec` | Field centre in decimal degrees (ICRS) |
| `fov` | Field of view in arcseconds, 60–1800 |
| `bands` | Detector array `1`–`6`, or a comma-separated list to average (e.g. `1,2,3,4,5,6`) |
| `mode` | `blink`, `diff` or `sum` |
| `ref` | What to subtract in difference mode: `auto`, `first`, `prev`, `mean`, or `e<N>` for epoch N |
| `speed` | Blink interval in milliseconds |
| `white`, `black`, `smooth`, `invert` | Display range (in units of the image noise), smoothing in pixels, inverted colours |
| `play=0`, `frame=N` | Start paused, start on frame N |
| `track` | `ra,dec,epoch,pmra,pmdec` of a moving object, to mark its predicted position |
| `embed=1` | Viewer only, for use in an `<iframe>` |

Example: `http://localhost:8000/?ra=133.795129&dec=-7.245147&fov=360&bands=6`

## How it works

```
browser (plain HTML/JS)  ──►  backend (FastAPI + astropy)  ──►  IRSA image search (SIA2): which images cover this spot?
 blink, difference, stretch     alignment, stacking, cache   ──►  public AWS S3 copy of the images: only the pixels needed
```

1. **Find the images.** IRSA's Simple Image Access service returns every SPHEREx spectral image whose
   footprint contains the position (1–5 s).
2. **Read only the pixels needed.** The images are 60+ MB uncompressed FITS files in a public S3 bucket.
   The backend reads the header and then just the rows around the target with HTTP range requests.
3. **Align.** Each small window is resampled onto a common north-up grid using the image's own
   astrometry (TAN-SIP), and its local sky level is removed.
4. **Group and stack.** Exposures are grouped into visits (a new epoch starts after a gap of more than
   15 days; long continuous coverage near the ecliptic poles is split into ~30-day windows) and averaged
   per detector with outlier rejection. Saturated star cores are marked rather than averaged.
5. **Display.** The browser receives raw float frames and does stretching, blinking and subtraction
   itself, so the controls respond instantly.

### HTTP API

| Endpoint | Returns |
|---|---|
| `GET /api/search?ra=&dec=` | Epochs and exposure counts per detector for a position |
| `GET /api/frames?ra=&dec=&fov=&bands=` | Aligned epoch frames (binary: JSON header + float32 pixels) |
| `GET /api/resolve?name=` | Position, proper motion and parallax of a named object (SIMBAD) |
| `GET /api/health` | Configured data collections and limits |

## Adding a new data release

Edit `backend/releases.json` and add the new collection name to `collections`. Weekly additions to an
existing collection need no change at all.

## Project layout

```
backend/    archive.py   image search and S3 range reads
            pipeline.py  alignment, epochs, stacking, cache
            app.py       web API, serves the front end
            releases.json
web/        index.html, css/, js/   the viewer (no build step)
scripts/    poc.py       command-line version that writes a GIF
```

## Test targets

| Target | What to look for |
|---|---|
| Barnard's Star | Moves about 10″ north per year; obvious in Blink and Difference (detector D2) |
| WISE 0855−0714 | Very faint, only visible in D6 (4.4–5.0 µm); Difference shows it shifting west |
| Epsilon Indi B | Brown-dwarf pair moving south-east (D2) |
| RW Aurigae, R Draconis | Variable stars: brightness changes between epochs |

## Status

Working: search by coordinates or name, per-detector epoch stacks, blink / difference / sum, field of view,
URL parameters, embed mode, disk cache.

Planned: Gaia DR3 overlay, on-the-fly spectra, contamination flags, bundled offline data for the test targets.

## Data and acknowledgements

This project uses data products from SPHEREx, a joint project of the Jet Propulsion Laboratory and the
California Institute of Technology funded by NASA, obtained from the NASA/IPAC Infrared Science Archive
(IRSA). Positions and proper motions come from the ESA Gaia mission (DR3) and the SIMBAD database.
The interface is modelled on [WiseView](http://byw.tools/wiseview).
