"""Trip count and ÖV-Güteklassen read GTFS tables for one date: a bundle's, or
the default network's cut to the area (``tools/pt_network.py``).

A small feed in the tables' own layout: two stops in the area, one outside,
and a station outside the area whose platform is in it. A weekday service, a
Saturday one, one added for a single date, and a holiday removing the
weekday service.
"""

import json
import shutil
import zipfile
from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.accessibility import (
    OevGueteklasseParams,
    OevGueteklasseStationConfig,
    OevGueteklasseTool,
)
from goatlib.analysis.accessibility.trip_count import TripCountStationTool
from goatlib.analysis.schemas.base import PTTimeWindow
from goatlib.analysis.schemas.trip_count import TripCountStationParams
from goatlib.bundles.importers.pt_network import store
from goatlib.tools import pt_network
from goatlib.tools.pt_network import cut_network_tables, gtfs_tables_for_count

TUESDAY, HOLIDAY, SATURDAY = "2026-11-24", "2026-11-25", "2026-11-28"

TABLES = {
    "stops": """SELECT * FROM (VALUES
        ('S1', 'Platform 1', 48.10, 11.10, 0, 'P1'),
        ('S2', 'Corner', 48.10, 11.12, 0, NULL),
        ('S3', 'Far away', 50.00, 13.00, 0, NULL),
        ('P1', 'Station', 48.30, 11.20, 1, NULL)
    ) t(stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)""",
    "routes": """SELECT * FROM (VALUES ('R1', 3), ('R2', 2)) t(route_id, route_type)""",
    "trips": """SELECT * FROM (VALUES
        ('T1', 'R1', 'WK'), ('T2', 'R1', 'SA'), ('T3', 'R2', 'WK'), ('T4', 'R2', 'ONCE')
    ) t(trip_id, route_id, service_id)""",
    "stop_times": """SELECT trip_id, stop_id, CAST(arrival_time AS INTERVAL) AS arrival_time,
            stop_sequence
        FROM (VALUES
        ('T1', 'S1', '07:10:00', 1), ('T1', 'S2', '07:20:00', 2),
        ('T2', 'S1', '07:30:00', 1), ('T3', 'S3', '07:00:00', 1),
        ('T3', 'S1', '07:40:00', 2), ('T4', 'S2', '08:00:00', 1)
    ) t(trip_id, stop_id, arrival_time, stop_sequence)""",
    "calendar": """SELECT * FROM (VALUES
        ('WK', 1, 1, 1, 1, 1, 0, 0, DATE '2026-01-01', DATE '2026-12-31'),
        ('SA', 0, 0, 0, 0, 0, 1, 0, DATE '2026-01-01', DATE '2026-12-31')
    ) t(service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
        start_date, end_date)""",
    "calendar_dates": """SELECT * FROM (VALUES
        ('ONCE', DATE '2026-11-24', 1), ('WK', DATE '2026-11-25', 2)
    ) t(service_id, date, exception_type)""",
}


@pytest.fixture(scope="module")
def tables(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The feed as a network's tables: a parquet per table and info.json."""
    out = tmp_path_factory.mktemp("gtfs_tables")
    con = duckdb.connect()
    for role, query in TABLES.items():
        con.execute(f"COPY ({query}) TO '{out / role}.parquet' (FORMAT PARQUET)")
    (out / "info.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "tables": [
                    {
                        "role": r,
                        "name": r,
                        "layer_type": "table",
                        "geometry_type": None,
                        "file": f"{r}.parquet",
                        "rows": 0,
                    }
                    for r in TABLES
                ],
            }
        )
    )
    return out


@pytest.fixture(scope="module")
def area(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("area") / "area.parquet"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "COPY (SELECT ST_GeomFromText('POLYGON((11 48, 11.2 48, 11.2 48.2, 11 48.2, "
        f"11 48))') AS geometry) TO '{path}' (FORMAT PARQUET)"
    )
    return path


def _ids(path: str, column: str) -> set:
    return {
        r[0]
        for r in duckdb.connect().execute(f"SELECT {column} FROM '{path}'").fetchall()
    }


