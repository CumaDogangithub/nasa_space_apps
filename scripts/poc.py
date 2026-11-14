"""Proof of concept: sky position -> blink GIF of SPHEREx epoch stacks.

Examples
--------
python scripts/poc.py --name barnard --ra 269.4486 --dec 4.7388 --band 2
python scripts/poc.py --name wise0855 --ra 133.7951 --dec -7.2451 --band 6 --fov 360

``--track ra,dec,epoch_year,pmra,pmdec`` (deg, deg, yr, mas/yr, mas/yr) marks
where a known moving object should be in each frame.
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import archive, config, pipeline  # noqa: E402

OUT = config.ROOT / "out"


def stretch(img: np.ndarray, lo: float, hi: float, a: float = 6.0) -> np.ndarray:
    x = np.clip((img - lo) / max(hi - lo, 1e-12), 0, 1)
    y = np.arcsinh(a * x) / math.asinh(a)
    return (255 * np.where(np.isnan(img), 0, y)).astype(np.uint8)


def predicted_xy(grid, track, mjd, zoom):
    ra0, dec0, epoch, pmra, pmdec = track
    dt = (mjd - (51544.5 + (epoch - 2000.0) * 365.25)) / 365.25
    dec = dec0 + pmdec * dt / 3.6e6
    ra = ra0 + pmra * dt / 3.6e6 / math.cos(math.radians(dec0))
    x, y = grid.wcs.all_world2pix(ra, dec, 0)
    return (float(x) + 0.5) * zoom, (grid.n - 1 - float(y) + 0.5) * zoom


def render(frame, lo, hi, zoom, label, mark=None, signed=False):
    if signed:
        x = np.clip(0.5 + 0.5 * frame / hi, 0, 1)
        arr = (255 * np.where(np.isfinite(frame), x, 0.5)).astype(np.uint8)
    else:
        arr = stretch(frame, lo, hi)
    im = Image.fromarray(arr, "L").resize((frame.shape[1] * zoom, frame.shape[0] * zoom), Image.BICUBIC).convert("RGB")
    d = ImageDraw.Draw(im)
    d.text((6, 4), label, fill=(255, 220, 80))
    if mark:
        x, y = mark
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            d.line([x + dx * 7, y + dy * 7, x + dx * 16, y + dy * 16], fill=(80, 255, 120), width=1)
    return im


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--ra", type=float, required=True)
    ap.add_argument("--dec", type=float, required=True)
    ap.add_argument("--band", type=int, default=2)
    ap.add_argument("--fov", type=float, default=240.0)
    ap.add_argument("--zoom", type=int, default=5)
    ap.add_argument("--track", default=None)
    args = ap.parse_args()

    def progress(label, done, total):
        if done == total or done % 20 == 0:
            print(f"  {label}: {done}/{total}", flush=True)

    t0 = time.time()
    res = pipeline.build_band(args.ra, args.dec, args.fov, args.band, progress)
    frames, meta, st = res["frames"], res["epochs"], res["stats"]
    print(f"band D{args.band}: {res['n_found']} images found, {res['n_used']} used, "
          f"{len(meta)} epoch frames, grid {res['n']}x{res['n']} @ {res['scale']:.2f}\"/px")
    print("timing (s):", {k: round(v, 1) for k, v in res["timing"].items()}, "total", round(time.time() - t0, 1))
    print(f"downloaded: {archive.stats['requests']} requests, {archive.stats['bytes'] / 1e6:.1f} MB")
    for m in meta:
        print(f"  epoch {m['epoch']}: {m['date_start']}..{m['date_end']} n={m['n_exposures']} noise={m['noise']:.4f}")
    if not len(frames):
        print("no frames")
        return

    track = tuple(float(v) for v in args.track.split(",")) if args.track else None
    grid = pipeline.make_grid(args.ra, args.dec, args.fov)
    lo, hi = -3 * st["noise"], 40 * st["noise"]
    images = []
    for frame, m in zip(frames, meta):
        mark = predicted_xy(grid, track, m["mjd"], args.zoom) if track else None
        images.append(render(frame, lo, hi, args.zoom, f"D{args.band}  {m['date']}  n={m['n_exposures']}", mark))

    OUT.mkdir(exist_ok=True)
    stem = OUT / f"{args.name}_D{args.band}"
    images[0].save(f"{stem}.gif", save_all=True, append_images=images[1:], duration=700, loop=0)

    panels = list(images)
    if len(frames) > 1:
        # difference of the two deepest epochs (later minus earlier)
        a, b = sorted(sorted(range(len(meta)), key=lambda i: -meta[i]["n_exposures"])[:2])
        diff = frames[b] - frames[a]
        label = f"{meta[b]['date']} - {meta[a]['date']}"
        panels.append(render(diff, 0, 8 * st["noise"], args.zoom, label, signed=True))
    w, h = panels[0].size
    sheet = Image.new("RGB", (w * len(panels) + 4 * (len(panels) - 1), h), (30, 30, 30))
    for i, p in enumerate(panels):
        sheet.paste(p, (i * (w + 4), 0))
    sheet.save(f"{stem}_sheet.png")
    print("wrote", f"{stem}.gif", "and", f"{stem}_sheet.png")


if __name__ == "__main__":
    main()
