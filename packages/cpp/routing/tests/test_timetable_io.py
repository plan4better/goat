"""Reading a nigiri timetable (.bin) as a routing request does.

The routing loads its timetable by memory-mapping it (src/pt/timetable_io.h):
the file's pages are read as a search touches them, the pointers inside are
fixed up in a private copy, and the integrity hash is skipped (a version's
files are checked against their sha256 when installed). These tests build a
small timetable from a GTFS feed and read it back through ``timetable_info``,
which loads it the same way.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

try:
    import routing
except Exception as exc:  # pragma: no cover - import guard for local dev
    routing = None
    ROUTING_IMPORT_ERROR = exc
else:
    ROUTING_IMPORT_ERROR = None

if os.getenv("CI") and routing is None:
    pytest.fail(f"routing is not importable: {ROUTING_IMPORT_ERROR}", pytrace=False)

pytestmark = pytest.mark.skipif(
    routing is None,
    reason=f"routing module is not importable: {ROUTING_IMPORT_ERROR}",
)

# One line, A - B - C, twice a day on weekdays of January 2026.
FEED = {
    "agency.txt": (
        "agency_id,agency_name,agency_url,agency_timezone\n"
        "AG,Test Transit,https://example.org,Europe/Berlin\n"
    ),
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon\n"
        "A,Stop A,48.1370,11.5750\n"
        "B,Stop B,48.1400,11.5800\n"
        "C,Stop C,48.1450,11.5900\n"
    ),
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,AG,1,3\n",
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,"
        "start_date,end_date\n"
        "WD,1,1,1,1,1,0,0,20260101,20260131\n"
    ),
    "trips.txt": "route_id,service_id,trip_id\nR1,WD,T1\nR1,WD,T2\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T1,08:00:00,08:00:00,A,1\n"
        "T1,08:05:00,08:05:00,B,2\n"
        "T1,08:12:00,08:12:00,C,3\n"
        "T2,09:00:00,09:00:00,A,1\n"
        "T2,09:05:00,09:05:00,B,2\n"
        "T2,09:12:00,09:12:00,C,3\n"
    ),
}


@pytest.fixture(scope="module")
def timetable(tmp_path_factory: pytest.TempPathFactory) -> Path:
    feed = tmp_path_factory.mktemp("feed")
    for name, content in FEED.items():
        (feed / name).write_text(content)
    out = tmp_path_factory.mktemp("timetable") / "gtfs.bin"
    routing.build_timetable(str(feed), str(out), "2026-01-05", 14)
    return out


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_a_built_timetable_reads_back(timetable: Path) -> None:
    info = routing.timetable_info(str(timetable))
    assert info["n_sources"] == 1
    assert info["n_routes"] == 1
    assert info["n_trips"] == 2
    # The feed's three stops, plus the special stations nigiri adds.
    assert info["n_locations"] >= 3


def test_reading_leaves_the_file_unchanged(timetable: Path) -> None:
    # Loading rewrites the pointers in place: in a private copy of the
    # mapped pages, never in the file other requests read.
    before = _sha256(timetable)
    routing.timetable_info(str(timetable))
    assert _sha256(timetable) == before


def test_the_file_is_unmapped_once_read(timetable: Path) -> None:
    for _ in range(20):
        routing.timetable_info(str(timetable))
    maps = Path("/proc/self/maps").read_text()
    assert str(timetable) not in maps


def test_a_missing_timetable_names_the_file(tmp_path: Path) -> None:
    missing = tmp_path / "missing.bin"
    with pytest.raises(RuntimeError, match="cannot open timetable .*missing.bin"):
        routing.timetable_info(str(missing))


def test_an_empty_file_is_refused(tmp_path: Path) -> None:
    empty = tmp_path / "empty.bin"
    empty.write_bytes(b"")
    with pytest.raises(RuntimeError, match="cannot map timetable"):
        routing.timetable_info(str(empty))


def test_a_file_that_is_not_a_timetable_is_refused(tmp_path: Path) -> None:
    # The static version check stays on: a file nigiri did not write, or
    # wrote in another version, is refused rather than read.
    other = tmp_path / "other.bin"
    other.write_bytes(b"\x00" * 4096)
    with pytest.raises(RuntimeError):
        routing.timetable_info(str(other))
