"""A layer's rows are stored next to their neighbours on the map.

Every write of a layer sorts its rows along a Hilbert curve so that a tile or
any other spatial query reads few row groups. The curve was computed without
a box, from the coordinates' raw float bits, which kept no neighbours
together: each row group spanned the whole layer. The tables written here are
checked by the area that blocks of consecutive rows cover.

A layer's feature ids are its row positions (rowid + 1, a catalog layer's
file_row_number), so data already written keeps its order: a re-run of the
catalog materialize job leaves the file it wrote before alone.
"""

import shutil
from pathlib import Path
from types import SimpleNamespace

import duckdb
import pytest
from fixtures.spatial_spread import SCATTERED_POINTS, block_spread
from goatlib.tools.catalog_materialize import CatalogMaterializeRunner
from goatlib.tools.layer_import import LayerImportRunner
from goatlib.tools.layer_replace import LayerReplaceMixin
from goatlib.utils.layer import layer_id_to_table_name, layer_table_path

LAYER_ID = "00000000-0000-0000-0000-0000000000b2"


@pytest.fixture
def scattered(tmp_path: Path) -> Path:
    path = tmp_path / "scattered.parquet"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"COPY ({SCATTERED_POINTS}) TO '{path}' (FORMAT PARQUET)")
    con.close()
    return path


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    return con


def test_an_imported_layer_is_stored_in_spatial_order(scattered: Path) -> None:
    con = _con()
    con.execute("ATTACH ':memory:' AS lake")
    runner = LayerImportRunner()
    runner._duckdb_con = con

    runner._ingest_to_ducklake(user_id="u", layer_id=LAYER_ID, parquet_path=scattered)

    table = layer_table_path(LAYER_ID)
    assert block_spread(con, f"SELECT rowid AS pos, geometry FROM {table}", 500) < 0.1


class _ReplaceHost(LayerReplaceMixin):
    settings = None

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self._con = con

    @property
    def duckdb_con(self) -> duckdb.DuckDBPyConnection:
        return self._con

    def resolve_layer_table_path(self, layer_id: str) -> str:
        return f"lake.main.t_{layer_id}"


def test_replaced_data_is_stored_in_spatial_order(
    scattered: Path, tmp_path: Path
) -> None:
    """In a DuckLake table, as the layers are: its rowids follow the sort."""
    con = _con()
    con.execute("INSTALL ducklake; LOAD ducklake")
    data = tmp_path / "lake"
    data.mkdir()
    con.execute(
        f"ATTACH 'ducklake:{tmp_path / 'meta.ducklake'}' AS lake (DATA_PATH '{data}')"
    )

    _ReplaceHost(con)._replace_ducklake_table(
        layer_id="abc", owner_id="someone", parquet_path=scattered
    )

    spread = block_spread(
        con, "SELECT rowid AS pos, geometry FROM lake.main.t_abc", 500
    )
    assert spread < 0.1


def _materialize_runner(source: Path, downloads: list[str]) -> CatalogMaterializeRunner:
    def download_file(_bucket: str, key: str, target: str) -> None:
        downloads.append(key)
        shutil.copyfile(source, target)

    runner = CatalogMaterializeRunner()
    runner._catalog_s3 = lambda: SimpleNamespace(download_file=download_file)  # type: ignore[method-assign]
    return runner


def test_a_materialized_catalog_layer_is_stored_in_spatial_order(
    scattered: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path / "catalog" / "layers"))
    monkeypatch.setenv("CATALOG_S3_BUCKET", "catalog")

    out, count, _, _, _ = _materialize_runner(scattered, [])._materialize_vector(
        LAYER_ID, "../../../data/item.parquet"
    )

    assert count == 20000
    spread = block_spread(
        _con(),
        f"SELECT file_row_number AS pos, geometry "
        f"FROM read_parquet('{out}', file_row_number=true)",
        500,
    )
    assert spread < 0.1


def test_a_rerun_keeps_the_file_it_wrote_before(
    scattered: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Core re-runs the job on a layer whose tiles failed or whose job looked
    stale. Rewritten, the file's rows could come out in another order (a new
    sort key, ties broken differently), which renumbers the layer's features
    under every reference to them; the file is complete once it has its name."""
    layers = tmp_path / "catalog" / "layers"
    layers.mkdir(parents=True)
    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(layers))
    monkeypatch.setenv("CATALOG_S3_BUCKET", "catalog")
    existing = layers / f"{layer_id_to_table_name(LAYER_ID)}.parquet"
    shutil.copyfile(scattered, existing)
    before = existing.read_bytes()
    downloads: list[str] = []

    out, count, bounds, geometry, _ = _materialize_runner(
        scattered, downloads
    )._materialize_vector(LAYER_ID, "../../../data/item.parquet")

    assert out == existing
    assert existing.read_bytes() == before
    assert downloads == []
    assert (count, geometry) == (20000, "geometry")
    assert bounds is not None and bounds[0] == pytest.approx(5.8, abs=0.01)


class _StopAfterTheTableError(Exception):
    """Raised right after the table is written: the rest of the run (style,
    tiles, the layer row) does not matter here."""


def test_a_finalized_workflow_result_is_stored_in_spatial_order(
    scattered: Path,
) -> None:
    from unittest.mock import MagicMock, patch

    from goatlib.tools.finalize_layer import FinalizeLayerParams, FinalizeLayerRunner

    con = _con()
    con.execute("ATTACH ':memory:' AS lake")
    runner = FinalizeLayerRunner()
    runner._duckdb_con = con
    runner.settings = MagicMock()
    params = FinalizeLayerParams(
        user_id="00000000-0000-0000-0000-000000000001",
        workflow_id="00000000-0000-0000-0000-000000000010",
        node_id="tool-1",
        project_id="00000000-0000-0000-0000-000000000030",
        layer_name="Result",
    )

    with (
        patch.object(
            runner, "_get_ducklake_snapshot_id", side_effect=_StopAfterTheTableError
        ),
        pytest.raises(_StopAfterTheTableError),
    ):
        runner._create_new_layer(params, scattered, {"geometry_type": "point"})

    (table,) = con.execute(
        "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = 'lake'"
    ).fetchall()
    relation = f'lake."{table[0]}"."{table[1]}"'
    assert (
        block_spread(con, f"SELECT rowid AS pos, geometry FROM {relation}", 500) < 0.1
    )
