"""An upload's names stay data on its way into the lake.

The converter writes each dataset of an upload under the name it came with
(an archive member's name is the uploader's own text) and keeps the file's
column names. Both then reach the statements that create the DuckLake table,
read its metadata and write a workflow preview, so each is bound or quoted
there too. The lake here is an in-memory database attached as `lake`, the
catalog name the tools use; nothing else of DuckLake is involved.
"""

import json
import zipfile
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.io.ingest import convert_all
from goatlib.io.sql import sql_identifier, sql_literal
from goatlib.tools.layer_import import LayerImportRunner
from goatlib.tools.layer_update import LayerUpdateRunner
from goatlib.tools.temp_writer import TempLayerWriter
from goatlib.utils.layer import layer_table_path

LAYER_ID = "00000000-0000-0000-0000-0000000000a1"


def _lake() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("ATTACH ':memory:' AS lake")
    return con


def _lake_tables(con: duckdb.DuckDBPyConnection) -> list[str]:
    return sorted(
        row[0]
        for row in con.execute(
            "SELECT table_name FROM duckdb_tables() WHERE database_name = 'lake'"
        ).fetchall()
    )


def _all_tables(con: duckdb.DuckDBPyConnection) -> list[str]:
    return sorted(
        row[0]
        for row in con.execute("SELECT table_name FROM duckdb_tables()").fetchall()
    )


def _import_runner(con: duckdb.DuckDBPyConnection) -> LayerImportRunner:
    runner = LayerImportRunner()
    runner._duckdb_con = con
    return runner


def _feature_collection(**properties: Any) -> str:
    return json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": {"type": "Point", "coordinates": [1.0, 2.0]},
                }
            ],
        }
    )


def _parquet_with_geometry_column(path: Path, column: str) -> Path:
    """A parquet file whose first geometry column is called `column`, with a
    second one called `geometry`."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        f"COPY (SELECT 1 AS id, ST_Point(3, 4) AS {sql_identifier(column)}, "
        f"ST_Point(1, 2) AS geometry) TO {sql_literal(path)}"
    )
    return path


# Names with a quote, a double quote, a semicolon, a bracket and a comment
# marker, which import unchanged.
ODD_MEMBER = 'it\'s -- "x"; y'
ODD_COLUMN = 'geom) "x"; y -- z'


def _layer_table() -> str:
    return layer_table_path(LAYER_ID).rsplit(".", 1)[1]


def test_a_member_name_with_quotes_and_comment_markers_imports_as_data(
    tmp_path: Path,
):
    archive = tmp_path / "upload.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(f"{ODD_MEMBER}.geojson", _feature_collection(a=1))
    report = convert_all(str(archive), tmp_path / "converted", target_crs="EPSG:4326")
    assert [o.name for o in report.outputs] == [ODD_MEMBER]
    con = _lake()

    info = _import_runner(con)._ingest_to_ducklake(
        user_id="u", layer_id=LAYER_ID, parquet_path=Path(report.outputs[0].path)
    )

    assert info["feature_count"] == 1
    assert info["geometry_type"] == "POINT"
    assert _lake_tables(con) == [_layer_table()]
    assert _all_tables(con) == [_layer_table()]


def test_a_geometry_column_name_with_quotes_and_brackets_imports_as_data(
    tmp_path: Path,
):
    source = _parquet_with_geometry_column(tmp_path / "two_geoms.parquet", ODD_COLUMN)
    report = convert_all(str(source), tmp_path / "converted", target_crs="EPSG:4326")
    assert report.failures == []
    con = _lake()

    info = _import_runner(con)._ingest_to_ducklake(
        user_id="u", layer_id=LAYER_ID, parquet_path=Path(report.outputs[0].path)
    )

    assert info["feature_count"] == 1
    assert info["geometry_column"] == ODD_COLUMN
    assert _lake_tables(con) == [_layer_table()]
    assert _all_tables(con) == [_layer_table()]


def test_a_geometry_column_with_a_space_ingests(tmp_path: Path):
    source = _parquet_with_geometry_column(tmp_path / "spaced.parquet", "my geom")
    con = _lake()

    info = _import_runner(con)._ingest_to_ducklake(
        user_id="u", layer_id=LAYER_ID, parquet_path=source
    )

    assert info["feature_count"] == 1
    assert info["geometry_column"] == "my geom"
    assert info["geometry_type"] == "POINT"
    assert info["extent"] == [3.0, 4.0, 3.0, 4.0]


def test_a_replaced_table_keeps_odd_names_as_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """An update replaces the table from the new upload the same way."""
    source = _parquet_with_geometry_column(
        tmp_path / f"{ODD_MEMBER}.parquet", ODD_COLUMN
    )
    con = _lake()
    runner = LayerUpdateRunner()
    runner._duckdb_con = con
    monkeypatch.setattr(runner, "resolve_layer_table_path", layer_table_path)

    info = runner._replace_ducklake_table(
        layer_id=LAYER_ID, owner_id="u", parquet_path=source
    )

    assert info["feature_count"] == 1
    assert info["geometry_type"] == "POINT"
    assert _lake_tables(con) == [_layer_table()]
    assert _all_tables(con) == [_layer_table()]


def test_a_workflow_preview_keeps_an_odd_column_name_as_data(tmp_path: Path):
    source = _parquet_with_geometry_column(tmp_path / "two_geoms.parquet", ODD_COLUMN)
    con = _lake()
    writer = TempLayerWriter(
        user_id="u",
        workflow_id="w",
        node_id="n",
        temp_data_root=tmp_path / "temporary",
        pmtiles_enabled=False,
    )

    result = writer.write_from_parquet(source, "preview", duckdb_con=con)

    assert result.metadata.feature_count == 1
    assert result.metadata.geometry_type == "POINT"
    assert result.metadata.bbox == [3.0, 4.0, 3.0, 4.0]
    assert _all_tables(con) == []
