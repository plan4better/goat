"""geoapi's side of the raster color contract (the web's side:
`apps/web/lib/style/__tests__/raster-color-contract.test.ts`). Each case of the
shared fixture holds a style, the token the web compiles from it and sample
cells with their colors. Here the raster tile route colors a small synthetic
file with that token, and each sample's pixel must be its color (transparent
where the color is null). The web's test checks the same colors against the
compiled token and the legend. The value tiles of the same file hold each
sample's value, which the browser colors.

Each case gets its own file: one 256 px tile of Web Mercator, so the tile route
reads its cells one to one, with each sample in a block of its own and the rest
no data."""

import io
import json
import warnings
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import morecantile
import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from goatlib.raster.token import decode_token
from goatlib.raster.values import ValueEncoding
from rasterio.transform import from_bounds

from geoapi.services import raster_service as rs

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json"
)
CASES: list[dict[str, Any]] = json.loads(FIXTURE.read_text())
#: The cases the browser colors from value tiles: all but the images.
VALUE_CASES = [c for c in CASES if decode_token(c["token"]).kind != "rgb"]

LAYER = "abc123def456789012345678901234cd"
TMS = morecantile.tms.get("WebMercatorQuad")
TILE = TMS.tile(11.55, 48.15, 14)
SIZE = 256
#: Samples sit in blocks of this many pixels, eight to a row.
BLOCK = 32
#: The largest difference per channel (0 to 255) a pixel may have.
TOLERANCE = 2


def _block_center(k: int) -> tuple[int, int]:
    return (k // 8) * BLOCK + BLOCK // 2, (k % 8) * BLOCK + BLOCK // 2


def _write_file(path: Path, case: dict[str, Any]) -> None:
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
    b = TMS.xy_bounds(TILE)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=SIZE,
        height=SIZE,
        count=count,
        dtype=dtype,
        crs="EPSG:3857",
        transform=from_bounds(b.left, b.bottom, b.right, b.top, SIZE, SIZE),
        nodata=no_data,
    ) as dst:
        dst.write(data)


