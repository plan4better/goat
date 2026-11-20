"""Reference value tiles: what a few fixed value tiles hold, pinned.

geoapi lets every cache keep a value tile read with content for good
(`Cache-Control: immutable`): its address names the layer's file version, the
band or formula, the resampling, the encoding's base and step, and
`ENCODING_VERSION`. Pixels that change for the same address would therefore mix
old and new tiles in caches for good. These tests read fixed tiles from small
files and pin their pixels, so such a change fails here first.

What is pinned is the decoded pixels (a hash of the RGBA array, and a few
decoded values to read a failure by), not the WebP bytes: lossless WebP keeps
the pixels exact, but another libwebp may pack them into other bytes, and the
browser only ever sees the pixels. A change in GDAL's or rio-tiler's reading
that moves a pixel trips this too, and rightly: a cached tile would no longer
match its neighbours.
"""

import hashlib
import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
import rasterio
from goatlib.raster.formula import parse_formula
from goatlib.raster.source import RasterSource
from goatlib.raster.values import ENCODING_VERSION, ValueEncoding
from rasterio.shutil import copy as rio_copy
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds

#: The files' area near Munich, in degrees, and their width and height.
BOUNDS = (11.50, 48.10, 11.60, 48.20)
SIZE = 512

BUMP = (
    "Value tiles are cached forever by their URL. A value tile now holds other "
    "pixels for the same address: bump ENCODING_VERSION in "
    "goatlib/raster/values.py (it joins every value tile's URL) and pin these "
    "tiles again under the new version. A change in how value_encoding picks "
    "base and step needs no bump: both are in the URL."
)


@dataclass(frozen=True)
class Case:
    file: str
    formula: str
    resampling: str
    tile: tuple[int, int, int]
    encoding: ValueEncoding


#: Literal encodings, as a tile's address names them (base and step).
WHOLE = ValueEncoding(base=-1.0, step=1.0, integer=False, range=None)
FINE = ValueEncoding(base=0.0, step=2.0**-15, integer=False, range=None)
RATIO = ValueEncoding(base=-1.25, step=2.0**-22, integer=False, range=None)
#: The exact path of 16 bit whole numbers: from the type's minimum, step 1.
SIGNED = ValueEncoding(base=-32769.0, step=1.0, integer=False, range=None)
#: A scaled band's values (cells times scale plus offset).
SCALED = ValueEncoding(base=-10.0, step=2.0**-16, integer=False, range=None)
#: z, x, y: a tile inside the files, one over their north-west corner (the
#: no-data block and the area outside the file), and one zoomed out so far
#: that it is read from the files' overview.
INSIDE = (13, 4358, 2842)
CORNER = (14, 8715, 5681)
COARSE = (11, 1089, 710)

#: A file in degrees is reprojected for a tile, a file in Web Mercator only
#: resized: the resampling asked for is the reprojection's and the read's.
CASES = {
    "uint8 nearest": Case("codes.tif", "b1", "nearest", INSIDE, WHOLE),
    "uint8 bilinear": Case("codes.tif", "b1", "bilinear", INSIDE, WHOLE),
    "float32 bilinear": Case("surface.tif", "b1", "bilinear", INSIDE, FINE),
    "float32 nearest": Case("surface.tif", "b1", "nearest", INSIDE, FINE),
    "float32 corner": Case("surface.tif", "b1", "bilinear", CORNER, FINE),
    "formula bilinear": Case(
        "pair.tif", "(b2 - b1) / (b2 + b1)", "bilinear", INSIDE, RATIO
    ),
    "web mercator bilinear": Case("mercator.tif", "b1", "bilinear", INSIDE, FINE),
    "web mercator nearest": Case("mercator.tif", "b1", "nearest", INSIDE, FINE),
    "float32 overview": Case("surface.tif", "b1", "bilinear", COARSE, FINE),
    "int16 nearest": Case("signed.tif", "b1", "nearest", INSIDE, SIGNED),
    "uint16 bilinear": Case("pair.tif", "b2", "bilinear", INSIDE, WHOLE),
    "scaled bilinear": Case("scaled.tif", "b1", "bilinear", INSIDE, SCALED),
}

