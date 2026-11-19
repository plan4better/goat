"""Raster files served by geoapi: value tiles and their description, colored
tiles, the file's statistics and point values (style spec 9). The coloring and
the value encoding are goatlib's (tested there); these tests pin the routes:
status codes, caching, and that the file is always the layer row's own address."""

import dataclasses
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi.testclient import TestClient
from goatlib.io.remote_source.url_guard import UnsafeUrlError
from goatlib.raster.source import (
    BandError,
    BandStats,
    PointValues,
    RasterInfo,
    RasterUnavailableError,
)
from goatlib.raster.token import encode_token
from goatlib.raster.values import ValueEncoding, value_encoding

from geoapi.config import settings
from geoapi.services import raster_service as rs

LAYER = "abc123def456789012345678901234ab"
ROW = rs.RasterLayer(id=LAYER, external_url="https://cdn.example/dem.tif", version="v1")
RAMP = encode_token(
    {
        "v": 1,
        "kind": "ramp",
        "band": 1,
        "noData": [],
        "colors": ["#000000", "#ffffff"],
        "domain": None,
        "outside": "clamp",
    }
)
INFO = RasterInfo(
    512,
    512,
    (11.5, 48.1, 11.6, 48.2),
    1,
    "float32",
    -9999.0,
    (32,),
    None,
    (1.0,),
    (0.0,),
    ("Band 1",),
    maxzoom=17,
)
STATS = [
    BandStats(
        1,
        100.0,
        400.0,
        250.0,
        80.0,
        106.0,
        394.0,
        ([3, 4], [100.0, 250.0, 400.0]),
        None,
    )
]


#: The value tiles' address and their description.
COVERAGE = f"/collections/{LAYER}/coverage/tiles/WebMercatorQuad"
#: The encoding the band's statistics give, which the description names.
DESCRIBED = value_encoding("float32", scaled=False, value_range=(100.0, 400.0))
#: A value tile's address names its encoding (code q is base + q * step).
VALUE_TILE = f"{COVERAGE}/12/1420/2178?f=webp&band=1&base=-1.5&step=0.25&v=v1-e1"
NAMED = ValueEncoding(base=-1.5, step=0.25, integer=False, range=None)
TOKEN_TILE = f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}"


class FakeSource:
    opened: list[str] = []
    tiles: list[tuple[Any, ...]] = []
    values_read: list[tuple[Any, ...]] = []
    fail: Exception | None = None

    def __init__(
        self, url: str, private_hosts: Any = (), *, stored_file: Any = None
    ) -> None:
        self.url = url

    def __enter__(self) -> "FakeSource":
        if FakeSource.fail is not None:
            raise FakeSource.fail
        FakeSource.opened.append(self.url)
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    def info(self) -> RasterInfo:
        return INFO

    def statistics(self) -> list[BandStats]:
        return STATS

    def tile(
        self, z: int, x: int, y: int, coloring: Any, band_range: Any = None
    ) -> bytes | None:
        FakeSource.tiles.append((z, x, y, coloring.kind, band_range))
        return None if z < 5 else b"\x89PNG-tile"

    def values(
        self, z: int, x: int, y: int, formula: Any, encoding: Any, resampling: str
    ) -> bytes | None:
        if max(formula.bands) > INFO.count:
            raise BandError("The raster has 1 band.")
        FakeSource.values_read.append(
            (z, x, y, formula.expression, encoding, resampling)
        )
        return None if z < 5 else b"RIFF-values"

    def point(self, lon: float, lat: float, formula: Any = None) -> PointValues:
        return PointValues([250.0], 250.0 if formula is not None else None)

    def sample(self, formula: Any) -> Any:
        import numpy as np

        return np.array([1.0, 3.0])


@pytest.fixture
def client(test_client: TestClient) -> Iterator[TestClient]:
    FakeSource.opened, FakeSource.tiles, FakeSource.fail = [], [], None
    FakeSource.values_read = []
    rs.raster_service.clear()
    with (
        patch.object(rs, "RasterSource", FakeSource),
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=ROW)),
        patch.object(rs, "remote_validator", return_value=None),
    ):
        yield test_client


