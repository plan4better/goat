"""A relative day in a filter, `daysAgo(n)` (`{"op": "daysAgo", "args": [n]}`):
"in the last n days" counts back from the day the filter is read, not from
the day it was saved.

`normalize` turns the call into the start (UTC) of the day n days before
today, so every service that reads a filter (tiles, counts, the table, tools,
exports) gets the date it means today.
"""

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any

import duckdb
import pytest
from goatlib.filter.normalize import normalize
from goatlib.filter.validate import validate
from goatlib.storage import build_cql_filter
from goatlib.style.context import DataContext, FieldInfo

pytestmark = pytest.mark.unit

SEEN = {"property": "seen"}
BUILT = {"property": "built"}
MONDAY = datetime(2026, 3, 2, 15, 30, tzinfo=UTC)


def last(days: Any, prop: dict[str, str] = SEEN) -> dict[str, Any]:
    return {"op": ">=", "args": [prop, {"op": "daysAgo", "args": [days]}]}


def test_a_relative_day_is_the_start_of_that_day() -> None:
    assert normalize(last(7), now=MONDAY) == {
        "op": ">=",
        "args": [SEEN, {"timestamp": "2026-02-23T00:00:00Z"}],
    }


def test_the_day_moves_on_with_today() -> None:
    tuesday = MONDAY + timedelta(days=1)
    assert normalize(last(7), now=tuesday)["args"][1] == {
        "timestamp": "2026-02-24T00:00:00Z"
    }
    # Without a moment, today counts.
    today = datetime.now(UTC).date() - timedelta(days=7)
    assert normalize(last(7))["args"][1] == {"timestamp": f"{today}T00:00:00Z"}


def test_the_day_is_the_day_in_utc() -> None:
    late = datetime.fromisoformat("2026-03-02T23:30:00-05:00")  # 3 March in UTC
    assert normalize(last(1), now=late)["args"][1] == {
        "timestamp": "2026-03-02T00:00:00Z"
    }


def test_a_relative_day_is_resolved_wherever_it_stands() -> None:
    cql = {
        "op": "and",
        "args": [
            {"op": "=", "args": [{"property": "kind"}, "school"]},
            {
                "op": "or",
                "args": [
                    {"op": "<", "args": [BUILT, {"op": "daysAgo", "args": [30]}]},
                    {"op": "isNull", "args": [BUILT]},
                ],
            },
        ],
    }
    out = normalize(cql, now=MONDAY)
    assert out["args"][1]["args"][0]["args"][1] == {"timestamp": "2026-01-31T00:00:00Z"}
    # The input is not changed.
    assert cql["args"][1]["args"][0]["args"][1] == {"op": "daysAgo", "args": [30]}


@pytest.mark.parametrize("days", [0, -3, 1.5, True, "7", None, 10**9], ids=repr)
def test_a_relative_day_that_is_no_whole_number_of_days_stays_and_is_malformed(
    days: Any,
) -> None:
    cql = last(days)
    assert normalize(cql, now=MONDAY) == cql
    issues = validate(cql)
    assert [i.code for i in issues] == ["malformed"]
    assert "compares with" in issues[0].message
    assert not translates(cql)


@pytest.mark.parametrize(
    "call",
    [
        {"op": "daysAgo", "args": [7, 1]},
        {"op": "daysAgo", "args": []},
        {"op": "daysAgo", "args": 7},
        {"op": "daysAgo", "args": [7], "unit": "weeks"},
    ],
    ids=["two-args", "no-args", "bare-arg", "more-keys"],
)
def test_another_call_of_daysago_is_no_relative_day(call: dict[str, Any]) -> None:
    cql = {"op": ">=", "args": [SEEN, call]}
    assert normalize(cql, now=MONDAY) == cql
    assert [i.code for i in validate(cql)] == ["malformed"]
    assert not translates(cql)


def test_a_relative_day_in_place_of_the_field_is_no_filter() -> None:
    cql = {"op": ">=", "args": [{"op": "daysAgo", "args": [7]}, SEEN]}
    assert [i.code for i in validate(cql)] == ["malformed"]


def translates(cql: dict[str, Any]) -> bool:
    """Whether the query builder makes a clause of the filter."""
    built = build_cql_filter({"filter": json.dumps(cql)}, ["seen", "built"])
    return bool(built.clauses)


@pytest.mark.parametrize("field_type", ["date", "datetime"])
def test_the_checker_takes_a_relative_day_on_a_date_field(field_type: str) -> None:
    ctx = DataContext(
        kind="vector", fields={"seen": FieldInfo(name="seen", type=field_type)}
    )
    not_in_the_last = {
        "op": "or",
        "args": [
            {"op": "<", "args": [SEEN, {"op": "daysAgo", "args": [30]}]},
            {"op": "isNull", "args": [SEEN]},
        ],
    }
    assert validate(last(7), ctx) == []
    assert validate(not_in_the_last, ctx) == []


def test_the_checker_names_a_relative_day_on_a_number_field() -> None:
    ctx = DataContext(kind="vector", fields={"seen": FieldInfo("seen", "integer")})
    assert [i.code for i in validate(last(7), ctx)] == ["field_type_mismatch"]


@pytest.mark.parametrize("moment", ["TIMESTAMP", "TIMESTAMPTZ"])
@pytest.mark.parametrize("zone", ["UTC", "Europe/Berlin"])
def test_the_query_keeps_the_rows_of_the_last_days_counted_from_today(
    moment: str, zone: str
) -> None:
    """A date field holds days, a timestamp field moments: both keep today and
    the n days before it, whatever the connection's time zone."""
    today = datetime.now(UTC).date()
    con = duckdb.connect()
    con.execute(f"SET TimeZone = '{zone}'")
    con.execute(f"CREATE TABLE t (id INTEGER, built DATE, seen {moment})")

    def day(n: int) -> date:
        return today - timedelta(days=n)

    def at(n: int, hour: int, minute: int = 0) -> datetime:
        instant = datetime(*day(n).timetuple()[:3], hour, minute, tzinfo=UTC)
        return instant if moment == "TIMESTAMPTZ" else instant.replace(tzinfo=None)

    rows = [
        (1, day(0), at(0, 8)),
        (2, day(7), at(7, 0)),
        (3, day(8), at(8, 23, 59)),
        (4, None, None),
    ]
    con.executemany("INSERT INTO t VALUES (?, ?, ?)", rows)

    def kept(cql: dict[str, Any]) -> list[int]:
        f = build_cql_filter(
            {"filter": json.dumps(cql), "lang": "cql2-json"}, ["id", "built", "seen"]
        )
        assert f.clauses, f"the filter was dropped: {cql}"
        sql = f"SELECT id FROM t WHERE {' AND '.join(f.clauses)} ORDER BY id"
        return [r[0] for r in con.execute(sql, f.params).fetchall()]

    def not_in_the_last(prop: dict[str, str]) -> dict[str, Any]:
        return {
            "op": "or",
            "args": [
                {"op": "<", "args": [prop, {"op": "daysAgo", "args": [7]}]},
                {"op": "isNull", "args": [prop]},
            ],
        }

    assert kept(last(7, BUILT)) == [1, 2]
    assert kept(last(7, SEEN)) == [1, 2]
    assert kept(not_in_the_last(BUILT)) == [3, 4]
    assert kept(not_in_the_last(SEEN)) == [3, 4]
