"""Appending into a real DuckLake table with geometry.

DuckLake keeps its transaction-local row id (around 1e18) on a row that is
updated in the transaction that inserted it, when the table has a GEOMETRY
column (see geoapi's bundle_edit_service). The append must therefore never
UPDATE rows it has just inserted: generated and computed values are filled
before the insert. A plain DuckDB table cannot show this, so these tests
attach a file-backed DuckLake catalog.
"""

from pathlib import Path

import duckdb
import pytest
from goatlib.tools.append_rows import AppendError, append_rows, plan_columns
from goatlib.utils.generated_fields import SerialCounters

FIELD_CONFIG = {
    "nr": {"kind": "serial", "start": 1},
    "status": {"allowed_values": ["ok"]},
    "double": {"is_computed": True, "kind": "formula", "formula": "n * 2"},
}
TABLE = "lake.t"


@pytest.fixture
def lake(tmp_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    try:
        con.execute("LOAD ducklake; LOAD spatial;")
    except duckdb.Error as exc:  # pragma: no cover - extension missing offline
        pytest.skip(f"ducklake/spatial extension unavailable: {exc}")
    con.execute(
        f"ATTACH 'ducklake:{tmp_path}/meta.ducklake' AS lake "
        f"(DATA_PATH '{tmp_path}/data')"
    )
    con.execute(
        f"CREATE TABLE {TABLE} (geometry GEOMETRY, nr BIGINT, n INTEGER, "
        "status VARCHAR, double INTEGER)"
    )
    con.execute(f"INSERT INTO {TABLE} VALUES (ST_Point(1, 1), 1, 1, 'ok', 2)")
    return con


def _append(
    con: duckdb.DuckDBPyConnection,
    lo: int,
    hi: int,
    status: str = "ok",
    counters: SerialCounters | None = None,
) -> int:
    con.execute(
        "CREATE OR REPLACE TEMP TABLE src AS SELECT ST_Point(i, i) AS geometry, "
        f"i::INTEGER AS n, '{status}' AS status FROM range({lo}, {hi}) t(i)"
    )
    inp = {r[0]: r[1] for r in con.execute("DESCRIBE SELECT * FROM src").fetchall()}
    tgt = {r[0]: r[1] for r in con.execute(f"DESCRIBE {TABLE}").fetchall()}
    plan = plan_columns(
        inp,
        target_cols=tgt,
        field_config=FIELD_CONFIG,
        input_geometry="POINT",
        target_geometry="point",
    )
    con.execute("BEGIN TRANSACTION")
    try:
        rows = append_rows(
            con, TABLE, "SELECT * FROM src", plan, FIELD_CONFIG, counters
        )
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return rows


def _rows(con: duckdb.DuckDBPyConnection) -> list[tuple]:
    return con.execute(
        f"SELECT rowid, nr, n, status, double FROM {TABLE} ORDER BY nr"
    ).fetchall()


def test_appended_rows_keep_ordinary_row_ids(lake: duckdb.DuckDBPyConnection) -> None:
    assert _append(lake, 10, 12) == 2
    rows = _rows(lake)
    assert [r[1] for r in rows] == [1, 2, 3]
    assert all(r[0] < 1_000_000 for r in rows)
    assert len({r[0] for r in rows}) == 3
    assert rows[1][4] == 20 and rows[2][4] == 22  # computed before the insert


def test_disallowed_value_appends_nothing(lake: duckdb.DuckDBPyConnection) -> None:
    with pytest.raises(AppendError, match="status"):
        _append(lake, 20, 21, status="BAD")
    assert _rows(lake) == [(0, 1, 1, "ok", 2)]


def test_repeated_appends_never_touch_existing_rows(
    lake: duckdb.DuckDBPyConnection,
) -> None:
    _append(lake, 10, 12)
    before = _rows(lake)
    _append(lake, 30, 34)
    after = _rows(lake)
    assert after[:3] == before
    assert [r[1] for r in after] == [1, 2, 3, 4, 5, 6, 7]
    assert len({r[0] for r in after}) == 7
    assert all(r[0] < 1_000_000 for r in after)


def test_serial_continues_after_the_high_water_mark(
    lake: duckdb.DuckDBPyConnection,
) -> None:
    # Numbers up to 9 were handed out once (rows since deleted): never again.
    counters = SerialCounters(high_water={"nr": 9})
    _append(lake, 10, 12, counters=counters)
    assert [r[1] for r in _rows(lake)] == [1, 10, 11]
    assert counters.assigned["nr"] == 11


def test_zero_rows_leave_the_table_alone(lake: duckdb.DuckDBPyConnection) -> None:
    assert _append(lake, 0, 0) == 0
    assert _rows(lake) == [(0, 1, 1, "ok", 2)]
