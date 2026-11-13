"""A negation in a workflow's filter rows keeps the rows without a value.

`status <> 'a'` is unknown, not true, where status is empty, so SQL drops
that row. The rows read "is not a", and the web app's filter writes the same
operators with the empty value as an alternative; the runner agrees with it.
"""

import duckdb
import pytest
from goatlib.storage import cql_to_where_clause
from goatlib.tools.workflow_runner import convert_filter_to_cql

ROWS = [(1, "a"), (2, "b"), (3, None), (4, "abc")]


def kept(expression: str, value: object) -> list[int]:
    cql = convert_filter_to_cql(
        {
            "op": "and",
            "expressions": [
                {"attribute": "status", "expression": expression, "value": value}
            ],
        }
    )
    where = cql_to_where_clause(cql, ["id", "status"], "geometry", inline=True)
    con = duckdb.connect()
    con.execute("CREATE TABLE t (id INTEGER, status VARCHAR)")
    con.executemany("INSERT INTO t VALUES (?, ?)", ROWS)
    return [
        r[0]
        for r in con.execute(f"SELECT id FROM t WHERE {where} ORDER BY id").fetchall()
    ]


@pytest.mark.parametrize(
    "expression, value, ids",
    [
        ("is_not", "a", [2, 3, 4]),
        ("excludes", ["a", "b"], [3, 4]),
        ("does_not_contains_the_text", "a", [2, 3]),
    ],
)
def test_negation_keeps_rows_without_a_value(
    expression: str, value: object, ids: list[int]
) -> None:
    assert kept(expression, value) == ids


def test_is_not_empty_string_is_unchanged() -> None:
    assert kept("is_not_empty_string", None) == [1, 2, 4]