def _columns(path: str) -> list:
    return [
        r[0]
        for r in duckdb.connect().execute(f"DESCRIBE SELECT * FROM '{path}'").fetchall()
    ]


def _count(paths: dict, area: Path, day: str, kind: str, out: Path) -> dict:
    """Departures 07:00-09:00 per stop, from tables named by role."""
    TripCountStationTool().run(
        TripCountStationParams(
            reference_area_path=str(area),
            stops_path=paths["stops"],
            stop_times_path=paths["stop_times"],
            trips_path=paths["trips"],
            routes_path=paths["routes"],
            calendar_path=paths.get("calendar"),
            calendar_dates_path=paths.get("calendar_dates"),
            service_date=day,
            time_window=PTTimeWindow(weekday=kind, from_time=25200, to_time=32400),
            output_path=str(out),
        )
    )
    if not out.exists():
        return {}
    rows = duckdb.connect().execute(f"SELECT stop_id, total FROM '{out}'").fetchall()
    return dict(rows)


def test_the_cut_keeps_what_a_count_in_the_area_on_the_date_reads(
    tables: Path, area: Path, tmp_path: Path
) -> None:
    cut = cut_network_tables(tables, area, TUESDAY, tmp_path)
    # The area's stops, the station of one of them though it lies outside, and
    # the stop T3 calls at just before the area.
    assert _ids(cut["stops"], "stop_id") == {"S1", "S2", "P1", "S3"}
    # Tuesday's trips: the weekday ones and the one added for the date.
    assert _ids(cut["trips"], "trip_id") == {"T1", "T3", "T4"}
    # Their stop times in the area, and the calls either side of one: T3's
    # call far away is the stop before its call in the area.
    assert _ids(cut["stop_times"], "stop_id") == {"S1", "S2", "S3"}
    assert "stop_sequence" in _columns(cut["stop_times"])
    assert _ids(cut["routes"], "route_id") == {"R1", "R2"}
    assert _ids(cut["calendar_dates"], "service_id") == {"WK", "ONCE"}


def test_tables_without_stop_sequence_are_told_to_update(
    tables: Path, area: Path, tmp_path: Path
) -> None:
    """Stop times without stop_sequence: refused with what to do, not a failure
    inside SQL."""
    old = tmp_path / "old_tables"
    shutil.copytree(tables, old)
    path = old / "stop_times.parquet"
    duckdb.connect().execute(
        f"COPY (SELECT * EXCLUDE (stop_sequence) FROM read_parquet('{path}')) "
        f"TO '{old / 'tmp.parquet'}' (FORMAT PARQUET)"
    )
    (old / "tmp.parquet").replace(path)
    with pytest.raises(ValueError, match=r"stop_sequence.*sync_base_data"):
        cut_network_tables(old, area, TUESDAY, tmp_path / "cut")


def test_a_date_the_feed_removes_keeps_no_trip(
    tables: Path, area: Path, tmp_path: Path
) -> None:
    cut = cut_network_tables(tables, area, HOLIDAY, tmp_path)
    assert _ids(cut["trips"], "trip_id") == set()


def test_a_count_from_the_cut_is_the_count_from_the_whole_tables(
    tables: Path, area: Path, tmp_path: Path
) -> None:
    whole = {role: str(tables / f"{role}.parquet") for role in TABLES}
    cut = cut_network_tables(tables, area, TUESDAY, tmp_path / "cut")
    expected = _count(whole, area, TUESDAY, "weekday", tmp_path / "whole.parquet")
    assert expected == {"S1": 2, "S2": 2}
    assert _count(cut, area, TUESDAY, "weekday", tmp_path / "cut.parquet") == expected


def test_the_date_decides_whatever_kind_of_day_the_window_names(
    tables: Path, area: Path, tmp_path: Path
) -> None:
    whole = {role: str(tables / f"{role}.parquet") for role in TABLES}
    # The tools send the window's kind of day from a field a picked date
    # hides: a Saturday is counted as Saturday whatever it says.
    for kind in ("weekday", "saturday", "sunday"):
        assert _count(whole, area, SATURDAY, kind, tmp_path / f"{kind}.parquet") == {
            "S1": 1
        }