def test_a_raster_layers_tile_is_colored_by_the_token(client: TestClient) -> None:
    r = client.get(f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}")
    assert r.status_code == 200 and r.content == b"\x89PNG-tile"
    assert r.headers["content-type"] == "image/webp"
    assert r.headers["cache-control"] == "public, max-age=3600" and r.headers["etag"]
    # The layer row's address, never anything from the request; no domain: the band's range.
    assert FakeSource.opened == [ROW.external_url]
    assert FakeSource.tiles == [(12, 2178, 1420, "ramp", (100.0, 400.0))]


def test_the_same_tile_again_is_not_modified(client: TestClient) -> None:
    url = f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}"
    etag = client.get(url).headers["etag"]
    assert client.get(url, headers={"If-None-Match": etag}).status_code == 304


def test_outside_the_file_there_is_no_content(client: TestClient) -> None:
    assert (
        client.get(
            f"/collections/{LAYER}/raster/tiles/3/1/1.webp?style={RAMP}"
        ).status_code
        == 204
    )


@pytest.mark.parametrize("token", ["", "!!!", encode_token({"v": 1, "kind": "nope"})])
def test_a_bad_token_is_400(client: TestClient, token: str) -> None:
    r = client.get(f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={token}")
    assert r.status_code == 400


def test_an_unreachable_file_is_504_and_a_refused_address_422(
    client: TestClient,
) -> None:
    url = f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}"
    FakeSource.fail = RasterUnavailableError("timeout")
    assert client.get(url).status_code == 504
    FakeSource.fail = UnsafeUrlError("private")
    assert client.get(url).status_code == 422


def test_a_layer_that_is_not_a_raster_file_has_no_raster_routes(
    client: TestClient,
) -> None:
    with patch.object(rs.raster_service, "layer", AsyncMock(return_value=None)):
        assert client.get(f"/collections/{LAYER}/raster/info").status_code == 404


def test_read_authorization_applies(client: TestClient) -> None:
    from geoapi.deps import authz

    authz._read_authz_cache.clear()
    with (
        patch(
            "geoapi.deps.authz.layer_service.user_can_read_layer",
            AsyncMock(return_value=False),
        ),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", True),
    ):
        for path in (
            "raster/info",
            f"raster/tiles/12/1/1.webp?style={RAMP}",
            "raster/point?lon=11.55&lat=48.15",
            "coverage/tiles/WebMercatorQuad",
            "coverage/tiles/WebMercatorQuad/12/1/1?f=webp&base=0&step=1",
        ):
            assert client.get(f"/collections/{LAYER}/{path}").status_code == 403, path
    authz._read_authz_cache.clear()


def test_info_lists_the_bands_statistics(client: TestClient) -> None:
    body = client.get(f"/collections/{LAYER}/raster/info").json()
    assert body["count"] == 1 and body["dtype"] == "float32" and body["nodata"] == -9999
    assert body["bounds"] == [11.5, 48.1, 11.6, 48.2]
    [band] = body["bands"]
    assert band["min"] == 100 and band["p98"] == 394 and band["approximate"] is True
    assert band["histogram"] == {"counts": [3, 4], "edges": [100.0, 250.0, 400.0]}


def test_a_point_answers_the_band_values_and_the_styled_value(
    client: TestClient,
) -> None:
    assert client.get(
        f"/collections/{LAYER}/raster/point?lon=11.55&lat=48.15"
    ).json() == {
        "values": [250.0],
        "styled": None,
    }
    styled = client.get(
        f"/collections/{LAYER}/raster/point?lon=11.55&lat=48.15&style={RAMP}"
    ).json()
    assert styled["styled"] == 250.0


