"""A regenerated PMTiles file is served fresh, not from the Redis tile cache.

Tiles were cached under ``tile:{layer_id}:{z}/{x}/{y}`` for an hour, and
only feature edits cleared that. A workflow re-run with "Overwrite on re-run"
(or a layer refresh from its source) regenerates the PMTiles file under the
same layer id, so every tile someone had already looked at came back old for
up to an hour, which looked exactly like the overwrite had not happened.
"""

import asyncio
import os
import threading
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from geoapi.services.tile_service import TileService


class _FakeRedis:
    """The slice of redis-py the tile cache uses: pipelined get/setex."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}

    def pipeline(self) -> "_FakePipeline":
        return _FakePipeline(self.store)


class _FakePipeline:
    def __init__(self, store: dict[str, bytes]) -> None:
        self.store = store
        self.ops: list[tuple[Any, ...]] = []

    def get(self, key: str) -> None:
        self.ops.append(("get", key))

    def setex(self, key: str, ttl: int, value: bytes | str) -> None:
        self.ops.append(("set", key, value))

    def execute(self) -> list[Any]:
        results: list[Any] = []
        for op in self.ops:
            if op[0] == "get":
                results.append(self.store.get(op[1]))
            else:
                value = op[2]
                self.store[op[1]] = (
                    value if isinstance(value, bytes) else value.encode()
                )
                results.append(True)
        return results


@pytest.mark.asyncio
async def test_regenerated_tiles_are_not_served_from_the_cache(tmp_path: Path) -> None:
    pmtiles = tmp_path / "t_abc.pmtiles"
    pmtiles.write_bytes(b"pmtiles")
    service = TileService()
    reads = AsyncMock(side_effect=[(b"old tile", True), (b"new tile", True)])

    with (
        patch.object(
            service, "_find_pmtiles_by_layer_id_async", AsyncMock(return_value=pmtiles)
        ),
        patch.object(service, "_get_tile_from_pmtiles_path", new=reads),
        patch("geoapi.tile_cache.get_redis_client", return_value=_FakeRedis()),
    ):
        first = await service.get_tile_from_pmtiles_by_layer_id("abc", 3, 4, 2)
        again = await service.get_tile_from_pmtiles_by_layer_id("abc", 3, 4, 2)

        later = pmtiles.stat().st_mtime_ns + 5_000_000_000
        os.utime(pmtiles, ns=(later, later))
        regenerated = await service.get_tile_from_pmtiles_by_layer_id("abc", 3, 4, 2)

    assert first == (b"old tile", True, "pmtiles")
    assert again == (b"old tile", True, "pmtiles-cached")
    assert regenerated == (b"new tile", True, "pmtiles")


def _service_over(tiles_dir: Path) -> TileService:
    service = TileService()
    service.tiles_data_dir = tiles_dir
    service.catalog_tiles_dir = tiles_dir / "catalog"
    return service


@pytest.mark.asyncio
async def test_tiles_regenerated_at_another_path_are_found_again(
    tmp_path: Path,
) -> None:
    """A cached path whose file is gone (deleted for regeneration, or written
    at another path since) must not lose the fast path for good: the lookup
    runs again and finds the flat ``t_x.pmtiles``."""
    stale = tmp_path / "user_abc" / "t_abc.pmtiles"
    service = _service_over(tmp_path)
    service._pmtiles_path_cache["abc"] = stale

    flat = tmp_path / "t_abc.pmtiles"
    flat.write_bytes(b"pmtiles")
    read_from: list[Path] = []

    async def read(path: Path, z: int, x: int, y: int) -> tuple[bytes, bool]:
        read_from.append(path)
        return (b"tile", True)

    with (
        patch.object(service, "_get_tile_from_pmtiles_path", new=read),
        patch("geoapi.tile_cache.get_redis_client", return_value=_FakeRedis()),
    ):
        result = await service.get_tile_from_pmtiles_by_layer_id("abc", 3, 4, 2)

    assert result == (b"tile", True, "pmtiles")
    assert read_from == [flat]


@pytest.mark.asyncio
async def test_label_tiles_follow_a_regenerated_anchor_file(tmp_path: Path) -> None:
    """Label tiles merge in the separate ``_anchor.pmtiles`` file, which is
    regenerated on its own (sync_pmtiles, catalog materialize)."""
    pmtiles = tmp_path / "t_abc.pmtiles"
    anchor = tmp_path / "t_abc_anchor.pmtiles"
    pmtiles.write_bytes(b"pmtiles")
    anchor.write_bytes(b"anchors")
    service = _service_over(tmp_path)
    merges = AsyncMock(side_effect=[(b"old labels", True), (b"new labels", True)])

    with (
        patch.object(
            service,
            "_get_tile_from_pmtiles_path",
            new=AsyncMock(return_value=(b"tile", True)),
        ),
        patch.object(service, "_merge_anchor_tile", new=merges),
        patch("geoapi.tile_cache.get_redis_client", return_value=_FakeRedis()),
    ):
        first = await service.get_tile_from_pmtiles_by_layer_id(
            "abc", 3, 4, 2, label=True
        )
        later = anchor.stat().st_mtime_ns + 5_000_000_000
        os.utime(anchor, ns=(later, later))
        regenerated = await service.get_tile_from_pmtiles_by_layer_id(
            "abc", 3, 4, 2, label=True
        )

    assert first == (b"old labels", True, "pmtiles")
    assert regenerated == (b"new labels", True, "pmtiles")


def test_lookup_by_layer_id_never_lists_the_tiles_directory(tmp_path: Path) -> None:
    """The tiles directory holds tens of thousands of files and is only ever
    probed by path: a schema-nested copy is not searched for, and listing the
    directory is not attempted at all."""
    nested = tmp_path / "user_abc" / "t_abc.pmtiles"
    nested.parent.mkdir()
    nested.write_bytes(b"pmtiles")
    service = _service_over(tmp_path)

    with patch.object(Path, "glob", side_effect=AssertionError("tiles dir listed")):
        assert service._find_pmtiles_by_layer_id("abc") is None

    flat = tmp_path / "t_abc.pmtiles"
    flat.write_bytes(b"pmtiles")
    assert service._find_pmtiles_by_layer_id("abc") == flat


@pytest.mark.asyncio
async def test_temp_tree_search_runs_once_off_the_event_loop(tmp_path: Path) -> None:
    """A layer without tiles is served dynamically, so every one of its tile
    requests asks for its PMTiles. Walking the workflow temp tree each time
    blocked the event loop on network storage until even the health check
    timed out: the walk runs in a worker thread, once per layer while its
    "not found" verdict lasts, however many requests arrive together."""
    (tmp_path / "temporary").mkdir()
    service = _service_over(tmp_path / "tiles")
    walks: list[str] = []
    real_glob = Path.glob

    def recording_glob(self: Path, pattern: str) -> Any:
        walks.append(threading.current_thread().name)
        return real_glob(self, pattern)

    with patch.object(Path, "glob", recording_glob):
        found = await asyncio.gather(
            *(
                service._find_pmtiles_by_layer_id_async("abc", search_temp=True)
                for _ in range(5)
            )
        )
        again = await service._find_pmtiles_by_layer_id_async("abc", search_temp=True)

    assert found == [None] * 5 and again is None
    assert len(walks) == 1
    assert walks[0] != threading.main_thread().name


@pytest.mark.asyncio
async def test_workflow_tiles_written_later_are_found_after_invalidation(
    tmp_path: Path,
) -> None:
    temp = tmp_path / "temporary" / "user_u" / "w_w" / "n_n"
    temp.mkdir(parents=True)
    service = _service_over(tmp_path / "tiles")
    assert (
        await service._find_pmtiles_by_layer_id_async("abc", search_temp=True) is None
    )

    tiles = temp / "t_abc.pmtiles"
    tiles.write_bytes(b"pmtiles")
    service.invalidate_pmtiles_path_cache("abc")

    assert (
        await service._find_pmtiles_by_layer_id_async("abc", search_temp=True) == tiles
    )


@pytest.mark.asyncio
async def test_a_layer_without_tiles_never_walks_the_temp_tree(tmp_path: Path) -> None:
    """The temp tree holds thousands of directories on NFS. A layer has its
    tiles at the flat path or none, so a layer lookup is stat() calls only;
    the tree is searched just for workflow results (`search_temp`)."""
    temp = tmp_path / "temporary" / "user_u" / "w_w" / "n_n"
    temp.mkdir(parents=True)
    (temp / "t_abc.pmtiles").write_bytes(b"pmtiles")
    service = _service_over(tmp_path / "tiles")

    with patch.object(Path, "glob", side_effect=AssertionError("temp tree walked")):
        assert await service._find_pmtiles_by_layer_id_async("abc") is None
