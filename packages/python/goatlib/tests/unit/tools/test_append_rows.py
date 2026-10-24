"""Planning and appending rows for "Save as dataset" set to an existing
dataset.

An in-memory DuckDB table stands in for the target's DuckLake table: the
append only uses SQL both understand (INSERT, a local staging table).
Columns must match: an input column the target lacks stops the append.
"""

from collections.abc import Iterator

import duckdb
import pytest
from goatlib.tools.append_rows import (
    AppendError,
    append_rows,
    geometry_family,
    plan_columns,
)

TARGET = {
    "id": "VARCHAR",
    "name": "VARCHAR",
    "status": "VARCHAR",
    "n": "INTEGER",
    "geometry": "GEOMETRY",
    "bbox": "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)",
}


def _plan(input_cols: dict[str, str], **kw: object):  # type: ignore[no-untyped-def]
    args: dict = dict(
        target_cols=TARGET,
        field_config=None,
        input_geometry="point",
        target_geometry="point",
    )
    args.update(kw)
    return plan_columns(input_cols, **args)


@pytest.fixture
def con() -> Iterator[duckdb.DuckDBPyConnection]:
    c = duckdb.connect()
    c.execute("LOAD spatial")
    c.execute(
        "CREATE TABLE target (id VARCHAR, name VARCHAR, status VARCHAR, n INTEGER, "
        "nr INTEGER, geometry GEOMETRY, "
        "bbox STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE))"
    )
    c.execute(
        "CREATE TABLE source (name VARCHAR, status VARCHAR, n VARCHAR, "
        "nr INTEGER, geometry GEOMETRY)"
    )
    yield c
    c.close()


def _cols(con: duckdb.DuckDBPyConnection, table: str) -> dict[str, str]:
    return {r[0]: r[1] for r in con.execute(f"DESCRIBE {table}").fetchall()}


def _seed_target(con: duckdb.DuckDBPyConnection, rows: int) -> None:
    for i in range(rows):
        con.execute(
            "INSERT INTO target (name, n, nr, geometry) VALUES (?, ?, ?, ST_Point(?, 0))",
            [f"old{i}", i, i + 1, float(i)],
        )


def _seed_source(
    con: duckdb.DuckDBPyConnection, rows: int, status: str = "fertig"
) -> None:
    for i in range(rows):
        con.execute(
            "INSERT INTO source VALUES (?, ?, ?, 99, ST_Point(?, 1))",
            [f"new{i}", status, str(10 + i), float(i)],
        )


def _append(con: duckdb.DuckDBPyConnection, field_config: dict | None = None) -> int:
    plan = plan_columns(
        _cols(con, "source"),
        target_cols=_cols(con, "target"),
        field_config=field_config,
        input_geometry="point",
        target_geometry="point",
    )
    return append_rows(con, "target", "SELECT * FROM source", plan, field_config)


# --- plan_columns -----------------------------------------------------------


def test_unknown_input_column_stops_the_append() -> None:
    with pytest.raises(AppendError, match="foo"):
        _plan({"name": "VARCHAR", "foo": "INTEGER", "geometry": "GEOMETRY"})


def test_missing_target_column_takes_default() -> None:
    plan = _plan(
        {"name": "VARCHAR", "geometry": "GEOMETRY"},
        field_config={"status": {"default_value": "zu prüfen"}},
    )
    i = plan.columns.index("status")
    assert plan.select_sql[i] == "CAST(? AS VARCHAR)"
    assert plan.params[plan.select_sql[:i].count("?")] == "zu prüfen"


def test_geometry_family_mismatch_refused() -> None:
    with pytest.raises(AppendError, match="geometry"):
        _plan(
            {"geometry": "GEOMETRY"}, input_geometry="point", target_geometry="polygon"
        )
    with pytest.raises(AppendError, match="table"):
        _plan({"name": "VARCHAR"}, input_geometry=None, target_geometry="point")


def test_multipoint_into_point_allowed() -> None:
    assert geometry_family("multipoint") == geometry_family("point") == "point"
    _plan(
        {"geometry": "GEOMETRY"}, input_geometry="multipoint", target_geometry="point"
    )