def test_the_default_network_is_counted_on_the_anchor_of_the_kind_of_day(
    tables: Path, area: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        pt_network, "fetch_gtfs_tables", lambda *a: pytest.fail("not a bundle")
    )
    timetable = tmp_path / "pt_network" / "gtfs.bin"
    timetable.parent.mkdir()
    (timetable.parent / "gtfs_tables").symlink_to(tables)
    paths, day = gtfs_tables_for_count(
        None,
        bundle_id=None,
        user_id="u",
        # A date picked for a bundle chosen before is not this network's.
        pt_date="2026-03-01",
        weekday="saturday",
        reference_area_path=area,
        pt_network_base_path=str(timetable),
        workdir=tmp_path / "work",
    )
    assert day == "2026-11-28"
    assert _ids(paths["trips"], "trip_id") == {"T2"}


def test_a_bundle_is_counted_from_its_own_tables_on_the_date_picked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        pt_network, "fetch_gtfs_tables", lambda source, bundle, user: {"stops": bundle}
    )
    paths, day = gtfs_tables_for_count(
        None,
        bundle_id="b1",
        user_id="u",
        pt_date=SATURDAY,
        weekday="weekday",
        reference_area_path="unused",
        pt_network_base_path="unused",
        workdir="unused",
    )
    assert (paths, day) == ({"stops": "b1"}, SATURDAY)
    with pytest.raises(ValueError):
        gtfs_tables_for_count(
            None,
            bundle_id="b1",
            user_id="u",
            pt_date=None,
            weekday="weekday",
            reference_area_path="unused",
            pt_network_base_path="unused",
            workdir="unused",
        )


# The area's edge. Lines in the area (lon 11.0-11.2, lat 48.0-48.2) whose
# trips come from or go on to stops outside it, each running every 10 minutes
# each way it runs: ÖV-Güteklassen reads a line's directions at a stop from
# the stops just before and just after each call, so every stop of each line
# reads 10 minutes, from the whole feed and from the cut alike.
EDGE_STOPS = {
    # name: (lon, lat); "+" marks a stop in the area
    # Line E1, both ways through M, whose stops either side are outside.
    "A": (10.95, 48.10),
    "M+": (11.10, 48.10),
    "B": (11.25, 48.10),
    # Line E2, both ways, E's next stop east outside.
    "C+": (11.05, 48.15),
    "E+": (11.19, 48.15),
    "F": (11.25, 48.15),
    # Line E3, one way only, H's next stop outside.
    "G+": (11.05, 48.05),
    "H+": (11.19, 48.05),
    "I": (11.25, 48.05),
    # Line E4 ends at K coming from outside, and starts there going back.
    "J": (10.95, 48.12),
    "K+": (11.02, 48.12),
    # Line E5 only ends at L, coming from outside.
    "LO": (10.95, 48.18),
    "L+": (11.02, 48.18),
    # Line E6, both ways through N, the stops either side of it outside and
    # untimed (no arrival time), the timed ones beyond.
    "W2": (10.90, 48.08),
    "W1": (10.95, 48.08),
    "N+": (11.10, 48.08),
    "U": (11.25, 48.08),
    "V": (11.30, 48.08),
    # Line E7, both ways through Q, the stops either side of it outside and
    # stations ("#"), which no vehicle stops at, the stops beyond them.
    "Y2": (10.90, 48.02),
    "Y1#": (10.95, 48.02),
    "Q+": (11.10, 48.02),
    "Z1#": (11.25, 48.02),
    "Z2": (11.30, 48.02),
    # Line E8, one way through S, three stops before it and two after.
    "O3": (10.80, 48.165),
    "O2": (10.88, 48.165),
    "O1": (10.95, 48.165),
    "S+": (11.10, 48.165),
    "O4": (11.25, 48.165),
    "O5": (11.32, 48.165),
    # Line E9, through TM one way after two stops sharing a stop_sequence
    # (T1A and T1B), the rule putting T1A first as the nearer to T0, the stop
    # before them; and back, its stop after TM, XB, across the street from
    # T1A. The way into TM comes from T1B, so the two do not cross: one
    # direction.
    "T0": (10.90, 48.04),
    "T1A": (10.95, 48.04),
    "T1B": (10.98, 48.12),
    "TM+": (11.10, 48.04),
    "T2": (11.30, 48.04),
    "T3": (11.30, 48.06),
    "XB": (10.9505, 48.0401),
}
#: Each line's ways, each as the stops its trips call at in order; "~" marks
#: an untimed call, "@n" a call's stop_sequence where it is not its place.
EDGE_LINES = {
    "E1": [["A", "M", "B"], ["B", "M", "A"]],
    "E2": [["C", "E", "F"], ["F", "E", "C"]],
    "E3": [["G", "H", "I"]],
    "E4": [["J", "K"], ["K", "J"]],
    "E5": [["LO", "L"]],
    "E6": [["W2", "~W1", "N", "~U", "V"], ["V", "~U", "N", "~W1", "W2"]],
    "E7": [["Y2", "Y1", "Q", "Z1", "Z2"], ["Z2", "Z1", "Q", "Y1", "Y2"]],
    "E8": [["O3", "O2", "O1", "S", "O4", "O5"]],
    "E9": [["T0", "T1A", "T1B@2", "TM", "T2"], ["T3", "TM", "XB", "T0"]],
}
EDGE_CONFIG = {
    "groups": {"3": "C"},
    "time_frequency": [5, 10, 20],
    "categories": [{"C": 1}, {"C": 2}, {"C": 3}],
    "classification": {"1": {300: "1"}, "2": {300: "2"}, "3": {300: "3"}},
}


