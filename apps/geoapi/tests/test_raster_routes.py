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
from goatlib.raster.values import ENCODING_VERSION, ValueEncoding, value_encoding

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
    minzoom=10,
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
#: The layer's values version: its row's, and the encoding's.
CURRENT = f"v1-{ENCODING_VERSION}"
#: A value tile's address names its encoding (code q is base + q * step).
VALUE_TILE = f"{COVERAGE}/12/1420/2178?f=webp&band=1&base=-1.5&step=0.25&v={CURRENT}"
#: What a value tile of the current version may be kept for: its address fixes
#: it. Shared caches may keep it only when it was read without signing in.
FOREVER = "public, max-age=31536000, immutable"
FOREVER_PRIVATE = "private, max-age=31536000, immutable"
#: A value tile of a remote file whose host gives no validator: its version
#: does not follow the file, so it is kept for an hour.
AN_HOUR = "public, max-age=3600"
AN_HOUR_PRIVATE = "private, max-age=3600"
SIGNED_IN = {"Authorization": "Bearer a-token"}
NAMED = ValueEncoding(base=-1.5, step=0.25, integer=False, range=None)
#: A colored tile's address names its coloring and, as a value tile's, the
#: layer's values version.
TOKEN_TILE = (
    f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={RAMP}&v={CURRENT}"
)
#: The colored tiles' description.
IMAGE_TILESET = f"/collections/{LAYER}/raster/tiles"
#: A tile of each kind at the layer's current values version, and what it holds.
TILES = {"values": VALUE_TILE, "image": TOKEN_TILE}
CONTENT = {"values": b"RIFF-values", "image": b"\x89PNG-tile"}
#: A tile of each kind outside the file: no content.
EMPTY = {
    "values": f"{COVERAGE}/3/1/1?f=webp&base=0&step=1&v={CURRENT}",
    "image": f"/collections/{LAYER}/raster/tiles/3/1/1.webp?style={RAMP}&v={CURRENT}",
}


class FakeSource:
    opened: list[str] = []
    tiles: list[tuple[Any, ...]] = []
    values_read: list[tuple[Any, ...]] = []
    #: The tile size of each tile read, colored or values.
    sizes: list[int] = []
    #: Whether each source opened remembers its failures for the file.
    remembering: list[bool] = []
    fail: Exception | None = None

    def __init__(
        self,
        url: str,
        private_hosts: Any = (),
        *,
        stored_file: Any = None,
        remember_failures: bool = True,
    ) -> None:
        #: What is read: the address, or the file GOAT stores for the layer.
        self.url = url if url is not None else stored_file
        FakeSource.remembering.append(remember_failures)

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
        self,
        z: int,
        x: int,
        y: int,
        coloring: Any,
        band_range: Any = None,
        tilesize: int = 256,
    ) -> bytes | None:
        FakeSource.tiles.append((z, x, y, coloring.kind, band_range))
        FakeSource.sizes.append(tilesize)
        return None if z < 5 else b"\x89PNG-tile"

    def values(
        self,
        z: int,
        x: int,
        y: int,
        formula: Any,
        encoding: Any,
        resampling: str,
        tilesize: int = 256,
    ) -> bytes | None:
        if max(formula.bands) > INFO.count:
            raise BandError("The raster has 1 band.")
        FakeSource.values_read.append(
            (z, x, y, formula.expression, encoding, resampling)
        )
        FakeSource.sizes.append(tilesize)
        return None if z < 5 else b"RIFF-values"

    def point(self, lon: float, lat: float, formula: Any = None) -> PointValues:
        return PointValues([250.0], 250.0 if formula is not None else None)

    def sample(self, formula: Any) -> Any:
        import numpy as np

        return np.array([1.0, 3.0])


@pytest.fixture
def client(test_client: TestClient) -> Iterator[TestClient]:
    FakeSource.opened, FakeSource.tiles, FakeSource.fail = [], [], None
    FakeSource.values_read, FakeSource.sizes = [], []
    FakeSource.remembering = []
    rs.raster_service.clear()
    with (
        patch.object(rs, "RasterSource", FakeSource),
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=ROW)),
        # The layer's host gives no validator (no ETag, no Last-Modified).
        patch.object(rs, "remote_validator", return_value=None),
    ):
        yield test_client


@pytest.fixture
def validated(client: TestClient) -> Iterator[str]:
    """The layer's host gives its file's ETag, so the values version follows
    the file: that version, as the descriptions name it."""
    with patch.object(rs, "remote_validator", return_value='"a"'):
        version = client.get(COVERAGE).json()["goat:values"]["version"]
        assert version != CURRENT
        assert client.get(IMAGE_TILESET).json()["goat:version"] == version
        yield version


def test_a_raster_layers_tile_is_colored_by_the_token(client: TestClient) -> None:
    r = client.get(TOKEN_TILE)
    assert r.status_code == 200 and r.content == b"\x89PNG-tile"
    assert r.headers["content-type"] == "image/webp"
    # The layer's host gives no validator: kept an hour.
    assert r.headers["cache-control"] == AN_HOUR and r.headers["etag"]
    # The layer row's address, never anything from the request; no domain: the band's range.
    assert FakeSource.opened == [ROW.external_url]
    assert FakeSource.tiles == [(12, 2178, 1420, "ramp", (100.0, 400.0))]


@pytest.mark.parametrize(
    ("outside", "domain", "band_range"),
    [("hide", None, (100.0, 400.0)), ("hide", [0, 30], None), ("clamp", None, None)],
)
def test_classes_that_hide_values_outside_get_the_bands_range_without_a_domain(
    client: TestClient,
    outside: str,
    domain: list[float] | None,
    band_range: tuple[float, float] | None,
) -> None:
    """Classes whose outside cells are hidden end at their domain, else at the
    band's range, as a ramp; with the end colors they need neither."""
    token = encode_token(
        {
            "v": 1,
            "kind": "classes",
            "band": 1,
            "noData": [],
            "classes": [
                {"to": 200, "color": "#000000"},
                {"from": 200, "color": "#ffffff"},
            ],
            "domain": domain,
            "outside": outside,
        }
    )
    r = client.get(f"/collections/{LAYER}/raster/tiles/12/2178/1420.webp?style={token}")
    assert r.status_code == 200
    assert FakeSource.tiles == [(12, 2178, 1420, "classes", band_range)]


