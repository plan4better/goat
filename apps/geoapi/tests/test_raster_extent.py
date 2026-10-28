"""A raster file layer's bounds: the `bounds` route reads only the file's header
and answers them in EPSG:4326. core stores them as the layer's extent when it
creates the layer; the web asks this route for a layer stored without one.
geoapi's raster routes only read: none of them writes to the layer row."""

import dataclasses
from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from goatlib.raster.source import BandStats, RasterInfo
from goatlib.raster.token import encode_token

from geoapi.services import raster_service as rs

LAYER = "abc123def456789012345678901234ab"
RGB = encode_token({"v": 1, "kind": "rgb", "bands": None, "noData": []})
#: A UTM file's bounds as goatlib reports them: already in degrees.
INFO = RasterInfo(
    10980,
    10980,
    (13.53, 51.36, 15.17, 52.37),
    3,
    "uint8",
    0.0,
    (8, 8, 8),
    None,
    (1.0, 1.0, 1.0),
    (0.0, 0.0, 0.0),
    ("R", "G", "B"),
)
STATS = [BandStats(1, 0.0, 255.0, 90.0, 40.0, 10.0, 240.0, ([1], [0.0, 255.0]), None)]


class FakeSource:
    headers = 0

    def __init__(self, url: str, private_hosts: Any = ()) -> None:
        self.url = url

    def __enter__(self) -> "FakeSource":
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    def info(self) -> RasterInfo:
        FakeSource.headers += 1
        return INFO

    def statistics(self) -> list[BandStats]:
        return STATS

    def tile(self, *args: Any, **kwargs: Any) -> bytes | None:
        return b"tile"

    def dem(self, *args: Any, **kwargs: Any) -> bytes | None:
        return b"dem"

    def point(self, *args: Any, **kwargs: Any) -> Any:
        return rs.PointValues([1.0], None)


#: The layer row as Postgres answers it: a COG stored without an extent.
ROW = {"url": "https://cdn.example/tci.tif", "updated": 1, "has_extent": False}


@pytest.fixture
def db() -> Iterator[AsyncMock]:
    """Every statement geoapi sends to Postgres; the layer lookup finds a COG
    layer stored without an extent."""
    FakeSource.headers = 0
    rs.raster_service.clear()

    async def execute(sql: str, *args: Any, **kwargs: Any) -> Any:
        return ROW if sql.lstrip().upper().startswith("SELECT") else None

    mock = AsyncMock(side_effect=execute)
    with (
        patch.object(rs, "RasterSource", FakeSource),
        patch.object(rs.layer_service, "_execute_with_retry", mock),
        patch.object(rs, "get_cached_tile", return_value=None),
        patch.object(rs, "cache_tile", return_value=True),
    ):
        yield mock


def _statements(db: AsyncMock) -> list[str]:
    return [" ".join(c.args[0].split()).upper() for c in db.await_args_list]


def test_bounds_answers_the_files_bounds_in_degrees(
    test_client: TestClient, db: AsyncMock
) -> None:
    r = test_client.get(f"/collections/{LAYER}/raster/bounds")
    assert r.status_code == 200
    assert r.json() == {"bounds": [13.53, 51.36, 15.17, 52.37]}


def test_bounds_reads_only_the_header_once_per_layer_version(
    test_client: TestClient, db: AsyncMock
) -> None:
    test_client.get(f"/collections/{LAYER}/raster/bounds")
    test_client.get(f"/collections/{LAYER}/raster/bounds")
    assert FakeSource.headers == 1


@pytest.mark.parametrize(
    "route",
    [
        "raster/bounds",
        "raster/info",
        f"raster/tiles/10/550/335.webp?style={RGB}",
        "raster/dem/10/550/335.webp",
        "raster/point?lon=14&lat=52",
    ],
)
def test_no_raster_route_writes_to_the_database(
    test_client: TestClient, db: AsyncMock, route: str
) -> None:
    """Tiles are the hot path, public maps read anonymously and a read-only
    role must serve them: the layer row is core's to write."""
    r = test_client.get(f"/collections/{LAYER}/{route}")
    assert r.status_code == 200, r.text
    statements = _statements(db)
    assert statements and all(s.startswith("SELECT") for s in statements)


def test_drawing_a_layer_reads_no_header_for_its_bounds(
    test_client: TestClient, db: AsyncMock
) -> None:
    test_client.get(f"/collections/{LAYER}/raster/dem/10/550/335.webp")
    assert FakeSource.headers == 0


@pytest.mark.parametrize(
    "bounds",
    [
        (float("nan"), 51.36, 15.17, 52.37),
        (13.53, 51.36, 13.53 - 1, 52.37),
        (-200.0, 51.36, 15.17, 52.37),
    ],
)
def test_bounds_that_are_no_box_on_earth_answer_null(
    test_client: TestClient, db: AsyncMock, bounds: tuple[float, ...]
) -> None:
    broken = dataclasses.replace(INFO, bounds=bounds)
    with patch.object(FakeSource, "info", lambda self: broken):
        r = test_client.get(f"/collections/{LAYER}/raster/bounds")
    assert r.status_code == 200 and r.json() == {"bounds": None}
