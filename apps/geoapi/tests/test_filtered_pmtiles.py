"""Filtered tiles of a layer whose stored tiles manby built are cut from them.

A tile request with a filter or bbox on such a layer is answered by filtering
the stored tile (or the parent it is cut from) with manby, cached in Redis
under the filter's digest and revalidated with an ETag from the file's
version. Whatever the stored tiles cannot answer exactly goes to DuckDB (the
dynamic path, `get_tile`): tiles without the manby marker, a filter manby
cannot express, `dynamic`, `decoration`, and a manby run that fails.
"""

import asyncio
import gzip
import json
import logging
import math
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import AsyncMock, MagicMock, patch

import manby
import pytest
from fastapi.testclient import TestClient
from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator

from geoapi.dependencies import LayerInfo
from geoapi.services import tile_filter
from geoapi.services.layer_service import LayerMetadata
from geoapi.services.tile_service import TileService

# `geoapi.services.tile_service` resolves to the singleton instance, not the
# module. Go through sys.modules instead.
tile_service_module = sys.modules["geoapi.services.tile_service"]

LAYER_UUID = "abc123de-f456-7890-1234-5678901234ab"
LAYER_ID = LAYER_UUID.replace("-", "")
LAYER_INFO = LayerInfo(
    layer_id=LAYER_ID, schema_name="user_x", table_name=f"t_{LAYER_ID}"
)
COLUMNS = [
    {"name": "name", "type": "VARCHAR", "json_type": "string"},
    {"name": "kind", "type": "VARCHAR", "json_type": "string"},
    {"name": "v", "type": "INTEGER", "json_type": "integer"},
    {"name": "geometry", "type": "GEOMETRY", "json_type": "geometry"},
]
DUCKDB_TILE = (b"duckdb tile", False, "geoparquet")


def _cql(op: str, prop: str, value: Any) -> dict:
    return {
        "filter": json.dumps({"op": op, "args": [{"property": prop}, value]}),
        "lang": "cql2-json",
    }


KIND_A = _cql("=", "kind", "a")