def test_the_same_tile_again_is_not_modified(client: TestClient) -> None:
    etag = client.get(TOKEN_TILE).headers["etag"]
    again = client.get(TOKEN_TILE, headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.headers["etag"] == etag
    assert again.headers["cache-control"] == AN_HOUR
    assert len(FakeSource.tiles) == 1


@pytest.mark.parametrize("kind", ["values", "image"])
def test_outside_the_file_there_is_no_content(client: TestClient, kind: str) -> None:
    r = client.get(EMPTY[kind])
    assert r.status_code == 204 and r.content == b""
    assert r.headers["cache-control"] == "public, max-age=3600"


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
            "raster/tiles",
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
    assert body["color_interp"] == [] and body["palette"] is None
    [band] = body["bands"]
    assert band["min"] == 100 and band["p98"] == 394 and band["approximate"] is True
    assert band["histogram"] == {"counts": [3, 4], "edges": [100.0, 250.0, 400.0]}


def test_info_carries_breaks_computed_once(client: TestClient) -> None:
    """The class breaks of the band asked for, for each method and count,
    computed once per values version and band, so the panel switches methods
    without a request."""
    import numpy as np
    from goatlib.raster.stats import BREAK_COUNTS, BREAK_METHODS

    def sample(self: FakeSource, formula: Any) -> Any:
        assert formula.expression == "b1"
        return np.arange(1, 101, dtype="float64")

    with (
        patch.object(FakeSource, "sample", sample),
        patch.object(
            rs, "precomputed_breaks", wraps=rs.precomputed_breaks
        ) as precomputed,
    ):
        bodies = [
            client.get(f"/collections/{LAYER}/raster/info?band=1").json()
            for _ in range(2)
        ]
    precomputed.assert_called_once()
    assert bodies[0] == bodies[1]
    [band] = bodies[0]["bands"]
    assert list(band["breaks"]) == list(BREAK_METHODS)
    assert list(band["breaks"]["quantile"]) == [str(n) for n in BREAK_COUNTS]
    assert band["breaks"]["quantile"]["4"] == [25.75, 50.5, 75.25]
    # 1 to 100 in three geometric classes: the ratio is 100 ** (1 / 3).
    assert band["breaks"]["geometric_interval"]["3"] == [4.64158883361, 21.5443469003]
    assert list(band["breaks"]["natural_breaks"])[-1] == "13"


def test_info_answers_breaks_only_for_the_band_asked_for(
    client: TestClient,
) -> None:
    """A file with three bands: the info computes the breaks of the band it is
    asked for (`band`) from that band's values alone, once per values version
    and band, and answers that band's only. Without a band, or for a formula,
    no band carries breaks, kept or not: an answer never depends on what a pod
    keeps, and a cold info never waits for bands nobody classifies."""
    import numpy as np

    three = dataclasses.replace(INFO, count=3, bits=(32, 32, 32))
    read: list[str] = []

    def sample(self: FakeSource, formula: Any) -> Any:
        read.append(formula.expression)
        return np.arange(1.0, 101.0) * formula.bands[-1]

    def breaks_of(body: dict[str, Any]) -> list[Any]:
        return [b.get("breaks", {}).get("quantile", {}).get("4") for b in body["bands"]]

    info = f"/collections/{LAYER}/raster/info"
    with (
        patch.object(FakeSource, "info", lambda self: three),
        patch.object(
            FakeSource,
            "statistics",
            lambda self: [dataclasses.replace(STATS[0], index=i) for i in (1, 2, 3)],
        ),
        patch.object(FakeSource, "sample", sample),
    ):
        plain = client.get(info).json()
        assert read == [] and all("breaks" not in b for b in plain["bands"])
        second = client.get(f"{info}?band=2").json()
        assert read == ["b2"]
        assert breaks_of(second) == [None, [51.5, 101.0, 150.5], None]
        assert "breaks" not in second["bands"][0] and "breaks" not in second["bands"][2]
        assert client.get(f"{info}?band=2").json() == second and read == ["b2"]
        first = client.get(f"{info}?band=1").json()
        assert read == ["b2", "b1"]
        assert breaks_of(first) == [[25.75, 50.5, 75.25], None, None]
        assert "breaks" not in first["bands"][1]
        # Kept breaks are answered for their band alone, and without a read.
        assert client.get(info).json() == plain
        assert client.get(f"{info}?band=2").json() == second


async def test_concurrent_cold_infos_of_one_band_compute_its_breaks_once(
    test_client: TestClient,
) -> None:
    """Infos asking for a cold band at the same time wait for one read of its
    values and one classification, and all answer its breaks."""
    import asyncio
    import time

    import httpx
    import numpy as np

    from geoapi.main import app

    read: list[str] = []

    class Slow(FakeSource):
        def sample(self, formula: Any) -> Any:
            read.append(formula.expression)
            time.sleep(0.2)
            return np.arange(1.0, 101.0)

    rs.raster_service.clear()
    info = f"/collections/{LAYER}/raster/info?band=1"
    with (
        patch.object(rs, "RasterSource", Slow),
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=ROW)),
        patch.object(rs, "remote_validator", return_value=None),
        patch.object(
            rs, "precomputed_breaks", wraps=rs.precomputed_breaks
        ) as precomputed,
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
            answers = await asyncio.gather(*(http.get(info) for _ in range(6)))
    assert read == ["b1"]
    precomputed.assert_called_once()
    assert {r.status_code for r in answers} == {200}
    assert all(
        r.json()["bands"][0]["breaks"]["quantile"]["4"] == [25.75, 50.5, 75.25]
        for r in answers
    )


def test_info_refuses_a_band_without_values(client: TestClient) -> None:
    """A band the file does not hold as values is refused in validation's
    words, as the tile routes refuse it; nothing is read for its breaks."""
    reads = []
    with patch.object(FakeSource, "sample", lambda self, f: reads.append(f) or None):
        r = client.get(f"/collections/{LAYER}/raster/info?band=2")
    assert r.status_code == 400 and r.json()["detail"] == "The raster has 1 band."
    assert reads == []


def test_info_has_no_geometric_intervals_for_a_band_reaching_zero(
    client: TestClient,
) -> None:
    """Geometric intervals need every value above 0: a band with negative
    values (a terrain model below sea level) gets none, the other methods
    theirs."""
    import numpy as np

    values = np.arange(-20, 81, dtype="float64")
    with patch.object(FakeSource, "sample", lambda self, formula: values):
        [band] = client.get(f"/collections/{LAYER}/raster/info?band=1").json()["bands"]
    assert band["breaks"]["geometric_interval"] == {}
    assert len(band["breaks"]["quantile"]["5"]) == 4


def test_a_whole_number_bands_breaks_in_the_info_are_whole_numbers(
    client: TestClient,
) -> None:
    """An 8 bit file (neither scaled nor offset): every method's breaks are
    whole numbers, as the style check writes them."""
    import dataclasses

    import numpy as np
    from goatlib.raster.stats import precomputed_breaks

    values = np.random.default_rng(3).gamma(2.0, 30.0, 5_000).round().clip(7, 255)
    byte = dataclasses.replace(INFO, dtype="uint8")
    with (
        patch.object(FakeSource, "sample", lambda self, formula: values),
        patch.object(FakeSource, "info", lambda self: byte),
    ):
        [band] = client.get(f"/collections/{LAYER}/raster/info?band=1").json()["bands"]
    for method, by_count in band["breaks"].items():
        for breaks in by_count.values():
            assert all(float(b).is_integer() for b in breaks), method
    assert band["breaks"]["geometric_interval"]["5"] == list(
        precomputed_breaks(values, whole=True)["geometric_interval"]["5"]
    )


