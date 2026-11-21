"""Makes the style lab's raster fixture tiles from synthetic data, with the
raster service's own code (goatlib.raster.source), and writes what the lab's
checks need to know about them to tiles.json.

- cone.webp: a value tile of one cone on flat ground, made by
  `RasterSource.values` (what geoapi's value tiles answer, read bilinear) from
  a synthetic elevation file that covers exactly one tile. tiles.json holds its
  encoding (the `raster-dem` source's factors) next to the cone's shape.
- values-<id>.webp: a value tile of each case of the raster color contract
  (packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json)
  that colors values, not an image: the case's file laid out as geoapi's
  contract test writes it (each sample's cells in a block of its own, no data
  around), read nearest. tiles.json holds each one's encoding, the band's (or
  formula's) range, whether it is stored exactly, and each sample's code at its
  block's center.
- cone-512.webp, values-512-<id>.webp: the cone's and a few cases' value tiles
  read at 512 px, as the web asks for them (`LARGE`): the same area at twice
  the resolution, each sample's block twice as wide. tiles.json `large` names
  the size and the cases; their encodings and codes are the 256 px tiles'.
- cells.webp: a few pixels, one per cell of known color, encoded as the
  service encodes its tiles. MapLibre stretches a tile's picture over the tile,
  so each pixel is drawn as a cell many pixels wide: the browser's resampling
  shows at the cells' edges.

Run from the repository root, then format tiles.json as the web app does:
    uv run --no-sync python apps/web/lib/style/__tests__/lab/fixtures/raster/make_tiles.py
    pnpm --filter @p4b/web exec prettier --write lib/style/__tests__/lab/fixtures/raster/tiles.json
"""

import io
import json
import tempfile
import warnings
from pathlib import Path
from typing import Any, Final, Literal

import morecantile
import numpy as np
import rasterio
from goatlib.raster.formula import Formula, parse_formula
from goatlib.raster.source import RasterSource, encode_tile
from goatlib.raster.token import decode_token
from goatlib.raster.values import ValueEncoding, value_encoding
from rasterio.transform import from_bounds

HERE = Path(__file__).resolve().parent
CASES = (
    HERE.parents[7]
    / "packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json"
)
SIZE: Final = 256
#: The tile every file covers: the one whose top left corner is [0, 0].
TILE = morecantile.Tile(x=4096, y=4096, z=13)
TMS = morecantile.tms.get("WebMercatorQuad")
#: The cone: its top in the tile's middle, its radius in pixels of the tile's
#: picture (SIZE wide) and its height in meters, steep enough to shade fully at
#: the lab's zoom.
CENTER = (128, 128)
RADIUS = 96
HEIGHT = 1500
#: A case's samples sit in blocks of this many pixels, eight to a row.
BLOCK = 32
#: The tile size the web asks for, and the cases whose value tiles are made at it
#: too.
LARGE: Final = 512
LARGE_CASES = ("categories",)
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


def write_file(path: Path, data: np.ndarray, no_data: float | None) -> None:
    """Bands (count x SIZE x SIZE) as a file that covers TILE exactly."""
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=SIZE,
        height=SIZE,
        count=data.shape[0],
        dtype=data.dtype,
        crs="EPSG:3857",
        transform=from_bounds(*TMS.xy_bounds(TILE), SIZE, SIZE),
        nodata=no_data,
    ) as out:
        out.write(data)


