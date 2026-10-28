"""Raster files served by geoapi: colored tiles, elevation tiles, the file's
statistics and point values (style spec 9). The coloring itself is goatlib's
(tested there); these tests pin the routes: status codes, caching, and that the
file is always the layer row's own address."""

from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from goatlib.io.remote_source.url_guard import UnsafeUrlError
from goatlib.raster.source import (
    BandStats,
    PointValues,
    RasterInfo,
    RasterUnavailableError,
)
from goatlib.raster.token import encode_token

from geoapi.services import raster_service as rs

LAYER = "abc123def456789012345678901234ab"
ROW = rs.RasterLayer(id=LAYER, url="https://cdn.example/dem.tif", version="v1")
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


class FakeSource:
    opened: list[str] = []
    tiles: list[tuple[Any, ...]] = []
    fail: Exception | None = None

    def __init__(self, url: str, private_hosts: Any = ()) -> None:
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

    def dem(self, z: int, x: int, y: int, band: int = 1) -> bytes | None:
        return b"\x89PNG-dem"

    def point(self, lon: float, lat: float, formula: Any = None) -> PointValues:
        return PointValues([250.0], 250.0 if formula is not None else None)

    def sample(self, formula: Any) -> Any:
        import numpy as np

        return np.array([1.0, 3.0])


@pytest.fixture
def client(test_client: TestClient) -> Iterator[TestClient]:
    FakeSource.opened, FakeSource.tiles, FakeSource.fail = [], [], None
    rs.raster_service.clear()
    with (
        patch.object(rs, "RasterSource", FakeSource),
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=ROW)),
        patch.object(rs, "get_cached_tile", return_value=None),
        patch.object(rs, "cache_tile", return_value=True),
    ):
        yield test_client


def test_a_raster_layers_tile_is_colored_by_the_token(client: TestClient) -> None:
    r = client.get(f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}")
    assert r.status_code == 200 and r.content == b"\x89PNG-tile"
    assert r.headers["content-type"] == "image/webp"
    assert r.headers["cache-control"] == "public, max-age=3600" and r.headers["etag"]
    # The layer row's address, never anything from the request; no domain: the band's range.
    assert FakeSource.opened == [ROW.url]
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


def test_a_tile_comes_from_the_cache_the_second_time(client: TestClient) -> None:
    with patch.object(rs, "get_cached_tile", return_value=(b"cached", False)):
        r = client.get(
            f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}"
        )
    assert r.content == b"cached" and FakeSource.tiles == []


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
            "info",
            f"tiles/12/1/1.webp?style={RAMP}",
            "dem/12/1/1.webp",
            "point?lon=11.55&lat=48.15",
        ):
            assert (
                client.get(f"/collections/{LAYER}/raster/{path}").status_code == 403
            ), path
    authz._read_authz_cache.clear()


def test_info_lists_the_bands_statistics(client: TestClient) -> None:
    body = client.get(f"/collections/{LAYER}/raster/info").json()
    assert body["count"] == 1 and body["dtype"] == "float32" and body["nodata"] == -9999
    assert body["bounds"] == [11.5, 48.1, 11.6, 48.2]
    [band] = body["bands"]
    assert band["min"] == 100 and band["p98"] == 394 and band["approximate"] is True
    assert band["histogram"] == {"counts": [3, 4], "edges": [100.0, 250.0, 400.0]}


def test_elevation_tiles_are_served(client: TestClient) -> None:
    r = client.get(f"/collections/{LAYER}/raster/dem/12/2178/1420.webp")
    assert r.status_code == 200 and r.content == b"\x89PNG-dem"


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


def test_a_cached_tile_does_not_wait_for_the_raster_readers(client: TestClient) -> None:
    from geoapi.routers import rasters

    submitted: list[object] = []

    class Recording:
        def submit(self, fn: Any, *args: Any) -> Any:
            submitted.append(fn)
            from concurrent.futures import Future

            future: Future = Future()
            future.set_result(fn(*args))
            return future

    with (
        patch.object(rasters, "RASTER_EXECUTOR", Recording()),
        patch.object(rs, "get_cached_tile", return_value=(b"cached", False)),
    ):
        r = client.get(
            f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}"
        )
    assert r.content == b"cached" and submitted == []


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
        patch.object(rs, "get_cached_tile", return_value=None),
        patch.object(rs, "cache_tile", return_value=True),
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
                target=rs.raster_service.tile, args=(ROW, 12, x, 1420, coloring, RAMP)
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
        rs.raster_service.tile(ROW, 12, 1, 1, image, "image")
    assert FakeSource.tiles[-1][4] is None