def test_info_breaks_are_those_a_style_check_writes(client: TestClient) -> None:
    """A band with more values than are classified: the info's breaks for a
    method and count are the class bounds the style check (processes) writes
    for them, so picking them in the panel and saving moves no class."""
    import numpy as np
    from goatlib.raster.stats import PRECOMPUTE_SAMPLE, compute_raster_into

    values = np.random.default_rng(5).gamma(2.0, 50.0, PRECOMPUTE_SAMPLE * 3)
    with patch.object(FakeSource, "sample", lambda self, formula: values):
        [band] = client.get(f"/collections/{LAYER}/raster/info?band=1").json()["bands"]
        for method in ("quantile", "natural_breaks"):
            style = {
                "version": "1.0.0",
                "kind": "raster",
                "render": {
                    "type": "continuous",
                    "palette": "goat:elevation",
                    "classify": {"method": method, "count": 5},
                },
            }
            checked, _ = compute_raster_into(
                FakeSource(ROW.external_url),  # type: ignore[arg-type]
                style,
                fingerprint="url:x",
            )
            classes = checked["render"]["classify"]["classes"]
            assert band["breaks"][method]["5"] == [k["to"] for k in classes[:-1]]


def test_a_failed_breaks_computation_still_answers_the_statistics(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    """The breaks are optional: the info answers the statistics and no breaks
    for the band, the log names the file without its key, the next info does
    not compute them again at once, and the file's tiles are not blamed."""
    import numpy as np
    from goatlib.raster.source import recent_failure

    calls = []

    def failing(values: Any, *rest: Any) -> Any:
        calls.append(values.size)
        raise RuntimeError("could not classify https://cdn.example/dem.tif?sig=abc")

    with (
        patch.object(FakeSource, "sample", lambda self, f: np.arange(10.0)),
        patch.object(rs, "precomputed_breaks", failing),
        caplog.at_level("WARNING"),
    ):
        answers = [
            client.get(f"/collections/{LAYER}/raster/info?band=1") for _ in range(2)
        ]
    for r in answers:
        assert r.status_code == 200
        [band] = r.json()["bands"]
        assert band["min"] == 100 and band["breaks"] == {}
    assert calls == [10]
    assert "could not classify" in caplog.text and "sig=abc" not in caplog.text
    assert recent_failure(rs.raster_service.failure_key(ROW)) is None
    assert client.get(TOKEN_TILE).status_code == 200


def test_a_failed_read_for_the_breaks_does_not_mark_the_file_failing(
    client: TestClient,
) -> None:
    from goatlib.raster.source import recent_failure

    def unreadable(self: FakeSource, formula: Any) -> Any:
        raise RasterUnavailableError("The file's host did not answer in time.")

    with patch.object(FakeSource, "sample", unreadable):
        r = client.get(f"/collections/{LAYER}/raster/info?band=1")
    assert r.status_code == 200 and r.json()["bands"][0]["breaks"] == {}
    # The statistics read remembers a failing file, the breaks read does not.
    assert FakeSource.remembering == [True, False]
    assert recent_failure(rs.raster_service.failure_key(ROW)) is None


def test_a_band_whose_breaks_fail_leaves_the_others_theirs(client: TestClient) -> None:
    """A band whose values overflow DuckDB's standard deviation gets no breaks;
    the other bands keep theirs."""
    import dataclasses

    import numpy as np

    two = dataclasses.replace(INFO, count=2, bits=(32, 32))
    huge = np.concatenate([np.linspace(0, 1000, 5000), [1.7976931348623157e308] * 10])

    read: list[str] = []

    def sample(self: FakeSource, formula: Any) -> Any:
        read.append(formula.expression)
        return huge if formula.expression == "b2" else np.arange(1.0, 101.0)

    with (
        patch.object(FakeSource, "info", lambda self: two),
        patch.object(
            FakeSource,
            "statistics",
            lambda self: [STATS[0], dataclasses.replace(STATS[0], index=2)],
        ),
        patch.object(FakeSource, "sample", sample),
    ):
        failed = client.get(f"/collections/{LAYER}/raster/info?band=2")
        r = client.get(f"/collections/{LAYER}/raster/info?band=1")
        again = client.get(f"/collections/{LAYER}/raster/info?band=2")
    assert failed.status_code == 200 and r.status_code == 200
    assert [b.get("breaks") for b in failed.json()["bands"]] == [None, {}]
    first, second = r.json()["bands"]
    assert first["breaks"]["quantile"]["4"] == [25.75, 50.5, 75.25]
    assert "breaks" not in second
    # The failed band's empty breaks are kept for 30 seconds, as the others' for an hour.
    assert again.json() == failed.json() and read == ["b2", "b1"]


def test_an_info_looks_up_the_values_version_once(client: TestClient) -> None:
    """Statistics and breaks of one answer are of the same file version."""
    with patch.object(
        rs.raster_service, "values_state", wraps=rs.raster_service.values_state
    ) as state:
        assert client.get(f"/collections/{LAYER}/raster/info").status_code == 200
    assert state.call_count == 1


BREAKS_S = 0.6


@pytest.mark.parametrize("infos", [1, 4])
async def test_tiles_never_wait_for_the_breaks(
    test_client: TestClient, infos: int
) -> None:
    """Cold infos of a layer wait for one computation of its breaks without a
    read slot, and the classifying runs after the slot is released: 8 tiles
    take about as long with 4 cold infos as with 1."""
    import asyncio
    import time

    import httpx
    import numpy as np

    from geoapi.main import app

    def slow_breaks(values: Any, *rest: Any) -> Any:
        time.sleep(BREAKS_S)
        return {}

    class Tiles(FakeSource):
        def tile(self, *args: Any, **kwargs: Any) -> bytes:
            time.sleep(0.05)
            return b"tile"

        def sample(self, formula: Any) -> Any:
            return np.arange(10.0)

    rs.raster_service.clear()
    tile = f"/collections/{LAYER}/raster/tiles/12/{{x}}/1420.webp?style={RAMP}"
    with (
        patch.object(rs, "RasterSource", Tiles),
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=ROW)),
        patch.object(rs, "remote_validator", return_value=None),
        patch.object(rs, "precomputed_breaks", slow_breaks),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
            # The statistics are warm: only the breaks are cold.
            await http.get(tile.format(x=0))
            info = f"/collections/{LAYER}/raster/info?band=1"
            cold = [asyncio.create_task(http.get(info)) for _ in range(infos)]
            await asyncio.sleep(0.1)
            started = time.monotonic()
            tiles = await asyncio.gather(
                *(http.get(tile.format(x=x)) for x in range(1, 9))
            )
            took = time.monotonic() - started
            answers = await asyncio.gather(*cold)
    assert {r.status_code for r in tiles} == {200}
    assert {r.status_code for r in answers} == {200}
    # Tiles held back by the breaks would take a whole computation or more.
    assert took < BREAKS_S * 0.75, took