async def test_one_slow_file_takes_at_most_a_few_readers(
    test_client: TestClient,
) -> None:
    import asyncio
    import threading

    import httpx

    from geoapi.main import app
    from geoapi.routers import rasters

    running = {"now": 0, "most": 0}
    lock = threading.Lock()

    class SlowSource(FakeSource):
        def tile(
            self, z: int, x: int, y: int, coloring: Any, band_range: Any = None
        ) -> bytes:
            with lock:
                running["now"] += 1
                running["most"] = max(running["most"], running["now"])
            import time

            time.sleep(0.2)
            with lock:
                running["now"] -= 1
            return b"tile"

    rs.raster_service.clear()
    with (
        patch.object(rs, "RasterSource", SlowSource),
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=ROW)),
        patch.object(rs, "remote_validator", return_value=None),
    ):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://t"
        ) as http:
            answers = await asyncio.gather(
                *(
                    http.get(
                        f"/collections/{LAYER}/raster/tiles/12/{x}/1420.webp?style={RAMP}"
                    )
                    for x in range(12)
                )
            )
    assert all(a.status_code == 200 for a in answers)
    assert running["most"] <= rasters.READS_PER_LAYER


def test_a_band_the_file_does_not_have_is_400(client: TestClient) -> None:
    from goatlib.raster.source import BandError

    def no_band(self: FakeSource, *args: Any, **kwargs: Any) -> bytes:
        raise BandError("The raster has 1 band.")

    with patch.object(FakeSource, "tile", no_band):
        r = client.get(
            f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}"
        )
    assert r.status_code == 400 and "1 band" in r.json()["detail"]


def test_info_of_a_file_whose_no_data_is_nan_answers_null(client: TestClient) -> None:
    import dataclasses
    import math

    nan_info = dataclasses.replace(INFO, nodata=math.nan)
    with patch.object(FakeSource, "info", lambda self: nan_info):
        r = client.get(f"/collections/{LAYER}/raster/info")
    assert r.status_code == 200 and r.json()["nodata"] is None


