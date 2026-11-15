"""manby overzoom is spawned off the event loop by the subprocess module.

Spawned through the event loop (uvloop in production), the child ran the
at-fork hooks before exec; a hook that waited on a lock held by another thread
at fork time hung the child, and the loop, blocked waiting for that child's
exec, stopped serving every request until the pod was deleted.
"""

import asyncio
import gzip
import json
import math
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import manby
import pytest
from pmtiles.reader import MmapSource, all_tiles

from geoapi.services.tile_service import TileService

# `geoapi.services.tile_service` resolves to the singleton instance, not the
# module. Go through sys.modules instead.
tile_service = sys.modules["geoapi.services.tile_service"]


def _overzoom(service: TileService) -> Any:
    return service._overzoom_tile(gzip.compress(b"parent"), 3, 4, 2, 4, 8, 4, True)


@pytest.mark.asyncio
async def test_overzoom_spawns_in_a_worker_thread() -> None:
    spawned_on: list[str] = []

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        spawned_on.append(threading.current_thread().name)
        with open(args[3], "wb") as out:
            out.write(b"child tile")
        return subprocess.CompletedProcess(args, 0, b"", b"")

    with (
        patch("subprocess.run", side_effect=run),
        patch.object(
            asyncio,
            "create_subprocess_exec",
            side_effect=AssertionError("spawned by the event loop"),
        ),
    ):
        result = await _overzoom(TileService())

    assert result == b"child tile"
    assert spawned_on and spawned_on[0] != threading.main_thread().name


@pytest.mark.asyncio
async def test_overzoom_timeout_returns_no_tile() -> None:
    timeout = subprocess.TimeoutExpired("manby", 10.0)
    with patch("subprocess.run", side_effect=timeout):
        assert await _overzoom(TileService()) is None


@pytest.mark.asyncio
async def test_overzoom_failure_returns_no_tile() -> None:
    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(args, 112, b"", b"PBF decoding error")

    with patch("subprocess.run", side_effect=run):
        assert await _overzoom(TileService()) is None


@pytest.mark.asyncio
async def test_overzoom_without_features_returns_empty_bytes() -> None:
    # manby writes an empty file and exits 0 for a tile without features: not
    # an error, so not None
    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(args, 0, b"", b"")

    with patch("subprocess.run", side_effect=run):
        assert await _overzoom(TileService()) == b""


@pytest.mark.asyncio
@pytest.mark.parametrize("filter_path", [None, Path("/tmp/filter.json")])
async def test_overzoom_runs_manby_overzoom_at_detail_16(
    filter_path: Path | None,
) -> None:
    calls: list[list[str]] = []

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, b"", b"")

    with patch("subprocess.run", side_effect=run):
        await TileService()._run_overzoom(
            gzip.compress(b"parent"), (3, 4, 2), (4, 8, 4), True, filter_path
        )

    (argv,) = calls
    out_path, in_path = argv[3], argv[-3]
    expected = [manby.binary(), "overzoom", "-o", out_path, "-b", "5", "-d", "16"]
    if filter_path is not None:
        expected += ["--feature-filter-file", str(filter_path)]
    expected += [in_path, "3/4/2", "4/8/4"]
    assert argv == expected


@pytest.mark.asyncio
async def test_overzoom_hands_manby_the_uncompressed_parent() -> None:
    seen: list[bytes] = []

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        seen.append(Path(args[-3]).read_bytes())
        return subprocess.CompletedProcess(args, 0, b"", b"")

    service = TileService()
    with patch("subprocess.run", side_effect=run):
        await service._run_overzoom(
            gzip.compress(b"parent"), (3, 4, 2), (4, 8, 4), True
        )
        await service._run_overzoom(b"parent", (3, 4, 2), (4, 8, 4), False)

    assert seen == [b"parent", b"parent"]


@pytest.mark.asyncio
async def test_overzoom_runs_at_most_as_many_manby_as_slots() -> None:
    lock = threading.Lock()
    running = 0
    peak = 0

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        nonlocal running, peak
        with lock:
            running += 1
            peak = max(peak, running)
        time.sleep(0.05)
        with lock:
            running -= 1
        return subprocess.CompletedProcess(args, 0, b"", b"")

    service = TileService()
    # A semaphore made here is bound to this test's loop; the module's own
    # would be bound to the first loop that made it wait.
    with (
        patch.object(tile_service, "_manby_slots", asyncio.Semaphore(2)),
        patch("subprocess.run", side_effect=run),
    ):
        await asyncio.gather(
            *(
                service._run_overzoom(b"parent", (3, 4, 2), (4, 8, 4), False)
                for _ in range(8)
            )
        )

    assert peak == 2


