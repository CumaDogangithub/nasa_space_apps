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
- **Sky map**: a globe of the SPHEREx all-sky survey next to the viewer. A slider steps through all
  102 wavelength channels. The map flies to each new target, marks the field being blinked and draws
  the footprints of the SPHEREx exposures of the epoch on screen, so you can see how the telescope
  scanned that spot. WISE, 2MASS and DSS maps are one click away for comparison, and
  **Blink map centre** blinks whatever you find while browsing the sky.
  **Field** zooms the map to exactly the area of the blink image, pointing at either picture marks
  the same spot on the other, and **Full screen** spreads the map over the whole window.
- **Gaia overlay**: circles mark the stars the Gaia mission already knows, moved to the date of each
  frame. Fast-moving stars get an arrow showing where they will be in five years, and pointing at a
  star shows its brightness, motion and distance. A moving object with no circle is not in Gaia,
  which is exactly what a new nearby brown dwarf would look like.
- **Spectrum and light curve on a click**: click a star in the blink image and it is measured in every
  SPHEREx exposure. Each exposure sees it at a different wavelength, so the points form a spectrum from
  0.75 to 5 µm, coloured by epoch; the light-curve view shows how each detector's brightness changed
  from visit to visit, relative to the star's own average at the same wavelength. Stars too bright for
  the detector are measured in a ring around their saturated core instead.
- **Quality flags and exposure list**: SPHEREx marks pixels it does not trust (cosmic-ray hits,
  saturation, leftover charge, ghosts of bright stars and more). Switching on **Flags** tints the
  pixels flagged in at least a quarter of the exposures behind a frame, names the flags under the
  pointer, and lists every exposure of the frame with its time, the wavelength it saw at the centre
  of the field, its flags there and a link to the original image.
- **Selectable field of view** from 1′ to 30′.
- **Coordinates or names**: decimal degrees, `08h55m10.8s -07d14m42.5s`, or a name looked up in SIMBAD.
  For objects with a known proper motion the field is centred where the object is *now*, and a marker
  shows its predicted position in every frame.
- **Shareable, embeddable links**: the whole view is in the URL.
- **Always current**: nothing is pre-computed. Every query asks the archive what exists, so new
  weekly SPHEREx releases show up without any change to the tool.

## Just want a look?

Open `web/index.html` in a browser. Without the server the page shows the five example targets from
recorded data (every detector, the Gaia stars, the target's spectrum and the quality flags of the
default view), so nothing needs to be installed. A banner says that it is running offline. Exploring
any other position needs the server below.

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
| `gaia=1` | Show the Gaia DR3 overlay |
| `flags=1` | Show the SPHEREx quality flags and the exposure list |
| `spec` | Open a spectrum: `target` for the object itself, or `ra,dec` in degrees for any spot |
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

### Spectra without a spectrograph

SPHEREx has no prism: a filter whose colour changes smoothly across each detector does the work, so the
wavelength a star is seen at depends on where it lands. The telescope steps across the sky between
exposures, and the star lands somewhere new each time. For a clicked position the backend therefore:

1. reads a 17 × 17 pixel window around it from every exposure of all six detectors;
2. measures the brightness in a circle of 12″ radius, with the sky level taken from a ring around it;
3. looks up the wavelength of the landing spot in the detector's own 9 × 9 lookup table
   (`backend/data/wavelength_tables.json`, extracted once from the files by `scripts/build_wavelength_tables.py`).

Stars too bright for the detector have a blank core. For those the light in a ring 25″–43″ from the
centre is measured instead: it follows the star's changes but is not its total brightness. The light
curve divides every exposure by the star's own average at the same wavelength before following it
through time, so that a red star does not seem to vary just because different visits sampled
different wavelengths.

**Is the brightness scale right?** `scripts/check_flux.py` measures ordinary stars the same way and
compares them with the 2MASS catalogue. For five stars near RW Aurigae the ratio SPHEREx / 2MASS was
0.94 in J, 1.01 in H and 0.97 in Ks. These are quick-look values: neighbours inside the circle add to
the result, and no correction is made for the light that falls outside it.

### Quality flags