def _edge_feed() -> dict:
    """The edge lines as GTFS files: 12 trips each way, calling at the first
    stop in the area at 07:05, 07:15, ... and every 3 minutes on."""
    stops = "\n".join(
        f"{name.rstrip('+#')},{name.rstrip('+#')},{lat},{lon},{int(name[-1] == '#')},"
        for name, (lon, lat) in EDGE_STOPS.items()
    )
    trips, stop_times = [], []
    for line, ways in EDGE_LINES.items():
        for w, calls in enumerate(ways):
            first = next(
                i
                for i, c in enumerate(calls)
                if c.lstrip("~").split("@")[0] + "+" in EDGE_STOPS
            )
            for k in range(12):
                trip = f"{line}_{w}_{k}"
                trips.append(f"{line},WK,{trip}")
                for i, call in enumerate(calls):
                    call, _, seq = call.partition("@")
                    t = 7 * 3600 + 300 + k * 600 + (i - first) * 180
                    clock = (
                        ""
                        if call.startswith("~")
                        else f"{t // 3600:02d}:{t // 60 % 60:02d}:00"
                    )
                    stop_times.append(
                        f"{trip},{clock},{clock},{call.lstrip('~')},{seq or i + 1}"
                    )
    return {
        "agency.txt": "agency_name,agency_url,agency_timezone\n"
        "Edge,https://edge.example,Europe/Berlin\n",
        "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
        + stops
        + "\n",
        "routes.txt": "route_id,route_short_name,route_type\n"
        + "".join(f"{line},{line},3\n" for line in EDGE_LINES),
        "trips.txt": "route_id,service_id,trip_id\n" + "\n".join(trips) + "\n",
        "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        + "\n".join(stop_times)
        + "\n",
        "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,"
        "saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\n",
    }


