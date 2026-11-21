"""Column names and types as every service reads them."""

import duckdb
import pytest
from goatlib.utils.column_types import column_types, type_class

TYPED_COLUMNS = {
    "i": ("INTEGER", "integer"),
    "b": ("BIGINT", "integer"),
    "h": ("HUGEINT", "integer"),
    "d": ("DOUBLE", "number"),
    "m": ("DECIMAL(10,2)", "number"),
    "flag": ("BOOLEAN", "boolean"),
    "day": ("DATE", "date"),
    "at": ("TIMESTAMP WITH TIME ZONE", "datetime"),
    "clock": ("TIME", "time"),
    "name": ("VARCHAR", "string"),
    "doc": ("JSON", "object"),
    "geom": ("GEOMETRY", "geometry"),
}


def test_column_types_and_their_classes(tmp_path) -> None:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "CREATE TABLE typed ("
        + ", ".join(f'"{name}" {sql}' for name, (sql, _) in TYPED_COLUMNS.items())
        + ")"
    )
    types = column_types(con, "typed")
    assert list(types) == list(TYPED_COLUMNS)
    assert {name: type_class(t) for name, t in types.items()} == {
        name: cls for name, (_, cls) in TYPED_COLUMNS.items()
    }
    con.execute(
        f"COPY (SELECT 1 AS a, 'x' AS b) TO '{tmp_path / 't.parquet'}' (FORMAT parquet)"
    )
    assert column_types(con, f"read_parquet('{tmp_path / 't.parquet'}')") == {
        "a": "INTEGER",
        "b": "VARCHAR",
    }


@pytest.mark.parametrize(
    ("duckdb_type", "expected"),
    [
        ("INTERVAL", "string"),
        ("POINT_2D", "geometry"),
        ("VARCHAR[]", "object"),
        ("INTEGER[3]", "object"),
        ("STRUCT(a INTEGER)", "object"),
        ("MAP(VARCHAR, INTEGER)", "object"),
        ("TIMESTAMP_MS", "datetime"),
        ("TIME WITH TIME ZONE", "time"),
        ("UUID", "string"),
        ("UBIGINT", "integer"),
        ("FLOAT", "number"),
        ("ENUM('point', 'interval')", "string"),
    ],
)
def test_type_class_reads_the_type_name_not_substrings(
    duckdb_type: str, expected: str
) -> None:
    assert type_class(duckdb_type) == expected


def test_importing_the_type_helpers_stays_light() -> None:
    import subprocess
    import sys

    out = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, goatlib.utils.column_types; print('goatlib.analysis' in sys.modules)",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.strip() == "False"
