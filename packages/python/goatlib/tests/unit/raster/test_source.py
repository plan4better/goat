import io

import morecantile
import numpy as np
import pytest
import rasterio
from goatlib.io.remote_source.url_guard import UnsafeUrlError
from goatlib.raster.formula import parse_formula
from goatlib.raster.source import RasterSource, RasterUnavailableError, resolve_address
from goatlib.raster.token import decode_token, encode_token

from .conftest import BOUNDS

LOCAL = ("127.0.0.1",)
TMS = morecantile.tms.get("WebMercatorQuad")
CENTER = ((BOUNDS[0] + BOUNDS[2]) / 2, (BOUNDS[1] + BOUNDS[3]) / 2)


def _png(data: bytes) -> np.ndarray:
    """A tile's RGBA pixels; tiles are lossless WebP, whose all-opaque alpha a
    decoder leaves out."""
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    with rasterio.MemoryFile(io.BytesIO(data)) as f, f.open() as src:
        pixels = np.moveaxis(src.read(), 0, -1)
    if pixels.shape[2] == 3:
        pixels = np.dstack([pixels, np.full(pixels.shape[:2], 255, "uint8")])
    return pixels


def _tile_at(lon: float, lat: float, zoom: int) -> tuple[int, int, int]:
    t = TMS.tile(lon, lat, zoom)
    return t.z, t.x, t.y


def _pixel_of(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    t = TMS.tile(lon, lat, zoom)
    b = TMS.xy_bounds(t)
    x, y = TMS.xy(lon, lat)
    return int((b.top - y) / (b.top - b.bottom) * 256), int(
        (x - b.left) / (b.right - b.left) * 256
    )


def ramp() -> object:
    spec = {
        "v": 1,
        "kind": "ramp",
        "band": 1,
        "noData": [],
        "colors": ["#000000", "#ffffff"],
        "domain": [100, 400],
        "outside": "clamp",
    }
    return decode_token(encode_token(spec))


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "/vsicurl/http://example.com/x.tif",
        "s3://bucket/x.tif",
        "http://127.0.0.1/x.tif",
        "http://10.1.2.3/x.tif",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/x.tif",
    ],
)
def test_only_http_addresses_of_public_hosts_open(url: str) -> None:
    with pytest.raises(UnsafeUrlError):
        resolve_address(url)


def test_a_listed_private_host_opens_but_a_redirect_to_another_does_not(
    cog_server: str,
) -> None:
    assert (
        resolve_address(f"{cog_server}/elevation.tif", LOCAL)
        == f"{cog_server}/elevation.tif"
    )
    with pytest.raises(UnsafeUrlError):
        resolve_address(f"{cog_server}/to/http://10.1.2.3/x.tif", LOCAL)
    assert (
        resolve_address(f"{cog_server}/to/{cog_server}/rgb.tif", LOCAL)
        == f"{cog_server}/rgb.tif"
    )