#: Per `ENCODING_VERSION`: each case's pixel hash and decoded summary
#: (no-data pixels, minimum, maximum, and the values at three pixels).
PINNED: dict[str, dict[str, dict[str, object]]] = {
    "e2": {
        "uint8 nearest": {
            "sha256": "8a94260abc539b7a88e7c9ea7eba92ce05cd25b2acede7028d9fde3707769a7c",
            "no_data": 2346,
            "min": 1.0,
            "max": 250.0,
            "at": [10.0, None, 149.0],
        },
        "uint8 bilinear": {
            "sha256": "e48dfb5e46b4158784847647e2da875ec1140f5d2a3c8bfe7b74055a9ee1be29",
            "no_data": 2346,
            "min": 1.0,
            "max": 250.0,
            "at": [11.0, None, 150.0],
        },
        "float32 bilinear": {
            "sha256": "9a8114681fe6bcf630d5e298bd0127ed9791af85be4471850b5b211024f1f97d",
            "no_data": 0,
            "min": 113.45748901367188,
            "max": 291.2685546875,
            "at": [126.12582397460938, 196.4761962890625, 113.74203491210938],
        },
        "float32 nearest": {
            "sha256": "4ec337ec49e80726abb821e4eb9312f23c5fb63955d77945a9bd4ccf585e70cb",
            "no_data": 0,
            "min": 113.45269775390625,
            "max": 291.2757263183594,
            "at": [126.17855834960938, 196.82769775390625, 113.74578857421875],
        },
        "float32 corner": {
            "sha256": "c0b49804b33ed9b2331486426b3ebb59f2687eea7a7a76ab56506b6d74b05698",
            "no_data": 64402,
            "min": 128.18548583984375,
            "max": 140.67333984375,
            "at": [None, None, None],
        },
        "formula bilinear": {
            "sha256": "6de48bcb392e5d22608a7f93de91b1f66a21a2cd4031b4aa73f3938a29b8fcb3",
            "no_data": 0,
            "min": 0.0016694068908691406,
            "max": 0.7997996807098389,
            "at": [0.7137329578399658, 0.3777778148651123, 0.7142856121063232],
        },
        "web mercator bilinear": {
            "sha256": "a2a1fb7c2c929ae9d613113d969d4ba9c53b310297fd2f4588a85b483947407f",
            "no_data": 0,
            "min": 113.4583740234375,
            "max": 291.2677001953125,
            "at": [126.10247802734375, 196.46505737304688, 113.72308349609375],
        },
        "web mercator nearest": {
            "sha256": "d2e5253a3a1954cc0bc0d255f188152a22ba547d113d4aecdcb7692fd6dfa3e5",
            "no_data": 0,
            "min": 113.45269775390625,
            "max": 291.2757263183594,
            "at": [125.96893310546875, 196.74298095703125, 113.74578857421875],
        },
        "float32 overview": {
            "sha256": "6c0ebceb37f14d3d2cf28c66551cfcc84dfcc764366bce3e09565fb8b71991a8",
            "no_data": 36530,
            "min": 50.29443359375,
            "max": 427.72186279296875,
            "at": [None, 125.53506469726562, None],
        },
        "int16 nearest": {
            "sha256": "9fefee7809684255e56708715d76abc010474bed7d83521b8c842dce92e56e67",
            "no_data": 1886,
            "min": -2949.0,
            "max": 2977.0,
            "at": [-2949.0, 95.0, 2063.0],
        },
        "uint16 bilinear": {
            "sha256": "f0ee991e3ec9727ed0309e78dd4466f14b29f4963c1c6aa51d1bf75ebd719ae5",
            "no_data": 0,
            "min": 300.0,
            "max": 899.0,
            "at": [886.0, 403.0, 642.0],
        },
        "scaled bilinear": {
            "sha256": "36771ac7fb169eb5613e3977873cda750bc98e270981464992d12cf6ef73676f",
            "no_data": 0,
            "min": 39.959991455078125,
            "max": 139.3300018310547,
            "at": [39.959991455078125, 89.83999633789062, 66.48001098632812],
        },
    },
}