def _tile_of(lon: float, lat: float, z: int) -> tuple[int, int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return z, x, y


# All squares lie in this tile; the stored tiles end at zoom 0, so it is cut
# from its parent
TILE = _tile_of(7.48, 47.49, 8)


class _FakeRedis:
    """The slice of redis-py the tile cache uses: pipelined get/setex."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}

    def pipeline(self) -> "_FakePipeline":
        return _FakePipeline(self.store)


class _FakePipeline:
    def __init__(self, store: dict[str, bytes]) -> None:
        self.store = store
        self.ops: list[tuple[Any, ...]] = []

    def get(self, key: str) -> None:
        self.ops.append(("get", key))

    def setex(self, key: str, ttl: int, value: bytes | str) -> None:
        self.ops.append(("set", key, value))

    def execute(self) -> list[Any]:
        results: list[Any] = []
        for op in self.ops:
            if op[0] == "get":
                results.append(self.store.get(op[1]))
            else:
                value = op[2]
                self.store[op[1]] = (
                    value if isinstance(value, bytes) else value.encode()
                )
                results.append(True)
        return results


# =====================================================================
#  Stored tiles
# =====================================================================


def _squares(kinds: dict[int, str] | None = None) -> dict:
    """20 small squares, named sq00 to sq19, of kind "a" (odd) or "b"."""
    features = []
    for i in range(4):
        for j in range(5):
            n = i * 5 + j
            x, y = 7.45 + 0.02 * i, 47.45 + 0.02 * j
            ring = [[x, y], [x + 0.004, y], [x + 0.004, y + 0.004], [x, y + 0.004]]
            kind = (kinds or {}).get(n, "a" if n % 2 else "b")
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "_rowid": n + 1,
                        "name": f"sq{n:02d}",
                        "kind": kind,
                        "v": n,
                    },
                    "geometry": {"type": "Polygon", "coordinates": [ring + [ring[0]]]},
                }
            )
    return {"type": "FeatureCollection", "features": features}


def _build(
    folder: Path,
    *,
    marker: bool = True,
    anchor_marker: bool | None = None,
    kinds: dict[int, str] | None = None,
) -> Path:
    """The layer's tiles and label points, built with goatlib's manby recipe.

    Without `marker` the description lacks the manby marker, as in tiles
    tippecanoe built. Returns the main file.
    """
    anchor_marker = marker if anchor_marker is None else anchor_marker
    generator = PMTilesGenerator(tiles_data_dir=folder, config=PMTilesConfig())
    source = folder / "squares.geojson"
    source.write_text(json.dumps(_squares(kinds)))
    main = folder / f"t_{LAYER_ID}.pmtiles"
    for path, label_anchor, with_marker in (
        (main, False, marker),
        (folder / f"t_{LAYER_ID}_anchor.pmtiles", True, anchor_marker),
    ):
        flags = generator.manby_flags("POLYGON", 7, label_anchor, None)
        if not with_marker:
            flags = [
                '--description={"snapshot_id": 7}'
                if flag.startswith("--description=")
                else flag
                for flag in flags
            ]
        built = folder / "build" / path.name
        built.parent.mkdir(exist_ok=True)
        manby.tile(str(source), built, *flags, "-t", str(built.parent))
        os.replace(built, path)
    return main


def _replace(path: Path, folder: Path, **kwargs: Any) -> None:
    """Rebuild the tiles in `folder` and move them over the ones at `path`,
    with an mtime clearly later than the files they replace."""
    later = path.stat().st_mtime_ns + 5_000_000_000
    folder.mkdir()
    built = _build(folder, **kwargs)
    os.replace(built, path)
    os.replace(
        built.with_name(built.stem + "_anchor.pmtiles"),
        path.with_name(path.stem + "_anchor.pmtiles"),
    )
    for p in (path, path.with_name(path.stem + "_anchor.pmtiles")):
        os.utime(p, ns=(later, later))


def _decoded(tile: bytes, z: int, x: int, y: int, folder: Path) -> dict[str, list]:
    """The features' properties of a tile, by layer."""
    path = folder / f"decode-{z}-{x}-{y}.mvt"
    path.write_bytes(gzip.decompress(tile) if tile[:2] == b"\x1f\x8b" else tile)
    out = subprocess.run(
        [manby.binary(), "decode", str(path), str(z), str(x), str(y)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return {
        layer["properties"]["layer"]: [f["properties"] for f in layer["features"]]
        for layer in json.loads(out)["features"]
    }


@pytest.fixture(autouse=True)
def empty_caches() -> Iterator[None]:
    tile_filter._prepared.clear()
    tile_service_module._pmtiles_reader_cache.clear()
    yield
    tile_filter._prepared.clear()
    tile_service_module._pmtiles_reader_cache.clear()


@pytest.fixture
def service(tmp_path: Path) -> TileService:
    tiles = tmp_path / "tiles"
    tiles.mkdir()
    service = TileService()
    service.tiles_data_dir = tiles
    service.catalog_tiles_dir = tiles / "catalog"
    # the dynamic path: DuckDB answers
    service.get_tile = AsyncMock(return_value=DUCKDB_TILE)  # type: ignore[method-assign]
    return service


@pytest.fixture
def redis() -> Iterator[_FakeRedis]:
    fake = _FakeRedis()
    with patch("geoapi.tile_cache.get_redis_client", return_value=fake):
        yield fake


@pytest.fixture
def overzooms() -> Iterator[MagicMock]:
    """Records the manby runs (and lets them run)."""
    real = subprocess.run
    with patch("subprocess.run", wraps=real) as run:
        yield run


def _overzoom_runs(run: MagicMock) -> int:
    return sum(1 for c in run.call_args_list if c.args[0][1] == "overzoom")


@pytest.fixture
def client(test_client: TestClient, service: TileService) -> Iterator[TestClient]:
    metadata = LayerMetadata(
        layer_id=LAYER_UUID,
        name="Squares",
        geometry_type="Polygon",
        bounds=[7.45, 47.45, 7.52, 47.54],
        columns=COLUMNS,
        geometry_column="geometry",
    )
    with (
        patch("geoapi.routers.tiles.tile_service", service),
        patch("geoapi.routers.tiles.layer_service") as layer_service,
        patch("geoapi.dependencies.get_layer_info", AsyncMock(return_value=LAYER_INFO)),
    ):
        layer_service.get_layer_metadata = AsyncMock(return_value=metadata)
        layer_service.cached_metadata = MagicMock(return_value=metadata)
        yield test_client


def _get(
    client: TestClient,
    tile: tuple[int, int, int] = TILE,
    cql: dict | None = KIND_A,
    headers: dict | None = None,
    **params: Any,
) -> Any:
    z, x, y = tile
    query = dict(params)
    if cql is not None:
        query |= {"filter": cql["filter"], "filter-lang": cql["lang"]}
    return client.get(
        f"/collections/{LAYER_UUID}/tiles/WebMercatorQuad/{z}/{x}/{y}",
        params=query,
        headers=headers or {},
    )


# =====================================================================
#  Answered from the stored tiles
# =====================================================================


def test_a_filtered_tile_is_cut_from_the_stored_tiles(
    client: TestClient, service: TileService, redis: _FakeRedis, tmp_path: Path
) -> None:
    _build(service.tiles_data_dir)

    response = _get(client)

    assert response.status_code == 200
    assert response.headers["X-Tile-Source"] == "pmtiles-filtered"
    assert response.headers["Cache-Control"] == "no-cache"
    assert response.headers["ETag"]
    features = _decoded(response.content, *TILE, tmp_path)["default"]
    assert sorted(f["name"] for f in features) == [
        f"sq{n:02d}" for n in range(1, 20, 2)
    ]
    service.get_tile.assert_not_called()


def test_the_etag_follows_the_file_the_filter_and_the_tile(
    client: TestClient, service: TileService, redis: _FakeRedis
) -> None:
    main = _build(service.tiles_data_dir)
    first = _get(client).headers["ETag"]

    assert _get(client).headers["ETag"] == first
    assert _get(client, cql=_cql("=", "kind", "b")).headers["ETag"] != first
    z, x, y = TILE
    assert _get(client, tile=(z + 1, 2 * x, 2 * y)).headers["ETag"] != first
    later = main.stat().st_mtime_ns + 5_000_000_000
    os.utime(main, ns=(later, later))
    assert _get(client).headers["ETag"] != first


def test_a_current_etag_gives_304_without_running_manby(
    client: TestClient, service: TileService, overzooms: MagicMock
) -> None:
    _build(service.tiles_data_dir)
    # no Redis: without the ETag the tile would be cut again
    with patch("geoapi.tile_cache.get_redis_client", return_value=None):
        etag = _get(client).headers["ETag"]
        runs = _overzoom_runs(overzooms)
        assert runs > 0

        response = _get(client, headers={"If-None-Match": etag})

    assert response.status_code == 304
    assert response.headers["ETag"] == etag
    assert response.headers["Cache-Control"] == "no-cache"
    assert _overzoom_runs(overzooms) == runs
    service.get_tile.assert_not_called()


def test_a_repeated_request_is_served_from_redis(
    client: TestClient, service: TileService, redis: _FakeRedis, overzooms: MagicMock
) -> None:
    main = _build(service.tiles_data_dir)
    first = _get(client)
    runs = _overzoom_runs(overzooms)

    again = _get(client)

    assert again.status_code == 200
    assert again.headers["X-Tile-Source"] == "pmtiles-filtered-cached"
    assert again.content == first.content
    assert _overzoom_runs(overzooms) == runs
    digest = tile_filter.request_digest(LAYER_ID, KIND_A, None)
    z, x, y = TILE
    key = f"tile:{LAYER_ID}:v{main.stat().st_mtime_ns}:f{digest}:{z}/{x}/{y}"
    assert key in redis.store


def test_a_repeated_filter_is_translated_once(
    client: TestClient, service: TileService, redis: _FakeRedis
) -> None:
    _build(service.tiles_data_dir)
    z, x, y = TILE
    spy = MagicMock(wraps=tile_filter.translate)

    with patch.object(tile_service_module, "translate", spy):
        for tile in [TILE, (z + 1, 2 * x, 2 * y), (z + 1, 2 * x + 1, 2 * y)]:
            assert _get(client, tile=tile).status_code in (200, 204)

    spy.assert_called_once()


def test_label_points_are_filtered_with_the_same_filter(
    client: TestClient, service: TileService, redis: _FakeRedis, tmp_path: Path
) -> None:
    _build(service.tiles_data_dir)

    response = _get(client, label="true")

    assert response.status_code == 200
    layers = _decoded(response.content, *TILE, tmp_path)
    odd = [f"sq{n:02d}" for n in range(1, 20, 2)]
    assert sorted(f["name"] for f in layers["default"]) == odd
    assert sorted(f["name"] for f in layers["default_anchor"]) == odd
    service.get_tile.assert_not_called()


def test_a_tile_without_matching_features_gives_204(
    client: TestClient, service: TileService, redis: _FakeRedis
) -> None:
    _build(service.tiles_data_dir)

    response = _get(client, cql=_cql("=", "name", "nobody"))

    assert response.status_code == 204
    assert response.headers["ETag"]
    assert response.headers["Cache-Control"] == "no-cache"
    service.get_tile.assert_not_called()


@pytest.mark.parametrize(
    "params",
    [
        # nowhere near the squares
        {"bbox": "100,10,101,11"},
        # the tile lies outside the tiles' bounds
        {"tile": _tile_of(100.5, 10.5, 10)},
    ],
    ids=["area elsewhere", "outside the bounds"],
)
def test_a_tile_nothing_can_reach_gives_204_without_manby(
    params: dict,
    client: TestClient,
    service: TileService,
    redis: _FakeRedis,
    overzooms: MagicMock,
) -> None:
    _build(service.tiles_data_dir)

    response = _get(client, **params)

    assert response.status_code == 204
    assert _overzoom_runs(overzooms) == 0
    service.get_tile.assert_not_called()


def test_a_replaced_file_gets_a_new_prepared_filter_and_cache_key(
    client: TestClient, service: TileService, redis: _FakeRedis, tmp_path: Path
) -> None:
    main = _build(service.tiles_data_dir)
    versions: list[str] = []
    real = tile_filter.get_prepared_filter

    def prepared(version: str, translated: Any, key: str | None = None) -> Any:
        versions.append(version)
        return real(version, translated, key)

    with patch.object(tile_service_module, "get_prepared_filter", prepared):
        before = _get(client)
        # every square of kind "a" now
        _replace(main, tmp_path / "rebuild", kinds={n: "a" for n in range(20)})
        after = _get(client)

    assert after.headers["X-Tile-Source"] == "pmtiles-filtered"
    assert after.headers["ETag"] != before.headers["ETag"]
    assert len(_decoded(before.content, *TILE, tmp_path)["default"]) == 10
    assert len(_decoded(after.content, *TILE, tmp_path)["default"]) == 20
    assert len(set(versions)) == 2
    z, x, y = TILE
    keys = [k for k in redis.store if k.endswith(f":{z}/{x}/{y}")]
    assert len(keys) == 2


@pytest.mark.parametrize(
    "replaced_at", [1, 2], ids=["while preparing the filter", "while cutting"]
)
def test_tiles_replaced_during_a_request_are_not_mixed_with_its_version(
    replaced_at: int,
    client: TestClient,
    service: TileService,
    redis: _FakeRedis,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A rebuild that lands between the request taking the tiles' version and
    reading them: what was read is not served or cached as that version."""
    main = _build(service.tiles_data_dir)
    real = tile_service_module._get_cached_pmtiles_reader
    reads = 0

    def reader(path: Path) -> Any:
        nonlocal reads
        reads += 1
        if reads == replaced_at:
            later = main.stat().st_mtime_ns + 5_000_000_000
            os.utime(main, ns=(later, later))
        return real(path)

    with (
        patch.object(tile_service_module, "_get_cached_pmtiles_reader", reader),
        caplog.at_level(logging.INFO, logger="geoapi.services.tile_service"),
    ):
        response = _get(client)

    assert response.content == DUCKDB_TILE[0]
    service.get_tile.assert_called_once()
    assert redis.store == {}
    assert [r.levelno for r in caplog.records if "replaced" in r.getMessage()] == [
        logging.INFO
    ]


# =====================================================================
#  Left to DuckDB
# =====================================================================


@pytest.mark.parametrize(
    ("build", "cql", "params"),
    [
        ({"marker": False}, KIND_A, {}),
        # the anchor file is not manby's: the label points could not follow
        ({"anchor_marker": False}, KIND_A, {"label": "true"}),
        # a property compared with another one
        ({}, _cql("=", "kind", {"property": "name"}), {}),
        ({}, KIND_A, {"dynamic": "true"}),
        ({}, KIND_A, {"decoration": "start"}),
        # the stored tiles hold every property and the features the tiler
        # kept
        ({}, KIND_A, {"properties": "name"}),
        ({}, KIND_A, {"limit": "5"}),
    ],
    ids=[
        "no marker",
        "anchor without marker",
        "untranslatable",
        "dynamic",
        "decoration",
        "properties",
        "limit",
    ],
)
def test_what_the_stored_tiles_cannot_answer_goes_to_duckdb(
    build: dict,
    cql: dict,
    params: dict,
    client: TestClient,
    service: TileService,
    redis: _FakeRedis,
    overzooms: MagicMock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _build(service.tiles_data_dir, **build)

    with caplog.at_level(logging.INFO, logger="geoapi.services.tile_service"):
        response = _get(client, cql=cql, **params)

    assert response.status_code == 200
    assert response.content == DUCKDB_TILE[0]
    service.get_tile.assert_called_once()
    assert _overzoom_runs(overzooms) == 0
    assert redis.store == {}
    # a decision, not a failure
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_a_failure_on_the_filtered_path_goes_to_duckdb(
    client: TestClient,
    service: TileService,
    redis: _FakeRedis,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _build(service.tiles_data_dir)

    with (
        patch("tempfile.mkdtemp", side_effect=OSError("No space left on device")),
        caplog.at_level(logging.WARNING),
    ):
        response = _get(client)

    assert response.status_code == 200
    assert response.content == DUCKDB_TILE[0]
    service.get_tile.assert_called_once()
    assert any(
        LAYER_UUID in r.getMessage() and "No space" in r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING
    )


def test_unreadable_metadata_is_read_again_on_the_next_request(
    client: TestClient,
    service: TileService,
    redis: _FakeRedis,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A failed read of the metadata (a network file system hiccup) is not
    remembered as "not built by manby"."""
    _build(service.tiles_data_dir)
    real = tile_service_module._stored_tileset
    reads = 0

    def tileset(metadata: dict) -> Any:
        nonlocal reads
        reads += 1
        if reads == 1:
            raise ValueError("truncated")
        return real(metadata)

    with (
        patch.object(tile_service_module, "_stored_tileset", tileset),
        caplog.at_level(logging.WARNING),
    ):
        first = _get(client)
        again = _get(client)

    assert first.content == DUCKDB_TILE[0]
    assert any(
        LAYER_ID in r.getMessage() and "unreadable PMTiles metadata" in r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING
    )
    assert again.headers["X-Tile-Source"] == "pmtiles-filtered"
    service.get_tile.assert_called_once()


@pytest.mark.parametrize(
    "failure",
    [
        subprocess.CompletedProcess([], 1, b"", b"PBF decoding error"),
        subprocess.TimeoutExpired("manby", 10.0),
    ],
    ids=["error", "timeout"],
)
def test_a_failed_manby_run_goes_to_duckdb(
    failure: Any,
    client: TestClient,
    service: TileService,
    redis: _FakeRedis,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _build(service.tiles_data_dir)

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        if isinstance(failure, Exception):
            raise failure
        return failure

    with (
        patch("subprocess.run", side_effect=run),
        caplog.at_level(logging.WARNING),
    ):
        response = _get(client)

    assert response.status_code == 200
    assert response.content == DUCKDB_TILE[0]
    service.get_tile.assert_called_once()
    assert any(
        LAYER_ID in r.getMessage() and r.levelno == logging.WARNING
        for r in caplog.records
    )
    assert redis.store == {}


# =====================================================================
#  A large area
# =====================================================================


def _large_area(vertices: int = 80_000) -> dict:
    """A ring around the squares, about 3 MB as CQL2 JSON."""
    ring = []
    for i in range(vertices):
        angle = 2 * math.pi * i / vertices
        radius = 0.2 + 0.01 * math.sin(37 * angle)
        ring.append([7.48 + radius * math.cos(angle), 47.49 + radius * math.sin(angle)])
    return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}


@pytest.mark.asyncio
async def test_a_large_area_is_parsed_once_for_all_tiles(
    service: TileService, redis: _FakeRedis
) -> None:
    _build(service.tiles_data_dir)
    cql = {
        "filter": json.dumps(
            {
                "op": "and",
                "args": [
                    {
                        "op": "s_intersects",
                        "args": [{"property": "geometry"}, _large_area()],
                    },
                    {"op": "=", "args": [{"property": "kind"}, "a"]},
                ],
            }
        ),
        "lang": "cql2-json",
    }
    assert len(cql["filter"]) > 2_000_000
    z, x, y = _tile_of(7.48, 47.49, 12)
    tiles = [(z, x + i, y + j) for i in (-1, 0, 1) for j in (-1, 0, 1)]
    spy = MagicMock(wraps=tile_filter.parse_cql2_filter)

    async def tile(zxy: tuple[int, int, int]) -> Any:
        return await service.get_filtered_tile_from_pmtiles(
            LAYER_INFO, *zxy, cql_filter=cql, bbox=None, columns=COLUMNS, label=False
        )

    with patch.object(tile_filter, "parse_cql2_filter", spy):
        # a screen of tiles at once, then more of them one by one
        first = await asyncio.gather(*(tile(t) for t in tiles))
        later = [await tile((z + 1, 2 * x + i, 2 * y)) for i in (0, 1)]

    assert all(result is not None for result in first + later)
    spy.assert_called_once()
