"""A remote FITS file opened through HTTP range requests.

Lets astropy walk the extensions of a 60+ MB file in S3 while downloading
only the headers and the small tables it actually reads.
"""
from __future__ import annotations

import io

import requests

from . import archive


class RangeFile(io.RawIOBase):
    """Read-only, seekable view of a URL that supports byte ranges."""

    def __init__(self, url: str):
        super().__init__()
        self.url = url
        self.pos = 0
        head = requests.head(url, timeout=(10, 30))
        head.raise_for_status()
        self.size = int(head.headers["Content-Length"])

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self.pos = offset
        elif whence == io.SEEK_CUR:
            self.pos += offset
        else:
            self.pos = self.size + offset
        self.pos = max(0, self.pos)
        return self.pos

    def readinto(self, buffer) -> int:
        count = min(len(buffer), self.size - self.pos)
        if count <= 0:
            return 0
        data = archive.get_range(self.url, self.pos, self.pos + count - 1)
        buffer[: len(data)] = data
        self.pos += len(data)
        return len(data)


def open_remote(url: str, buffer_size: int = 512 * 1024) -> io.BufferedReader:
    """File object for ``astropy.io.fits.open``; reads ahead in ``buffer_size`` chunks."""
    return io.BufferedReader(RangeFile(url), buffer_size=buffer_size)
