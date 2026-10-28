from pathlib import Path

import duckdb
from goatlib.style.fingerprint import (
    advance_data_snapshots_sql,
    changed_table_ids,
    fingerprint,
    is_stale,
)

CLASSIFIED = {
    "version": 1,
    "kind": "vector",
    "classify": [
        {
            "id": "density",
            "field": "density",
            "method": "quantile",
            "count": 5,
            "computed": {"at": "2026-10-25T10:00:00Z", "data": "ducklake:5"},
            "classes": [{"id": "c1", "to": 3}, {"id": "c2", "from": 3}],
        }
    ],
}


def test_changed_tables_come_from_data_changes_only() -> None:
    changes = (
        "inserted_into_table:12,merge_adjacent:12,altered_table:7,deleted_from_table:3"
    )
    assert changed_table_ids(changes) == {12, 7, 3}
    assert changed_table_ids("inlined_insert:4,inlined_delete:9") == {4, 9}
    assert changed_table_ids("merge_adjacent:5") == set()
    assert changed_table_ids("") == set()
    assert changed_table_ids("created_table:x,altered_table:") == set()


def test_the_tracker_statement_names_the_schemas_it_is_given() -> None:
    sql = advance_data_snapshots_sql("test_schema")
    assert "test_schema.layer" in sql
    assert "test_schema.data_snapshot_cursor" in sql
    assert "ducklake.ducklake_snapshot_changes" in sql
    assert "GREATEST" in sql
    assert "merge_adjacent" not in sql
    assert sql.count(";") <= 1
    assert "lake2.ducklake_table" in advance_data_snapshots_sql(
        "s", ducklake_schema="lake2"
    )


def test_fingerprints() -> None:
    assert fingerprint(data_snapshot=7, catalog_version="3") == "catalog:3"
    assert fingerprint(data_snapshot=7, catalog_version=None) == "ducklake:7"
    assert fingerprint(data_snapshot=None, catalog_version=None) == "ducklake:0"


def test_stale_when_computed_data_differs_or_computed_values_are_missing() -> None:
    assert is_stale(CLASSIFIED, "ducklake:6")
    assert not is_stale(CLASSIFIED, "ducklake:5")
    without = {
        **CLASSIFIED,
        "classify": [{**CLASSIFIED["classify"][0], "computed": None}],
    }
    del without["classify"][0]["computed"]
    assert is_stale(without, "ducklake:5")
    plain = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#ff0000"}}}
    assert not is_stale(plain, "ducklake:5")
    assert not is_stale(CLASSIFIED, None)
    by_attribute = {
        "version": 1,
        "kind": "vector",
        "symbol": {"line": {"width": {"field": "traffic", "range": [1, 8]}}},
    }
    assert is_stale(by_attribute, "ducklake:1")
    fixed = {
        "version": 1,
        "kind": "vector",
        "symbol": {
            "line": {"width": {"field": "traffic", "range": [1, 8], "domain": [0, 9]}}
        },
    }
    assert not is_stale(fixed, "ducklake:1")


def test_the_change_kinds_match_what_ducklake_writes(tmp_path: Path) -> None:
    """Against a real (file-backed) DuckLake: every data change of a table is
    named in its snapshot's `changes_made`, compaction is not. A DuckLake upgrade
    that renames a change kind fails here instead of silently ending every
    recompute (spec 12)."""
    data = tmp_path / "data"
    data.mkdir()
    con = duckdb.connect()
    con.execute("INSTALL ducklake; LOAD ducklake")
    con.execute(
        f"ATTACH 'ducklake:{tmp_path / 'meta.ducklake'}' AS lake "
        f"(DATA_PATH '{data}', DATA_INLINING_ROW_LIMIT 10)"
    )
    steps = {
        "create": ("CREATE TABLE lake.t (a INTEGER)", False),
        "file insert": ("INSERT INTO lake.t SELECT range FROM range(100)", True),
        "second file": ("INSERT INTO lake.t SELECT range FROM range(100, 200)", True),
        "compaction": ("CALL ducklake_merge_adjacent_files('lake')", False),
        "inlined insert": ("INSERT INTO lake.t VALUES (1000), (1001)", True),
        "inlined delete": ("DELETE FROM lake.t WHERE a = 1000", True),
        "file delete": ("DELETE FROM lake.t WHERE a >= 100 AND a < 150", True),
        "rewrite": (
            "CALL ducklake_rewrite_data_files('lake', delete_threshold => 0)",
            False,
        ),
        "file update": ("UPDATE lake.t SET a = a + 1 WHERE a < 40", True),
        "added column": ("ALTER TABLE lake.t ADD COLUMN b VARCHAR", True),
    }
    seen: dict[str, tuple[str, set[int]]] = {}
    newest = 0
    meta = "__ducklake_metadata_lake.ducklake_snapshot_changes"
    for name, (sql, _) in steps.items():
        con.execute(sql)
        rows = con.execute(
            f"SELECT snapshot_id, changes_made FROM {meta} WHERE snapshot_id > ? "
            "ORDER BY snapshot_id",
            [newest],
        ).fetchall()
        if rows:
            newest = rows[-1][0]
        made = ",".join(r[1] for r in rows)
        seen[name] = (made, changed_table_ids(made))
    table_id = con.execute(
        "SELECT table_id FROM __ducklake_metadata_lake.ducklake_table WHERE table_name = 't'"
    ).fetchone()[0]
    for name, (_, data_change) in steps.items():
        made, ids = seen[name]
        assert ids == ({table_id} if data_change else set()), (name, made)
