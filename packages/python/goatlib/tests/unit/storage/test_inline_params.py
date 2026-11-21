"""A filter's SQL with its values written in keeps the rows its parameters keep.

The If step and the layer export run a filter's SQL with the values written in
(`cql_to_where_clause(..., inline=True)`); a value holding a placeholder's
question mark or a quote is a value like any other there.
"""

import duckdb
import pytest
from goatlib.storage import cql_to_where_clause, inline_params

COLUMNS = ["id", "name"]
NAMES = [(1, "what?"), (2, "x"), (3, "it's"), (4, "a ? b"), (5, None)]


@pytest.fixture
def con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute('CREATE TABLE t (id INTEGER, "name" VARCHAR)')
    con.executemany("INSERT INTO t VALUES (?, ?)", NAMES)
    return con


def _kept(con: duckdb.DuckDBPyConnection, cql: dict) -> tuple[list[int], list[int]]:
    where, params = cql_to_where_clause(cql, COLUMNS)
    with_params = con.execute(
        f"SELECT id FROM t WHERE {where} ORDER BY id", params
    ).fetchall()
    inline = cql_to_where_clause(cql, COLUMNS, inline=True)
    written_in = con.execute(f"SELECT id FROM t WHERE {inline} ORDER BY id").fetchall()
    return [r[0] for r in written_in], [r[0] for r in with_params]


@pytest.mark.parametrize(
    "cql, ids",
    [
        ({"op": "in", "args": [{"property": "name"}, ["what?", "x"]]}, [1, 2]),
        ({"op": "in", "args": [{"property": "name"}, ["a ? b", "it's"]]}, [3, 4]),
        (
            {
                "op": "or",
                "args": [
                    {"op": "=", "args": [{"property": "name"}, "what?"]},
                    {"op": "like", "args": [{"property": "name"}, "%?%"]},
                ],
            },
            [1, 4],
        ),
    ],
)
def test_values_with_question_marks_keep_their_rows(
    con: duckdb.DuckDBPyConnection, cql: dict, ids: list[int]
) -> None:
    written_in, with_params = _kept(con, cql)
    assert with_params == ids
    assert written_in == ids


def test_a_question_mark_in_a_quoted_name_is_no_placeholder() -> None:
    assert (
        inline_params('"a?b" = ? AND "c" = ?', ["x?", 2])
        == '"a?b" = \'x?\' AND "c" = 2'
    )