def test_concurrent_tiles_of_a_cold_layer_read_its_statistics_once(
    client: TestClient,
) -> None:
    import threading
    import time

    from goatlib.raster.token import decode_token

    calls = {"n": 0}

    def slow_statistics(self: FakeSource) -> list[BandStats]:
        calls["n"] += 1
        time.sleep(0.2)
        return STATS

    coloring = decode_token(RAMP)
    with patch.object(FakeSource, "statistics", slow_statistics):
        threads = [
            threading.Thread(
                target=rs.raster_service.tile, args=(ROW, 12, x, 1420, coloring)
            )
            for x in range(8)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert calls["n"] == 1


def test_an_image_of_three_bands_reads_no_statistics(client: TestClient) -> None:
    import dataclasses

    from goatlib.raster.token import decode_token

    three = dataclasses.replace(INFO, count=3, bits=(8, 8, 8))
    image = decode_token(
        encode_token({"v": 1, "kind": "rgb", "bands": None, "noData": []})
    )
    with (
        patch.object(FakeSource, "info", lambda self: three),
        patch.object(
            FakeSource,
            "statistics",
            lambda self: (_ for _ in ()).throw(AssertionError("read")),
        ),
    ):
        rs.raster_service.tile(ROW, 12, 1, 1, image)
    assert FakeSource.tiles[-1][4] is None


def test_the_value_tileset_describes_the_encoding(client: TestClient) -> None:
    r = client.get(COVERAGE)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {
        "title",
        "tileMatrixSetURI",
        "crs",
        "dataType",
        "maxzoom",
        "links",
        "goat:values",
    }
    assert body["title"] == f"{LAYER} values"
    assert (
        body["tileMatrixSetURI"]
        == "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
    )
    assert body["crs"] == "http://www.opengis.net/def/crs/EPSG/0/3857"
    assert body["dataType"] == "coverage" and body["maxzoom"] == INFO.maxzoom
    values = body["goat:values"]
    # A float band: its statistics' range spread over the codes.
    assert values["encoding"] == DESCRIBED.factors()
    assert values["range"] == [100.0, 400.0] and values["integer"] is False
    assert values["version"] == "v1-e1"
    [link] = body["links"]
    assert link == {
        "rel": "item",
        "type": "image/webp",
        "templated": True,
        "href": (
            f"http://testserver{COVERAGE}/{{tileMatrix}}/{{tileRow}}/{{tileCol}}"
            "?f=webp&band=1&resampling=bilinear"
            f"&base={DESCRIBED.base!r}&step={DESCRIBED.step!r}&v=v1-e1"
        ),
    }
    assert r.headers["cache-control"] == "public, max-age=60"
    etag = r.headers["etag"]
    assert client.get(COVERAGE, headers={"If-None-Match": etag}).status_code == 304
    nearest = client.get(f"{COVERAGE}?resampling=nearest")
    assert nearest.headers["etag"] != etag
    assert nearest.json()["links"][0]["href"].endswith(
        f"?f=webp&band=1&resampling=nearest&base={DESCRIBED.base!r}"
        f"&step={DESCRIBED.step!r}&v=v1-e1"
    )


def test_a_value_tile_is_webp_and_answers_304_on_its_etag(client: TestClient) -> None:
    r = client.get(VALUE_TILE)
    assert r.status_code == 200 and r.content == b"RIFF-values"
    assert r.headers["content-type"] == "image/webp"
    assert r.headers["cache-control"] == "public, max-age=3600"
    # Row 1420 is y, column 2178 is x; the band's values in the address's encoding.
    assert FakeSource.values_read == [(12, 2178, 1420, "b1", NAMED, "bilinear")]
    assert FakeSource.opened == [ROW.external_url]
    etag = r.headers["etag"]
    again = client.get(VALUE_TILE, headers={"If-None-Match": etag})
    assert again.status_code == 304 and len(FakeSource.values_read) == 1
    # Another version, resampling, formula, base or step is another tile.
    for other in (
        VALUE_TILE.replace("v=v1-e1", "v=v2-e1"),
        VALUE_TILE.replace("band=1", "band=1&resampling=nearest"),
        VALUE_TILE.replace("band=1", "formula=b1*2"),
        VALUE_TILE.replace("base=-1.5", "base=-2.5"),
        VALUE_TILE.replace("step=0.25", "step=0.5"),
    ):
        assert client.get(other).headers["etag"] != etag, other


def test_a_value_tile_is_encoded_as_its_address_says_and_reads_no_statistics(
    client: TestClient,
) -> None:
    with (
        patch.object(FakeSource, "statistics") as statistics,
        patch.object(FakeSource, "sample") as sample,
    ):
        r = client.get(VALUE_TILE.replace("base=-1.5&step=0.25", "base=7&step=1e-3"))
    assert r.status_code == 200
    [(*_, encoding, _)] = FakeSource.values_read
    assert encoding == ValueEncoding(base=7.0, step=0.001, integer=False, range=None)
    statistics.assert_not_called()
    sample.assert_not_called()


def test_a_value_tile_needs_a_valid_encoding_in_its_address(
    client: TestClient,
) -> None:
    tile = f"{COVERAGE}/12/1420/2178?f=webp&band=1&v=v1-e1"
    for missing in ("", "&base=0", "&step=1"):
        assert client.get(f"{tile}{missing}").status_code == 422, missing
    for bad in (
        "base=nan&step=1",
        "base=-inf&step=1",
        "base=0&step=inf",
        "base=0&step=0",
        "base=0&step=-1",
        # The last code would be past the largest float.
        "base=1e308&step=1e301",
    ):
        assert client.get(f"{tile}&{bad}").status_code == 400, bad
    assert FakeSource.opened == []


def test_a_value_tile_outside_the_file_is_204(client: TestClient) -> None:
    r = client.get(f"{COVERAGE}/3/1/1?f=webp&base=0&step=1")
    assert r.status_code == 204 and r.content == b""


def test_a_formulas_value_tiles_read_the_formula(client: TestClient) -> None:
    r = client.get(
        f"{COVERAGE}/12/1420/2178?f=webp&formula=b1*2&resampling=nearest"
        "&base=0&step=0.5"
    )
    assert r.status_code == 200
    [(z, x, y, expression, encoding, resampling)] = FakeSource.values_read
    assert (z, x, y, expression, resampling) == (12, 2178, 1420, "b1*2", "nearest")
    assert encoding == ValueEncoding(base=0.0, step=0.5, integer=False, range=None)
    # A formula's range is sampled, and it never takes the exact integer path.
    described = client.get(f"{COVERAGE}?formula=b1 %2B 1").json()
    values = described["goat:values"]
    assert values["range"] == [1.0, 3.0] and values["integer"] is False
    expected = value_encoding(
        "float32", scaled=False, value_range=(1.0, 3.0), formula=True
    )
    assert values["encoding"] == expected.factors()
    href = described["links"][0]["href"]
    assert (
        f"?f=webp&formula=b1%20%2B%201&resampling=bilinear&base={expected.base!r}"
        f"&step={expected.step!r}&v="
    ) in href


def test_band_and_formula_together_are_400_and_a_bad_formula_is_400(
    client: TestClient,
) -> None:
    for query in ("band=1&formula=b1", "formula=nope", "formula=b1 %2B"):
        assert client.get(f"{COVERAGE}?{query}").status_code == 400, query
        r = client.get(f"{COVERAGE}/12/1420/2178?f=webp&{query}&base=0&step=1")
        assert r.status_code == 400, query
    # The file has one band.
    assert client.get(f"{COVERAGE}?band=2").status_code == 400
    r = client.get(f"{COVERAGE}/12/1420/2178?f=webp&band=2&base=0&step=1")
    assert r.status_code == 400 and "1 band" in r.json()["detail"]
    assert FakeSource.values_read == []


def test_the_values_version_follows_the_remote_file(client: TestClient) -> None:
    host = {"validator": '"a"'}
    with patch.object(
        rs, "remote_validator", side_effect=lambda *args: host["validator"]
    ) as check:
        first = client.get(COVERAGE).json()["goat:values"]["version"]
        host["validator"] = '"b"'
        second = client.get(COVERAGE).json()["goat:values"]["version"]
    check.assert_called_with(ROW.external_url, settings.raster_private_hosts)
    assert first != second
    assert first.startswith("v1-") and first.endswith("-e1") and len(first) == 14
    # A file GOAT stores has no host to ask.
    stored = dataclasses.replace(
        ROW, external_url=None, stored_file=Path("/data/layer.tif")
    )
    with (
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=stored)),
        patch.object(rs, "remote_validator") as check,
    ):
        assert client.get(COVERAGE).json()["goat:values"]["version"] == "v1-e1"
    check.assert_not_called()


