"""A workflow keeps the rows the layer filter keeps for the same condition.

The filter panel stores a dataset step's conditions as rows (`{attribute,
expression, value}`, the web's `workflowFilter.ts`) and a layer's as CQL2
(`rows.ts`); the runner turns the rows into CQL2 (`convert_filter_to_cql`) for
the query builder the layer filter goes through. Each case is a condition the
panel offers for its field's type, with the rows the layer filter keeps for the
panel's CQL2 on the table below: a dataset step delivers those rows, an If
behind it judges them, and an If with that condition takes its True branch on
the table and its False branch on the other rows. The shared filter cases hold
the panel's CQL2 itself (`test_shared_case_keeps_the_layer_filters_rows`).
"""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import duckdb
import pytest
from goatlib.filter.normalize import normalize
from goatlib.storage import cql_to_where_clause
from goatlib.storage.query_builder import build_cql_filter
from goatlib.tools import workflow_runner
from goatlib.tools.if_node import _build_simple_condition_sql
from goatlib.utils.column_types import column_types, type_class

pytestmark = pytest.mark.unit

#: "In the last 7 days" counts back from here.
NOW = datetime(2024, 5, 20, 12, 0, tzinfo=UTC)
USER = "00000000-0000-0000-0000-000000000001"
LAYER = "90e3bcb2-d7ec-4abf-955d-50633ab4a101"
COLUMNS = ["id", "name", "kind", "pop", "area", "open", "built", "seen"]
ROWS = [
    (1, "Berlin", "school", 10, 1.5, True, "2024-05-01", "2024-05-01 00:00:00"),
    (2, "Hamburg", "park", 20, 2.5, False, "2024-05-02", "2024-05-01 10:30:00"),
    (3, None, None, None, None, None, None, None),
    (4, "", "", 30, 10, True, "2024-06-01", "2024-05-02 00:00:00"),
    (5, "Bremen", "school", 5, 5, False, "2024-04-30", "2024-04-30 23:59:59"),
    (6, "Bamberg", "kita", -3, -3.5, True, "2024-05-15", "2024-05-15 12:00:00"),
]