def _rgba_cog(path: Path) -> Path:
    """A small orthophoto with an alpha band (its transparency) over the
    layer's bounds: red runs with x, green with y, blue is 50, and the left
    quarter is transparent."""
    import numpy as np
    import rasterio
    from rasterio.shutil import copy as rio_copy
    from rasterio.transform import from_bounds

    size = 256
    y, x = np.mgrid[0:size, 0:size]
    opacity = np.where(x < size // 4, 0, 255)
    data = np.stack([x, y, np.full_like(x, 50), opacity]).astype("uint8")
    plain = path.with_suffix(".plain.tif")
    with rasterio.open(
        plain,
        "w",
        driver="GTiff",
        width=size,
        height=size,
        count=4,
        dtype="uint8",
        crs="EPSG:4326",
        transform=from_bounds(*INFO.bounds, size, size),
        photometric="RGB",
        alpha="YES",
    ) as dst:
        dst.write(data)
    rio_copy(plain, path, driver="COG", BLOCKSIZE=256)
    return path


def test_an_orthophoto_with_an_alpha_band_is_described_and_drawn(
    test_client: TestClient, tmp_path: Path
) -> None:
    """Read by goatlib's own reader: the alpha band is the image's
    transparency, as the reader takes it, so the info describes the three
    color bands (the file has four), its tiles and value tiles draw, and a
    point has no value for the alpha band."""
    import morecantile

    path = _rgba_cog(tmp_path / "rgba.tif")
    layer = rs.RasterLayer(id=LAYER, external_url=None, version="v1", stored_file=path)
    west, south, east, north = INFO.bounds
    lon, lat = west + (east - west) * 0.6, (south + north) / 2
    tile = morecantile.tms.get("WebMercatorQuad").tile(lon, lat, 14)
    image = encode_token({"v": 1, "kind": "rgb", "bands": None, "noData": []})
    rs.raster_service.clear()
    with patch.object(rs.raster_service, "layer", AsyncMock(return_value=layer)):
        info = test_client.get(f"/collections/{LAYER}/raster/info?band=1")
        colored = test_client.get(
            f"/collections/{LAYER}/raster/tiles/{tile.z}/{tile.x}/{tile.y}.webp"
            f"?style={image}"
        )
        values = test_client.get(
            f"{COVERAGE}/{tile.z}/{tile.y}/{tile.x}?f=webp&band=3&base=0&step=1"
        )
        point = test_client.get(
            f"/collections/{LAYER}/raster/point?lon={lon}&lat={lat}"
        )
    rs.raster_service.clear()
    assert info.status_code == 200, info.text
    body = info.json()
    assert body["count"] == 4
    assert [b["index"] for b in body["bands"]] == [1, 2, 3]
    assert body["bands"][2]["min"] == body["bands"][2]["max"] == 50
    assert body["bands"][0]["breaks"]["quantile"]["4"]
    assert colored.status_code == 200 and values.status_code == 200
    assert point.status_code == 200
    assert point.json()["values"][2] == 50 and point.json()["values"][3] is None


def test_an_orthophotos_tiles_take_its_value_bands_only(
    test_client: TestClient, tmp_path: Path
) -> None:
    """The alpha band is the image's transparency: a band or formula naming it
    is refused as validation refuses it, in its words; the color bands draw."""
    import morecantile

    path = _rgba_cog(tmp_path / "rgba.tif")
    layer = rs.RasterLayer(id=LAYER, external_url=None, version="v1", stored_file=path)
    west, south, east, north = INFO.bounds
    lon, lat = west + (east - west) * 0.6, (south + north) / 2
    t = morecantile.tms.get("WebMercatorQuad").tile(lon, lat, 14)
    tiles = f"{COVERAGE}/{t.z}/{t.y}/{t.x}?f=webp&base=0&step=1"

    def ramp(band: int) -> str:
        return encode_token(
            {
                "v": 1,
                "kind": "ramp",
                "band": band,
                "noData": [],
                "colors": ["#000000", "#ffffff"],
                "domain": [0, 255],
                "outside": "clamp",
            }
        )

    colored = f"/collections/{LAYER}/raster/tiles/{t.z}/{t.x}/{t.y}.webp?style="
    rs.raster_service.clear()
    with patch.object(rs.raster_service, "layer", AsyncMock(return_value=layer)):
        refused = [
            test_client.get(f"{COVERAGE}?band=4"),
            test_client.get(f"{COVERAGE}?formula=b4*2"),
            test_client.get(f"{tiles}&band=4"),
            test_client.get(f"{tiles}&formula=b4*2"),
            test_client.get(colored + ramp(4)),
        ]
        drawn = [
            response
            for band in (1, 2, 3)
            for response in (
                test_client.get(f"{COVERAGE}?band={band}"),
                test_client.get(f"{tiles}&band={band}"),
                test_client.get(colored + ramp(band)),
            )
        ]
    rs.raster_service.clear()
    for r in refused:
        assert r.status_code == 400, r.request.url
        assert r.json()["detail"] == "The raster has 3 bands."
    assert [r.status_code for r in drawn] == [200] * 9


def test_info_counts_the_cells_of_each_code(client: TestClient) -> None:
    """A whole-number band with few codes lists them with how many cells of the
    overview hold each, so the class editor shows each category's share."""
    codes = dataclasses.replace(STATS[0], values=[1.0, 2.0, 7.0], counts=[5, 3, 2])
    with patch.object(FakeSource, "statistics", lambda self: [codes]):
        [band] = client.get(f"/collections/{LAYER}/raster/info").json()["bands"]
    assert band["values"] == [1, 2, 7] and band["counts"] == [5, 3, 2]
    rs.raster_service.clear()
    [band] = client.get(f"/collections/{LAYER}/raster/info").json()["bands"]
    assert band["values"] is None and band["counts"] is None


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
            self,
            z: int,
            x: int,
            y: int,
            coloring: Any,
            band_range: Any = None,
            tilesize: int = 256,
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
        "bounds",
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
    # West, south, east and north in degrees, as TileJSON gives them.
    assert body["bounds"] == list(INFO.bounds)
    values = body["goat:values"]
    # A float band: its statistics' range spread over the codes.
    assert values["encoding"] == DESCRIBED.factors()
    assert values["range"] == [100.0, 400.0] and values["integer"] is False
    assert values["version"] == CURRENT
    [link] = body["links"]
    assert link == {
        "rel": "item",
        "type": "image/webp",
        "templated": True,
        "href": (
            f"http://testserver{COVERAGE}/{{tileMatrix}}/{{tileRow}}/{{tileCol}}"
            "?f=webp&band=1&resampling=bilinear"
            f"&base={DESCRIBED.base!r}&step={DESCRIBED.step!r}&v={CURRENT}"
        ),
    }
    assert r.headers["cache-control"] == "public, max-age=60"
    etag = r.headers["etag"]
    assert client.get(COVERAGE, headers={"If-None-Match": etag}).status_code == 304
    nearest = client.get(f"{COVERAGE}?resampling=nearest")
    assert nearest.headers["etag"] != etag
    assert nearest.json()["links"][0]["href"].endswith(
        f"?f=webp&band=1&resampling=nearest&base={DESCRIBED.base!r}"
        f"&step={DESCRIBED.step!r}&v={CURRENT}"
    )


def test_the_value_tileset_names_the_files_bands(client: TestClient) -> None:
    """The file's band names as `/raster/info` gives them (a band without a
    description is "Band <n>"): a map's popup labels the values with them
    without asking for the info."""
    import dataclasses

    assert client.get(COVERAGE).json()["goat:values"]["names"] == ["Band 1"]
    named = dataclasses.replace(INFO, names=("Höhe",))
    with patch.object(FakeSource, "info", lambda self: named):
        body = client.get(f"{COVERAGE}?resampling=nearest").json()
    assert body["goat:values"]["names"] == ["Höhe"]


def test_the_value_tilesets_etag_names_its_shape(client: TestClient) -> None:
    """A description that gained a field (`names`) is not a 304 of one kept
    from before: its ETag names the body's shape, not only what the tiles
    show, while the tiles keep their URLs (`ENCODING_VERSION`)."""
    from urllib.parse import urlencode

    from geoapi.routers import rasters

    shown = urlencode({"f": "webp", "band": 1, "resampling": "bilinear"})
    etag = client.get(COVERAGE).headers["etag"]
    assert etag != rasters._etag(LAYER, CURRENT, shown)
    assert etag == rasters._etag(
        LAYER, CURRENT, shown, rasters.VALUES_DESCRIPTION_SHAPE
    )
    stale = rasters._etag(LAYER, CURRENT, shown)
    assert client.get(COVERAGE, headers={"If-None-Match": stale}).status_code == 200


def test_the_value_tileset_of_512_px_tiles_is_one_zoom_higher_up(
    client: TestClient,
) -> None:
    """A 512 px tile shows a file's cells at their own size one zoom higher up
    than a 256 px one: its description's native zoom is one less, and its link
    asks for 512 px tiles."""
    small = client.get(COVERAGE)
    large = client.get(f"{COVERAGE}?tilesize=512")
    assert large.status_code == 200, large.text
    body = large.json()
    assert body["maxzoom"] == small.json()["maxzoom"] - 1 == INFO.maxzoom - 1
    assert body["bounds"] == small.json()["bounds"]
    assert body["goat:values"] == small.json()["goat:values"]
    assert body["links"][0]["href"] == (
        f"http://testserver{COVERAGE}/{{tileMatrix}}/{{tileRow}}/{{tileCol}}"
        "?f=webp&band=1&resampling=bilinear&tilesize=512"
        f"&base={DESCRIBED.base!r}&step={DESCRIBED.step!r}&v={CURRENT}"
    )
    assert large.headers["etag"] != small.headers["etag"]
    # The default is 256 px, as before.
    assert client.get(f"{COVERAGE}?tilesize=256").json() == small.json()


def test_the_value_tileset_of_512_px_tiles_never_goes_below_the_minzoom(
    client: TestClient,
) -> None:
    shallow = dataclasses.replace(INFO, maxzoom=INFO.minzoom)
    with patch.object(FakeSource, "info", return_value=shallow):
        body = client.get(f"{COVERAGE}?tilesize=512").json()
    assert body["maxzoom"] == INFO.minzoom


def test_a_files_bounds_that_are_no_box_on_earth_are_null_in_the_value_tileset(
    client: TestClient,
) -> None:
    across = dataclasses.replace(INFO, bounds=(170.0, -10.0, -170.0, 10.0))
    with patch.object(FakeSource, "info", return_value=across):
        assert client.get(COVERAGE).json()["bounds"] is None


def test_the_image_tileset_tells_an_8_bit_files_bands(client: TestClient) -> None:
    """A map reads an 8 bit image's values from the pixels it draws (spec
    9.7): the description says the file's bands are 8 bit, unscaled and
    without a color table. Its ETag names this shape."""
    from urllib.parse import urlencode

    from geoapi.routers import rasters

    rgb = dataclasses.replace(
        INFO,
        count=4,
        dtype="uint8",
        nodata=None,
        bits=(8, 8, 8, 8),
        scales=(1.0,) * 4,
        offsets=(0.0,) * 4,
        names=("Rot", "Band 2", "Band 3", "Band 4"),
    )
    with patch.object(FakeSource, "info", lambda self: rgb):
        r = client.get(IMAGE_TILESET)
    assert r.json()["goat:bands"] == {
        "count": 4,
        "dtype": "uint8",
        "scaled": False,
        "color_table": False,
        "names": ["Rot", "Band 2", "Band 3", "Band 4"],
        "value_bands": [1, 2, 3, 4],
        "color_interp": [],
        "palette": None,
    }
    # Which bands the file marks red, green and blue: an image draws those.
    bgr = dataclasses.replace(rgb, color_interp=("blue", "green", "red", "undefined"))
    with patch.object(FakeSource, "info", lambda self: bgr):
        bands = client.get(IMAGE_TILESET).json()["goat:bands"]
    assert bands["color_interp"] == ["blue", "green", "red", "undefined"]
    # An alpha band holds no values: the bands a map counts leave it out.
    rgba = dataclasses.replace(rgb, alpha_bands=(4,))
    with patch.object(FakeSource, "info", lambda self: rgba):
        body = client.get(f"{IMAGE_TILESET}?tilesize=512").json()
    assert body["goat:bands"]["value_bands"] == [1, 2, 3]
    stale = rasters._etag(LAYER, CURRENT, urlencode({}))
    assert r.headers["etag"] == rasters._etag(
        LAYER, CURRENT, urlencode({}), rasters.IMAGE_DESCRIPTION_SHAPE
    )
    assert r.headers["etag"] != stale
    scaled = dataclasses.replace(rgb, scales=(0.5, 1.0, 1.0, 1.0))
    with patch.object(FakeSource, "info", lambda self: scaled):
        assert client.get(f"{IMAGE_TILESET}?tilesize=512").json()["goat:bands"][
            "scaled"
        ]


def test_the_image_tileset_and_the_info_tell_the_color_tables_colors(
    client: TestClient,
) -> None:
    """An image drawn with the file's color table: the band it colors and the
    table's every entry (RGBA), from the header, so a map tells a drawn pixel's
    code from its color (spec 9.7), also a code the statistics' overview never
    met. No statistics are read for it."""
    paletted = dataclasses.replace(
        INFO,
        dtype="uint8",
        nodata=None,
        bits=(8,),
        color_table={
            1: (255, 0, 0, 255),
            2: (0, 128, 0),
            4: (0, 0, 0, 0),
            9: (255, 0, 0, 255),
        },
        color_interp=("palette",),
    )
    palette = {
        "band": 1,
        "colors": {
            "1": [255, 0, 0, 255],
            "2": [0, 128, 0, 255],
            "4": [0, 0, 0, 0],
            "9": [255, 0, 0, 255],
        },
    }
    with (
        patch.object(FakeSource, "info", lambda self: paletted),
        patch.object(FakeSource, "statistics") as statistics,
    ):
        bands = client.get(IMAGE_TILESET).json()["goat:bands"]
        statistics.assert_not_called()
        statistics.return_value = STATS
        info = client.get(f"/collections/{LAYER}/raster/info").json()
    assert bands["palette"] == palette
    assert info["palette"] == palette
    assert bands["color_interp"] == info["color_interp"] == ["palette"]
    # A table of more entries than an 8 bit band has (a 16 bit file's), and
    # stored values that are scaled (no codes of the table): none.
    rs.raster_service.clear()
    long = dataclasses.replace(
        paletted, color_table={i: (i % 256, i // 256, 0, 255) for i in range(300)}
    )
    scaled = dataclasses.replace(paletted, scales=(0.5,))
    for header in (long, scaled):
        with patch.object(FakeSource, "info", lambda self, header=header: header):
            assert client.get(IMAGE_TILESET).json()["goat:bands"]["palette"] is None
        rs.raster_service.clear()


def test_the_image_tileset_describes_the_files_edges_and_native_zoom(
    client: TestClient,
) -> None:
    """What a map needs for the colored tiles: the file's bounds, the zoom past
    which a tile only magnifies its cells, and the values version their
    addresses name. Read from the file's header: no statistics (but for a
    file with a color table, `palette`)."""
    with (
        patch.object(FakeSource, "statistics") as statistics,
        patch.object(FakeSource, "sample") as sample,
    ):
        r = client.get(f"{IMAGE_TILESET}?tilesize=512")
        small = client.get(IMAGE_TILESET)
    assert r.status_code == 200, r.text
    statistics.assert_not_called()
    sample.assert_not_called()
    body = r.json()
    assert body == {
        "title": f"{LAYER} image",
        "tileMatrixSetURI": (
            "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
        ),
        "crs": "http://www.opengis.net/def/crs/EPSG/0/3857",
        "dataType": "map",
        "maxzoom": INFO.maxzoom - 1,
        "bounds": list(INFO.bounds),
        "links": [
            {
                "rel": "item",
                "type": "image/webp",
                "templated": True,
                "href": (
                    f"http://testserver/collections/{LAYER}/raster/tiles/"
                    "{tileMatrix}/{tileCol}/{tileRow}.webp"
                    f"?tilesize=512&v={CURRENT}"
                ),
            }
        ],
        "goat:version": CURRENT,
        # What tells whether the tiles' pixels are the file's values (8 bit
        # bands drawn as they are), and the bands' names.
        "goat:bands": {
            "count": 1,
            "dtype": "float32",
            "scaled": False,
            "color_table": False,
            "names": ["Band 1"],
            "value_bands": [1],
            "color_interp": [],
            "palette": None,
        },
    }
    # The value tiles' facts for the same tile size.
    values = client.get(f"{COVERAGE}?tilesize=512").json()
    assert body["maxzoom"] == values["maxzoom"]
    assert body["bounds"] == values["bounds"]
    assert body["goat:version"] == values["goat:values"]["version"]
    # 256 px tiles by default, one zoom deeper.
    assert small.json()["maxzoom"] == INFO.maxzoom
    assert small.json()["links"][0]["href"].endswith(f".webp?v={CURRENT}")
    assert r.headers["cache-control"] == "public, max-age=60"
    etag = r.headers["etag"]
    assert etag != small.headers["etag"]
    again = client.get(f"{IMAGE_TILESET}?tilesize=512", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers["cache-control"] == "public, max-age=60"


def test_the_image_tileset_follows_the_remote_file(client: TestClient) -> None:
    host = {"validator": '"a"'}
    with patch.object(
        rs, "remote_validator", side_effect=lambda *args: host["validator"]
    ):
        first = client.get(IMAGE_TILESET)
        host["validator"] = '"b"'
        second = client.get(
            IMAGE_TILESET, headers={"If-None-Match": first.headers["etag"]}
        )
    assert second.status_code == 200
    assert first.json()["goat:version"] != second.json()["goat:version"]


def test_the_image_tileset_of_a_stored_file(client: TestClient) -> None:
    """A catalog raster's file is the one GOAT stores: its header gives the
    extent, its row the version, and no host is asked for a validator."""
    stored = dataclasses.replace(
        ROW, external_url=None, stored_file=Path("/data/layer.tif")
    )
    with (
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=stored)),
        patch.object(rs, "remote_validator") as check,
        patch.object(FakeSource, "statistics") as statistics,
    ):
        r = client.get(f"{IMAGE_TILESET}?tilesize=512")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["goat:version"] == CURRENT
    assert body["maxzoom"] == INFO.maxzoom - 1
    assert body["bounds"] == list(INFO.bounds)
    assert body["links"][0]["href"].endswith(f".webp?tilesize=512&v={CURRENT}")
    assert FakeSource.opened == [Path("/data/layer.tif")]
    check.assert_not_called()
    statistics.assert_not_called()


@pytest.mark.parametrize("description", [COVERAGE, IMAGE_TILESET])
def test_a_description_read_with_a_sign_in_is_kept_by_the_browser_only(
    client: TestClient, description: str
) -> None:
    """As the tiles: one read with a sign-in may be of a layer not everyone may
    read, which no shared cache may keep."""
    anonymous = client.get(description)
    assert anonymous.headers["cache-control"] == "public, max-age=60"
    signed_in = client.get(description, headers=SIGNED_IN)
    assert signed_in.status_code == 200
    assert signed_in.headers["cache-control"] == "private, max-age=60"
    again = client.get(
        description, headers={**SIGNED_IN, "If-None-Match": signed_in.headers["etag"]}
    )
    assert again.status_code == 304
    assert again.headers["cache-control"] == "private, max-age=60"
    unchanged = client.get(
        description, headers={"If-None-Match": anonymous.headers["etag"]}
    )
    assert unchanged.status_code == 304
    assert unchanged.headers["cache-control"] == "public, max-age=60"


def test_a_files_bounds_that_are_no_box_on_earth_are_null_in_the_image_tileset(
    client: TestClient,
) -> None:
    across = dataclasses.replace(INFO, bounds=(170.0, -10.0, -170.0, 10.0))
    with patch.object(FakeSource, "info", return_value=across):
        assert client.get(IMAGE_TILESET).json()["bounds"] is None


@pytest.mark.parametrize("route", ["image", "values"])
def test_tiles_are_256_px_unless_512_are_asked_for(
    client: TestClient, route: str
) -> None:
    from geoapi.routers import rasters

    tile = TOKEN_TILE if route == "image" else VALUE_TILE
    small = client.get(tile)
    large = client.get(f"{tile}&tilesize=512")
    assert small.status_code == large.status_code == 200, large.text
    assert FakeSource.sizes == [256, 512]
    assert large.headers["cache-control"] == small.headers["cache-control"]
    # Another tile size is another tile.
    assert large.headers["etag"] != small.headers["etag"]
    again = client.get(
        f"{tile}&tilesize=512", headers={"If-None-Match": large.headers["etag"]}
    )
    assert again.status_code == 304 and FakeSource.sizes == [256, 512]
    # A 256 px tile keeps the ETag it had before tiles had sizes.
    if route == "image":
        version = rs.raster_service.tile_version(ROW, RAMP)
        unsized = rasters._etag(LAYER, version, 12, 2178, 1420)
    else:
        shown = f"values:b1:bilinear:webp:{ENCODING_VERSION}"
        version = rs.raster_service.tile_version(ROW, shown)
        unsized = rasters._etag(LAYER, version, CURRENT, -1.5, 0.25, 12, 2178, 1420)
    assert small.headers["etag"] == unsized
    assert client.get(f"{tile}&tilesize=256").headers["etag"] == unsized


@pytest.mark.parametrize(
    "url",
    [
        f"{route}{sep}tilesize={size}"
        for route, sep in (
            (TOKEN_TILE, "&"),
            (VALUE_TILE, "&"),
            (COVERAGE, "?"),
            (IMAGE_TILESET, "?"),
        )
        for size in ("300", "1024", "big")
    ],
)
def test_only_256_and_512_px_tiles_are_served(client: TestClient, url: str) -> None:
    assert client.get(url).status_code == 422
    assert FakeSource.opened == []


def test_a_value_tile_is_webp_and_answers_304_on_its_etag(client: TestClient) -> None:
    r = client.get(VALUE_TILE)
    assert r.status_code == 200 and r.content == b"RIFF-values"
    assert r.headers["content-type"] == "image/webp"
    assert r.headers["cache-control"] == AN_HOUR
    # Row 1420 is y, column 2178 is x; the band's values in the address's encoding.
    assert FakeSource.values_read == [(12, 2178, 1420, "b1", NAMED, "bilinear")]
    assert FakeSource.opened == [ROW.external_url]
    etag = r.headers["etag"]
    again = client.get(VALUE_TILE, headers={"If-None-Match": etag})
    assert again.status_code == 304 and len(FakeSource.values_read) == 1
    # The 304 carries its 200's header.
    assert again.headers["cache-control"] == AN_HOUR
    assert again.headers["etag"] == etag
    # Another version, resampling, formula, base or step is another tile.
    for other in (
        VALUE_TILE.replace(f"v={CURRENT}", f"v=v2-{ENCODING_VERSION}"),
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
    tile = f"{COVERAGE}/12/1420/2178?f=webp&band=1&v={CURRENT}"
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


@pytest.mark.parametrize("kind", ["values", "image"])
def test_only_a_tile_read_with_content_is_kept_forever(
    client: TestClient, validated: str, kind: str
) -> None:
    """A 200 tile's address names everything its pixels depend on (a value
    tile's band or formula and encoding, a colored tile's coloring, and the
    values version), so a cache keeps it for good; every other answer keeps
    its own header."""
    tile = TILES[kind].replace(CURRENT, validated)
    r = client.get(tile)
    assert r.status_code == 200 and r.content == CONTENT[kind]
    assert r.headers["cache-control"] == FOREVER
    again = client.get(tile, headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304 and again.headers["cache-control"] == FOREVER
    # Outside the file: no content, kept an hour.
    empty = client.get(EMPTY[kind].replace(CURRENT, validated))
    assert empty.status_code == 204 and empty.headers["cache-control"] == AN_HOUR
    # The descriptions follow the file and stay short.
    for described in (client.get(COVERAGE), client.get(IMAGE_TILESET)):
        assert described.status_code == 200
        assert described.headers["cache-control"] == "public, max-age=60"
    # A file that cannot be read.
    FakeSource.fail = RasterUnavailableError("timeout")
    with patch.dict("goatlib.raster.source._failures", clear=True):
        r = client.get(tile)
    assert r.status_code == 504 and "cache-control" not in r.headers


def test_a_refused_value_tile_has_no_cache_header(client: TestClient) -> None:
    # Refused addresses and a band the file does not have: no cache header.
    for url, status in (
        (f"{COVERAGE}/12/1420/2178?f=webp&band=1&v={CURRENT}", 422),
        (f"{COVERAGE}/12/1420/2178?f=webp&band=1&base=0&step=0", 400),
        (VALUE_TILE.replace("band=1", "band=2"), 400),
    ):
        r = client.get(url)
        assert r.status_code == status, url
        assert "cache-control" not in r.headers, url


@pytest.mark.parametrize("kind", ["values", "image"])
def test_a_signed_in_viewers_tile_is_kept_by_their_browser_only(
    client: TestClient, validated: str, kind: str
) -> None:
    """A tile read with a sign-in may be of a layer not everyone may read: no
    shared cache may keep it. One read without a sign-in is of a layer anyone
    may read."""
    tile = TILES[kind].replace(CURRENT, validated)
    r = client.get(tile, headers=SIGNED_IN)
    assert r.status_code == 200 and r.headers["cache-control"] == FOREVER_PRIVATE
    again = client.get(tile, headers={**SIGNED_IN, "If-None-Match": r.headers["etag"]})
    assert again.status_code == 304
    assert again.headers["cache-control"] == FOREVER_PRIVATE
    anonymous = client.get(tile)
    assert anonymous.status_code == 200
    assert anonymous.headers["cache-control"] == FOREVER


@pytest.mark.parametrize("kind", ["values", "image"])
def test_a_tile_of_a_file_without_a_validator_is_kept_an_hour(
    client: TestClient, kind: str
) -> None:
    """A host that gives neither ETag nor Last-Modified (or refuses HEAD): a
    file replaced at its address keeps the version, so its tiles are kept no
    longer than before."""
    tile = TILES[kind]
    r = client.get(tile)
    assert r.status_code == 200 and r.headers["cache-control"] == AN_HOUR
    again = client.get(tile, headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304 and again.headers["cache-control"] == AN_HOUR
    signed_in = client.get(tile, headers=SIGNED_IN)
    assert signed_in.headers["cache-control"] == AN_HOUR_PRIVATE


@pytest.mark.parametrize("kind", ["values", "image"])
def test_a_stored_files_tile_is_kept_forever(client: TestClient, kind: str) -> None:
    """A file GOAT stores (a catalog raster) changes only with its row: its
    version follows it without a validator."""
    stored = dataclasses.replace(
        ROW, external_url=None, stored_file=Path("/data/layer.tif")
    )
    with (
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=stored)),
        patch.object(rs, "remote_validator") as check,
    ):
        r = client.get(TILES[kind])
    assert r.status_code == 200 and r.headers["cache-control"] == FOREVER
    check.assert_not_called()


@pytest.mark.parametrize("kind", ["values", "image"])
def test_a_tile_of_another_version_is_never_kept(client: TestClient, kind: str) -> None:
    """An address naming a version the layer does not have (any more, or yet,
    on a pod whose row is older), or none, is answered with the current file,
    which that address does not name: no cache may keep it."""
    tile = TILES[kind]
    for v in (f"v0-{ENCODING_VERSION}", "", "v1-e0"):
        r = client.get(tile.replace(f"v={CURRENT}", f"v={v}"))
        assert r.status_code == 200 and r.content == CONTENT[kind], v
        assert r.headers["cache-control"] == "no-store", v
    # An address without a version, as before addresses named one.
    unversioned = client.get(tile.replace(f"&v={CURRENT}", ""))
    assert unversioned.status_code == 200
    assert unversioned.headers["cache-control"] == "no-store"
    outside = client.get(EMPTY[kind].replace(f"v={CURRENT}", "v=v0"))
    assert outside.status_code == 204
    assert outside.headers["cache-control"] == "no-store"
    # Asked again, its 304 carries its 200's header too.
    stale = tile.replace(f"v={CURRENT}", "v=v0")
    etag = client.get(stale).headers["etag"]
    again = client.get(stale, headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.headers["cache-control"] == "no-store"
    # A remote file replaced at the same address: only the version the
    # descriptions now name is kept.
    with patch.object(rs, "remote_validator", return_value='"b"'):
        version = client.get(COVERAGE).json()["goat:values"]["version"]
        assert client.get(IMAGE_TILESET).json()["goat:version"] == version
        old = client.get(tile)
        new = client.get(tile.replace(CURRENT, version))
    assert old.headers["cache-control"] == "no-store"
    assert new.headers["cache-control"] == FOREVER


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
    assert first.startswith("v1-") and first.endswith(f"-{ENCODING_VERSION}")
    assert len(first) == 14
    # A file GOAT stores has no host to ask.
    stored = dataclasses.replace(
        ROW, external_url=None, stored_file=Path("/data/layer.tif")
    )
    with (
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=stored)),
        patch.object(rs, "remote_validator") as check,
    ):
        assert client.get(COVERAGE).json()["goat:values"]["version"] == CURRENT
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
    #: Reads of the statistics, of the formula's sample (its range) and of the
    #: band's sample (its class breaks).
    reads = {"statistics": 0, "b1*2": 0, "b1": 0}

    def statistics(self: FakeSource) -> list[BandStats]:
        reads["statistics"] += 1
        return STATS

    def sample(self: FakeSource, formula: Any) -> Any:
        import numpy as np

        reads[formula.expression] += 1
        return np.array([1.0, 3.0])

    with (
        patch.object(
            rs, "remote_validator", side_effect=lambda *args: host["validator"]
        ),
        patch.object(FakeSource, "statistics", statistics),
        patch.object(FakeSource, "sample", sample),
    ):
        for _ in range(2):
            info = client.get(f"/collections/{LAYER}/raster/info?band=1")
            assert info.status_code == 200
            assert client.get(f"{COVERAGE}?formula=b1*2").status_code == 200
        assert reads == {"statistics": 1, "b1*2": 1, "b1": 1}
        # The same address answers another validator: another file.
        host["validator"] = '"b"'
        client.get(f"/collections/{LAYER}/raster/info?band=1")
        client.get(f"{COVERAGE}?formula=b1*2")
    assert reads == {"statistics": 2, "b1*2": 2, "b1": 2}


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
                IMAGE_TILESET,
                VALUE_TILE,
                TOKEN_TILE,
                f"/collections/{LAYER}/raster/info?band=1",
                f"/collections/{LAYER}/raster/bounds",
                f"/collections/{LAYER}/raster/point?lon=11.55&lat=48.15",
            )
        ]
    for r in answers:
        assert r.status_code == 504, r.url
        assert r.json()["detail"] == "The file could not be read: gone"
    slot.assert_not_called()


