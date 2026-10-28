"""The one-off backfill of raster extents: COG layers created before core stored
their extent get the file's bounds, read the way the `bounds` route reads them.
Run twice, it writes nothing the second time."""

import asyncio
import dataclasses
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch
from uuid import UUID

import pytest
from goatlib.raster.source import RasterInfo, RasterUnavailableError

from geoapi.scripts import backfill_raster_extents as backfill
from geoapi.services import raster_service as rs

A = UUID("abc123de-f456-7890-1234-5678901234ab")
B = UUID("0000000f-0000-0000-0000-00000000000b")
INFO = RasterInfo(
    100,
    100,
    (13.53, 51.36, 15.17, 52.37),
    1,
    "uint8",
    None,
    (8,),
    None,
    (1.0,),
    (0.0,),
    ("b1",),
)


class FakeSource:
    def __init__(self, url: str, private_hosts: Any = ()) -> None:
        self.url = url

    def __enter__(self) -> "FakeSource":
        if "down" in self.url:
            raise RasterUnavailableError("down")
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    def info(self) -> RasterInfo:
        if "broken" in self.url:
            return dataclasses.replace(INFO, bounds=(1.0, 1.0, 0.0, 0.0))
        return INFO


class FakeDb:
    """customer.layer as the backfill sees it: rows by id with url and extent."""

    def __init__(self, rows: dict[UUID, str]) -> None:
        self.url = dict(rows)
        self.extent: dict[UUID, tuple[float, ...]] = {}
        self.updates: list[tuple[Any, ...]] = []

    async def execute(self, sql: str, *args: Any, fetch_one: bool = False) -> Any:
        flat = " ".join(sql.split())
        if flat.startswith("UPDATE"):
            self.updates.append((flat, *args))
            if "extent IS NULL" in flat and args[0] not in self.extent:
                self.extent[args[0]] = tuple(args[1:])
            return None
        if "extent IS NULL" in flat:
            return [
                {"id": i, "url": u} for i, u in self.url.items() if i not in self.extent
            ]
        # The raster routes' own lookup of one layer.
        layer_id = args[0]
        return {"url": self.url[layer_id], "updated": 1} if fetch_one else None


@pytest.fixture
def world() -> Iterator[FakeDb]:
    db = FakeDb({A: "https://cdn.example/a.tif"})
    rs.raster_service.clear()
    with (
        patch.object(rs, "RasterSource", FakeSource),
        patch.object(rs.layer_service, "_execute_with_retry", db.execute),
    ):
        yield db


def run(**kwargs: Any) -> backfill.Counts:
    return asyncio.run(backfill.backfill(**kwargs))


def test_a_cog_without_an_extent_gets_the_files_bounds(world: FakeDb) -> None:
    counts = run()
    assert counts == backfill.Counts(candidates=1, written=1)
    [(sql, layer_id, *bounds)] = world.updates
    assert "extent IS NULL" in sql and "4326" in sql and "updated_at" not in sql
    assert layer_id == A and bounds == [13.53, 51.36, 15.17, 52.37]


def test_a_second_run_writes_nothing(world: FakeDb) -> None:
    run()
    rs.raster_service.clear()
    assert run() == backfill.Counts()
    assert len(world.updates) == 1


def test_an_unreadable_file_is_counted_and_the_others_still_run(
    world: FakeDb,
) -> None:
    world.url = {B: "https://down.example/b.tif", A: "https://cdn.example/a.tif"}
    counts = run()
    assert counts == backfill.Counts(candidates=2, written=1, failed=1)
    assert [u[1] for u in world.updates] == [A]


def test_bounds_that_are_no_box_on_earth_are_skipped(world: FakeDb) -> None:
    world.url = {B: "https://cdn.example/broken.tif"}
    assert run() == backfill.Counts(candidates=1, skipped=1)
    assert world.updates == []


def test_a_dry_run_reads_but_writes_nothing(world: FakeDb) -> None:
    assert run(dry_run=True) == backfill.Counts(candidates=1, written=1)
    assert world.updates == []
