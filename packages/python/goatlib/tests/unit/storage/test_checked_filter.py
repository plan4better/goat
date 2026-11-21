"""A layer's filter as a tool or an export applies it: in full, or not at all.

`build_cql_filter` drops a filter it cannot read, which for a map request
means "show everything". A tool or an export would then run on the whole
layer and hand back a result that looks right. `checked_cql_filter` refuses
such a filter with a reason instead (`UnreadableFilterError`).
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import duckdb
import pytest
from goatlib.filter import limits
from goatlib.storage.query_builder import (
    UnreadableFilterError,
    build_cql_filter,
    checked_cql_filter,
)

pytestmark = pytest.mark.unit

#: A layer's columns as DESCRIBE gives them.
COLUMNS = {
    "id": "INTEGER",
    "name": "VARCHAR",
    "pop": "BIGINT",
    "opens": "TIME",
    "built": "DATE",
    "tags": "VARCHAR[]",
    "geometry": "GEOMETRY",
}


def p(name: str) -> dict[str, str]:
    return {"property": name}


def where(cql: Any) -> list[int]:
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE t AS SELECT * FROM (VALUES (1, 'a', 5, TIME '08:00', DATE '2024-01-01'),"
        " (2, 'b', 50, TIME '20:00', CURRENT_DATE)) AS t(id, name, pop, opens, built)"
    )
    f = checked_cql_filter(cql, COLUMNS)
    sql = f"SELECT id FROM t WHERE {f.to_full_where()} ORDER BY id"
    return [r[0] for r in con.execute(sql, f.params).fetchall()]


def test_a_readable_filter_gives_the_builders_clauses() -> None:
    cql = {"op": ">", "args": [p("pop"), 10]}
    built = build_cql_filter({"filter": json.dumps(cql)}, list(COLUMNS))
    checked = checked_cql_filter(cql, COLUMNS)
    assert (checked.clauses, checked.params) == (built.clauses, built.params)
    assert where(cql) == [2]


def test_the_filter_may_come_as_json_text() -> None:
    assert where(json.dumps({"op": "=", "args": [p("name"), "a"]})) == [1]


def test_a_relative_day_counts_back_from_today() -> None:
    assert where(
        {"op": ">=", "args": [p("built"), {"op": "daysAgo", "args": [7]}]}
    ) == [2]


def test_a_time_field_is_text_as_the_map_reads_it() -> None:
    assert where({"op": "=", "args": [p("opens"), "08:00"]}) == [1]
    with pytest.raises(UnreadableFilterError, match="compares numbers or dates"):
        checked_cql_filter({"op": "<", "args": [p("opens"), "12:00"]}, COLUMNS)


@pytest.mark.parametrize(
    ("cql", "reason"),
    [
        ({"op": "=", "args": [p("gone"), "a"]}, 'no field "gone"'),
        ({"op": "=", "args": [p("pop"), "many"]}, '"pop" is a integer field'),
        ({"op": "like", "args": [p("pop"), "5%"]}, '"like" reads text'),
        ({"op": "=", "args": [p("tags"), "a"]}, 'no field "tags"'),
        ({"op": "frobnicate", "args": [p("name"), 1]}, "cannot be used in a filter"),
        ({"op": "=", "args": [p("name")]}, "takes a field and a value"),
        (
            {"op": ">=", "args": [p("built"), {"op": "daysAgo", "args": [0]}]},
            "compares with",
        ),
        ("{not json", "not valid JSON"),
        (["=", "name", "a"], "is a CQL2-JSON object"),
    ],
    ids=[
        "unknown-field",
        "type-mismatch",
        "operator-type",
        "object-column",
        "unknown-operator",
        "malformed",
        "bad-relative-day",
        "not-json",
        "not-an-object",
    ],
)
def test_a_filter_that_cannot_be_applied_is_refused_with_its_reason(
    cql: Any, reason: str
) -> None:
    with pytest.raises(UnreadableFilterError) as refused:
        checked_cql_filter(cql, COLUMNS)
    message = str(refused.value)
    assert reason in message
    assert message.startswith("The layer's filter cannot be applied")


def test_a_filter_saved_over_a_save_limit_still_applies() -> None:
    """The save limits are warnings for a filter saved before: the map still
    filters by it, and so does a tool."""
    many = {
        "op": "and",
        "args": [
            {"op": "<>", "args": [p("pop"), 100 + i]}
            for i in range(limits.MAX_CONDITIONS + 1)
        ],
    }
    assert where(many) == [1, 2]


def test_a_filter_over_a_request_ceiling_is_refused() -> None:
    values = list(range(limits.REQUEST_MAX_VALUES + 1))
    with pytest.raises(UnreadableFilterError, match="at most"):
        checked_cql_filter({"op": "in", "args": [p("pop"), values]}, COLUMNS)


def test_a_filter_the_evaluator_cannot_translate_is_refused() -> None:
    """What the checker lets through but the evaluator refuses is refused too:
    an area on a geometry field the layer does not have (the checker does not
    read the field of an area)."""
    square = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    }
    cql = {"op": "s_intersects", "args": [p("shape"), square]}
    assert not build_cql_filter({"filter": json.dumps(cql)}, list(COLUMNS)).clauses
    with pytest.raises(UnreadableFilterError, match="cannot be applied"):
        checked_cql_filter(cql, COLUMNS)


def test_the_columns_may_come_as_their_kinds() -> None:
    """The If step knows a layer's fields by kind (`if_node.layer_field_types`)."""
    kinds = {"pop": "integer", "area": "number", "seen": "datetime"}
    assert checked_cql_filter({"op": ">", "args": [p("area"), 1.5]}, kinds).clauses
    assert checked_cql_filter(
        {"op": ">=", "args": [p("seen"), {"op": "daysAgo", "args": [3]}]}, kinds
    ).clauses
    with pytest.raises(UnreadableFilterError, match="does not fit"):
        checked_cql_filter({"op": "=", "args": [p("area"), "big"]}, kinds)


def test_no_filter_is_no_clause() -> None:
    assert checked_cql_filter(None, COLUMNS).clauses == []
    assert checked_cql_filter({}, COLUMNS).clauses == []


def test_the_reason_is_short_for_many_issues() -> None:
    cql = {
        "op": "and",
        "args": [{"op": "=", "args": [p(f"gone{i}"), 1]} for i in range(12)],
    }
    with pytest.raises(UnreadableFilterError) as refused:
        checked_cql_filter(cql, COLUMNS)
    assert len(str(refused.value)) < 600


def test_today_is_not_frozen_in_the_clauses() -> None:
    """The relative day resolves when the clauses are built."""
    built = checked_cql_filter(
        {"op": ">=", "args": [p("built"), {"op": "daysAgo", "args": [1]}]}, COLUMNS
    )
    since = (datetime.now(UTC).date() - timedelta(days=1)).isoformat()
    assert any(since in str(v) for v in built.params)