def test_info_describes_the_file(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/landcover.tif", LOCAL) as src:
        info = src.info()
    assert info.count == 1 and info.dtype == "uint8" and info.nodata == 0
    assert info.color_table[1][:3] == (255, 0, 0)
    assert info.bits == (8,)
    assert info.bounds == pytest.approx(BOUNDS, abs=1e-6)


def test_a_tile_is_colored_from_the_overview_the_zoom_needs(cog_server: str) -> None:
    z, x, y = _tile_at(*CENTER, 13)
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        rgba = _png(src.tile(z, x, y, ramp()))
        low = _png(src.tile(*_tile_at(*CENTER, 9), ramp()))
    row, col = _pixel_of(*CENTER, 13)
    # The center is 250 m of 100..400: half way, mid grey.
    assert abs(int(rgba[row, col, 0]) - 128) <= 3 and rgba[row, col, 3] == 255
    assert rgba.shape[:2] == (256, 256) and low.shape[:2] == (256, 256)


def test_outside_the_file_there_is_no_tile(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        assert src.tile(*_tile_at(0.0, 0.0, 10), ramp()) is None


def test_the_files_no_data_is_transparent_in_a_tile(cog_server: str) -> None:
    corner = (BOUNDS[0] + 0.002, BOUNDS[3] - 0.002)
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        rgba = _png(src.tile(*_tile_at(*corner, 14), ramp()))
    row, col = _pixel_of(*corner, 14)
    assert rgba[row, col, 3] == 0


def test_an_image_without_bands_draws_the_color_table(cog_server: str) -> None:
    image = decode_token(
        encode_token({"v": 1, "kind": "rgb", "bands": None, "noData": []})
    )
    left = (BOUNDS[0] + 0.01, CENTER[1])
    with RasterSource(f"{cog_server}/landcover.tif", LOCAL) as src:
        rgba = _png(src.tile(*_tile_at(*left, 13), image))
    row, col = _pixel_of(*left, 13)
    assert rgba[row, col].tolist() == [255, 0, 0, 255]


def test_statistics_come_from_an_overview_and_list_the_codes_of_a_whole_number_band(
    cog_server: str,
) -> None:
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        [band] = src.statistics()
    assert band.index == 1 and band.approximate
    assert band.min == pytest.approx(100, abs=2) and band.max == pytest.approx(
        400, abs=2
    )
    assert band.p2 < band.p98 and band.values is None
    assert (
        sum(band.histogram[0]) > 0
        and len(band.histogram[1]) == len(band.histogram[0]) + 1
    )
    with RasterSource(f"{cog_server}/landcover.tif", LOCAL) as src:
        [codes] = src.statistics()
    assert codes.values == [1, 2, 3, 4]


def test_a_formulas_values_are_sampled(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/multiband.tif", LOCAL) as src:
        values = src.sample(parse_formula("(b4 - b1) / (b4 + b1)"))
    assert values.size > 0 and np.allclose(values, 400 / 600)


def test_elevation_tiles_are_terrarium_encoded(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        rgb = _png(src.dem(*_tile_at(*CENTER, 13)))
    row, col = _pixel_of(*CENTER, 13)
    r, g, b = (int(v) for v in rgb[row, col, :3])
    assert r * 256 + g + b / 256 - 32768 == pytest.approx(250, abs=2)


def test_a_point_answers_every_band_and_a_formulas_value(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/multiband.tif", LOCAL) as src:
        point = src.point(*CENTER, parse_formula("b4 - b1"))
        outside = src.point(0.0, 0.0)
    assert point.values == [100, 200, 300, 500]
    assert point.formula == pytest.approx(400)
    assert outside.values == [None, None, None, None]


def test_an_unreachable_or_broken_file_is_unavailable(cog_server: str) -> None:
    for url in (
        f"{cog_server}/notatiff.tif",
        f"{cog_server}/missing.tif",
        "http://127.0.0.1:9/x.tif",
    ):
        with pytest.raises(RasterUnavailableError):
            with RasterSource(url, LOCAL) as src:
                src.info()


def test_a_file_without_overviews_is_not_read_whole_for_a_low_zoom(
    cog_server: str,
) -> None:
    url = f"{cog_server}/no_overviews.tif"
    seven = decode_token(
        encode_token({"v": 1, "kind": "rgb", "bands": None, "noData": []})
    )
    with RasterSource(url, LOCAL) as src:
        assert src.tile(*_tile_at(*CENTER, 8), seven) is None
        assert src.tile(*_tile_at(*CENTER, 17), seven) is not None
        [band] = src.statistics()
    assert band.values == [7]


def test_the_checked_address_is_kept_for_a_while(
    cog_server: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import goatlib.raster.source as source

    calls: list[str] = []
    real_head = source.requests.head

    def counting_head(url: str, **kwargs: object) -> object:
        calls.append(url)
        return real_head(url, **kwargs)

    monkeypatch.setattr(source.requests, "head", counting_head)
    url = f"{cog_server}/rgb.tif?kept"
    resolve_address(url, LOCAL)
    resolve_address(url, LOCAL)
    assert calls == [url]


def test_a_points_values_read_as_written_without_float32_noise(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/multiband.tif", LOCAL) as src:
        share = src.point(*CENTER, parse_formula("b1 / b4"))
    assert share.formula == 0.2
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        [value] = src.point(*CENTER).values
    assert value is not None and value == float(str(np.float32(value)))
    assert repr(value) == str(np.float32(value))


def test_a_host_that_never_answers_fails_within_seconds_and_then_at_once(
    cog_server: str,
) -> None:
    import time

    url = f"{cog_server}/stall/elevation.tif"
    started = time.monotonic()
    with pytest.raises(RasterUnavailableError):
        with RasterSource(url, LOCAL) as src:
            src.info()
    assert time.monotonic() - started < 12
    # The failure is kept for a moment: the next tile of that file answers at once.
    started = time.monotonic()
    with pytest.raises(RasterUnavailableError):
        with RasterSource(url, LOCAL) as src:
            src.info()
    assert time.monotonic() - started < 0.5


def test_a_band_the_file_does_not_have_is_a_band_error(cog_server: str) -> None:
    from goatlib.raster.source import BandError

    band2 = decode_token(encode_token({**ramp().model_dump(by_alias=True), "band": 2}))
    rgb = decode_token(
        encode_token({"v": 1, "kind": "rgb", "bands": [1, 2, 3], "noData": []})
    )
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        for coloring in (band2, rgb):
            with pytest.raises(BandError):
                src.tile(*_tile_at(*CENTER, 13), coloring)
        assert src.point(*CENTER, parse_formula("b5")).formula is None