def test_a_failing_file_is_not_asked_for_its_version_again(
    client: TestClient,
) -> None:
    down = RasterUnavailableError("The file's host did not answer.")
    with (
        patch.dict("goatlib.raster.source._failures", clear=True),
        patch.object(rs, "remote_validator", side_effect=down) as check,
    ):
        assert client.get(COVERAGE).status_code == 504
        # Remembered for 30 seconds: no second HEAD.
        r = client.get(COVERAGE)
        assert r.status_code == 504 and r.json()["detail"] == str(down)
    check.assert_called_once()


def test_a_replaced_remote_file_gets_fresh_statistics(client: TestClient) -> None:
    host = {"validator": '"a"'}
    reads = {"statistics": 0, "sample": 0}

    def statistics(self: FakeSource) -> list[BandStats]:
        reads["statistics"] += 1
        return STATS

    def sample(self: FakeSource, formula: Any) -> Any:
        import numpy as np

        reads["sample"] += 1
        return np.array([1.0, 3.0])

    with (
        patch.object(
            rs, "remote_validator", side_effect=lambda *args: host["validator"]
        ),
        patch.object(FakeSource, "statistics", statistics),
        patch.object(FakeSource, "sample", sample),
    ):
        for _ in range(2):
            assert client.get(f"/collections/{LAYER}/raster/info").status_code == 200
            assert client.get(f"{COVERAGE}?formula=b1*2").status_code == 200
        assert reads == {"statistics": 1, "sample": 1}
        # The same address answers another validator: another file.
        host["validator"] = '"b"'
        client.get(f"/collections/{LAYER}/raster/info")
        client.get(f"{COVERAGE}?formula=b1*2")
    assert reads == {"statistics": 2, "sample": 2}


