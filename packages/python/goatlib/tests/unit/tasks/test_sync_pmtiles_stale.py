"""sync_pmtiles rebuilds the tiles that are not in sync, catalog layers' too.

Tiles are in sync when manby built them with the current recipe from the
current data, so a plain run after a deploy rebuilds the tiles from before
manby, without `force`. A catalog layer has no DuckLake snapshot: its tiles
are built from its local GeoParquet copy and are stale when that is newer.
"""

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import duckdb
import manby
import pytest
from goatlib.io.pmtiles import MANBY_MARKER, PMTilesGenerator
from goatlib.tasks.sync_pmtiles import LayerInfo, PMTilesSyncParams, PMTilesSyncTask

LAYER = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
SNAPSHOT = 7
POINT = "ST_Point(7.6, 47.5)"
POLYGON = "ST_GeomFromText('POLYGON((7.5 47.5, 7.6 47.5, 7.6 47.6, 7.5 47.5))')"


class _Manager:
    """The DuckLake manager, on a connection with a `lake` catalog in memory."""

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self.con = con

    @contextmanager
    def connection(self) -> Iterator[duckdb.DuckDBPyConnection]:
        yield self.con


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Every directory the task reads or writes, in tmp_path."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path / "catalog" / "layers"))
    monkeypatch.setenv("CATALOG_TILES_DIR", str(tmp_path / "catalog" / "tiles"))
    monkeypatch.setenv("TILES_DATA_DIR", str(tmp_path / "tiles"))
    (tmp_path / "catalog" / "layers").mkdir(parents=True)
    return SimpleNamespace(
        tiles=tmp_path / "tiles",
        catalog_layers=tmp_path / "catalog" / "layers",
        catalog_tiles=tmp_path / "catalog" / "tiles",
    )


@pytest.fixture
def con() -> Iterator[duckdb.DuckDBPyConnection]:
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    connection.execute("ATTACH ':memory:' AS lake")
    connection.execute("CREATE SCHEMA lake.s")
    yield connection
    connection.close()


