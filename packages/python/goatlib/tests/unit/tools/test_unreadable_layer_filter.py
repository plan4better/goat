"""A tool or an export refuses a layer filter it cannot apply.

It used to drop the filter (`build_cql_filter` logs the parse error and hands
back no clause) and run on the whole layer: a result that looks right and is
not. Every place a tool or an export reads a layer with its filter now refuses
with the reason (`goatlib.storage.UnreadableFilterError`).
"""

from pathlib import Path
from typing import Any
from unittest.mock import patch

import duckdb
import pytest
from goatlib.storage import UnreadableFilterError
from goatlib.tools import if_node, temp_writer
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.catchment_area import CatchmentAreaToolRunner
from goatlib.tools.layer_export import LayerExportRunner

pytestmark = pytest.mark.unit

USER = "00000000-0000-0000-0000-000000000001"
LAYER = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
#: A filter on a field the layer no longer has.
GONE = {"op": "=", "args": [{"property": "status"}, "open"]}
#: A filter whose value its field cannot hold.
MISMATCH = {"op": "=", "args": [{"property": "id"}, "many"]}
#: A filter the parser does not read.
MALFORMED = {"op": "and", "args": "not a list"}
READS_ONE = {"op": "=", "args": [{"property": "category"}, "school"]}

_POINTS = """
    SELECT * FROM (VALUES
        (1, 'school', ST_Point(11.5, 48.1)),
        (2, 'hospital', ST_Point(11.6, 48.2))
    ) AS t(id, category, geometry)
"""

UNREADABLE = pytest.mark.parametrize(
    "cql", [GONE, MISMATCH, MALFORMED], ids=["gone", "mismatch", "malformed"]
)


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