@pytest.fixture(scope="module")
def edge_tables(tmp_path_factory: pytest.TempPathFactory) -> dict:
    """The edge feed as the network's tables, indexed (``store.build_store``)
    and as schema 1 wrote them (no index): two ways the cut reads them."""
    work = tmp_path_factory.mktemp("edge")
    feed = work / "edge_gtfs.zip"
    with zipfile.ZipFile(feed, "w") as zf:
        for name, text in _edge_feed().items():
            zf.writestr(name, text)
    indexed = work / "indexed"
    store.build_store(str(feed), str(indexed))
    old = work / "schema1"
    shutil.copytree(indexed, old)
    info = json.loads((old / store.INFO_FILENAME).read_text())
    path = old / "stop_times.parquet"
    duckdb.connect().execute(
        f"COPY (SELECT * EXCLUDE ({store.LINE_NO}) FROM read_parquet('{path}')) "
        f"TO '{old / 'tmp.parquet'}' (FORMAT PARQUET)"
    )
    (old / "tmp.parquet").replace(path)
    # No shapes in the feed, so no shape numbers.
    for name in store.INDEX_FILES.values():
        (old / name).unlink(missing_ok=True)
    info.pop("index")
    (old / store.INFO_FILENAME).write_text(json.dumps({**info, "schema": 1}))
    return {"indexed": indexed, "schema1": old}


def _classes(paths: dict, area: Path, out: Path) -> dict:
    """Each station's minutes between services and its trips, ÖV-Güteklassen
    07:00-09:00."""
    OevGueteklasseTool().run(
        OevGueteklasseParams(
            reference_area_path=str(area),
            stops_path=paths["stops"],
            stop_times_path=paths["stop_times"],
            trips_path=paths["trips"],
            routes_path=paths["routes"],
            calendar_path=paths.get("calendar"),
            calendar_dates_path=paths.get("calendar_dates"),
            service_date=TUESDAY,
            time_window=PTTimeWindow(weekday="weekday", from_time=25200, to_time=32400),
            output_path=str(out / "classes.parquet"),
            stations_output_path=str(out / "stations.parquet"),
            station_config=OevGueteklasseStationConfig(**EDGE_CONFIG),
        )
    )
    rows = duckdb.connect().execute(
        f"SELECT stop_id, frequency_minutes, total_trips "
        f"FROM '{out / 'stations.parquet'}'"
    )
    return {stop: (minutes, trips) for stop, minutes, trips in rows.fetchall()}


@pytest.mark.parametrize("layout", ["indexed", "schema1"])
def test_the_cut_counts_directions_at_the_areas_edge_as_the_whole_feed(
    edge_tables: dict, area: Path, tmp_path: Path, layout: str
) -> None:
    # The whole tables, as a bundle's are counted.
    whole = {
        role: str(edge_tables["schema1"] / f"{role}.parquet")
        for role in ("stops", "stop_times", "trips", "routes", "calendar")
    }
    (tmp_path / "whole").mkdir()
    expected = _classes(whole, area, tmp_path / "whole")
    # Every stop of every line reads 10 minutes, its two directions or one.
    assert expected == {
        "M": (10.0, 24),
        "C": (10.0, 24),
        "E": (10.0, 24),
        "G": (10.0, 12),
        "H": (10.0, 12),
        "K": (10.0, 24),
        "L": (10.0, 12),
        "N": (10.0, 24),
        "Q": (10.0, 24),
        "S": (10.0, 12),
        # One direction at TM, 24 trips: 5 minutes.
        "TM": (5.0, 24),
    }
    cut = cut_network_tables(edge_tables[layout], area, TUESDAY, tmp_path / "cut")
    # Not whole trips: the calls in the area and those the rule reads around
    # them, two stop_sequences before and one after (E8: O2, O1, S, O4).
    kept = _ids(cut["stop_times"], "stop_id")
    assert {"O2", "O1", "S", "O4"} <= kept
    assert not {"O3", "O5"} & kept
    (tmp_path / "from_cut").mkdir()
    assert _classes(cut, area, tmp_path / "from_cut") == expected
    # And trip count, which reads the same tables, counts only the area's calls.
    assert _count(cut, area, TUESDAY, "weekday", tmp_path / "tc_cut.parquet") == (
        _count(whole, area, TUESDAY, "weekday", tmp_path / "tc_whole.parquet")
    )
