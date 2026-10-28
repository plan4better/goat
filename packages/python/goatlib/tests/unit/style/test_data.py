"""A style's data description and statistics read from DuckDB."""

import subprocess
import sys
import time

import duckdb
import pytest
from goatlib.style.compute import Breaks
from goatlib.style.data import compute_into, compute_stats, describe

ODD = 'Einwohner "2020" ß'


@pytest.fixture
def duck() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "CREATE TABLE t (id INTEGER, name VARCHAR, pop DOUBLE, ok BOOLEAN, d DATE, "
        "share DECIMAL(10,2), clock TIME, geom GEOMETRY)"
    )
    con.execute(
        "INSERT INTO t VALUES "
        "(1, 'a', 1.0, true, '2024-01-01', 2.50, '10:00', ST_Point(0, 0)), "
        "(2, 'b', 5.0, false, '2024-01-02', 3.00, '11:00', ST_Point(1, 1)), "
        "(3, 'a', 9.0, NULL, '2024-01-03', 3.00, '12:00', ST_Point(2, 2))"
    )
    return con


def test_describe_types_and_only_used_fields_get_values(duck) -> None:
    ctx = describe(duck, "t", geometry="point", fields_used={"name", "ok", "id"})
    assert {n: f.type for n, f in ctx.fields.items()} == {
        "id": "integer",
        "name": "string",
        "pop": "number",
        "ok": "boolean",
        "d": "date",
        "share": "number",
    }
    assert ctx.fields["name"].values == ("a", "b")
    assert ctx.fields["ok"].values == ("false", "true")
    assert (ctx.fields["id"].min, ctx.fields["id"].max) == (1.0, 3.0)
    assert ctx.fields["pop"].min is None and ctx.fields["pop"].values is None
    assert ctx.feature_count == 3 and ctx.geometry == "point" and ctx.kind == "vector"


def test_more_than_a_hundred_values_are_unknown() -> None:
    con = duckdb.connect()
    con.execute("CREATE TABLE t AS SELECT i::VARCHAR AS k FROM range(150) r(i)")
    assert (
        describe(con, "t", geometry=None, fields_used={"k"}).fields["k"].values is None
    )


def test_parquet_views_work_like_tables(duck, tmp_path) -> None:
    duck.execute(
        f"COPY (SELECT id, name, pop FROM t) TO '{tmp_path / 't.parquet'}' (FORMAT parquet)"
    )
    con = duckdb.connect()
    con.execute(
        f"CREATE VIEW v AS SELECT * FROM read_parquet('{tmp_path / 't.parquet'}')"
    )
    assert (
        describe(con, "v", geometry="point", fields_used={"pop"}).fields["pop"].max
        == 9.0
    )
    assert compute_stats(con, "v", [("breaks", "pop", "natural_breaks", "2")])


def test_compute_stats_and_odd_names() -> None:
    con = duckdb.connect()
    con.execute(f'CREATE TABLE t ("{ODD.replace(chr(34), chr(34) * 2)}" DOUBLE)')
    con.execute("INSERT INTO t VALUES (1), (2), (4), (NULL)")
    stats = compute_stats(con, "t", [("range", ODD), ("range", ODD)])
    assert stats == {("range", ODD): (1.0, 4.0)}


def test_breaks_top_values_and_scaled_ranges(duck) -> None:
    duck.execute(
        "INSERT INTO t (id, name, pop, share) VALUES (4, 'c', -3.0, 3.00), (5, 'a', 0.0, 2.50)"
    )
    stats = compute_stats(
        duck,
        "t",
        [
            ("breaks", "pop", "equal_interval", "2"),
            ("top", "name", "2"),
            ("top", "id", "2"),
            ("top", "ok", "1"),
            ("top", "share", "2"),
            ("range", "pop", "sqrt"),
            ("range", "pop", "log"),
        ],
    )
    assert stats[("breaks", "pop", "equal_interval", "2")] == Breaks(
        (3.0,), -3.0, 9.0, False
    )
    assert stats[("top", "name", "2")] == [("a", 3), ("b", 1)]
    assert stats[("top", "id", "2")] == [(1, 1), (2, 1)]
    assert stats[("top", "ok", "1")] == [("false", 1)]
    assert stats[("top", "share", "2")] == [("3", 3), ("2.5", 2)]
    assert stats[("range", "pop", "sqrt")] == (0.0, 9.0)
    assert stats[("range", "pop", "log")] == (1.0, 9.0)


def test_methods_that_make_fewer_classes_by_design_are_not_merged() -> None:
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE t AS SELECT 1.0 AS v FROM range(50) UNION ALL SELECT 2.0 FROM range(50)"
    )
    stats = compute_stats(
        con,
        "t",
        [("breaks", "v", "heads_and_tails", "4"), ("breaks", "v", "quantile", "4")],
    )
    assert stats[("breaks", "v", "heads_and_tails", "4")] == Breaks(
        (1.5,), 1.0, 2.0, False
    )
    assert stats[("breaks", "v", "quantile", "4")].merged is True


def test_unknown_and_text_fields_are_left_to_the_checks(duck) -> None:
    stats = compute_stats(
        duck,
        "t",
        [("breaks", "nope", "quantile", "5"), ("range", "name"), ("top", "geom", "3")],
    )
    assert stats == {}


def test_compute_into_writes_the_classes_and_stamps_them(duck) -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "classify": [{"field": "pop", "method": "equal_interval", "count": 2}],
    }
    out, notes = compute_into(
        duck, "t", doc, geometry="point", fingerprint="ducklake:3"
    )
    [c] = out["classify"]
    assert [(k.get("from"), k.get("to")) for k in c["classes"]] == [
        (None, 5),
        (5, None),
    ]
    assert c["computed"]["data"] == "ducklake:3"
    assert c["computed"]["at"].endswith("Z") and notes == []
    assert "classes" not in doc["classify"][0]


def test_compute_into_reads_nothing_for_a_style_without_computed_values() -> None:
    by_hand = {
        "field": "kind",
        "method": "categories",
        "classes": [{"values": ["a"]}],
        "computed": {"at": "2026-01-01T00:00:00Z", "data": "ducklake:1"},
    }
    doc = {"version": 1, "kind": "vector", "classify": [by_hand]}
    out, notes = compute_into(
        None, "no_such_relation", doc, geometry="point", fingerprint="f"
    )
    assert "computed" not in out["classify"][0] and notes == []


def test_a_million_rows_compute_in_seconds() -> None:
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE t AS SELECT random() * 1000 AS v, (i % 7)::VARCHAR AS k FROM range(1000000) r(i)"
    )
    keys = [
        ("breaks", "v", m, "5")
        for m in (
            "quantile",
            "equal_interval",
            "natural_breaks",
            "std_dev",
            "heads_and_tails",
        )
    ] + [("top", "k", "5")]
    t = time.perf_counter()
    stats = compute_stats(con, "t", keys)
    assert time.perf_counter() - t < 15
    assert len(stats) == 6


def test_importing_goatlib_style_does_not_load_duckdb() -> None:
    out = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, goatlib.style, goatlib.style.validate, goatlib.style.merge, "
            "goatlib.style.compute; print('duckdb' in sys.modules, 'numpy' in sys.modules)",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.strip() == "False False"