@pytest.mark.parametrize(
    ("affinity", "cpu_max", "expected"),
    [
        (16, "200000 100000", 2),
        (16, "150000 100000", 2),
        (16, "max 100000", 16),
        (16, None, 16),
        (4, "800000 100000", 4),
        (16, "100000 100000", 2),
        (1, None, 2),
    ],
)
def test_manby_concurrency_follows_the_cpus_of_the_container(
    affinity: int, cpu_max: str | None, expected: int, tmp_path: Path
) -> None:
    cgroup = tmp_path / "cpu.max"
    if cpu_max is not None:
        cgroup.write_text(cpu_max + "\n")
    with (
        patch.object(tile_service, "CGROUP_CPU_MAX_FILE", cgroup),
        patch.object(tile_service.os, "sched_getaffinity", lambda _: range(affinity)),
    ):
        assert tile_service._manby_concurrency() == expected


@pytest.mark.parametrize(("quota", "expected"), [("300000", 3), ("-1", 16)])
def test_manby_concurrency_reads_a_cgroup_v1_quota(
    quota: str, expected: int, tmp_path: Path
) -> None:
    (tmp_path / "quota").write_text(quota + "\n")
    (tmp_path / "period").write_text("100000\n")
    with (
        patch.object(tile_service, "CGROUP_CPU_MAX_FILE", tmp_path / "no-cpu.max"),
        patch.object(tile_service, "CGROUP_CPU_V1_QUOTA_FILE", tmp_path / "quota"),
        patch.object(tile_service, "CGROUP_CPU_V1_PERIOD_FILE", tmp_path / "period"),
        patch.object(tile_service.os, "sched_getaffinity", lambda _: range(16)),
    ):
        assert tile_service._manby_concurrency() == expected


def _tile_of(lon: float, lat: float, z: int) -> tuple[int, int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return z, x, y


@pytest.fixture
def parent_tile(tmp_path: Path) -> tuple[tuple[int, int, int], bytes]:
    """A tile manby built from two named points, one in each of two children."""
    points = [("west", 7.45, 47.5), ("east", 7.65, 47.5)]
    source = tmp_path / "points.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": name},
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    }
                    for name, lon, lat in points
                ],
            }
        )
    )
    archive = tmp_path / "points.pmtiles"
    manby.tile(str(source), archive, "-z10", "-r1", layer="points")
    with open(archive, "rb") as f:
        (zxy, tile) = next(t for t in all_tiles(MmapSource(f)) if t[0][0] == 10)
    assert zxy == _tile_of(7.45, 47.5, 10) == _tile_of(7.65, 47.5, 10)
    return zxy, tile


@pytest.mark.asyncio
async def test_overzoom_cuts_a_child_from_a_tile_manby_built(
    parent_tile: tuple[tuple[int, int, int], bytes],
) -> None:
    parent, tile = parent_tile
    service = TileService()
    west = _tile_of(7.45, 47.5, 11)
    east = _tile_of(7.65, 47.5, 11)
    assert west != east

    # the stored tile is gzipped, as the PMTiles header says
    child = await service._run_overzoom(tile, parent, west, True)

    assert child is not None and child[:2] == b"\x1f\x8b"
    assert b"west" in gzip.decompress(child)
    assert b"east" not in gzip.decompress(child)
    child = await service._run_overzoom(tile, parent, east, True)
    assert child is not None
    assert b"east" in gzip.decompress(child)
    # nothing in the children to the north
    assert (
        await service._run_overzoom(tile, parent, (11, west[1], west[2] - 1), True)
        == b""
    )


@pytest.mark.asyncio
async def test_overzoom_applies_the_feature_filter_file(
    parent_tile: tuple[tuple[int, int, int], bytes], tmp_path: Path
) -> None:
    parent, tile = parent_tile
    service = TileService()
    west = _tile_of(7.45, 47.5, 11)
    matching = tmp_path / "matching.json"
    matching.write_text(json.dumps({"*": ["==", "name", "west"]}))
    other = tmp_path / "other.json"
    other.write_text(json.dumps({"*": ["==", "name", "east"]}))

    kept = await service._run_overzoom(tile, parent, west, True, matching)
    dropped = await service._run_overzoom(tile, parent, west, True, other)

    assert kept is not None and b"west" in gzip.decompress(kept)
    assert dropped == b""
