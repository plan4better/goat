"""A layer a tool reads, exported with no rows.

A dataset filter that keeps nothing, an empty layer, or an earlier step whose
result is empty: the tool gets a parquet file without rows, and it can only
work on it if the file's geometry column is still a geometry. DuckDB writes a
GEOMETRY column of a file without rows as plain BLOB unless the COPY names a
GeoParquet version.
"""

from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.tools import temp_writer
from goatlib.tools.base import BaseToolRunner

USER = "00000000-0000-0000-0000-000000000001"
LAYER = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
#: A filter no row of `_POINTS` meets.
NOTHING = {"op": "=", "args": [{"property": "category"}, "university"]}

_POINTS = """
    SELECT * FROM (VALUES
        (1, 'school', ST_Point(11.5, 48.1)::GEOMETRY('OGC:CRS84')),
        (2, 'hospital', ST_Point(11.6, 48.2)::GEOMETRY('OGC:CRS84'))
    ) AS t(id, category, geometry)
"""


class _Runner(BaseToolRunner):
    """The base class on a plain in-memory DuckDB, where the layer is the
    table `layer_points`."""

    def _get_duckdb_connection(self) -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        return con

    def get_layer_owner_id_sync(self, layer_id: str) -> str | None:
        return USER

    def resolve_layer_table_path(self, layer_id: str) -> str:
        return "layer_points"

    def process(self, params: Any, temp_dir: Path) -> Any:  # not exercised
        raise NotImplementedError


def _geometry_type(path: str | Path) -> str:
    con = duckdb.connect()
    try:
        con.execute("LOAD spatial")
        rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
    finally:
        con.close()
    return {str(r[0]): str(r[1]) for r in rows}["geometry"]


def _write(path: Path, query: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    try:
        con.execute("LOAD spatial")
        con.execute(f"COPY ({query}) TO '{path}' (FORMAT PARQUET)")
    finally:
        con.close()
    return path


@pytest.fixture
def runner() -> _Runner:
    runner = _Runner()
    runner.duckdb_con.execute(f"CREATE TABLE layer_points AS {_POINTS}")
    return runner


def test_a_filter_that_keeps_nothing_exports_a_geometry_column(
    runner: _Runner,
) -> None:
    out = runner.export_layer_to_parquet(LAYER, USER, cql_filter=NOTHING)
    assert _geometry_type(out) == "GEOMETRY('OGC:CRS84')"


def test_an_empty_layer_exports_a_geometry_column(runner: _Runner) -> None:
    runner.duckdb_con.execute("DELETE FROM layer_points")
    out = runner.export_layer_to_parquet(LAYER, USER)
    assert _geometry_type(out) == "GEOMETRY('OGC:CRS84')"


def test_a_catalog_filter_that_keeps_nothing_exports_a_geometry_column(
    runner: _Runner, tmp_path: Path
) -> None:
    catalog_file = _write(tmp_path / "catalog.parquet", _POINTS)
    out = runner._export_catalog_filtered(catalog_file, NOTHING)
    assert _geometry_type(out) == "GEOMETRY('OGC:CRS84')"


@pytest.fixture
def temp_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "temporary"
    monkeypatch.setattr(temp_writer, "TEMP_DATA_ROOT", root)
    return root


def test_a_filter_on_an_earlier_step_that_keeps_nothing_exports_a_geometry_column(
    runner: _Runner, temp_root: Path
) -> None:
    step = temp_root / f"user_{USER.replace('-', '')}" / "w_abc" / "n_ring"
    _write(step / "t_1.parquet", _POINTS)
    out = runner.export_layer_to_parquet("abc:ring:1", USER, cql_filter=NOTHING)
    assert _geometry_type(out) == "GEOMETRY('OGC:CRS84')"


@pytest.mark.parametrize("temp_layer_id", ["abc:ring", "abc:ring:1"])
def test_a_missing_earlier_result_is_reported_without_its_path(
    runner: _Runner, temp_root: Path, temp_layer_id: str
) -> None:
    """The message is what the step shows: it names the step, not the file."""
    (temp_root / f"user_{USER.replace('-', '')}" / "w_abc" / "n_ring").mkdir(
        parents=True
    )
    with pytest.raises(FileNotFoundError) as raised:
        runner.export_layer_to_parquet(temp_layer_id, USER)
    message = str(raised.value)
    assert str(temp_root) not in message
    assert "ring" in message


def test_an_if_on_a_missing_earlier_result_names_the_step(temp_root: Path) -> None:
    from goatlib.tools.if_node import _resolve_layer_sql_ref

    (temp_root / f"user_{USER.replace('-', '')}" / "w_abc" / "n_ring").mkdir(
        parents=True
    )
    with pytest.raises(FileNotFoundError) as raised:
        _resolve_layer_sql_ref("abc:ring", USER)
    message = str(raised.value)
    assert str(temp_root) not in message
    assert "ring" in message