def test_a_failing_file_answers_at_once_without_waiting_for_a_read_slot(
    client: TestClient,
) -> None:
    from goatlib.raster.source import remember_failure

    from geoapi.routers import rasters

    with (
        patch.dict("goatlib.raster.source._failures", clear=True),
        patch.object(rasters, "_slot", side_effect=AssertionError("slot")) as slot,
    ):
        remember_failure(ROW.external_url, "The file could not be read: gone")
        answers = [
            client.get(url)
            for url in (
                COVERAGE,
                VALUE_TILE,
                TOKEN_TILE,
                f"/collections/{LAYER}/raster/info",
                f"/collections/{LAYER}/raster/bounds",
                f"/collections/{LAYER}/raster/point?lon=11.55&lat=48.15",
            )
        ]
    for r in answers:
        assert r.status_code == 504, r.url
        assert r.json()["detail"] == "The file could not be read: gone"
    slot.assert_not_called()


def test_a_value_tiles_version_is_short(client: TestClient) -> None:
    assert client.get(VALUE_TILE.replace("v1-e1", "v" * 64)).status_code == 200
    assert client.get(VALUE_TILE.replace("v1-e1", "v" * 65)).status_code == 422


def test_raster_tiles_never_touch_the_redis_cache(client: TestClient) -> None:
    from geoapi import tile_cache

    with (
        patch.object(tile_cache, "get_cached_tile", Mock(return_value=None)) as get,
        patch.object(tile_cache, "cache_tile", Mock(return_value=True)) as put,
        patch.object(tile_cache, "get_redis_client", Mock(return_value=None)) as redis,
    ):
        token = client.get(TOKEN_TILE)
        value = client.get(VALUE_TILE)
    assert not get.called and not put.called
    # Credit metering shares the client (`for_tile_cache=False`); no tile asks.
    asked = [c for c in redis.call_args_list if c.kwargs.get("for_tile_cache", True)]
    assert asked == []
    assert token.status_code == 200 and value.status_code == 200


def test_the_elevation_route_is_gone(client: TestClient) -> None:
    r = client.get(f"/collections/{LAYER}/raster/dem/12/2178/1420.webp")
    assert r.status_code == 404


def test_a_tile_nobody_waits_for_is_not_read(client: TestClient) -> None:
    gone = AsyncMock(return_value=True)
    with patch("starlette.requests.Request.is_disconnected", gone):
        for url in (VALUE_TILE, TOKEN_TILE):
            r = client.get(url)
            assert r.status_code == 204 and r.content == b"", url
            assert r.headers["cache-control"] == "no-store", url
    # Gone while it waited for a read slot.
    later = AsyncMock(side_effect=[False, True])
    with patch("starlette.requests.Request.is_disconnected", later):
        assert client.get(VALUE_TILE).status_code == 204
    assert later.await_count == 2
    assert FakeSource.opened == [] and FakeSource.values_read == []


def test_a_tile_read_past_the_deadline_is_504_and_the_file_is_remembered_failing(
    client: TestClient,
) -> None:
    import threading
    import time

    from geoapi.routers import rasters

    finished = threading.Event()

    def slow_values(self: FakeSource, *args: Any) -> bytes:
        time.sleep(0.5)
        finished.set()
        return b"RIFF-values"

    with (
        patch.object(rasters, "TILE_DEADLINE_S", 0.2),
        patch.object(FakeSource, "values", slow_values),
        patch.object(rasters, "remember_failure") as remember,
    ):
        r = client.get(VALUE_TILE)
        assert r.status_code == 504
        # The read thread cannot be stopped: wait for it before the next test.
        assert finished.wait(2)
    remember.assert_called_once()
    assert remember.call_args.args[0] == "https://cdn.example/dem.tif"


