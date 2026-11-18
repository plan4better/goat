"""Makes the style lab's raster fixture tiles from synthetic data, with the
raster service's own code (goatlib.raster.source), and writes what the lab's
checks need to know about them to tiles.json.

- dem.webp: a Terrarium elevation tile of one cone on flat ground, made by
  `RasterSource.dem` (what geoapi's elevation route answers) from a synthetic
  elevation file that covers exactly one tile.
- cells.webp: a few pixels, one per cell of known color, encoded as the
  service encodes its tiles. MapLibre stretches a tile's picture over the tile,
  so each pixel is drawn as a cell many pixels wide: the browser's resampling
  shows at the cells' edges.

Run from the repository root, then format tiles.json as the web app does:
    uv run --no-sync python apps/web/lib/style/__tests__/lab/fixtures/raster/make_tiles.py
    pnpm --filter @p4b/web exec prettier --write lib/style/__tests__/lab/fixtures/raster/tiles.json
"""

import json
import tempfile
from pathlib import Path

import morecantile
import numpy as np
import rasterio
from goatlib.raster.source import RasterSource, encode_tile
from rasterio.transform import from_bounds

HERE = Path(__file__).resolve().parent
SIZE = 256
#: The tile the elevation file covers: the one whose top left corner is [0, 0].
TILE = morecantile.Tile(x=4096, y=4096, z=13)
TMS = morecantile.tms.get("WebMercatorQuad")
#: The cone: its top in the tile's middle, its radius in pixels of the tile's
#: picture (SIZE wide) and its height in meters, steep enough to shade fully at
#: the lab's zoom.
CENTER = (128, 128)
RADIUS = 96
HEIGHT = 1500
#: The cells' colors, row by row from the top.
CELLS = [
    ["#e41a1c", "#377eb8", "#4daf4a", "#984ea3"],
    ["#ff7f00", "#ffff33", "#a65628", "#f781bf"],
    ["#1b9e77", "#d95f02", "#7570b3", "#e7298a"],
    ["#66a61e", "#e6ab02", "#a6761d", "#666666"],
]


def cone() -> np.ndarray:
    y, x = np.mgrid[0:SIZE, 0:SIZE] + 0.5
    r = np.hypot(x - CENTER[0], y - CENTER[1])
    return np.clip(HEIGHT * (1 - r / RADIUS), 0, None).astype("float32")


def dem_tile() -> bytes:
    bounds = TMS.xy_bounds(TILE)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cone.tif"
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=SIZE,
            height=SIZE,
            count=1,
            dtype="float32",
            crs="EPSG:3857",
            transform=from_bounds(*bounds, SIZE, SIZE),
        ) as out:
            out.write(cone(), 1)
        with RasterSource(None, stored_file=path) as source:
            tile = source.dem(TILE.z, TILE.x, TILE.y)
    if tile is None:
        raise RuntimeError("The elevation file gave no tile.")
    return tile


def cells_tile() -> bytes:
    rgba = np.zeros((len(CELLS), len(CELLS[0]), 4), dtype="uint8")
    for i, line in enumerate(CELLS):
        for j, color in enumerate(line):
            rgba[i, j, :3] = [int(color[k : k + 2], 16) for k in (1, 3, 5)]
    rgba[..., 3] = 255
    return encode_tile(rgba)


def main() -> None:
    (HERE / "dem.webp").write_bytes(dem_tile())
    (HERE / "cells.webp").write_bytes(cells_tile())
    facts = {
        "cone": {
            "size": SIZE,
            "center": list(CENTER),
            "radius": RADIUS,
            "height": HEIGHT,
        },
        "cells": CELLS,
    }
    (HERE / "tiles.json").write_text(json.dumps(facts, indent=2) + "\n")


if __name__ == "__main__":
    main()