def test_a_value_tiles_version_is_short(client: TestClient) -> None:
    assert client.get(VALUE_TILE.replace(CURRENT, "v" * 64)).status_code == 200
    assert client.get(VALUE_TILE.replace(CURRENT, "v" * 65)).status_code == 422


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

    def slow_values(self: FakeSource, *args: Any, **kwargs: Any) -> bytes:
        time.sleep(0.5)
        finished.set()
        return b"RIFF-values"

    with (
        patch.object(rasters, "TILE_DEADLINE_S", 0.2),
        patch.object(FakeSource, "values", slow_values),
        patch.object(rasters, "remember_failure") as remember,
    ):
        r = client.get(VALUE_TILE)
        assert r.status_code == 504 and "cache-control" not in r.headers
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
    assert "cache-control" not in r.headers
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

    def slow_values(self: FakeSource, *args: Any, **kwargs: Any) -> bytes:
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

    def hanging_values(self: FakeSource, *args: Any, **kwargs: Any) -> bytes:
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


#: A remote file whose address carries an access key in its query.
SIGNED_URL = "https://example.org/a/b.tif?sig=secret"
SIGNED_ROW = rs.RasterLayer(id=LAYER, external_url=SIGNED_URL, version="v1")
#: Every raster route that reads the file.
READING_ROUTES = [
    COVERAGE,
    IMAGE_TILESET,
    VALUE_TILE,
    TOKEN_TILE,
    f"/collections/{LAYER}/raster/info?band=1",
    f"/collections/{LAYER}/raster/bounds",
    f"/collections/{LAYER}/raster/point?lon=11.55&lat=48.15",
]