def test_a_tile_still_waiting_for_a_reader_at_the_deadline_is_503_and_never_read(
    client: TestClient,
) -> None:
    """A busy pool is not the file's fault: no memo, and the queued read is
    dropped."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from geoapi.routers import rasters

    pool = ThreadPoolExecutor(max_workers=1)
    release = threading.Event()
    pool.submit(release.wait, 5)
    try:
        with (
            patch.object(rasters, "RASTER_EXECUTOR", pool),
            patch.object(rasters, "TILE_DEADLINE_S", 0.05),
            patch.object(rasters, "remember_failure") as remember,
        ):
            r = client.get(VALUE_TILE)
    finally:
        release.set()
        pool.shutdown(wait=True)
    assert r.status_code == 503 and "busy" in r.json()["detail"]
    remember.assert_not_called()
    # Not even read once the reader is free.
    assert FakeSource.opened == [] and FakeSource.values_read == []


def test_a_read_that_got_its_reader_late_is_503_and_the_file_is_not_blamed(
    client: TestClient,
) -> None:
    """The deadline counts from the request: a read that waited for a thread
    has not had its time when it passes."""
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor

    from geoapi.routers import rasters

    pool = ThreadPoolExecutor(max_workers=1)
    release = threading.Event()
    pool.submit(release.wait, 5)
    started, finished = threading.Event(), threading.Event()

    def slow_values(self: FakeSource, *args: Any) -> bytes:
        started.set()
        time.sleep(0.6)
        finished.set()
        return b"RIFF-values"

    # The reader frees up halfway to the deadline.
    timer = threading.Timer(0.3, release.set)
    try:
        with (
            patch.object(rasters, "RASTER_EXECUTOR", pool),
            patch.object(rasters, "TILE_DEADLINE_S", 0.6),
            patch.object(FakeSource, "values", slow_values),
            patch.object(rasters, "remember_failure") as remember,
        ):
            timer.start()
            r = client.get(VALUE_TILE)
            assert finished.wait(3)
    finally:
        timer.cancel()
        release.set()
        pool.shutdown(wait=True)
    assert started.is_set()
    assert r.status_code == 503 and "busy" in r.json()["detail"]
    remember.assert_not_called()


def test_a_read_done_at_the_deadline_is_answered(client: TestClient) -> None:
    from concurrent.futures import Future

    from geoapi.routers import rasters

    class Finished:
        """Reads at once: done before the route sees the zero deadline pass."""

        def submit(self, fn: Any, *args: Any) -> Future:
            future: Future = Future()
            try:
                future.set_result(fn(*args))
            except Exception as error:  # noqa: BLE001
                future.set_exception(error)
            return future

    with (
        patch.object(rasters, "RASTER_EXECUTOR", Finished()),
        patch.object(rasters, "TILE_DEADLINE_S", 0),
        patch.object(rasters, "remember_failure") as remember,
    ):
        r = client.get(VALUE_TILE)
        other_band = client.get(VALUE_TILE.replace("band=1", "band=2"))
    assert r.status_code == 200 and r.content == b"RIFF-values"
    assert other_band.status_code == 400 and "1 band" in other_band.json()["detail"]
    remember.assert_not_called()


def test_a_hanging_read_whose_thread_started_a_moment_late_is_still_blamed(
    client: TestClient,
) -> None:
    """A thread starts a little after the deadline's clock (it needs the
    interpreter's lock); that is no wait for a reader."""
    import threading
    import time
    from concurrent.futures import Future, ThreadPoolExecutor

    from geoapi.routers import rasters

    class SlowToStart:
        def __init__(self) -> None:
            self.pool = ThreadPoolExecutor(max_workers=1)

        def submit(self, fn: Any, *args: Any) -> Future:
            def later() -> Any:
                time.sleep(0.005)
                return fn(*args)

            return self.pool.submit(later)

    finished = threading.Event()

    def hanging_values(self: FakeSource, *args: Any) -> bytes:
        time.sleep(0.6)
        finished.set()
        return b"RIFF-values"

    executor = SlowToStart()
    try:
        with (
            patch.object(rasters, "RASTER_EXECUTOR", executor),
            patch.object(rasters, "TILE_DEADLINE_S", 0.4),
            patch.object(FakeSource, "values", hanging_values),
            patch.object(rasters, "remember_failure") as remember,
        ):
            r = client.get(VALUE_TILE)
            assert finished.wait(3)
    finally:
        executor.pool.shutdown(wait=True)
    assert r.status_code == 504
    remember.assert_called_once()
