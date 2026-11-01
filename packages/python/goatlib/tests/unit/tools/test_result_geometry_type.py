"""The geometry type a tool gives its result when the rows give none.

A result without rows is still a layer of a geometry type: the one the
analysis reports, else the one the tool declares, else, for a tool whose
result keeps the geometry of its input (clip, erase, intersection, union,
dissolve, join, merge, a filtered copy), the geometry type of the input it
read first: an earlier step's result or a layer.
"""

import json
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.models.io import DatasetMetadata
from goatlib.tools import temp_writer
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.clip import ClipToolRunner
from goatlib.tools.custom_sql import CustomSqlToolRunner
from goatlib.tools.difference import DifferenceToolRunner
from goatlib.tools.dissolve import DissolveToolRunner
from goatlib.tools.intersection import IntersectionToolRunner
from goatlib.tools.join import JoinToolRunner
from goatlib.tools.layer_create_filtered import LayerCreateFilteredToolRunner
from goatlib.tools.merge import MergeToolRunner
from goatlib.tools.union import UnionToolRunner

USER = "00000000-0000-0000-0000-000000000001"
LAYER = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
OTHER = "6fa85f64-5717-4562-b3fc-2c963f66afa6"
POINTS = "SELECT 1 AS id, ST_Point(11.5, 48.1)::GEOMETRY('OGC:CRS84') AS geometry"


def _metadata(geometry_type: str | None = None) -> DatasetMetadata:
    return DatasetMetadata(
        path="out.parquet", source_type="vector", geometry_type=geometry_type
    )


class _Layers:
    """A stand-in for the database service: the layer records by id."""

    def __init__(self, geometry_types: dict[str, str | None]) -> None:
        self.geometry_types = geometry_types

    async def get_layer_info(self, layer_id: str) -> dict[str, Any] | None:
        if layer_id not in self.geometry_types:
            return None
        return {"id": layer_id, "geometry_type": self.geometry_types[layer_id]}


class _Runner(BaseToolRunner):
    """The base class on a plain in-memory DuckDB, where every layer is the
    table `layer_rows` (one point)."""

    def _get_duckdb_connection(self) -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(f"CREATE TABLE layer_rows AS {POINTS}")
        return con

    def get_layer_owner_id_sync(self, layer_id: str) -> str | None:
        return USER

    def resolve_layer_table_path(self, layer_id: str) -> str:
        return "layer_rows"

    def process(self, params: Any, temp_dir: Path) -> Any:  # not exercised
        raise NotImplementedError


class _Buffer(_Runner):
    output_geometry_type = "polygon"


class _KeepsInput(_Runner):
    output_geometry_follows_input = True


def test_the_analysis_reports_the_type() -> None:
    assert _Buffer().result_geometry_type(USER, _metadata("MultiLineString")) == (
        "LINESTRING"
    )


def test_else_the_tool_declares_it() -> None:
    assert _Buffer().result_geometry_type(USER, _metadata()) == "POLYGON"


def test_else_a_tool_that_keeps_its_input_takes_the_first_layer_s() -> None:
    runner = _KeepsInput()
    runner.db_service = _Layers({LAYER: "point", OTHER: "polygon"})  # type: ignore[assignment]
    runner.export_layer_to_parquet(LAYER, USER)
    runner.export_layer_to_parquet(OTHER, USER)
    assert runner.result_geometry_type(USER, _metadata()) == "POINT"


def test_or_the_geometry_of_the_earlier_step_it_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(temp_writer, "TEMP_DATA_ROOT", tmp_path)
    folder = temp_writer.temp_step_folder(USER, "wf-1", "rest")
    folder.mkdir(parents=True)
    (folder / "metadata.json").write_text(json.dumps({"geometry_type": "POLYGON"}))
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"COPY ({POINTS} WHERE false) TO '{folder / 't_abc.parquet'}'")
    con.close()
    runner = _KeepsInput()
    runner.export_layer_to_parquet("wf-1:rest:abc", USER)
    assert runner.result_geometry_type(USER, _metadata()) == "POLYGON"


def test_a_tool_whose_result_does_not_keep_its_input_says_nothing() -> None:
    runner = _Runner()
    runner.db_service = _Layers({LAYER: "point"})  # type: ignore[assignment]
    runner.export_layer_to_parquet(LAYER, USER)
    assert runner.result_geometry_type(USER, _metadata()) is None


def test_an_input_nobody_knows_gives_nothing() -> None:
    runner = _KeepsInput()
    runner.db_service = _Layers({})  # type: ignore[assignment]
    runner.export_layer_to_parquet(LAYER, USER)
    assert runner.result_geometry_type(USER, _metadata()) is None


@pytest.mark.parametrize(
    "runner_class",
    [
        ClipToolRunner,
        DifferenceToolRunner,
        IntersectionToolRunner,
        UnionToolRunner,
        DissolveToolRunner,
        JoinToolRunner,
        MergeToolRunner,
        LayerCreateFilteredToolRunner,
    ],
)
def test_the_tools_that_keep_their_input_s_geometry(runner_class: type) -> None:
    assert runner_class.output_geometry_follows_input is True


def test_custom_sql_does_not_guess() -> None:
    """Its result's geometry is whatever the query makes of the inputs."""
    assert CustomSqlToolRunner.output_geometry_follows_input is False
