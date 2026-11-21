"""A filter with a relative day (`daysAgo(n)`, "in the last n days") counts
back from the day of the request.

The tile caches, the prepared filters of the stored tiles and the ETags all
key on the filter text `cql_filter_query` passes on. It passes on the filter
with the day resolved, so a filter sent the same way on two days is two
filters, and on one day one.
"""

import asyncio
import functools
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from goatlib.filter.normalize import normalize

from geoapi import dependencies
from geoapi.dependencies import cql_filter_query
from geoapi.services.tile_filter import translate

SEEN = {"property": "ts"}
LAST_7 = {"op": ">=", "args": [SEEN, {"op": "daysAgo", "args": [7]}]}
MONDAY = datetime(2026, 3, 2, 15, 30, tzinfo=UTC)


def query(cql: Any) -> dict[str, Any] | None:
    return asyncio.run(cql_filter_query(filter=json.dumps(cql), filter_lang=None))


def on(day: datetime, monkeypatch: pytest.MonkeyPatch) -> None:
    """The request comes on `day`."""
    monkeypatch.setattr(
        dependencies, "normalize", functools.partial(normalize, now=day)
    )


def test_the_filter_is_passed_on_with_the_day_resolved() -> None:
    passed = query(LAST_7)
    assert passed is not None
    since = (datetime.now(UTC).date() - timedelta(days=7)).isoformat()
    assert "daysAgo" not in passed["filter"]
    assert json.loads(passed["filter"]) == {
        "op": ">=",
        "args": [SEEN, {"timestamp": f"{since}T00:00:00Z"}],
    }


def test_the_same_filter_on_two_days_is_two_filters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    on(MONDAY, monkeypatch)
    monday = query(LAST_7)
    on(MONDAY + timedelta(hours=8), monkeypatch)
    assert query(LAST_7) == monday
    on(MONDAY + timedelta(days=1), monkeypatch)
    tuesday = query(LAST_7)
    assert tuesday != monday
    assert json.loads(tuesday["filter"])["args"][1] == {
        "timestamp": "2026-02-24T00:00:00Z"
    }


def test_a_filter_without_a_relative_day_is_passed_on_as_sent() -> None:
    text = json.dumps({"op": "!=", "args": [{"property": "a"}, 1]})
    assert asyncio.run(cql_filter_query(filter=text, filter_lang=None)) == {
        "filter": text,
        "lang": "cql2-json",
    }


def test_a_relative_day_that_is_no_number_of_days_is_refused() -> None:
    with pytest.raises(Exception) as refused:
        query({"op": ">=", "args": [SEEN, {"op": "daysAgo", "args": ["soon"]}]})
    assert getattr(refused.value, "status_code", None) == 400


@pytest.mark.parametrize(
    ("column", "kind", "expected"),
    [
        ("day", "DATE", "2026-02-23"),
        ("ts", "TIMESTAMP", "2026-02-23T00:00:00"),
    ],
)
def test_a_relative_day_still_translates_to_the_stored_tiles(
    column: str, kind: str, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fast path: geoapi cuts the filtered tile from the stored tiles."""
    on(MONDAY, monkeypatch)
    cql = {"op": ">=", "args": [{"property": column}, {"op": "daysAgo", "args": [7]}]}
    passed = query(cql)
    columns = [{"name": column, "type": kind}, {"name": "geometry", "type": "GEOMETRY"}]
    translated = translate(passed, None, columns, {column})
    assert translated is not None
    assert translated.attributes == [">=", column, expected]