def _write(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial")
        con.execute(f"COPY ({_POINTS}) TO '{path}' (FORMAT PARQUET)")
    finally:
        con.close()
    return path


def _ids(path: str) -> list[int]:
    return [
        r[0]
        for r in duckdb.connect()
        .execute(f"SELECT id FROM '{path}' ORDER BY id")
        .fetchall()
    ]


@pytest.fixture
def runner() -> _Runner:
    runner = _Runner()
    runner.duckdb_con.execute(f"CREATE TABLE layer_points AS {_POINTS}")
    return runner


@pytest.fixture
def temp_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "temporary"
    monkeypatch.setattr(temp_writer, "TEMP_DATA_ROOT", root)
    _write(root / f"user_{USER.replace('-', '')}" / "w_abc" / "n_ring" / "t_1.parquet")
    return root


# --- the tools' layer inputs (BaseToolRunner) -------------------------------


@UNREADABLE
def test_a_layer_input_refuses_a_filter_it_cannot_apply(
    runner: _Runner, cql: dict
) -> None:
    with pytest.raises(UnreadableFilterError, match="cannot be applied"):
        runner.export_layer_to_parquet(LAYER, USER, cql_filter=cql)


def test_a_layer_input_names_the_field_the_layer_lost(runner: _Runner) -> None:
    with pytest.raises(UnreadableFilterError, match='no field "status"'):
        runner.export_layer_to_parquet(LAYER, USER, cql_filter=GONE)


def test_a_layer_input_still_applies_a_filter_it_can_read(runner: _Runner) -> None:
    assert _ids(runner.export_layer_to_parquet(LAYER, USER, cql_filter=READS_ONE)) == [
        1
    ]


@UNREADABLE
def test_a_catalog_layer_input_refuses_a_filter_it_cannot_apply(
    runner: _Runner, tmp_path: Path, cql: dict
) -> None:
    catalog_file = _write(tmp_path / "catalog.parquet")
    with pytest.raises(UnreadableFilterError):
        runner._export_catalog_filtered(catalog_file, cql)


@UNREADABLE
def test_an_earlier_steps_result_refuses_a_filter_it_cannot_apply(
    runner: _Runner, temp_root: Path, cql: dict
) -> None:
    with pytest.raises(UnreadableFilterError):
        runner.export_layer_to_parquet("abc:ring:1", USER, cql_filter=cql)


def test_an_earlier_steps_result_still_applies_a_filter_it_can_read(
    runner: _Runner, temp_root: Path
) -> None:
    out = runner.export_layer_to_parquet("abc:ring:1", USER, cql_filter=READS_ONE)
    assert _ids(out) == [1]


# --- the starting points of a catchment area --------------------------------


class _Catchment(CatchmentAreaToolRunner):
    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self._duckdb_con = con

    def get_layer_owner_id_sync(self, layer_id: str) -> str | None:
        return USER

    def resolve_layer_table_path(self, layer_id: str) -> str:
        return "layer_points"


@UNREADABLE
def test_starting_points_refuse_a_filter_they_cannot_apply(
    runner: _Runner, cql: dict
) -> None:
    catchment = _Catchment(runner.duckdb_con)
    with pytest.raises(UnreadableFilterError):
        catchment._extract_coordinates_from_layer(LAYER, USER, cql_filter=cql)


def test_starting_points_still_apply_a_filter_they_can_read(runner: _Runner) -> None:
    catchment = _Catchment(runner.duckdb_con)
    lats, lons = catchment._extract_coordinates_from_layer(
        LAYER, USER, cql_filter=READS_ONE
    )
    assert (lats, lons) == ([pytest.approx(48.1)], [pytest.approx(11.5)])


# --- the layer export -------------------------------------------------------


#: The export reads a DuckLake table, `lake.<schema>.<table>`.
EXPORTED = "lake.user_abc.t_abc"


@pytest.fixture
def export(runner: _Runner) -> LayerExportRunner:
    con = runner.duckdb_con
    con.execute("ATTACH ':memory:' AS lake")
    con.execute("CREATE SCHEMA lake.user_abc")
    con.execute(f"CREATE TABLE {EXPORTED} AS SELECT * FROM layer_points")
    instance = LayerExportRunner.__new__(LayerExportRunner)
    instance._duckdb_con = con
    return instance


def _exported(export: LayerExportRunner, where: str | None) -> list[int]:
    sql = f"SELECT id FROM {EXPORTED} WHERE {where} ORDER BY id"
    return [r[0] for r in export.duckdb_con.execute(sql).fetchall()]


@UNREADABLE
def test_an_export_refuses_a_filter_it_cannot_apply(
    export: LayerExportRunner, cql: dict
) -> None:
    with pytest.raises(UnreadableFilterError):
        export._convert_cql2_to_sql(cql, EXPORTED)


def test_an_export_still_applies_a_filter_it_can_read(
    export: LayerExportRunner,
) -> None:
    assert _exported(export, export._convert_cql2_to_sql(READS_ONE, EXPORTED)) == [1]


def test_an_export_with_a_relative_day_counts_from_today(
    export: LayerExportRunner,
) -> None:
    export.duckdb_con.execute(f"ALTER TABLE {EXPORTED} ADD COLUMN seen DATE")
    export.duckdb_con.execute(f"UPDATE {EXPORTED} SET seen = CURRENT_DATE WHERE id = 1")
    where = export._convert_cql2_to_sql(
        {"op": ">=", "args": [{"property": "seen"}, {"op": "daysAgo", "args": [7]}]},
        EXPORTED,
    )
    assert _exported(export, where) == [1]


# --- the If step ------------------------------------------------------------


@UNREADABLE
def test_an_if_step_refuses_its_input_layers_filter_when_it_cannot_apply_it(
    cql: dict,
) -> None:
    """The If judged the whole layer when the filter of the layer it was
    given did not compile."""
    node = {
        "id": "if-1",
        "data": {
            "mode": "simple",
            "condition": {
                "op": "and",
                "expressions": [
                    {"attribute": "category", "expression": "is", "value": "school"}
                ],
            },
        },
    }
    with (
        patch.object(
            if_node,
            "layer_field_types",
            return_value={
                "id": "integer",
                "category": "string",
                "geometry": "geometry",
            },
        ),
        patch.object(if_node, "_evaluate_boolean_sql_against_layer") as judged,
        pytest.raises(UnreadableFilterError),
    ):
        if_node.execute_if_node(node, LAYER, USER, {}, upstream_filter=cql)
    judged.assert_not_called()
