"""Filtered tiles that DuckDB draws hold only a part of the dynamic-tile
threads and of the DuckDB connections.

A filter whose tiles DuckDB has to draw (an "outside" area, a layer without
stored tiles, H3 hexagons) can take seconds per tile, and a screen asks for
many at once. Holding every thread, they kept the tiles of every other layer
that DuckDB draws waiting behind them.
"""

import asyncio
import sys
import threading
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from geoapi.dependencies import LayerInfo
from geoapi.services.tile_service import TileService

# `geoapi.services.tile_service` resolves to the singleton instance, not the
# module. Go through sys.modules instead.
tile_service = sys.modules["geoapi.services.tile_service"]

INFO = LayerInfo(layer_id="a" * 32, schema_name="user_data", table_name="t_layer")
FILTER = {"filter": '{"op":"=","args":[{"property":"name"},"x"]}', "lang": "cql2-json"}


class Work:
    """Stands in for the DuckDB work: filtered work waits for `gate`."""

    def __init__(self) -> None:
        self.gate = threading.Event()
        self.lock = threading.Lock()
        self.started = 0
        self.running = 0
        self.peak = 0

    def _filtered(self) -> None:
        with self.lock:
            self.started += 1
            self.running += 1
            self.peak = max(self.peak, self.running)
        self.gate.wait(10)
        with self.lock:
            self.running -= 1

    def tile(self, **kwargs: Any) -> bytes:
        if not (kwargs.get("cql_filter") or kwargs.get("bbox")):
            return b"plain"
        self._filtered()
        return b"filtered"

    def query(self, sql: str, **kwargs: Any) -> tuple[bytes]:
        if '"name" = ?' in sql:
            self._filtered()
        return (b"hexagons",)

    async def settled(self, started: int) -> None:
        """Wait for `started` pieces of filtered work, and a moment more for
        any that should not have started."""
        for _ in range(200):
            if self.started >= started:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.1)


def _patched(work: Work, slots: int) -> Any:
    pool = MagicMock()
    pool.execute_with_retry.side_effect = work.query
    return (
        # A semaphore made here is bound to this test's loop; the module's own
        # would be bound to the first loop that made it wait.
        patch.object(
            tile_service, "_filtered_tile_slots", asyncio.Semaphore(slots), create=True
        ),
        patch.object(TileService, "_generate_dynamic_tile", side_effect=work.tile),
        patch.object(tile_service, "ducklake_pool", pool),
    )


def _filtered_tile(service: TileService) -> Any:
    return service.get_tile(INFO, 10, 1, 1, cql_filter=FILTER)


def _filtered_h3_tile(service: TileService) -> Any:
    return service.get_h3_tile(
        INFO, 10, 1, 1, "auto", "count", None, ["name", "geometry"], cql_filter=FILTER
    )


async def test_filtered_duckdb_tiles_leave_threads_to_the_others() -> None:
    work = Work()
    service = TileService()
    threads = tile_service._dynamic_tile_executor._max_workers
    slots, tiles, executor = _patched(work, 3)
    with slots, tiles, executor:
        filtered = [
            asyncio.ensure_future(make(service))
            for make in (_filtered_tile, _filtered_h3_tile) * (threads // 2)
        ]
        try:
            await work.settled(3)
            plain = await asyncio.wait_for(
                service.get_tile(INFO, 10, 1, 1, force_dynamic=True), 2
            )
            unfiltered_h3 = await asyncio.wait_for(
                service.get_h3_tile(
                    INFO, 10, 1, 1, "auto", "count", None, ["name", "geometry"]
                ),
                2,
            )
        finally:
            work.gate.set()
            done = await asyncio.gather(*filtered)

    assert plain == (b"plain", False, "geoparquet")
    assert unfiltered_h3 == b"hexagons"
    assert work.peak == 3
    assert done == [(b"filtered", False, "geoparquet"), b"hexagons"] * (threads // 2)


async def test_a_filtered_tile_keeps_its_slot_until_its_thread_is_done() -> None:
    """A request that timed out leaves its query running on its thread: the
    slot is the thread's, so the next filtered tile waits for that query."""
    work = Work()
    service = TileService()
    slots, tiles, executor = _patched(work, 1)
    with slots, tiles, executor:
        gave_up = asyncio.ensure_future(_filtered_tile(service))
        await work.settled(1)
        gave_up.cancel()
        following = asyncio.ensure_future(_filtered_tile(service))
        try:
            await work.settled(2)
            started_behind_the_running_query = work.started
        finally:
            work.gate.set()
            done = await following

    assert started_behind_the_running_query == 1
    assert done == (b"filtered", False, "geoparquet")
    assert work.started == 2


@pytest.mark.parametrize(("pool", "expected"), [(1, 1), (2, 1), (4, 3), (64, 7)])
def test_filtered_tiles_leave_a_connection_and_a_thread(
    pool: int, expected: int
) -> None:
    assert tile_service._dynamic_tile_executor._max_workers == 8
    with patch.object(tile_service.settings, "DUCKLAKE_POOL_SIZE", pool):
        assert tile_service._filtered_tile_concurrency() == expected