def _unreachable(*args: Any, **kwargs: Any) -> Any:
    import requests

    raise requests.ConnectionError(
        "HTTPSConnectionPool(host='example.org', port=443): Max retries exceeded "
        "with url: /a/b.tif?sig=secret (Caused by NameResolutionError)"
    )


def _not_a_raster(*args: Any, **kwargs: Any) -> Any:
    from rasterio.errors import RasterioIOError

    raise RasterioIOError(
        "'/vsicurl/https://example.org/a/b.tif?sig=secret' not recognized as "
        "being in a supported file format."
    )


@pytest.mark.parametrize("route", READING_ROUTES)
@pytest.mark.parametrize(
    ("failure", "said"),
    [
        ("unreachable", "The file's host could not be reached."),
        ("not_a_raster", "The file could not be read as a raster."),
    ],
)
def test_a_failing_files_answer_never_carries_its_address(
    test_client: TestClient,
    caplog: pytest.LogCaptureFixture,
    route: str,
    failure: str,
    said: str,
) -> None:
    """goatlib's real reader behind the routes: the 504 says what failed, the
    first time and while the failure is remembered; the address, its query
    included, reaches the log only."""
    ok = Mock(status_code=200, headers={})
    head = {
        "unreachable": Mock(side_effect=_unreachable),
        "not_a_raster": Mock(return_value=ok),
    }
    reader = Mock(side_effect=_not_a_raster)
    rs.raster_service.clear()
    with (
        patch.object(rs.raster_service, "layer", AsyncMock(return_value=SIGNED_ROW)),
        patch("goatlib.raster.source.assert_public_http_url"),
        patch("goatlib.raster.source.requests.head", head[failure]),
        patch("goatlib.raster.source.Reader", reader),
        patch.dict("goatlib.raster.source._failures", clear=True),
        patch.dict("goatlib.raster.source._addresses", clear=True),
        caplog.at_level("WARNING", logger="goatlib.raster.source"),
    ):
        answers = [test_client.get(route), test_client.get(route)]
    for r in answers:
        assert r.status_code == 504, (r.url, r.text)
        assert r.json()["detail"] == said
        for part in ("sig", "secret", "example.org/a/b.tif"):
            assert part not in r.text, (r.url, part)
    # The log names the file and the error, without the key.
    assert "example.org/a/b.tif" in caplog.text
    assert "sig" not in caplog.text and "secret" not in caplog.text