@pytest.fixture
def task(
    dirs: SimpleNamespace,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[PMTilesSyncTask]:
    """A task without Postgres: tests hand it the layers to list."""
    task = PMTilesSyncTask()
    task.settings = SimpleNamespace(
        tiles_data_dir=str(dirs.tiles),
        pmtiles_min_zoom=0,
        pmtiles_max_zoom=14,
        customer_schema="customer",
    )
    manager = _Manager(con)
    monkeypatch.setattr(task, "_get_manager", lambda: manager)
    monkeypatch.setattr(task, "get_geometry_layers", lambda **_: [])
    monkeypatch.setattr(task, "_promoted_layer_ids", lambda: [])
    yield task
    task.close()


def _ducklake_layer(
    con: duckdb.DuckDBPyConnection, geometry: str, layer_id: str = LAYER
) -> LayerInfo:
    table = "t_" + layer_id.replace("-", "")
    con.execute(f"CREATE TABLE lake.s.{table} AS SELECT 1 AS n, {geometry} AS geometry")
    return LayerInfo(
        schema_name="s",
        table_name=table,
        user_id="u",
        layer_id=layer_id,
        geometry_column="geometry",
        snapshot_id=SNAPSHOT,
        size_bytes=1024,
        record_count=1,
    )


def _old_tileset(path: Path, description: dict | None = None) -> None:
    """Tiles as built before manby: no marker, the current snapshot at most."""
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    flags = ["-z5"]
    if description is not None:
        flags.append(f"--description={json.dumps(description)}")
    manby.tile(con.sql(f"SELECT {POINT} AS geometry"), path, *flags)
    con.close()


def _sync(task: PMTilesSyncTask, **params: object) -> dict:
    return task.run(PMTilesSyncParams(**params))


# =====================================================================
#  DuckLake layers
# =====================================================================


def test_tiles_from_before_manby_with_the_current_snapshot_are_rebuilt(
    task: PMTilesSyncTask,
    con: duckdb.DuckDBPyConnection,
    dirs: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A tippecanoe build of the current snapshot used to count as in sync,
    so only `force` rebuilt it, and with it every layer already done."""
    layer = _ducklake_layer(con, POINT)
    monkeypatch.setattr(task, "get_geometry_layers", lambda **_: [layer])
    path = dirs.tiles / f"{layer.table_name}.pmtiles"
    _old_tileset(path, {"snapshot_id": SNAPSHOT})
    generator = PMTilesGenerator(tiles_data_dir=dirs.tiles)

    planned = _sync(task, layers="ducklake", dry_run=True)

    assert planned["stale"] == 1 and planned["in_sync"] == 0
    assert planned["skipped"] == 1  # would_regenerate
    assert generator.read_marker(path) == {"snapshot_id": SNAPSHOT}

    rebuilt = _sync(task, layers="ducklake")

    assert rebuilt["stale"] == 1 and rebuilt["generated"] == 1
    marker = generator.read_marker(path)
    assert MANBY_MARKER.items() <= marker.items()
    assert marker["snapshot_id"] == SNAPSHOT

    # Done: a run started again leaves it alone
    again = _sync(task, layers="ducklake")

    assert again["in_sync"] == 1 and again["generated"] == 0


def test_a_main_file_in_sync_beside_old_anchors_is_stale(
    task: PMTilesSyncTask,
    con: duckdb.DuckDBPyConnection,
    dirs: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    layer = _ducklake_layer(con, POLYGON)
    monkeypatch.setattr(task, "get_geometry_layers", lambda **_: [layer])
    assert _sync(task, layers="ducklake")["generated"] == 1
    anchor = dirs.tiles / f"{layer.table_name}_anchor.pmtiles"
    assert anchor.exists()
    assert _sync(task, layers="ducklake")["in_sync"] == 1

    _old_tileset(anchor, {"snapshot_id": SNAPSHOT})

    stats = _sync(task, layers="ducklake")

    assert stats["stale"] == 1 and stats["generated"] == 1
    generator = PMTilesGenerator(tiles_data_dir=dirs.tiles)
    assert generator.is_pmtiles_in_sync(anchor, SNAPSHOT)

    # Without an anchor file the main file is complete: a polygon layer's
    # anchors are published before it
    anchor.unlink()

    assert _sync(task, layers="ducklake")["in_sync"] == 1


def test_a_polygon_run_rebuilds_old_tiles_that_have_anchors(
    task: PMTilesSyncTask,
    con: duckdb.DuckDBPyConnection,
    dirs: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The polygon filter used to skip every layer with an anchor file, old
    ones included: a leftover of the migration that added the anchors."""
    layer = _ducklake_layer(con, POLYGON)
    monkeypatch.setattr(task, "get_geometry_layers", lambda **_: [layer])
    _old_tileset(dirs.tiles / f"{layer.table_name}.pmtiles", {"snapshot_id": SNAPSHOT})
    _old_tileset(
        dirs.tiles / f"{layer.table_name}_anchor.pmtiles", {"snapshot_id": SNAPSHOT}
    )

    stats = _sync(task, geometry_type_filter="polygon")

    assert stats["stale"] == 1 and stats["generated"] == 1


# =====================================================================
#  Catalog layers
# =====================================================================


def _catalog_parquet(
    dirs: SimpleNamespace, layer_id: str, columns: str = f"1 AS n, {POINT} AS geom"
) -> Path:
    path = dirs.catalog_layers / f"t_{layer_id.replace('-', '')}.parquet"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"COPY (SELECT {columns}) TO '{path}' (FORMAT PARQUET)")
    con.close()
    return path


def _catalog_tiles(dirs: SimpleNamespace, layer_id: str) -> Path:
    return dirs.catalog_tiles / f"t_{layer_id.replace('-', '')}.pmtiles"


def test_the_catalog_pass_builds_missing_and_stale_tiles_only(
    task: PMTilesSyncTask,
    dirs: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing, old, current, replaced, table = (
        f"00000000-0000-0000-0000-00000000000{n}" for n in range(1, 6)
    )
    orphan = "00000000-0000-0000-0000-000000000006"  # a parquet without a row
    no_copy = "00000000-0000-0000-0000-000000000007"  # a row without a parquet
    parquets = {
        layer_id: _catalog_parquet(dirs, layer_id)
        for layer_id in (missing, old, current, replaced, orphan)
    }
    _catalog_parquet(dirs, table, columns="1 AS n, 'a' AS name")
    listed = [missing, old, current, replaced, table, no_copy]
    monkeypatch.setattr(task, "_promoted_layer_ids", lambda: listed)
    parquet_mtimes = {k: p.stat().st_mtime_ns for k, p in parquets.items()}

    first = _sync(task, layers="catalog")

    assert first["total_layers"] == 5  # the row without a parquet is left out
    assert first["missing"] == 5 and first["generated"] == 4
    assert first["skipped"] == 1  # no geometry column
    assert not _catalog_tiles(dirs, orphan).exists()
    assert not dirs.tiles.exists() or not any(dirs.tiles.iterdir())

    _catalog_tiles(dirs, missing).unlink()
    _old_tileset(_catalog_tiles(dirs, old))
    current_tiles = _catalog_tiles(dirs, current).stat().st_mtime_ns
    # A copy written again after its tiles were built: the tiles are older
    older = parquet_mtimes[replaced] - 10**9
    os.utime(_catalog_tiles(dirs, replaced), ns=(older, older))

    second = _sync(task, layers="catalog")

    assert second["in_sync"] == 1
    assert second["missing"] == 2  # the one deleted, and the table
    assert second["stale"] == 2  # the old tiles, and the replaced copy's
    assert second["generated"] == 3
    assert _catalog_tiles(dirs, current).stat().st_mtime_ns == current_tiles
    generator = PMTilesGenerator(tiles_data_dir=dirs.catalog_tiles)
    for layer_id in (missing, old, current, replaced):
        tiles = _catalog_tiles(dirs, layer_id)
        assert generator.is_pmtiles_in_sync(tiles, None), layer_id
    assert _catalog_tiles(dirs, replaced).stat().st_mtime_ns >= parquet_mtimes[replaced]
    # The copies are read, never written
    assert {k: p.stat().st_mtime_ns for k, p in parquets.items()} == parquet_mtimes

    assert _sync(task, layers="catalog")["in_sync"] == 4


def test_a_plain_run_syncs_ducklake_and_catalog_layers(
    task: PMTilesSyncTask,
    con: duckdb.DuckDBPyConnection,
    dirs: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    layer = _ducklake_layer(con, POINT)
    monkeypatch.setattr(task, "get_geometry_layers", lambda **_: [layer])
    catalog_layer = "00000000-0000-0000-0000-000000000001"
    _catalog_parquet(dirs, catalog_layer)
    monkeypatch.setattr(task, "_promoted_layer_ids", lambda: [catalog_layer])

    stats = _sync(task)

    assert stats["total_layers"] == 2 and stats["generated"] == 2
    assert (dirs.tiles / f"{layer.table_name}.pmtiles").exists()
    assert _catalog_tiles(dirs, catalog_layer).exists()


@pytest.mark.parametrize(
    "narrowing",
    [{"user_id": "u"}, {"geometry_type_filter": "point"}, {"anchor_only": True}],
)
def test_ducklake_filters_leave_the_catalog_layers_out(
    task: PMTilesSyncTask,
    monkeypatch: pytest.MonkeyPatch,
    narrowing: dict,
) -> None:
    def listed() -> list[str]:
        raise AssertionError("catalog layers listed")

    monkeypatch.setattr(task, "_promoted_layer_ids", listed)

    assert _sync(task, **narrowing)["total_layers"] == 0