def test_generated_and_storage_columns_are_not_taken_from_the_input() -> None:
    plan = _plan(
        {"name": "VARCHAR", "nr": "INTEGER", "id": "VARCHAR"},
        target_cols={**TARGET, "nr": "INTEGER"},
        field_config={"nr": {"kind": "serial", "start": 1}},
    )
    assert "nr" not in plan.columns
    assert "id" not in plan.columns


# --- append_rows ------------------------------------------------------------


def test_append_keeps_existing_rows_and_adds_no_columns(
    con: duckdb.DuckDBPyConnection,
) -> None:
    _seed_target(con, 2)
    _seed_source(con, 3)
    before = set(_cols(con, "target"))

    assert _append(con) == 3

    rows = con.execute(
        "SELECT name, n, bbox.xmin FROM target ORDER BY rowid"
    ).fetchall()
    assert rows[:2] == [("old0", 0, None), ("old1", 1, None)]  # seeded without bbox
    assert rows[2:] == [("new0", 10, 0.0), ("new1", 11, 1.0), ("new2", 12, 2.0)]
    assert set(_cols(con, "target")) == before


def test_zero_rows_appends_nothing(con: duckdb.DuckDBPyConnection) -> None:
    _seed_target(con, 2)
    assert _append(con) == 0
    assert con.execute("SELECT count(*) FROM target").fetchone() == (2,)


def test_serial_continues_after_hand_written_rows(
    con: duckdb.DuckDBPyConnection,
) -> None:
    _seed_target(con, 3)
    _seed_source(con, 2)
    _append(con, field_config={"nr": {"kind": "serial", "start": 1}})
    nrs = [r[0] for r in con.execute("SELECT nr FROM target ORDER BY rowid").fetchall()]
    assert nrs == [1, 2, 3, 4, 5]


