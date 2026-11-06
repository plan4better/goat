"""An upload's names stay data on their way into a Postgres-backed DuckLake.

The cases of `tests/unit/tools/test_ingest_names.py` (an archive member and a
geometry column whose names hold quotes, semicolons, brackets and comment
markers, a geometry column with a space, the update path) against the catalog
the workers use: the throwaway catalog schema of
`lake_env`, data in tmp_path. The path is a bound parameter of `CREATE TABLE
... AS SELECT ... FROM read_parquet(?)`, which the unit tests check on an
in-memory database only.

Run explicitly with:
    uv run pytest tests/integration/test_ingest_names_pg.py -m integration -v
"""

import json
import zipfile
from pathlib import Path
from typing import Any, Iterator

import duckdb
import pytest
from goatlib.io.ingest import convert_all
from goatlib.io.sql import sql_identifier, sql_literal
from goatlib.storage import BaseDuckLakeManager
from goatlib.tools.layer_import import LayerImportRunner
from goatlib.tools.layer_update import LayerUpdateRunner
from goatlib.utils.layer import layer_table_path

pytestmark = pytest.mark.integration

LAYER_ID = "00000000-0000-4000-8000-0000000000b1"
# Names with a quote, a double quote, a semicolon, a bracket and a comment
# marker, which import unchanged.
ODD_MEMBER = 'it\'s -- "x"; y'
ODD_COLUMN = 'geom) "x"; y -- z'
LAYER_TABLE = layer_table_path(LAYER_ID).rsplit(".", 1)[1]


@pytest.fixture
def lake(
    lake_env: tuple[Any, BaseDuckLakeManager],
) -> Iterator[tuple[duckdb.DuckDBPyConnection, str]]:
    """The writer's connection, with `lake` attached to the Postgres catalog,
    and the catalog's metadata schema."""
    settings, writer = lake_env
    with writer.connection() as con:
        yield con, settings.DUCKLAKE_CATALOG_SCHEMA


def _catalog_tables(con: duckdb.DuckDBPyConnection, schema: str) -> list[str]:
    """The live tables the DuckLake catalog in Postgres records."""
    rows = con.execute(
        f"SELECT table_name FROM __ducklake_metadata_lake.{schema}.ducklake_table "
        "WHERE end_snapshot IS NULL"
    ).fetchall()
    return sorted(row[0] for row in rows)


def _connection_tables(con: duckdb.DuckDBPyConnection) -> list[str]:
    """Every table the connection sees, the lake's included."""
    rows = con.execute("SELECT table_name FROM duckdb_tables()").fetchall()
    return sorted(row[0] for row in rows)


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
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        f"COPY (SELECT 1 AS id, ST_Point(3, 4) AS {sql_identifier(column)}, "
        f"ST_Point(1, 2) AS geometry) TO {sql_literal(path)}"
    )
    return path


def _import_runner(con: duckdb.DuckDBPyConnection) -> LayerImportRunner:
    runner = LayerImportRunner()
    runner._duckdb_con = con
    return runner


def test_a_member_name_with_quotes_and_comment_markers_imports_as_data(
    tmp_path: Path, lake
):
    con, schema = lake
    before = set(_connection_tables(con))
    archive = tmp_path / "upload.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(f"{ODD_MEMBER}.geojson", _feature_collection(a=1))
    report = convert_all(str(archive), tmp_path / "converted", target_crs="EPSG:4326")
    assert [o.name for o in report.outputs] == [ODD_MEMBER]

    info = _import_runner(con)._ingest_to_ducklake(
        user_id="u", layer_id=LAYER_ID, parquet_path=Path(report.outputs[0].path)
    )

    assert info["feature_count"] == 1
    assert info["geometry_type"] == "POINT"
    assert _catalog_tables(con, schema) == sorted(["t_first", LAYER_TABLE])
    assert set(_connection_tables(con)) <= before | {LAYER_TABLE}


def test_a_geometry_column_name_with_quotes_and_brackets_imports_as_data(
    tmp_path: Path, lake
):
    con, schema = lake
    before = set(_connection_tables(con))
    source = _parquet_with_geometry_column(tmp_path / "two.parquet", ODD_COLUMN)
    report = convert_all(str(source), tmp_path / "converted", target_crs="EPSG:4326")
    assert report.failures == []

    info = _import_runner(con)._ingest_to_ducklake(
        user_id="u", layer_id=LAYER_ID, parquet_path=Path(report.outputs[0].path)
    )

    assert info["feature_count"] == 1
    assert info["geometry_column"] == ODD_COLUMN
    assert _catalog_tables(con, schema) == sorted(["t_first", LAYER_TABLE])
    assert set(_connection_tables(con)) <= before | {LAYER_TABLE}


def test_a_geometry_column_with_a_space_ingests(tmp_path: Path, lake):
    con, schema = lake
    source = _parquet_with_geometry_column(tmp_path / "spaced.parquet", "my geom")

    info = _import_runner(con)._ingest_to_ducklake(
        user_id="u", layer_id=LAYER_ID, parquet_path=source
    )

    assert info["feature_count"] == 1
    assert info["geometry_column"] == "my geom"
    assert info["geometry_type"] == "POINT"
    assert info["extent"] == [3.0, 4.0, 3.0, 4.0]
    assert _catalog_tables(con, schema) == sorted(["t_first", LAYER_TABLE])


def test_a_replaced_table_keeps_odd_names_as_data(
    tmp_path: Path, lake, monkeypatch: pytest.MonkeyPatch
):
    con, schema = lake
    first = tmp_path / "first.geojson"
    first.write_text(_feature_collection(a=1))
    converted = convert_all(str(first), tmp_path / "converted", target_crs="EPSG:4326")
    _import_runner(con)._ingest_to_ducklake(
        user_id="u", layer_id=LAYER_ID, parquet_path=Path(converted.outputs[0].path)
    )
    source = _parquet_with_geometry_column(
        tmp_path / f"{ODD_MEMBER}.parquet", ODD_COLUMN
    )
    before = set(_connection_tables(con))
    runner = LayerUpdateRunner()
    runner._duckdb_con = con
    # The catalog lookup of an existing layer's table is not under test here.
    monkeypatch.setattr(runner, "resolve_layer_table_path", layer_table_path)

    info = runner._replace_ducklake_table(
        layer_id=LAYER_ID, owner_id="u", parquet_path=source
    )

    assert info["feature_count"] == 1
    assert info["geometry_type"] == "POINT"
    rows = con.execute(f"SELECT id FROM {layer_table_path(LAYER_ID)}").fetchall()
    assert rows == [(1,)]
    assert _catalog_tables(con, schema) == sorted(["t_first", LAYER_TABLE])
    assert set(_connection_tables(con)) <= before | {LAYER_TABLE}
