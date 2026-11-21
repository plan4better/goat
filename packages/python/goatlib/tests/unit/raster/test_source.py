import dataclasses
import io
from pathlib import Path

import morecantile
import numpy as np
import pytest
import rasterio
import rasterio.shutil
import rasterio.transform
from goatlib.io.remote_source.url_guard import UnsafeUrlError
from goatlib.raster.formula import parse_formula
from goatlib.raster.source import (
    RasterSource,
    RasterUnavailableError,
    failure_key,
    native_zoom,
    recent_failure,
    remember_failure,
    remote_validator,
    resolve_address,
)
from goatlib.raster.token import decode_token, encode_token
from goatlib.raster.values import value_encoding

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


def test_info_tells_each_bands_color_interpretation(cog_server: str) -> None:
    """As rasterio reads the file: an image draws the bands marked red, green
    and blue (`image_bands`)."""
    with RasterSource(f"{cog_server}/bgr.tif", LOCAL) as src:
        assert src.info().color_interp == ("blue", "green", "red")
    with RasterSource(f"{cog_server}/landcover.tif", LOCAL) as src:
        assert src.info().color_interp == ("palette",)


def test_an_image_of_a_bgr_file_draws_red_from_its_third_band(cog_server: str) -> None:
    image = decode_token(
        encode_token({"v": 1, "kind": "rgb", "bands": None, "noData": []})
    )
    z, x, y = _tile_at(*CENTER, 13)
    with RasterSource(f"{cog_server}/bgr.tif", LOCAL) as src:
        rgba = _png(src.tile(z, x, y, image))
    assert rgba[128, 128].tolist() == [200, 100, 50, 255]


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


def test_a_value_tile_holds_the_files_values(cog_server: str) -> None:
    encoding = value_encoding("float32", scaled=False, value_range=(100.0, 400.0))
    z, x, y = _tile_at(*CENTER, 13)
    corner = (BOUNDS[0] + 0.002, BOUNDS[3] - 0.002)
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        values = encoding.decode(
            _png(src.values(z, x, y, parse_formula("b1"), encoding))
        )
        read = src.reader.tile(
            x,
            y,
            z,
            tilesize=256,
            indexes=(1,),
            resampling_method="bilinear",
            reproject_method="bilinear",
        )
        hole = encoding.decode(
            _png(src.values(*_tile_at(*corner, 14), parse_formula("b1"), encoding))
        )
    expected = np.ma.filled(read.array[0].astype("float64"), np.nan)
    assert np.array_equal(np.isnan(values), np.isnan(expected))
    assert np.nanmax(np.abs(values - expected)) <= encoding.step
    row, col = _pixel_of(*CENTER, 13)
    assert values[row, col] == pytest.approx(250, abs=2)
    assert np.isnan(hole[_pixel_of(*corner, 14)])


def test_a_bilinear_value_tile_of_a_file_in_degrees_is_smooth(cog_dir) -> None:  # noqa: ANN001
    """A file in degrees is reprojected for a tile, and the resampling asked
    for is the reprojection's too: bilinear values change between the cells'
    centers, where nearest repeats each cell over several pixels."""
    encoding = value_encoding("float32", scaled=False, value_range=(100.0, 400.0))
    tile = _tile_at(*CENTER, 15)
    rows = {}
    with RasterSource(None, stored_file=cog_dir / "elevation.tif") as src:
        for resampling in ("nearest", "bilinear"):
            data = src.values(*tile, parse_formula("b1"), encoding, resampling)
            rows[resampling] = encoding.decode(_png(data))[128]
    # The elevation grows along x only, a cell about four pixels wide here.
    assert len(np.unique(rows["bilinear"])) > 3 * len(np.unique(rows["nearest"]))


def test_a_value_tile_of_a_formula_holds_its_result(cog_server: str) -> None:
    encoding = value_encoding(
        "uint16", scaled=False, value_range=(100.0, 100.0), formula=True
    )
    with RasterSource(f"{cog_server}/multiband.tif", LOCAL) as src:
        tile = src.values(*_tile_at(*CENTER, 13), parse_formula("b2 - b1"), encoding)
    values = encoding.decode(_png(tile))
    assert np.isfinite(values).any()
    assert np.nanmax(np.abs(values - 100)) <= encoding.step