def _write(
    path: Path,
    data: np.ndarray,
    nodata: float,
    crs: str = "EPSG:4326",
    scale: tuple[float, float] | None = None,
) -> None:
    """A COG of `data` over `BOUNDS`, in `crs`, with `scale` (scale and offset)
    when given. Its overview takes every other cell (nearest), so the coarse
    case reads cells as written, whatever GDAL's default for overviews."""
    bounds = transform_bounds("EPSG:4326", crs, *BOUNDS)
    plain = path.with_suffix(".plain.tif")
    count, height, width = data.shape
    with rasterio.open(
        plain,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=count,
        dtype=str(data.dtype),
        crs=crs,
        transform=from_bounds(*bounds, width, height),
        nodata=nodata,
    ) as dst:
        dst.write(data)
        if scale is not None:
            dst.scales = (scale[0],) * count
            dst.offsets = (scale[1],) * count
    rio_copy(
        plain,
        path,
        driver="COG",
        BLOCKSIZE=256,
        COMPRESS="DEFLATE",
        OVERVIEW_RESAMPLING="NEAREST",
    )
    plain.unlink()


@pytest.fixture(scope="module")
def files(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("reference")
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype("float64")
    codes = ((x * 7 + y * 3) % 250 + 1).astype("uint8")
    codes[230:260, 150:190] = 0
    _write(root / "codes.tif", codes[None], nodata=0)
    surface = 100 + 300 * x / (SIZE - 1) + 50 * np.sin(y / 23) * np.cos(x / 37)
    surface = surface.astype("float32")
    _write(root / "mercator.tif", surface[None], -9999, crs="EPSG:3857")
    surface[:64, :64] = -9999
    _write(root / "surface.tif", surface[None], nodata=-9999)
    b1 = 200 + 100 * np.sin(x / 19)
    b2 = 600 + 300 * np.cos(y / 29)
    _write(root / "pair.tif", np.stack([b1, b2]).astype("uint16"), nodata=0)
    signed = (500 * np.sin(x / 41) * np.cos(y / 53) * 6).astype("int16")
    signed[300:340, 100:140] = -32768
    _write(root / "signed.tif", signed[None], nodata=-32768)
    # Hundredths of a degree from -5: what a temperature file stores.
    raw = (x * 37 + y * 11).astype("int16")
    _write(root / "scaled.tif", raw[None], nodata=-1, scale=(0.01, -5.0))
    return root


def _pixels(data: bytes) -> np.ndarray:
    """A value tile's RGBA pixels; a decoder may leave out an all-opaque alpha."""
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    with rasterio.MemoryFile(io.BytesIO(data)) as f, f.open() as src:
        pixels = np.moveaxis(src.read(), 0, -1)
    if pixels.shape[2] == 3:
        pixels = np.dstack([pixels, np.full(pixels.shape[:2], 255, "uint8")])
    return np.ascontiguousarray(pixels, dtype="uint8")


def _summary(case: Case, pixels: np.ndarray) -> dict[str, object]:
    values = case.encoding.decode(pixels)

    def at(row: int, col: int) -> float | None:
        v = float(values[row, col])
        return None if np.isnan(v) else v

    return {
        "sha256": hashlib.sha256(pixels.tobytes()).hexdigest(),
        "no_data": int(np.isnan(values).sum()),
        "min": float(np.nanmin(values)) if np.isfinite(values).any() else None,
        "max": float(np.nanmax(values)) if np.isfinite(values).any() else None,
        "at": [at(0, 0), at(128, 128), at(255, 31)],
    }


def test_the_pins_are_for_this_encoding_version() -> None:
    assert ENCODING_VERSION in PINNED, (
        f"Pin the reference value tiles for ENCODING_VERSION {ENCODING_VERSION!r}: "
        "the failures of the test below print each tile's new pin."
    )


@pytest.mark.parametrize("name", list(CASES))
def test_a_reference_value_tile_holds_its_pinned_pixels(files: Path, name: str) -> None:
    case = CASES[name]
    with RasterSource(None, stored_file=files / case.file) as src:
        data = src.values(
            *case.tile, parse_formula(case.formula), case.encoding, case.resampling
        )
    assert data is not None, name
    pixels = _pixels(data)
    assert pixels.shape == (256, 256, 4) and np.all(pixels[..., 3] == 255)
    got = _summary(case, pixels)
    pinned = PINNED.get(ENCODING_VERSION, {}).get(name)
    assert got == pinned, f"{BUMP}\n{name}: {got!r}"