def test_computed_column_filled_for_new_rows(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("ALTER TABLE target ADD COLUMN double INTEGER")
    _seed_source(con, 1)
    _append(
        con,
        field_config={
            "double": {"is_computed": True, "kind": "formula", "formula": "n * 2"}
        },
    )
    assert con.execute("SELECT double FROM target").fetchone() == (20,)


def test_bad_cast_names_column(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        "INSERT INTO source VALUES ('x', 'fertig', 'abc', NULL, ST_Point(0, 0))"
    )
    with pytest.raises(AppendError, match="'n'"):
        _append(con)
    assert con.execute("SELECT count(*) FROM target").fetchone() == (0,)


def test_allowed_value_violation_fails(con: duckdb.DuckDBPyConnection) -> None:
    _seed_target(con, 1)
    _seed_source(con, 2, status="x")
    con.execute("BEGIN")
    with pytest.raises(AppendError, match="status"):
        _append(
            con, field_config={"status": {"allowed_values": ["zu prüfen", "fertig"]}}
        )
    con.execute("ROLLBACK")
    assert con.execute("SELECT count(*) FROM target").fetchone() == (1,)


# --- geometry of every row --------------------------------------------------


def test_every_row_counts_for_the_geometry_check(
    con: duckdb.DuckDBPyConnection,
) -> None:
    from goatlib.tools.append_rows import input_geometry_types

    con.execute("INSERT INTO source (name, geometry) VALUES ('a', ST_Point(0, 0))")
    con.execute(
        "INSERT INTO source (name, geometry) VALUES "
        "('b', ST_GeomFromText('MULTIPOINT ((1 1), (2 2))')), ('c', NULL)"
    )
    assert input_geometry_types(con, "SELECT * FROM source") == {"point"}
    con.execute(
        "INSERT INTO source (name, geometry) VALUES "
        "('d', ST_GeomFromText('POLYGON ((0 0, 1 0, 1 1, 0 0))'))"
    )
    assert input_geometry_types(con, "SELECT * FROM source") == {"point", "polygon"}


def test_mixed_geometry_refused() -> None:
    from goatlib.tools.append_rows import check_same_geometry

    check_same_geometry({"point"}, "point")
    check_same_geometry(set(), "point")  # no geometry in any row: nothing to check
    with pytest.raises(AppendError, match="point and polygon"):
        check_same_geometry({"point", "polygon"}, "point")
    with pytest.raises(
        AppendError,
        match="^The input has line geometry; the target layer has polygon geometry.$",
    ):
        check_same_geometry({"line"}, "polygon")


def test_geometry_collection_refused(con: duckdb.DuckDBPyConnection) -> None:
    from goatlib.tools.append_rows import check_same_geometry, input_geometry_types

    con.execute(
        "INSERT INTO source (name, geometry) VALUES "
        "('g', ST_GeomFromText('GEOMETRYCOLLECTION (POINT (0 0))'))"
    )
    with pytest.raises(AppendError):
        check_same_geometry(input_geometry_types(con, "SELECT * FROM source"), "point")


def test_rows_without_a_single_fitting_column_fail(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # Two input rows, but the target has nothing they can fill (its only
    # column is generated): appending empty rows would be a silent no-op.
    con.execute("CREATE TABLE only_serial (nr INTEGER)")
    con.execute("CREATE TABLE src2 (nr INTEGER)")
    con.execute("INSERT INTO src2 VALUES (1), (2)")
    config = {"nr": {"kind": "serial", "start": 1}}
    plan = plan_columns(
        _cols(con, "src2"),
        target_cols=_cols(con, "only_serial"),
        field_config=config,
        input_geometry=None,
        target_geometry=None,
    )
    with pytest.raises(AppendError, match="no column"):
        append_rows(con, "only_serial", "SELECT * FROM src2", plan, config)


def test_defaults_take_the_column_type_as_in_the_data_table(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # As when a row is added by hand (geoapi inserts, so the database casts
    # the default to the column, then computes): a default stored as text
    # for a number column is a number by the time formulas and allowed
    # values see it.
    con.execute("ALTER TABLE target ADD COLUMN prio INTEGER")
    con.execute("ALTER TABLE target ADD COLUMN prio_plus_one INTEGER")
    _seed_source(con, 1)
    config = {
        "prio": {"default_value": "1", "allowed_values": [1, 2, 3]},
        "prio_plus_one": {
            "is_computed": True,
            "kind": "formula",
            "formula": "prio + 1",
        },
    }
    assert _append(con, field_config=config) == 1
    assert con.execute("SELECT prio, prio_plus_one FROM target").fetchone() == (1, 2)


def test_a_database_error_is_not_hidden_by_the_cleanup(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # Inside the caller's transaction (as finalize runs it), a database error
    # aborts the transaction. Dropping the staging table afterwards must not
    # replace that error with "transaction is aborted".
    con.execute("ALTER TABLE target ADD COLUMN ratio DOUBLE")
    _seed_source(con, 1)
    config = {
        "ratio": {
            "is_computed": True,
            "kind": "formula",
            "formula": "CAST(name AS INTEGER) / 2",
        }
    }
    con.execute("BEGIN TRANSACTION")
    with pytest.raises(duckdb.Error) as failure:
        _append(con, field_config=config)
    con.execute("ROLLBACK")
    assert "aborted" not in str(failure.value).lower()
    assert "new0" in str(failure.value) or "convert" in str(failure.value).lower()


class _CountingCon:
    """A connection that counts the queries checking casts."""

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self.con = con
        self.cast_checks = 0

    def execute(self, sql: str, *args: object):  # type: ignore[no-untyped-def]
        if "TRY_CAST" in sql:
            self.cast_checks += 1
        return self.con.execute(sql, *args)


def test_all_casts_are_checked_in_one_pass(con: duckdb.DuckDBPyConnection) -> None:
    # One read of the input for every column, not one per column: the layer
    # stays locked while this runs.
    _seed_source(con, 3)
    plan = plan_columns(
        _cols(con, "source"),
        target_cols=_cols(con, "target"),
        field_config=None,
        input_geometry="point",
        target_geometry="point",
    )
    assert len(plan.cast_columns) >= 3
    counting = _CountingCon(con)
    append_rows(counting, "target", "SELECT * FROM source", plan, None)
    assert counting.cast_checks == 1


def test_a_type_that_never_converts_is_named(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("CREATE TABLE src_geom_n (name VARCHAR, n GEOMETRY, geometry GEOMETRY)")
    con.execute("INSERT INTO src_geom_n VALUES ('a', ST_Point(0, 0), ST_Point(0, 0))")
    plan = plan_columns(
        _cols(con, "src_geom_n"),
        target_cols=_cols(con, "target"),
        field_config=None,
        input_geometry="point",
        target_geometry="point",
    )
    with pytest.raises(AppendError, match="'n'"):
        append_rows(con, "target", "SELECT * FROM src_geom_n", plan, None)