def _pixels(data: bytes) -> np.ndarray:
    """A tile's RGBA pixels; tiles are lossless WebP, whose all-opaque alpha a
    decoder leaves out."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
        with rasterio.MemoryFile(io.BytesIO(data)) as f, f.open() as src:
            pixels = np.moveaxis(src.read(), 0, -1)
    if pixels.shape[2] == 3:
        pixels = np.dstack([pixels, np.full(pixels.shape[:2], 255, "uint8")])
    return pixels


def _rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


@pytest.fixture
def raster_file(
    test_client: TestClient, tmp_path: Path, request: pytest.FixtureRequest
) -> Iterator[tuple[TestClient, dict[str, Any]]]:
    case = request.param
    path = tmp_path / f"{case['id']}.tif"
    _write_file(path, case)
    row = rs.RasterLayer(
        id=LAYER, external_url=None, version=case["id"], stored_file=path
    )
    rs.raster_service.clear()
    with patch.object(rs.raster_service, "layer", AsyncMock(return_value=row)):
        yield test_client, case
    rs.raster_service.clear()


def test_the_fixture_has_cases() -> None:
    assert len(CASES) >= 10
    assert all(c["token"] for c in CASES)
    assert all(len(c["samples"]) <= (SIZE // BLOCK) ** 2 for c in CASES)


@pytest.mark.parametrize(
    "raster_file", CASES, ids=[c["id"] for c in CASES], indirect=True
)
def test_a_tile_paints_each_sample_in_its_color(
    raster_file: tuple[TestClient, dict[str, Any]],
) -> None:
    client, case = raster_file
    r = client.get(
        f"/collections/{LAYER}/raster/tiles/{TILE.z}/{TILE.x}/{TILE.y}.webp"
        f"?style={case['token']}"
    )
    assert r.status_code == 200, r.text
    pixels = _pixels(r.content)
    wrong = []
    for k, sample in enumerate(case["samples"]):
        y, x = _block_center(k)
        red, green, blue, alpha = (int(v) for v in pixels[y, x])
        cell = sample.get("cells", [sample["value"]])
        if sample["color"] is None:
            if alpha != 0:
                wrong.append(
                    f"{cell}: painted #{red:02x}{green:02x}{blue:02x}, not transparent"
                )
            continue
        expected = _rgb(sample["color"])
        # Opacity is the browser's paint property: the service paints opaque.
        if alpha != 255 or any(
            abs(a - b) > TOLERANCE for a, b in zip((red, green, blue), expected)
        ):
            wrong.append(
                f"{cell}: painted #{red:02x}{green:02x}{blue:02x} alpha {alpha}, "
                f"expected {sample['color']}"
            )
    assert wrong == []


@pytest.mark.parametrize(
    "raster_file", VALUE_CASES, ids=[c["id"] for c in VALUE_CASES], indirect=True
)
def test_a_value_tile_holds_each_samples_value(
    raster_file: tuple[TestClient, dict[str, Any]],
) -> None:
    client, case = raster_file
    band = case["style"]["render"].get("band")
    if isinstance(band, dict):
        query = f"formula={band['expression']}"
    else:
        query = f"band={band or 1}"
    coverage = f"/collections/{LAYER}/coverage/tiles/WebMercatorQuad"
    described = client.get(f"{coverage}?{query}")
    assert described.status_code == 200, described.text
    values = described.json()["goat:values"]
    factors = values["encoding"]
    encoding = ValueEncoding(
        base=-factors["baseShift"],
        step=factors["blueFactor"],
        integer=values["integer"],
        range=tuple(values["range"]) if values["range"] else None,
    )
    # The tile at the description's link, which names the encoding.
    href = described.json()["links"][0]["href"].removeprefix("http://testserver")
    for name, value in (
        ("tileMatrix", TILE.z),
        ("tileRow", TILE.y),
        ("tileCol", TILE.x),
    ):
        href = href.replace(f"{{{name}}}", str(value))
    r = client.get(href)
    assert r.status_code == 200, r.text
    decoded = encoding.decode(_pixels(r.content))
    no_data = case.get("file", {}).get("no_data", -9999)
    wrong = []
    for k, sample in enumerate(case["samples"]):
        y, x = _block_center(k)
        value = float(decoded[y, x])
        cells = sample.get("cells", [sample["value"]])
        if no_data is not None and no_data in cells:
            if not np.isnan(value):
                wrong.append(f"{cells}: {value}, not no data")
        elif not abs(value - sample["value"]) <= encoding.step:
            wrong.append(f"{cells}: {value}, expected {sample['value']}")
    assert wrong == []


@pytest.mark.parametrize("raster_file", VALUE_CASES[:1], indirect=True)
def test_512_px_tiles_hold_the_same_samples_at_twice_the_width(
    raster_file: tuple[TestClient, dict[str, Any]],
) -> None:
    """The web asks for 512 px tiles: the same area at twice the resolution,
    whose description names the file's bounds."""
    client, case = raster_file
    coverage = f"/collections/{LAYER}/coverage/tiles/WebMercatorQuad"
    # Nearest: each pixel holds its cell's own value.
    small = client.get(f"{coverage}?band=1&resampling=nearest").json()
    large = client.get(f"{coverage}?band=1&resampling=nearest&tilesize=512").json()
    # A file of one 256 px tile: a 512 px tile shows its cells at their own
    # size one zoom higher up, but the native zoom stays at its minzoom.
    assert large["maxzoom"] == small["maxzoom"] == TILE.z
    b = TMS.bounds(TILE)
    assert large["bounds"] == pytest.approx([b.left, b.bottom, b.right, b.top])
    assert large["bounds"] == small["bounds"]
    href = large["links"][0]["href"].removeprefix("http://testserver")
    for name, value in (
        ("tileMatrix", TILE.z),
        ("tileRow", TILE.y),
        ("tileCol", TILE.x),
    ):
        href = href.replace(f"{{{name}}}", str(value))
    assert "tilesize=512" in href
    values = client.get(href)
    image = client.get(
        f"/collections/{LAYER}/raster/tiles/{TILE.z}/{TILE.x}/{TILE.y}.webp"
        f"?style={case['token']}&tilesize=512"
    )
    small_values = client.get(href.replace("&tilesize=512", ""))
    small_image = client.get(image.url.path + f"?style={case['token']}")
    for r in (values, image, small_values, small_image):
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "image/webp"
    # Each pixel of the 256 px tile is a block of two by two pixels of the 512.
    for large_tile, small_tile in ((values, small_values), (image, small_image)):
        pixels = _pixels(large_tile.content)
        assert pixels.shape == (512, 512, 4)
        assert np.array_equal(pixels[::2, ::2], _pixels(small_tile.content))
