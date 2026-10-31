"""`ducklake_layer_fields` gives the workflow check a layer's fields, and
`recorded_feature_count` its feature count.

What it reads is cached per layer and last change, read off the event loop,
and left unknown (None) whenever it cannot be read. A feature count is the one
a catalog dataset's copy recorded, never counted.
"""

import threading
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi import HTTPException

from processes.services import workflow_checks
from processes.services.workflow_checks import (
    ducklake_layer_fields,
    recorded_feature_count,
)

LAYER = "11111111-1111-1111-1111-111111111111"
LONG_AGO = datetime(2026, 1, 1, tzinfo=timezone.utc)


@pytest.fixture
def lake(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """The layer table and DuckLake, replaced: each layer's last change, its
    columns, and every column read with the thread it ran on."""
    state: dict[str, Any] = {
        "changed": {LAYER: LONG_AGO},
        "columns": {LAYER: ["id", "name", "geom", "width", "h3_3"]},
        "reads": [],
    }

    async def last_change(layer_id: str) -> datetime | None:
        return state["changed"].get(layer_id)

    def column_names(layer_id: str) -> list[str]:
        state["reads"].append((layer_id, threading.get_ident()))
        if layer_id not in state["columns"]:
            raise HTTPException(status_code=404, detail="Layer not found")
        return list(state["columns"][layer_id])

    monkeypatch.setattr(workflow_checks, "_last_change", last_change)
    monkeypatch.setattr(workflow_checks.analytics_service, "column_names", column_names)
    workflow_checks._field_cache.clear()
    return state


async def test_the_fields_include_the_columns_every_layer_carries(
    lake: dict[str, Any],
) -> None:
    # A tool setting may name them (a join on geometry, an id field).
    assert await ducklake_layer_fields(LAYER) == ["id", "name", "geom", "width", "h3_3"]


async def test_the_columns_are_read_off_the_event_loop(lake: dict[str, Any]) -> None:
    await ducklake_layer_fields(LAYER)

    assert lake["reads"][0][1] != threading.get_ident()


async def test_a_layer_is_read_once_until_it_changes(lake: dict[str, Any]) -> None:
    await ducklake_layer_fields(LAYER)
    await ducklake_layer_fields(LAYER.replace("-", ""))
    assert len(lake["reads"]) == 1

    lake["changed"][LAYER] = datetime(2026, 2, 1, tzinfo=timezone.utc)
    lake["columns"][LAYER] = ["name", "width", "speed"]

    assert await ducklake_layer_fields(LAYER) == ["name", "width", "speed"]
    assert len(lake["reads"]) == 2


async def test_a_change_this_moment_is_not_cached_yet(lake: dict[str, Any]) -> None:
    lake["changed"][LAYER] = datetime.now(timezone.utc)

    await ducklake_layer_fields(LAYER)
    await ducklake_layer_fields(LAYER)

    assert len(lake["reads"]) == 2


async def test_what_cannot_be_read_is_unknown(lake: dict[str, Any]) -> None:
    gone = "22222222-2222-2222-2222-222222222222"
    no_table = "33333333-3333-3333-3333-333333333333"
    lake["changed"][no_table] = LONG_AGO

    assert await ducklake_layer_fields(gone) is None
    assert await ducklake_layer_fields(no_table) is None
    assert await ducklake_layer_fields("not-a-layer") is None
    assert [layer_id for layer_id, _ in lake["reads"]] == [no_table]


# -- feature counts -------------------------------------------------------------


class FakePool:
    """The query pool, answering every lookup with `value` (raising it when it
    is an exception) and remembering each query."""

    def __init__(self, value: Any) -> None:
        self.value = value
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    async def fetchval(self, sql: str, *args: Any) -> Any:
        self.queries.append((sql, args))
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


def use_pool(monkeypatch: pytest.MonkeyPatch, value: Any) -> FakePool:
    pool = FakePool(value)

    async def get_pool() -> FakePool:
        return pool

    monkeypatch.setattr(workflow_checks, "get_pool", get_pool)
    return pool


async def test_the_count_a_catalog_copy_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = use_pool(monkeypatch, "934847")

    assert await recorded_feature_count(LAYER.replace("-", "")) == 934847
    [(sql, args)] = pool.queries
    assert "catalog_materialize,feature_count" in sql
    assert "customer.layer" in sql
    assert args == (LAYER,)


@pytest.mark.parametrize("stored", [None, "", "many", "12.5", "-3"])
async def test_a_layer_without_a_recorded_count_has_none(
    monkeypatch: pytest.MonkeyPatch, stored: str | None
) -> None:
    use_pool(monkeypatch, stored)

    assert await recorded_feature_count(LAYER) is None


async def test_a_count_that_cannot_be_read_is_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = use_pool(monkeypatch, OSError("connection refused"))

    assert await recorded_feature_count(LAYER) is None
    assert await recorded_feature_count("not-a-layer") is None
    assert len(pool.queries) == 1