def test_outside_the_file_there_is_no_value_tile(cog_server: str) -> None:
    encoding = value_encoding("float32", scaled=False, value_range=(100.0, 400.0))
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        assert (
            src.values(*_tile_at(0.0, 0.0, 10), parse_formula("b1"), encoding) is None
        )


def test_info_names_the_files_native_zoom(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        info = src.info()
    assert isinstance(info.maxzoom, int) and info.maxzoom >= 0
    assert isinstance(info.minzoom, int) and 0 <= info.minzoom <= info.maxzoom


def _children(tile: tuple[int, int, int], read) -> np.ndarray:  # noqa: ANN001
    """The four 256 px tiles one zoom deeper than `tile` (z, x, y), read by
    `read` and put side by side: the area of `tile` at 512 px."""
    z, x, y = tile
    rows = [
        np.concatenate([read((z + 1, 2 * x + dx, 2 * y + dy)) for dx in (0, 1)], axis=1)
        for dy in (0, 1)
    ]
    return np.concatenate(rows, axis=0)


@pytest.mark.parametrize("zoom", [12, 14])
def test_a_512_px_value_tile_holds_the_values_of_the_256_px_tiles_it_covers(
    cog_server: str, zoom: int
) -> None:
    """A 512 px tile is the same tile at twice the resolution. For this file
    in degrees, read nearest, its pixels are exactly those of the four 256 px
    tiles one zoom deeper; a file in another CRS may differ at cell edges,
    where the two reprojection grids round differently."""
    encoding = value_encoding("float32", scaled=False, value_range=(100.0, 400.0))
    b1 = parse_formula("b1")
    # A tile at the file's no-data corner at 14: no data and values in one tile.
    corner = (BOUNDS[0] + 0.002, BOUNDS[3] - 0.002)
    tile = _tile_at(*(CENTER if zoom == 12 else corner), zoom)
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        large = src.values(*tile, b1, encoding, "nearest", tilesize=512)
        # A child outside the file has no tile: its pixels are no data.
        empty = encoding.encode(np.ma.masked_all((256, 256)))
        small = _children(
            tile,
            lambda t: _png(data)
            if (data := src.values(*t, b1, encoding, "nearest"))
            else empty,
        )
    pixels = _png(large)
    assert pixels.shape == (512, 512, 4)
    assert np.array_equal(pixels, small)
    decoded = encoding.decode(pixels)
    assert np.isfinite(decoded).any()
    assert zoom == 12 or np.isnan(decoded).any()


def test_a_512_px_colored_tile_holds_the_colors_of_the_256_px_tiles_it_covers(
    cog_server: str,
) -> None:
    tile = _tile_at(*CENTER, 12)
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        large = _png(src.tile(*tile, ramp(), tilesize=512))
        small = _children(tile, lambda t: _png(src.tile(*t, ramp())))
    assert large.shape == (512, 512, 4)
    assert np.array_equal(large, small)


def test_a_512_px_tile_reads_an_overview_a_256_px_tile_of_its_zoom_would_refuse(
    cog_server: str,
) -> None:
    """A 512 px tile decimates the file half as much as a 256 px tile of the
    same zoom: it is drawn whenever the 256 px tiles of the next zoom are."""
    url = f"{cog_server}/no_overviews.tif"
    seven = decode_token(
        encode_token({"v": 1, "kind": "rgb", "bands": None, "noData": []})
    )
    with RasterSource(url, LOCAL) as src:
        zoom = next(
            z
            for z in range(8, 18)
            if src.tile(*_tile_at(*CENTER, z), seven) is not None
        )
        assert src.tile(*_tile_at(*CENTER, zoom - 1), seven) is None
        assert src.tile(*_tile_at(*CENTER, zoom - 1), seven, tilesize=512) is not None


def test_info_gives_the_native_zoom_of_each_tile_size(cog_server: str) -> None:
    with RasterSource(f"{cog_server}/elevation.tif", LOCAL) as src:
        info = src.info()
    assert native_zoom(info, 256) == info.maxzoom
    # A 512 px tile shows the cells at their own size one zoom higher up.
    assert native_zoom(info, 512) == info.maxzoom - 1
    # Never below the zoom the file's smallest overview fills a tile at.
    at_min = dataclasses.replace(info, maxzoom=info.minzoom)
    assert native_zoom(at_min, 512) == info.minzoom
    assert native_zoom(dataclasses.replace(info, maxzoom=None), 512) is None


def test_the_remote_validator_is_the_files_last_modified(cog_server: str) -> None:
    import requests

    url = f"{cog_server}/elevation.tif"
    expected = requests.head(url, timeout=3).headers["Last-Modified"]
    assert remote_validator(url, LOCAL) == expected


@pytest.mark.parametrize("status", [200, 204, 403, 405, 500])
def test_only_a_successful_head_gives_the_files_validator(
    status: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A host that refuses HEAD (a URL signed for GET only answers 403) may
    still send an ETag or a date, which then says nothing about the file."""
    import goatlib.raster.source as source

    class Answer:
        status_code = status
        headers = {"ETag": '"x"', "Last-Modified": "Mon, 02 Nov 2026 10:00:00 GMT"}

    monkeypatch.setattr(source, "assert_public_http_url", lambda *args: None)
    monkeypatch.setattr(source.requests, "head", lambda *args, **kwargs: Answer())
    monkeypatch.setattr(source, "_addresses", {})
    validator = remote_validator("https://cdn.example/dem.tif")
    assert validator == ('"x"' if status in (200, 204) else None)


def _write_constant(path: Path, value: int) -> None:
    """An uncompressed one-band COG over BOUNDS, all `value`: the same size
    for every value, as a file replaced by a new version of itself may be."""
    plain = path.with_suffix(".plain.tif")
    with rasterio.open(
        plain,
        "w",
        driver="GTiff",
        width=512,
        height=512,
        count=1,
        dtype="uint8",
        crs="EPSG:4326",
        transform=rasterio.transform.from_bounds(*BOUNDS, 512, 512),
    ) as dst:
        dst.write(np.full((1, 512, 512), value, "uint8"))
    rasterio.shutil.copy(plain, path, driver="COG", BLOCKSIZE=256, COMPRESS="NONE")
    plain.unlink()


@pytest.mark.parametrize("validated", [True, False])
def test_a_replaced_remote_file_is_read_anew_once_its_address_is_checked_again(
    cog_server: str,
    cog_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    validated: bool,
) -> None:
    """GDAL keeps what it read of a remote file for the process: a file
    replaced at the same address is read anew once the address check sees
    another validator (or, without one, at every check), never from the old
    file's kept blocks under the new version."""
    import os
    import shutil
    import time

    import goatlib.raster.source as source

    if not validated:
        follow = source._follow
        monkeypatch.setattr(source, "_follow", lambda *args: (follow(*args)[0], None))
    # The address is checked again at every open here, not every ten minutes.
    monkeypatch.setattr(source, "ADDRESS_TTL_S", 0)
    name = f"replaced-{validated}.tif"
    _write_constant(cog_dir / name, 1)
    url = f"{cog_server}/{name}"
    encoding = value_encoding("uint8", scaled=False, value_range=None)
    tile = _tile_at(*CENTER, 13)

    def values() -> set[float]:
        with RasterSource(url, LOCAL) as src:
            data = src.values(*tile, parse_formula("b1"), encoding, "nearest")
        return set(np.unique(encoding.decode(_png(data))).tolist())

    assert values() == {1.0}
    staged = cog_dir / f"staged-{validated}.tif"
    _write_constant(staged, 2)
    later = time.time() + 60
    os.utime(staged, (later, later))
    shutil.move(staged, cog_dir / name)
    assert values() == {2.0}


@pytest.mark.parametrize("found", ["nothing", "another library"])
def test_a_read_cache_that_cannot_be_cleared_is_said_once(
    found: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Only rasterio's own GDAL holds the cache: no other libgdal is tried, and
    a clear that cannot happen is never silent."""
    import ctypes.util
    import logging

    import goatlib.raster.source as source

    libc = ctypes.util.find_library("c")
    paths = [] if found == "nothing" else [libc]
    monkeypatch.setattr(source, "_rasterio_libgdal", lambda: paths)
    monkeypatch.setattr(
        ctypes.util, "find_library", lambda name: pytest.fail("another libgdal")
    )
    source._gdal.cache_clear()
    try:
        with caplog.at_level(logging.WARNING, logger=source.__name__):
            source.forget_cached_reads("https://cdn.example/a.tif")
            source.forget_cached_reads("https://cdn.example/b.tif")
    finally:
        source._gdal.cache_clear()
    [warning] = [r for r in caplog.records if r.levelno == logging.WARNING]
    reason = "no libgdal" if found == "nothing" else "VSICurlPartialClearCache"
    assert reason in warning.getMessage()


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
    remote_validator(url, LOCAL)
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
        encoding = value_encoding("float32", scaled=False, value_range=None)
        with pytest.raises(BandError):
            src.values(*_tile_at(*CENTER, 13), parse_formula("b2 - b1"), encoding)


def test_a_stored_file_opens_only_when_named_as_one(cog_dir) -> None:  # noqa: ANN001
    """The file GOAT stores for a layer opens as `stored_file`; an address that
    merely looks like a path is still refused, since a user's raster layer
    stores whatever address was typed."""
    local = str(cog_dir / "landcover.tif")
    with RasterSource(None, stored_file=cog_dir / "landcover.tif") as src:
        assert src.info().bounds == pytest.approx(BOUNDS, abs=1e-6)
    for address in (local, f"file://{local}"):
        with pytest.raises(UnsafeUrlError):
            RasterSource(address).__enter__()


def test_a_missing_stored_file_is_unavailable(cog_dir) -> None:  # noqa: ANN001
    with pytest.raises(RasterUnavailableError):
        RasterSource(None, stored_file=cog_dir / "gone.tif").__enter__()


def test_a_source_needs_a_stored_file_or_an_address() -> None:
    with pytest.raises(ValueError):
        RasterSource(None)
    # An empty address is still the URL guard's to refuse.
    with pytest.raises(UnsafeUrlError):
        RasterSource("").__enter__()


def test_a_remembered_failure_is_recent_for_a_while(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from goatlib.raster import source

    monkeypatch.setattr(source, "_failures", {})
    key = failure_key(None, Path("/data/layer.tif"))
    assert recent_failure(key) is None
    remember_failure(key, "The file could not be read.")
    assert recent_failure(key) == "The file could not be read."
    monkeypatch.setattr(source, "FAILURE_TTL_S", 0)
    remember_failure(key, "Again.")
    assert recent_failure(key) is None


#: The query a signed link carries: no failure answer and no log line may
#: hold it.
SIGNED = "?sig=secret"


def assert_logged_without_the_key(log: str, address: str, error: str) -> None:
    """The log names the file by its address without query and credentials,
    and the error; nothing of the key."""
    assert address.split("?", 1)[0].split("://", 1)[1] in log
    assert error in log
    assert "sig" not in log and "secret" not in log


@pytest.mark.parametrize(
    ("address", "said", "error"),
    [
        (
            "http://127.0.0.1:9/a/b.tif",
            "The file's host could not be reached.",
            "Connection refused",
        ),
        (
            "{server}/notatiff.tif",
            "The file could not be read as a raster.",
            "not recognized as being in a supported file format",
        ),
        (
            "{server}/missing.tif",
            "The file's host answered with HTTP 404.",
            "HTTP response code: 404",
        ),
        # GDAL reports a host that stops sending as a file it cannot recognize.
        (
            "{server}/stall/elevation.tif",
            "The file could not be read as a raster.",
            "not recognized as being in a supported file format",
        ),
    ],
)
def test_a_failure_says_what_went_wrong_without_the_files_address(
    cog_server: str,
    caplog: pytest.LogCaptureFixture,
    address: str,
    said: str,
    error: str,
) -> None:
    """The message is what geoapi answers with, now and for the next 30
    seconds; the error's own text goes to the log only, and the log names the
    file without its query."""
    from unittest.mock import patch

    import goatlib.raster.source as source

    url = address.format(server=cog_server) + SIGNED
    path = url.split("://", 1)[1].split("?", 1)[0].split("/", 1)[1]
    with (
        patch.dict(source._failures, clear=True),
        caplog.at_level("WARNING", logger="goatlib.raster.source"),
    ):
        with pytest.raises(RasterUnavailableError) as first:
            with RasterSource(url, LOCAL) as src:
                src.info()
        with pytest.raises(RasterUnavailableError) as again:
            with RasterSource(url, LOCAL) as src:
                src.info()
        remembered = recent_failure(failure_key(url, None))
    for message in (str(first.value), str(again.value), remembered):
        assert message == said
        assert "sig" not in message and "secret" not in message
        assert path not in message
    assert_logged_without_the_key(caplog.text, url, error)


def test_a_host_that_does_not_answer_the_check_in_time_says_so(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import goatlib.raster.source as source
    import requests

    url = "https://example.org/a/b.tif" + SIGNED

    def head(address: str, **kwargs: object) -> object:
        raise requests.ConnectTimeout(
            "HTTPSConnectionPool(host='example.org', port=443): Max retries "
            f"exceeded with url: /a/b.tif{SIGNED}"
        )

    monkeypatch.setattr(source, "assert_public_http_url", lambda *args: None)
    monkeypatch.setattr(source.requests, "head", head)
    with caplog.at_level("WARNING", logger="goatlib.raster.source"):
        with pytest.raises(RasterUnavailableError) as failed:
            resolve_address(url)
    assert str(failed.value) == "The file's host did not answer in time."
    assert_logged_without_the_key(caplog.text, url, "Max retries exceeded")


def test_a_log_line_names_the_file_without_its_query_or_credentials() -> None:
    from goatlib.raster.source import logged

    url = "https://user:pw@example.org:8443/a/b.tif" + SIGNED + "#x"
    error = OSError(f"'/vsicurl/{url}' not recognized as being in a supported format")
    address, text = logged(url, error)
    assert address == "https://example.org:8443/a/b.tif"
    # The quote that closed the quoted address goes with the query.
    assert text == (
        "'/vsicurl/https://example.org:8443/a/b.tif not recognized as being in "
        "a supported format"
    )
    # A stored file's path is logged as it is.
    assert logged("/data/catalog/layers/x.tif", error)[0] == (
        "/data/catalog/layers/x.tif"
    )


def _photo_tile() -> np.ndarray:
    """A 512 px RGBA tile as `colorize` makes them: noisy colors, and
    transparent cells with black RGB."""
    rng = np.random.default_rng(16)
    rgba = rng.integers(0, 256, (512, 512, 4), dtype="uint8")
    rgba[..., 3] = np.where(rgba[..., 3] < 32, 0, 255)
    rgba[rgba[..., 3] == 0, :3] = 0
    return rgba


def _value_tile() -> np.ndarray:
    """A 512 px value tile: codes in RGB, alpha 255 everywhere."""
    values = np.ma.masked_less(
        np.random.default_rng(17).normal(500, 120, (512, 512)), 200
    )
    return value_encoding("float32", scaled=False, value_range=(0, 1000)).encode(values)


@pytest.mark.parametrize("make", [_photo_tile, _value_tile])
def test_a_tile_is_encoded_with_less_effort_and_decodes_to_its_exact_pixels(
    make: object,
) -> None:
    """Lossless WebP at GDAL's QUALITY 50: for a lossless image QUALITY is
    libwebp's effort, which takes less time than the default 75 for about the
    same size, and the pixels stay exact."""
    from unittest.mock import patch

    from goatlib.raster.source import encode_tile
    from rio_tiler.utils import render

    rgba = make()  # type: ignore[operator]
    with patch("rio_tiler.utils.render", wraps=render) as encoder:
        data = encode_tile(rgba)
    options = encoder.call_args.kwargs
    assert options["img_format"] == "WEBP" and options["LOSSLESS"] is True
    assert options["QUALITY"] == 50
    assert np.array_equal(_png(data), rgba)


def test_a_file_on_a_plain_web_address_opens_without_an_s3_session(
    cog_server: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With AWS credentials in the environment, rasterio builds a boto3
    session for every `Env`: a tile's open would build one for a file no S3
    signature reaches. GDAL reads an http(s) address unsigned, a bucket's
    included, so only a path it reads through S3 (`s3://`, `/vsis3/`) gets
    one."""
    from unittest.mock import patch

    from goatlib.raster.source import gdal_env
    from rasterio.session import AWSSession, DummySession

    # Without boto3 (the `raster` extra alone) rasterio builds no session at all.
    pytest.importorskip("boto3")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "a-key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "a-secret")
    image = decode_token(encode_token({"v": 1, "kind": "rgb", "noData": []}))
    with patch("rasterio.session.boto3.Session") as boto3_session:
        boto3_session.side_effect = AssertionError("a boto3 session was built")
        with RasterSource(f"{cog_server}/photo_3857.tif", LOCAL) as src:
            assert src.info().count == 3
            assert src.tile(*_tile_at(*CENTER, 14), image, tilesize=512)
        for plain in (
            "/data/catalog/layers/x.tif",
            "https://bucket.s3.eu-central-1.amazonaws.com/a.tif",
        ):
            assert isinstance(gdal_env(plain).session, DummySession), plain
        boto3_session.assert_not_called()
        boto3_session.side_effect = None
        buckets = [
            gdal_env(path) for path in ("s3://bucket/a.tif", "/vsis3/bucket/a.tif")
        ]
    assert all(isinstance(bucket.session, AWSSession) for bucket in buckets)
    assert boto3_session.call_count == 2


def _no_key(log: str) -> None:
    """No part of the query (`sig=` rather than `sig`: rasterio's lines read
    "GDAL signalled an error")."""
    assert "sig=" not in log and "secret" not in log


def test_rasterios_own_log_names_the_file_without_its_key(
    cog_server: str, caplog: pytest.LogCaptureFixture
) -> None:
    """rasterio logs GDAL's error, address and query included, at INFO, the
    level geoapi and processes log at."""
    from unittest.mock import patch

    import goatlib.raster.source as source

    url = f"{cog_server}/notatiff.tif{SIGNED}"
    with patch.dict(source._failures, clear=True), caplog.at_level("INFO"):
        with pytest.raises(RasterUnavailableError):
            with RasterSource(url, LOCAL) as src:
                src.info()
    assert any(r.name.startswith("rasterio") for r in caplog.records)
    assert "/notatiff.tif" in caplog.text
    _no_key(caplog.text)


def test_urllib3s_log_of_the_address_check_has_no_key(
    cog_server: str, caplog: pytest.LogCaptureFixture
) -> None:
    from unittest.mock import patch

    import goatlib.raster.source as source

    with patch.dict(source._addresses, clear=True), caplog.at_level("DEBUG"):
        resolve_address(f"{cog_server}/rgb.tif{SIGNED}", LOCAL)
    assert any(
        r.name.startswith("urllib3") and "/rgb.tif" in r.getMessage()
        for r in caplog.records
    )
    _no_key(caplog.text)


def test_a_query_holding_quotes_is_cut_whole(caplog: pytest.LogCaptureFixture) -> None:
    import logging

    from goatlib.raster.source import logged

    quoted = "https://example.org/a/b.tif?sig=it's\"secret#x'"
    error = OSError(
        f"'/vsicurl/{quoted}' not recognized as being in a supported format"
    )
    address, text = logged(quoted, error)
    assert address == "https://example.org/a/b.tif"
    assert text.startswith("'/vsicurl/https://example.org/a/b.tif")
    assert text.endswith(" not recognized as being in a supported format")
    _no_key(text)
    with caplog.at_level("INFO"):
        logging.getLogger("rasterio._env").info(
            "GDAL signalled an error: err_no=4, msg=%r", str(error)
        )
    assert "example.org/a/b.tif" in caplog.text
    _no_key(caplog.text)


def test_a_logged_exception_names_the_file_without_its_key(
    caplog: pytest.LogCaptureFixture,
) -> None:
    import logging

    import goatlib.raster.source  # noqa: F401  (sets up the filter)

    with caplog.at_level("INFO"):
        try:
            raise OSError("'/vsicurl/https://example.org/a/b.tif?sig=secret' not found")
        except OSError:
            logging.getLogger("rasterio._env").exception("Read failed")
    assert "example.org/a/b.tif" in caplog.text
    _no_key(caplog.text)


def test_a_failing_header_read_before_a_tile_is_unavailable(
    cog_server: str, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The checks before a tile read (does the tile touch the file, is it too
    coarse) read the file's header too: their failure is the neutral answer."""
    from unittest.mock import patch

    import goatlib.raster.source as source
    from rasterio.errors import RasterioIOError
    from rio_tiler.io import Reader

    def failing(*args: object, **kwargs: object) -> bool:
        raise RasterioIOError(
            f"'/vsicurl/{cog_server}/rgb.tif{SIGNED}' could not be read"
        )

    monkeypatch.setattr(Reader, "tile_exists", failing)
    url = f"{cog_server}/rgb.tif?header"
    seven = decode_token(
        encode_token({"v": 1, "kind": "rgb", "bands": None, "noData": []})
    )
    with (
        patch.dict(source._failures, clear=True),
        caplog.at_level("WARNING", logger="goatlib.raster.source"),
    ):
        with RasterSource(url, LOCAL) as src:
            with pytest.raises(RasterUnavailableError) as failed:
                src.tile(*_tile_at(*CENTER, 14), seven)
    assert str(failed.value) == "The file could not be read as a raster."
    assert "/rgb.tif" in caplog.text
    _no_key(caplog.text)


@pytest.mark.parametrize("scheme", ["http", "HTTP"])
def test_a_buckets_https_address_opens_without_looking_for_credentials(
    cog_dir: Path,
    cog_server: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    scheme: str,
) -> None:
    """rasterio's own open takes an address naming amazonaws.com for S3 and
    builds an AWS session for it, and without credentials in the environment
    (as geoapi runs) botocore looks for them, the cloud's metadata service
    last, about two seconds every time. GDAL reads the address over https
    unsigned all the same, so it opens by its `/vsicurl/` name: no lookup,
    whatever the case of its scheme."""
    import shutil
    from unittest.mock import patch

    pytest.importorskip("boto3")
    bucket = cog_dir / "bucket.s3.eu-central-1.amazonaws.com"
    bucket.mkdir(exist_ok=True)
    shutil.copy(cog_dir / "dem_utm.tif", bucket / "dem.tif")
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    server = scheme + cog_server.removeprefix("http")
    url = f"{server}/bucket.s3.eu-central-1.amazonaws.com/dem.tif"
    lookup = AssertionError("botocore looked for credentials")
    with patch("botocore.session.Session.get_credentials", side_effect=lookup) as found:
        with RasterSource(url, LOCAL) as src:
            assert src.info().count == 1
            assert src.tile(*_tile_at(*CENTER, 13), ramp(), tilesize=512)
    found.assert_not_called()


@pytest.mark.parametrize("suffix", ["#part", "?sig=1#part"])
def test_an_address_with_a_fragment_opens_as_the_file(
    cog_server: str, suffix: str
) -> None:
    """A fragment is no part of what a host is asked for: GDAL opens the file
    without it, its query (a signed link's key) kept."""
    from goatlib.raster.source import _gdal_path

    with RasterSource(f"{cog_server}/rgb.tif{suffix}", LOCAL) as src:
        assert src.info().count == 3
    assert _gdal_path("HTTPS://bucket.example/a.tif?X-Amz-Signature=s1#part") == (
        "/vsicurl/https://bucket.example/a.tif?X-Amz-Signature=s1"
    )
    assert _gdal_path("/data/catalog/layers/x.tif") == "/data/catalog/layers/x.tif"