#: (field, operator, value, the layer filter's rows). A range's value is its
#: two bounds, as the panel stores them.
CASES: list[tuple[str, str, Any, list[int]]] = [
    ("name", "is", "Berlin", [1]),
    ("name", "is_not", "Berlin", [2, 3, 4, 5, 6]),
    ("name", "includes", ["Berlin", "Hamburg"], [1, 2]),
    ("name", "excludes", ["Berlin", "Hamburg"], [3, 4, 5, 6]),
    ("name", "contains_the_text", "berg", [6]),
    ("name", "does_not_contains_the_text", "berg", [1, 2, 3, 4, 5]),
    ("name", "starts_with", "B", [1, 5, 6]),
    ("name", "ends_with", "burg", [2]),
    ("name", "is_blank", None, [3, 4]),
    ("name", "is_not_blank", None, [1, 2, 5, 6]),
    ("pop", "is", 20, [2]),
    ("pop", "is_not", 20, [1, 3, 4, 5, 6]),
    ("pop", "includes", [10, 20], [1, 2]),
    ("pop", "excludes", [10, 20], [3, 4, 5, 6]),
    ("pop", "is_less_than", 10, [5, 6]),
    ("pop", "is_greater_than", 10, [2, 4]),
    ("pop", "is_at_most", 10, [1, 5, 6]),
    ("pop", "is_at_least", 10, [1, 2, 4]),
    ("pop", "is_between", [5, 20], [1, 2, 5]),
    ("pop", "is_between", [-5, 5], [5, 6]),
    ("pop", "is_not_between", [5, 20], [3, 4, 6]),
    ("pop", "is_not_between", [-5, 5], [1, 2, 3, 4]),
    ("pop", "is_blank", None, [3]),
    ("pop", "is_not_blank", None, [1, 2, 4, 5, 6]),
    ("area", "is", 2.5, [2]),
    ("area", "is_not", 2.5, [1, 3, 4, 5, 6]),
    ("area", "includes", [1.5, 5], [1, 5]),
    ("area", "excludes", [1.5, 5], [2, 3, 4, 6]),
    ("area", "is_less_than", 2.5, [1, 6]),
    ("area", "is_greater_than", 2.5, [4, 5]),
    ("area", "is_at_most", 2.5, [1, 2, 6]),
    ("area", "is_at_least", 2.5, [2, 4, 5]),
    ("area", "is_between", [1.5, 5], [1, 2, 5]),
    ("area", "is_between", [-5, 2], [1, 6]),
    ("area", "is_not_between", [1.5, 5], [3, 4, 6]),
    ("area", "is_blank", None, [3]),
    ("area", "is_not_blank", None, [1, 2, 4, 5, 6]),
    ("open", "is_true", None, [1, 4, 6]),
    ("open", "is_false", None, [2, 5]),
    ("open", "is_blank", None, [3]),
    ("open", "is_not_blank", None, [1, 2, 4, 5, 6]),
    ("built", "is_on", "2024-05-01", [1]),
    ("built", "is_not_on", "2024-05-01", [2, 3, 4, 5, 6]),
    ("built", "is_before", "2024-05-02", [1, 5]),
    ("built", "is_after", "2024-05-01", [2, 4, 6]),
    ("built", "is_between", ["2024-05-01", "2024-05-15"], [1, 2, 6]),
    ("built", "is_not_between", ["2024-05-01", "2024-05-15"], [3, 4, 5]),
    ("built", "in_the_last", 7, [4, 6]),
    ("built", "not_in_the_last", 7, [1, 2, 3, 5]),
    ("built", "is_blank", None, [3]),
    ("built", "is_not_blank", None, [1, 2, 4, 5, 6]),
    ("seen", "is_on", "2024-05-01", [1, 2]),
    ("seen", "is_not_on", "2024-05-01", [3, 4, 5, 6]),
    ("seen", "is_before", "2024-05-01", [5]),
    ("seen", "is_before", "2024-05-01T10:30:00Z", [1, 5]),
    ("seen", "is_after", "2024-05-01", [2, 4, 6]),
    ("seen", "is_after", "2024-05-01T10:30:00Z", [4, 6]),
    ("seen", "is_between", ["2024-05-01", "2024-05-02"], [1, 2, 4]),
    ("seen", "is_between", ["2024-05-01T05:00:00Z", "2024-05-02T00:00:00Z"], [2, 4]),
    ("seen", "is_not_between", ["2024-05-01", "2024-05-02"], [3, 5, 6]),
    ("seen", "in_the_last", 7, [6]),
    ("seen", "not_in_the_last", 7, [1, 2, 3, 4, 5]),
    ("seen", "is_blank", None, [3]),
    ("seen", "is_not_blank", None, [1, 2, 4, 5, 6]),
]
CASE_IDS = [f"{f}-{op}-{json.dumps(v)}" for f, op, v, _ in CASES]
#: A moment field as a timestamp with and without its zone.
MOMENTS = ["TIMESTAMP", "TIMESTAMPTZ"]