def case_bands(case: dict[str, Any]) -> tuple[np.ndarray, float | None]:
    """The case's cells: each sample's band values in a block, no data around."""
    file = case.get("file", {})
    dtype = file.get("dtype", "float32")
    no_data = file.get("no_data", -9999)
    cells = [s.get("cells", [s["value"]]) for s in case["samples"]]
    count = max(len(c) for c in cells)
    data = np.full((count, SIZE, SIZE), no_data if no_data is not None else 0, dtype)
    for k, values in enumerate(cells):
        row, col = (k // 8) * BLOCK, (k % 8) * BLOCK
        for band, value in enumerate(values):
            data[band, row : row + BLOCK, col : col + BLOCK] = value
    return data, no_data


def block_center(k: int, tilesize: int = SIZE) -> tuple[int, int]:
    """The row and column of sample `k`'s block's center in a tile `tilesize`
    px wide."""
    block = BLOCK * tilesize // SIZE
    return (k // 8) * block + block // 2, (k % 8) * block + block // 2


def encoding_of(source: RasterSource, formula: Formula) -> ValueEncoding:
    """The formula's encoding as geoapi gives it: a formula that only names a
    band (`b2`) is that band, over its statistics' minimum and maximum; any
    other formula is over a sample's. Both read an overview at most 1024 px
    wide, which for these files is the whole file."""
    info = source.info()
    single = (
        len(formula.bands) == 1 and formula.expression.strip() == f"b{formula.bands[0]}"
    )
    if single:
        stats = source.statistics()[formula.bands[0] - 1]
        value_range = None if stats.min is None else (stats.min, stats.max)
    else:
        valid = source.sample(formula)
        value_range = (float(valid.min()), float(valid.max())) if valid.size else None
    return value_encoding(
        info.dtype,
        scaled=info.scaled,
        value_range=value_range,
        formula=not single,
    )


def value_tile(
    path: Path,
    formula: Formula,
    resampling: Literal["nearest", "bilinear"],
    tilesize: Literal[256, 512] = SIZE,
) -> tuple[bytes, ValueEncoding]:
    """The file's value tile at TILE, `tilesize` px wide, and its encoding."""
    with RasterSource(None, stored_file=path) as source:
        encoding = encoding_of(source, formula)
        tile = source.values(
            TILE.z,
            TILE.x,
            TILE.y,
            formula,
            encoding,
            resampling=resampling,
            tilesize=tilesize,
        )
    if tile is None:
        raise RuntimeError(f"{path.name} gave no tile.")
    return tile, encoding


def codes(tile: bytes) -> np.ndarray:
    """Each pixel's code `q` (R * 65536 + G * 256 + B) of a value tile."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
        with rasterio.MemoryFile(io.BytesIO(tile)) as f, f.open() as src:
            rgb = src.read((1, 2, 3)).astype("int64")
    return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]


def cone_tile(
    tmp: Path, tilesize: Literal[256, 512] = SIZE
) -> tuple[bytes, ValueEncoding]:
    path = tmp / "cone.tif"
    write_file(path, cone()[np.newaxis], None)
    return value_tile(path, parse_formula("b1"), "bilinear", tilesize)


def case_tiles(
    tmp: Path, tilesize: Literal[256, 512] = SIZE, ids: tuple[str, ...] | None = None
) -> dict[str, tuple[bytes, dict[str, Any]]]:
    """Each value case's tile (`tilesize` px wide; the cases `ids`, else all) and
    what tiles.json holds about it, by case id."""
    out = {}
    for case in json.loads(CASES.read_text()):
        if decode_token(case["token"]).kind == "rgb":
            continue
        if ids is not None and case["id"] not in ids:
            continue
        path = tmp / f"{case['id']}.tif"
        write_file(path, *case_bands(case))
        # The band or formula the case's style colors.
        band = case["style"]["render"].get("band", 1)
        formula = parse_formula(
            band["expression"] if isinstance(band, dict) else f"b{band}"
        )
        tile, encoding = value_tile(path, formula, "nearest", tilesize)
        q = codes(tile)
        out[case["id"]] = (
            tile,
            {
                "encoding": encoding.factors(),
                "range": list(encoding.range) if encoding.range else None,
                "integer": encoding.integer,
                "codes": [
                    int(q[block_center(k, tilesize)])
                    for k in range(len(case["samples"]))
                ],
            },
        )
    return out


def cells_tile() -> bytes:
    rgba = np.zeros((len(CELLS), len(CELLS[0]), 4), dtype="uint8")
    for i, line in enumerate(CELLS):
        for j, color in enumerate(line):
            rgba[i, j, :3] = [int(color[k : k + 2], 16) for k in (1, 3, 5)]
    rgba[..., 3] = 255
    return encode_tile(rgba)


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cone_bytes, cone_encoding = cone_tile(Path(tmp))
        cases = case_tiles(Path(tmp))
        large_cone, large_cone_encoding = cone_tile(Path(tmp), LARGE)
        large_cases = case_tiles(Path(tmp), LARGE, LARGE_CASES)
    # A 512 px tile holds the same values in the same encoding: the lab reads the
    # 256 px tiles' facts for it.
    if large_cone_encoding != cone_encoding:
        raise RuntimeError("The 512 px cone has another encoding.")
    for case_id, (_, about) in large_cases.items():
        if about != cases[case_id][1]:
            raise RuntimeError(f"The 512 px tile of {case_id} holds other codes.")
    (HERE / "cone.webp").write_bytes(cone_bytes)
    (HERE / f"cone-{LARGE}.webp").write_bytes(large_cone)
    for case_id, (tile, _) in cases.items():
        (HERE / f"values-{case_id}.webp").write_bytes(tile)
    for case_id, (tile, _) in large_cases.items():
        (HERE / f"values-{LARGE}-{case_id}.webp").write_bytes(tile)
    (HERE / "cells.webp").write_bytes(cells_tile())
    facts = {
        "cone": {
            "encoding": cone_encoding.factors(),
            "size": SIZE,
            "center": list(CENTER),
            "radius": RADIUS,
            "height": HEIGHT,
        },
        "cells": CELLS,
        "values": {case_id: about for case_id, (_, about) in cases.items()},
        "large": {"size": LARGE, "values": list(LARGE_CASES)},
    }
    (HERE / "tiles.json").write_text(json.dumps(facts, indent=2) + "\n")


if __name__ == "__main__":
    main()
