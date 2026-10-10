"""Custom SQL on an empty input layer.

DuckDB writes no GeoParquet metadata for an empty table, so an empty
intermediate workflow result reads back with its geometry as WKB BLOB.
The view registered for the custom SQL query must restore the geometry
type, otherwise spatial functions on it fail to bind.
"""

from pathlib import Path

import duckdb
from goatlib.tools.custom_sql import CustomSqlToolRunner


def _write_parquet(con: duckdb.DuckDBPyConnection, path: Path, where: str) -> None:
    con.execute(
        f"COPY (SELECT 1 AS id, ST_Point(7.13, 50.76) AS geometry WHERE {where}) "
        f"TO '{path}' (FORMAT PARQUET)"
    )


def test_empty_input_geometry_is_restored(tmp_path: Path) -> None:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    empty, full = tmp_path / "empty.parquet", tmp_path / "full.parquet"
    _write_parquet(con, empty, "false")
    _write_parquet(con, full, "true")

    # The precondition this guards against: the empty file reads back as BLOB.
    raw = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{empty}')").fetchall()
    assert dict((c[0], c[1]) for c in raw)["geometry"] == "BLOB"

    CustomSqlToolRunner._register_layer_as_view(None, con, "input_1", str(empty))
    CustomSqlToolRunner._register_layer_as_view(None, con, "input_2", str(full))

    types = dict(
        (c[0], c[1]) for c in con.execute("DESCRIBE SELECT * FROM input_1").fetchall()
    )
    assert types["geometry"].startswith("GEOMETRY")

    count = con.execute(
        "SELECT count(*) FROM input_2 JOIN input_1 "
        "ON ST_Intersects(input_1.geometry, input_2.geometry)"
    ).fetchone()[0]
    assert count == 0


def test_non_empty_input_is_unchanged(tmp_path: Path) -> None:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    full = tmp_path / "full.parquet"
    _write_parquet(con, full, "true")

    CustomSqlToolRunner._register_layer_as_view(None, con, "input_1", str(full))

    assert (
        con.execute("SELECT ST_AsText(geometry) FROM input_1").fetchone()[0]
        == "POINT (7.13 50.76)"
    )