def table(moment: str, ids: list[int] | None = None) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    con.execute(
        "CREATE TABLE t (id INTEGER, name VARCHAR, kind VARCHAR, pop INTEGER, "
        f"area DOUBLE, open BOOLEAN, built DATE, seen {moment})"
    )
    rows = [r for r in ROWS if ids is None or r[0] in ids]
    if rows:
        con.executemany("INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return con


def field_types(moment: str) -> dict[str, str]:
    """The table's fields by type, as a run reads a layer's (`layer_field_types`)."""
    return {n: type_class(t) for n, t in column_types(table(moment), "t").items()}


def stored(rows: list[tuple[str, str, Any]], match: str = "and") -> dict[str, Any]:
    """The rows as the panel stores them on a dataset step (`rowExpression`)."""
    return {
        "op": match,
        "expressions": [
            {
                "id": f"r{i}",
                "type": "logical",
                "attribute": field,
                "expression": op,
                "value": "" if value is None else value,
            }
            for i, (field, op, value) in enumerate(rows)
        ],
    }


def as_typed(condition: dict[str, Any]) -> dict[str, Any]:
    """The rows as the If step's editor holds them: every value as typed text."""
    out = json.loads(json.dumps(condition))
    for row in out["expressions"]:
        v = row["value"]
        row["value"] = [str(x) for x in v] if isinstance(v, list) else str(v)
    return out


def kept(con: duckdb.DuckDBPyConnection, cql: dict[str, Any] | None) -> list[int]:
    """The rows a step reads with this filter (`export_layer_to_parquet`)."""
    if not cql:
        return [r[0] for r in con.execute("SELECT id FROM t ORDER BY id").fetchall()]
    f = build_cql_filter({"filter": json.dumps(cql), "lang": "cql2-json"}, COLUMNS)
    assert f.clauses, f"the filter was dropped: {cql}"
    sql = f"SELECT id FROM t WHERE {' AND '.join(f.clauses)} ORDER BY id"
    return [r[0] for r in con.execute(sql, f.params).fetchall()]


def step_filter(condition: dict[str, Any], moment: str) -> dict[str, Any] | None:
    """The CQL2 a run gives the steps behind a dataset step with this filter."""
    node = {
        "id": "n-data",
        "type": "dataset",
        "data": {"type": "dataset", "layerId": LAYER, "filter": condition},
    }
    with patch.object(
        workflow_runner, "layer_field_types", return_value=field_types(moment)
    ):
        nodes = workflow_runner.dataset_filters_as_cql([node], USER, now=NOW)
    return workflow_runner.dataset_filter_for_source(nodes[0], [], nodes)


def if_takes_true(
    condition: dict[str, Any], moment: str, ids: list[int] | None
) -> bool:
    """Whether an If with this condition takes its True branch on these rows."""
    sql = _build_simple_condition_sql(
        condition, COLUMNS, field_types=field_types(moment), now=NOW
    )
    assert sql, f"the condition was dropped: {condition}"
    row = table(moment, ids).execute(f"SELECT ({sql}) FROM t").fetchone()
    return bool(row and row[0])


@pytest.mark.parametrize("moment", MOMENTS)
@pytest.mark.parametrize("field, op, value, ids", CASES, ids=CASE_IDS)
def test_dataset_step_delivers_the_layer_filters_rows(
    field: str, op: str, value: Any, ids: list[int], moment: str
) -> None:
    cql = step_filter(stored([(field, op, value)]), moment)
    assert kept(table(moment), cql) == ids


@pytest.mark.parametrize("moment", MOMENTS)
@pytest.mark.parametrize("field, op, value, ids", CASES, ids=CASE_IDS)
def test_if_behind_a_dataset_step_judges_its_rows(
    field: str, op: str, value: Any, ids: list[int], moment: str
) -> None:
    cql = step_filter(stored([(field, op, value)]), moment)
    where = cql_to_where_clause(cql, COLUMNS, "geometry", inline=True)
    sql = f"SELECT id FROM t WHERE {where} ORDER BY id"
    assert [r[0] for r in table(moment).execute(sql).fetchall()] == ids


@pytest.mark.parametrize("typed", [False, True], ids=["values", "typed-text"])
@pytest.mark.parametrize("moment", MOMENTS)
@pytest.mark.parametrize("field, op, value, ids", CASES, ids=CASE_IDS)
def test_if_condition_takes_the_branch_the_rows_give(
    field: str, op: str, value: Any, ids: list[int], moment: str, typed: bool
) -> None:
    condition = stored([(field, op, value)])
    if typed:
        condition = as_typed(condition)
    others = [r[0] for r in ROWS if r[0] not in ids]
    assert if_takes_true(condition, moment, None) is bool(ids)
    assert if_takes_true(condition, moment, others) is False


def test_range_stored_as_text_before() -> None:
    """Older steps hold a number range as `low-high` text."""
    cql = step_filter(stored([("pop", "is_between", "5-20")]), "TIMESTAMP")
    assert kept(table("TIMESTAMP"), cql) == [1, 2, 5]


@pytest.mark.parametrize("value", [[5], [5, 10, 20], "5"])
def test_range_without_two_bounds_is_an_error(value: Any) -> None:
    """A range that is not two bounds fails the run's step, never filters by
    something else."""
    with pytest.raises(ValueError, match="two values"):
        workflow_runner.convert_filter_to_cql(stored([("pop", "is_between", value)]))


def test_in_the_last_counts_from_the_run() -> None:
    """A step stores the number of days; a run counts them back from the day
    it started, to the start of that day, as the layer filter's relative day
    counts them (`goatlib.filter.normalize.days_ago`)."""
    cql = workflow_runner.convert_filter_to_cql(
        stored([("seen", "in_the_last", 7), ("built", "in_the_last", 7)]),
        field_types={"seen": "datetime", "built": "date"},
        now=NOW,
    )
    assert cql == {
        "op": "and",
        "args": [
            {
                "op": ">=",
                "args": [{"property": "seen"}, {"timestamp": "2024-05-13T00:00:00Z"}],
            },
            {"op": ">=", "args": [{"property": "built"}, {"date": "2024-05-13"}]},
        ],
    }
    relative = {
        "op": ">=",
        "args": [{"property": "seen"}, {"op": "daysAgo", "args": [7]}],
    }
    assert workflow_runner.convert_filter_to_cql(
        stored([("seen", "in_the_last", 7)]), now=NOW
    ) == normalize(relative, NOW)


def test_text_is_empty_reads_the_layers_field_types_only_when_needed() -> None:
    """Only "is empty" and "is not empty" are written by the field's type (on
    text they also take the empty text, on other fields that would fail): for
    other rows a run does not read the layer's schema."""
    node = {
        "id": "n-data",
        "type": "dataset",
        "data": {
            "type": "dataset",
            "layerId": LAYER,
            "filter": stored([("built", "is_on", "2024-05-01")]),
        },
    }
    with patch.object(workflow_runner, "layer_field_types") as lookup:
        workflow_runner.dataset_filters_as_cql([node], USER, now=NOW)
    lookup.assert_not_called()


FIXTURE = Path(__file__).parents[1] / "filter" / "fixtures" / "filter_cases.json"
FIXTURE_FIELDS = {
    "name": "string",
    "kind": "string",
    "pop": "integer",
    "area": "number",
    "open": "boolean",
    "built": "date",
    "seen": "datetime",
}


def _plain_cases() -> list[dict[str, Any]]:
    """The shared cases the panel writes as they are (`stable`) from rows a
    dataset step stores: no custom row, no area."""
    out = []
    for case in json.loads(FIXTURE.read_text()):
        rows = case.get("rows")
        if (
            case.get("stable")
            and case["fields"] == FIXTURE_FIELDS
            and isinstance(rows, dict)
            and not rows.get("area")
            and all(isinstance(r, dict) for r in rows["rows"])
        ):
            out.append(case)
    return out


@pytest.mark.parametrize("moment", MOMENTS)
@pytest.mark.parametrize("case", _plain_cases(), ids=lambda c: c["name"])
def test_shared_case_keeps_the_layer_filters_rows(
    case: dict[str, Any], moment: str
) -> None:
    rows = case["rows"]
    condition = stored(
        [
            (
                r["field"],
                r["op"],
                [r["value"], r["value2"]] if "value2" in r else r.get("value"),
            )
            for r in rows["rows"]
        ],
        "or" if rows["match"] == "any" else "and",
    )
    con = table(moment)
    # A relative day of the layer filter read on the day of the run.
    layer_filter = normalize(case["cql"], NOW)
    assert kept(con, step_filter(condition, moment)) == kept(con, layer_filter)
