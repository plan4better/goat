"""Every case without an error runs: `normalize`, the parser, the evaluator and
DuckDB, against a table with the case's fields."""

import json
from typing import Any

import duckdb
import pytest
from goatlib.filter.issues import CODES
from goatlib.filter.normalize import normalize
from goatlib.storage.cql_evaluator import cql2_to_duckdb_sql
from pygeofilter.parsers.cql2_json import parse

from .conftest import load_cases

COLUMN = {
    "string": "VARCHAR",
    "integer": "INTEGER",
    "number": "DOUBLE",
    "boolean": "BOOLEAN",
    "date": "DATE",
    "datetime": "TIMESTAMP",
}
SAMPLE = {
    "string": "'Berlin'",
    "integer": "5",
    "number": "1.5",
    "boolean": "true",
    "date": "DATE '2024-05-01'",
    "datetime": "TIMESTAMP '2024-05-01 10:30:00'",
}
RUNS = [
    c for c in load_cases() if not any(CODES[code] == "error" for code in c["issues"])
]


@pytest.fixture(scope="module")
def con() -> Any:
    con = duckdb.connect()
    con.execute("LOAD spatial")
    yield con
    con.close()


@pytest.mark.parametrize("case", RUNS, ids=[c["name"] for c in RUNS])
def test_runs(case: dict[str, Any], con: Any) -> None:
    fields: dict[str, str] = case["fields"]
    names = list(fields) + ["geom"]
    con.execute("DROP TABLE IF EXISTS t")
    con.execute(
        "CREATE TABLE t ("
        + ", ".join(f'"{n}" {COLUMN[t]}' for n, t in fields.items())
        + ", geom GEOMETRY)"
    )
    con.execute(
        "INSERT INTO t VALUES ("
        + ", ".join(SAMPLE[t] for t in fields.values())
        + ", ST_Point(0.5, 0.5)), ("
        + ", ".join("NULL" for _ in fields)
        + ", NULL)"
    )
    sql, params = cql2_to_duckdb_sql(
        parse(json.dumps(normalize(case["cql"]))), names, "geom"
    )
    con.execute(f"SELECT count(*) FROM t WHERE {sql}", params).fetchall()
