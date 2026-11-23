"""Trip count and ÖV-Güteklassen read GTFS tables for one date: a bundle's, or
the default network's cut to the area (``tools/pt_network.py``).

A small feed in the tables' own layout: two stops in the area, one outside,
and a station outside the area whose platform is in it. A weekday service, a
Saturday one, one added for a single date, and a holiday removing the
weekday service.
"""

import json
from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.accessibility.trip_count import TripCountStationTool
from goatlib.analysis.schemas.base import PTTimeWindow
from goatlib.analysis.schemas.trip_count import TripCountStationParams
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
    "stop_times": """SELECT trip_id, stop_id, CAST(arrival_time AS INTERVAL) AS arrival_time
        FROM (VALUES
        ('T1', 'S1', '07:10:00'), ('T1', 'S2', '07:20:00'), ('T2', 'S1', '07:30:00'),
        ('T3', 'S3', '07:00:00'), ('T3', 'S1', '07:40:00'), ('T4', 'S2', '08:00:00')
    ) t(trip_id, stop_id, arrival_time)""",
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
    # The area's stops, and the station of one of them though it lies outside.
    assert _ids(cut["stops"], "stop_id") == {"S1", "S2", "P1"}
    # Tuesday's trips: the weekday ones and the one added for the date.
    assert _ids(cut["trips"], "trip_id") == {"T1", "T3", "T4"}
    # Only their stop times in the area: T3's call far away is left out.
    assert _ids(cut["stop_times"], "stop_id") == {"S1", "S2"}
    assert _ids(cut["routes"], "route_id") == {"R1", "R2"}
    assert _ids(cut["calendar_dates"], "service_id") == {"WK", "ONCE"}


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
