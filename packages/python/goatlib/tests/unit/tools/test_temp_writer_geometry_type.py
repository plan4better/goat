"""The geometry type a step's temp result is saved with.

The rows of a result decide its geometry type. A result without rows has
none to read, so the writer takes the type the tool says its result has: an
export of it is then a layer of that type, which the map draws once a later
run gives it rows. A result without a geometry column stays a table.
"""

from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.io.config import parquet_copy_options
from goatlib.tools.temp_writer import TempLayerWriter, temp_step_folder

POINTS = "SELECT 1 AS id, ST_Point(11.5, 48.1)::GEOMETRY('OGC:CRS84') AS geometry"


def _write(path: Path, query: str) -> Path:
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(f"COPY ({query}) TO '{path}' {parquet_copy_options()}")
    finally:
        con.close()
    return path


@pytest.fixture
def tiles_made(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """The tile runs a write starts, without running tippecanoe."""
    made: list[Any] = []
    monkeypatch.setattr(
        TempLayerWriter, "_generate_pmtiles", lambda self, con=None: made.append(1)
    )
    return made


def _writer(tmp_path: Path) -> TempLayerWriter:
    return TempLayerWriter(
        user_id="u-1", workflow_id="w-1", node_id="ring", temp_data_root=tmp_path
    )


def test_an_empty_result_takes_the_type_the_tool_gives(
    tmp_path: Path, tiles_made: list[Any]
) -> None:
    source = _write(tmp_path / "out.parquet", f"{POINTS} WHERE false")
    result = _writer(tmp_path).write_from_parquet(
        source, layer_name="Ringe", geometry_type="POLYGON"
    )
    assert (result.metadata.geometry_type, result.metadata.feature_count) == (
        "POLYGON",
        0,
    )
    assert tiles_made == [], "no tiles for a layer without rows"


def test_the_rows_decide_when_there_are_rows(
    tmp_path: Path, tiles_made: list[Any]
) -> None:
    source = _write(tmp_path / "out.parquet", POINTS)
    result = _writer(tmp_path).write_from_parquet(
        source, layer_name="Punkte", geometry_type="POLYGON"
    )
    assert result.metadata.geometry_type == "POINT"
    assert tiles_made == [1]


def test_a_result_without_a_geometry_column_stays_a_table(
    tmp_path: Path, tiles_made: list[Any]
) -> None:
    source = _write(tmp_path / "out.parquet", "SELECT 1 AS id WHERE false")
    result = _writer(tmp_path).write_from_parquet(
        source, layer_name="Tabelle", geometry_type="POINT"
    )
    assert result.metadata.geometry_type is None


def test_the_step_folder_is_where_the_writer_writes(tmp_path: Path) -> None:
    writer = _writer(tmp_path)
    assert temp_step_folder("u-1", "w-1", "ring", tmp_path) == writer.base_path
