"""Small COGs served over HTTP with range requests, as remote raster files are."""

import threading
import time
from collections.abc import Iterator
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

rasterio = pytest.importorskip("rasterio")
from rasterio.shutil import copy as rio_copy  # noqa: E402
from rasterio.transform import from_bounds  # noqa: E402

#: A small area near Munich, in degrees.
BOUNDS = (11.50, 48.10, 11.60, 48.20)
SIZE = 512


class _RangeHandler(SimpleHTTPRequestHandler):
    """Serves files with `Range` support, a redirect (`/to/<url>` answers 302) and a
    host that never answers a read (`/stall/<file>`: HEAD answers, GET hangs)."""

    def log_message(self, *args: object) -> None:
        pass

    def do_HEAD(self) -> None:  # noqa: N802
        if self._redirect():
            return
        if self.path.startswith("/stall/"):
            real = Path(self.translate_path(self.path.replace("/stall/", "/", 1)))
            self.send_response(200)
            self.send_header("Content-Type", "image/tiff")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(real.stat().st_size))
            self.end_headers()
            return
        super().do_HEAD()

    def do_GET(self) -> None:  # noqa: N802
        if self._redirect():
            return
        if self.path.startswith("/stall/"):
            time.sleep(60)
            return
        rng = self.headers.get("Range")
        path = Path(self.translate_path(self.path))
        if not rng or not path.is_file():
            super().do_GET()
            return
        data = path.read_bytes()
        start_s, end_s = rng.removeprefix("bytes=").split("-")
        start, end = int(start_s), min(int(end_s or len(data) - 1), len(data) - 1)
        self.send_response(206)
        self.send_header("Content-Type", "image/tiff")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self.wfile.write(data[start : end + 1])

    def _redirect(self) -> bool:
        if not self.path.startswith("/to/"):
            return False
        self.send_response(302)
        self.send_header("Location", self.path.removeprefix("/to/"))
        self.end_headers()
        return True


def _write_cog(
    path: Path,
    data: np.ndarray,
    *,
    nodata: float | None = None,
    colormap=None,
    overviews: str = "AUTO",
) -> None:
    tmp = path.with_suffix(".plain.tif")
    profile = {
        "driver": "GTiff",
        "width": data.shape[2],
        "height": data.shape[1],
        "count": data.shape[0],
        "dtype": str(data.dtype),
        "crs": "EPSG:4326",
        "transform": from_bounds(*BOUNDS, data.shape[2], data.shape[1]),
        "nodata": nodata,
    }
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(data)
        if colormap:
            dst.write_colormap(1, colormap)
    rio_copy(
        tmp, path, driver="COG", BLOCKSIZE=256, OVERVIEWS=overviews, COMPRESS="DEFLATE"
    )
    tmp.unlink()


@pytest.fixture(scope="session")
def cog_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("cogs")
    y, x = np.mgrid[0:SIZE, 0:SIZE]
    elevation = (100 + x * 300 / (SIZE - 1)).astype("float32")
    elevation[:64, :64] = -9999
    _write_cog(root / "elevation.tif", elevation[None], nodata=-9999)
    rgb = np.stack([np.full((SIZE, SIZE), v, "uint8") for v in (200, 100, 50)])
    _write_cog(root / "rgb.tif", rgb)
    codes = (1 + (x // (SIZE // 4)) + (y // (SIZE // 2)) * 0).astype("uint8")
    table = {
        1: (255, 0, 0, 255),
        2: (0, 255, 0, 255),
        3: (0, 0, 255, 255),
        4: (9, 9, 9, 255),
    }
    _write_cog(root / "landcover.tif", codes[None], nodata=0, colormap=table)
    bands = np.stack([np.full((SIZE, SIZE), v, "uint16") for v in (100, 200, 300, 500)])
    _write_cog(root / "multiband.tif", bands, nodata=0)
    big = np.full((1, 8192, 8192), 7, "uint8")
    _write_cog(root / "no_overviews.tif", big, overviews="NONE")
    (root / "notatiff.tif").write_text("hello")
    return root


@pytest.fixture(scope="session")
def cog_server(cog_dir: Path) -> Iterator[str]:
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(_RangeHandler, directory=str(cog_dir))
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