Each image file carries a FLAGS extension with a 32-bit mask per pixel. Unlike the image it is stored
compressed, one Rice-compressed tile per detector row. The backend reads the extension's header and
tile directory once per file (about 34 kB), then only the compressed bytes of the rows it needs, and
decodes them. For a frame, a pixel is tinted when at least a quarter of its exposures carry a flag
other than the purely informative ones (`SOURCE`, `FULLSAMPLE`). The flag names and meanings shown are
read from the files themselves.

### Are the frames in the right place?

`scripts/check_astrometry.py` compares the blink frames with Gaia DR3: it predicts where each Gaia star
should fall in a frame and measures where the star actually is. In three 6′ test fields (RW Aurigae,
Proxima Centauri, WISE 0855; detector D2) the median difference was 0.4–0.8″, a small fraction of one
SPHEREx pixel (6.15″). The sky map draws the blink field from the same coordinates.

### HTTP API

| Endpoint | Returns |
|---|---|
| `GET /api/search?ra=&dec=` | Epochs, exposure counts per detector and exposure footprints for a position |
| `GET /api/frames?ra=&dec=&fov=&bands=` | Aligned epoch frames (binary: JSON header + float32 pixels) |
| `GET /api/flags?ra=&dec=&fov=&bands=` | Quality-flag maps for the blink frames and one row per exposure (binary: JSON header + masks) |
| `GET /api/spectrum?ra=&dec=` | One sky position measured in every exposure: wavelength, flux, date, detector and epoch per point |
| `GET /api/gaia?ra=&dec=&fov=` | Gaia DR3 stars in and around a field (position, proper motion, parallax, magnitude) |
| `GET /api/resolve?name=` | Position, proper motion and parallax of a named object (SIMBAD) |
| `GET /api/health` | Configured data collections and limits |

## Offline demo data

`web/demo/<target>.js` holds, for each example target, exactly what the server would answer (3.9 MB
in total). The page uses these files when it cannot reach the server, or when `?demo=1` is added to
the address. After a new data release, refresh them with

```bash
.venv/Scripts/python scripts/build_demo.py
```

which takes a few minutes the first time because every detector of every target is read.

## Adding a new data release

Edit `backend/releases.json` and add the new collection name to `collections`. Weekly additions to an
existing collection need no change at all.

## Project layout

```
backend/    archive.py   image search and S3 range reads
            pipeline.py  alignment, epochs, stacking, cache
            spectra.py   photometry and wavelength of each exposure: spectra and light curves
            flags.py     quality-flag maps and the exposure list
            remote.py    reads parts of a remote FITS file through byte ranges
            catalogs.py  Gaia DR3 stars for the overlay
            data/        wavelength lookup tables of the six detectors
            app.py       web API, serves the front end
            releases.json
web/        index.html, css/        the page (no build step)
            js/app.js    blink viewer
            js/skymap.js sky map (Aladin Lite)
            js/spectrum.js spectrum and light-curve plot
            js/targets.js example targets
            demo/        recorded data of the example targets, for use without the server
scripts/    poc.py       command-line version that writes a GIF
            check_astrometry.py  compares frame positions with Gaia DR3
            check_flux.py        compares measured brightness with 2MASS
            build_wavelength_tables.py  extracts the detectors' wavelength tables
            build_demo.py        records the example targets for the offline demo
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
sky map with the 102-channel SPHEREx cube and exposure footprints, Gaia DR3 overlay, spectra and light
curves on a click, quality flags and exposure list, URL parameters, embed mode, disk cache, and an
offline demo of the five example targets.

Ideas not built yet: using the quality flags to clean the spectra, labelling known asteroids, and
reading large fields faster.

## Data and acknowledgements

This project uses data products from SPHEREx, a joint project of the Jet Propulsion Laboratory and the
California Institute of Technology funded by NASA, obtained from the NASA/IPAC Infrared Science Archive
(IRSA). Positions and proper motions come from the ESA Gaia mission (DR3) and the SIMBAD database.
The interface is modelled on [WiseView](http://byw.tools/wiseview) and on IRSA's SPHEREx Data Explorer.

The sky map uses [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) (CDS, Strasbourg; GPL-3), loaded
from the jsDelivr CDN when the page opens, and the all-sky maps (SPHEREx, AllWISE, 2MASS, DSS) hosted by IRSA.
If the library cannot be loaded, the page still works without the map.
