"""Keeps the disk cache within bounds.

Everything under ``cache/`` can be fetched or computed again, so when the
cache grows past its limit (``BLINK_CACHE_MB``, see config.py) the files
written longest ago are removed. The lists of images (``cache/sia``) go last:
they are what the tool falls back on when the archive's search is down.
"""
from __future__ import annotations

import os
import threading
import time

from . import config

CHECK_EVERY = 1800.0      # seconds between two looks at the cache
KEEP_SHARE = 0.8          # how full the cache is left after a clean-up
LAST = ("sia",)           # folders emptied only when everything else is gone

_started = False


def _files(folder: str) -> list[tuple[float, int, str]]:
    """(time written, size, path) of every file below a folder."""
    out = []
    stack = [folder]
    while stack:
        here = stack.pop()
        try:
            with os.scandir(here) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        else:
                            info = entry.stat(follow_symlinks=False)
                            out.append((info.st_mtime, info.st_size, entry.path))
                    except OSError:
                        continue
        except OSError:
            continue
    return out


def trim(limit_mb: float | None = None) -> dict:
    """Remove the oldest cache files if the cache is over its limit; says what it found and did."""
    limit = (config.CACHE_LIMIT_MB if limit_mb is None else limit_mb) * 1e6
    first: list[tuple[float, int, str]] = []
    last: list[tuple[float, int, str]] = []
    if config.CACHE_DIR.exists():
        with os.scandir(config.CACHE_DIR) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    (last if entry.name in LAST else first).extend(_files(entry.path))
    total = sum(size for _, size, _ in first) + sum(size for _, size, _ in last)
    count, removed = len(first) + len(last), 0
    if limit > 0 and total > limit:
        goal = limit * KEEP_SHARE
        for group in (sorted(first), sorted(last)):
            for _, size, path in group:
                if total <= goal:
                    break
                try:
                    os.remove(path)
                except OSError:
                    continue
                total -= size
                removed += 1
    return {"files": count - removed, "mb": round(total / 1e6, 1), "removed": removed}


def _keep() -> None:
    while True:
        try:
            report = trim()
            if report["removed"]:
                print(f"[cache] removed {report['removed']} old files, {report['mb']} MB left", flush=True)
        except Exception as exc:                      # the cache keeper must never take the server down
            print(f"[cache] clean-up failed: {exc}", flush=True)
        time.sleep(CHECK_EVERY)


def start() -> None:
    """Begin looking after the cache in the background (once; a limit of 0 switches it off)."""
    global _started
    if _started or config.CACHE_LIMIT_MB <= 0:
        return
    _started = True
    threading.Thread(target=_keep, name="cache-keeper", daemon=True).start()
