"""Saving the Explorer's edits to a bundle: a change set applied to the mini
feed's tables (``tests/fixtures/explorer_mini_gtfs``; see the snapshot tests
for what it holds). The feed carries two problems of its own — U2 calls at a
stop that does not exist, Z1 runs on a route that does not — which no change
here is blamed for."""

import zipfile
from pathlib import Path
from typing import Any, Dict, List

import duckdb
import pytest
from goatlib.bundles.explorer.changeset import (
    ChangeSet,
    ChangeSetError,
    ChangeSetIntegrityError,
    apply_changeset,
)
from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter
from goatlib.bundles.importers.pt_network.stop_chains import stop_chain_id
from pydantic import ValidationError

FIXTURE = Path(__file__).parents[2] / "fixtures" / "explorer_mini_gtfs"


@pytest.fixture(scope="module")
def layers(tmp_path_factory: pytest.TempPathFactory) -> Dict[str, str]:
    root = tmp_path_factory.mktemp("changeset")
    archive = root / "mini_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(FIXTURE.iterdir()):
            zf.write(f, f.name)
    work = root / "work"
    work.mkdir()
    return {
        layer.role: layer.file_path
        for layer in GtfsImporter().extract_layers(str(archive), str(work))
    }


@pytest.fixture
def con(layers: Dict[str, str]) -> duckdb.DuckDBPyConnection:
    """The feed's member tables, each a plain table named for its role."""
    c = duckdb.connect()
    c.execute("INSTALL spatial; LOAD spatial")
    for role, path in layers.items():
        c.execute(f"CREATE TABLE {role} AS SELECT * FROM read_parquet('{path}')")
    return c


TABLES = {
    r: r
    for r in (
        "agency",
        "stops",
        "routes",
        "trips",
        "stop_times",
        "calendar",
        "calendar_dates",
        "frequencies",
        "shapes",
        "shape_lines",
    )
}


def apply(con: duckdb.DuckDBPyConnection, ops: List[Dict[str, Any]]) -> Any:
    return apply_changeset(con, TABLES, ChangeSet(ops=ops))


def one(con: duckdb.DuckDBPyConnection, sql: str) -> Any:
    return con.execute(sql).fetchone()


def line(con: duckdb.DuckDBPyConnection, shape_id: str) -> Any:
    row = one(
        con,
        f"SELECT ST_AsText(geometry) FROM shape_lines WHERE shape_id = '{shape_id}'",
    )
    return row[0] if row else None


def chain(stop_ids: List[str]) -> str:
    return stop_chain_id(stop_ids)


def test_a_stop_is_renamed(con: duckdb.DuckDBPyConnection) -> None:
    applied = apply(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S2"},
                "values": {"stop_name": "Second Street"},
            }
        ],
    )
    assert one(con, "SELECT stop_name FROM stops WHERE stop_id = 'S2'") == (
        "Second Street",
    )
    assert applied.rows == {"stops": {"inserted": 0, "updated": 1, "deleted": 0}}
    assert applied.warnings == []
    # Nothing left behind on the connection.
    assert one(con, "SELECT count(*) FROM duckdb_tables() WHERE temporary") == (0,)


def test_a_moved_stop_takes_its_geometry_and_redraws_the_lines_through_it(
    con: duckdb.DuckDBPyConnection,
) -> None:
    t3 = chain(["S5", "S4", "S3", "S2", "S1"])
    assert "13.42 52.5" in line(con, t3)
    apply(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S3"},
                "values": {"stop_lat": 52.51, "stop_lon": 13.425},
            }
        ],
    )
    assert one(con, "SELECT ST_AsText(geometry) FROM stops WHERE stop_id = 'S3'") == (
        "POINT (13.425 52.51)",
    )
    # T3 has no shape: its line runs through its stops, S3 now elsewhere.
    assert "13.425 52.51" in line(con, t3)
    # SH1 is drawn from its own points and does not move with a stop.
    assert "13.425" not in line(con, "SH1")


def test_a_new_stop_written_twice_is_one_insert(con: duckdb.DuckDBPyConnection) -> None:
    applied = apply(
        con,
        [
            {
                "role": "stops",
                "op": "insert",
                "key": {"stop_id": "N1"},
                "values": {
                    "stop_name": "New",
                    "stop_lat": "52.52",
                    "stop_lon": "13.43",
                    "location_type": 0,
                },
            },
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "N1"},
                "values": {"stop_name": "Newer"},
            },
        ],
    )
    assert applied.rows["stops"] == {"inserted": 1, "updated": 0, "deleted": 0}
    assert one(
        con, "SELECT stop_name, ST_AsText(geometry) FROM stops WHERE stop_id = 'N1'"
    ) == (
        "Newer",
        "POINT (13.43 52.52)",
    )


def test_an_optional_field_the_feed_left_out_gets_its_column(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # The mini feed has no wheelchair_boarding: a value adds the column, typed
    # as an import types it; an empty value for it is no value, not an error.
    cols = lambda: {r[0]: r[1] for r in con.execute("DESCRIBE stops").fetchall()}  # noqa: E731
    assert "wheelchair_boarding" not in cols()
    apply(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S3"},
                "values": {"stop_name": "Third", "wheelchair_boarding": None},
            }
        ],
    )
    assert "wheelchair_boarding" not in cols()
    apply(
        con,
        [
            {
                "role": "stops",
                "op": "insert",
                "key": {"stop_id": "goat_0000002a"},
                "values": {
                    "stop_name": "New",
                    "stop_lat": 52.51,
                    "stop_lon": 13.41,
                    "location_type": 0,
                    "wheelchair_boarding": 1,
                },
            }
        ],
    )
    assert cols()["wheelchair_boarding"] == "INTEGER"
    assert one(
        con,
        "SELECT wheelchair_boarding, ST_AsText(geometry) FROM stops "
        "WHERE stop_id = 'goat_0000002a'",
    ) == (1, "POINT (13.41 52.51)")


def test_a_stop_s_gtfs_fields_get_their_columns(con: duckdb.DuckDBPyConnection) -> None:
    # An entrance to the station, with what the Explorer lets a stop say.
    apply(
        con,
        [
            {
                "role": "stops",
                "op": "insert",
                "key": {"stop_id": "E1"},
                "values": {
                    "stop_name": "Main Station, north exit",
                    "stop_lat": 52.501,
                    "stop_lon": 13.4,
                    "location_type": 2,
                    "parent_station": "P",
                },
            },
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S1"},
                "values": {"platform_code": "1"},
            },
        ],
    )
    assert one(
        con,
        "SELECT location_type, parent_station FROM stops WHERE stop_id = 'E1'",
    ) == (2, "P")
    assert one(con, "SELECT platform_code FROM stops WHERE stop_id = 'S1'") == ("1",)


def refused(con: duckdb.DuckDBPyConnection, ops: List[Dict[str, Any]]) -> Any:
    """The problems a refused change set names, rolled back as geoapi does."""
    con.begin()
    with pytest.raises(ChangeSetIntegrityError) as caught:
        apply(con, ops)
    con.rollback()
    return {(n.code, dict(n.key)["stop_id"]) for n in caught.value.notices}


def test_an_entrance_needs_its_station(con: duckdb.DuckDBPyConnection) -> None:
    entrance = {
        "role": "stops",
        "op": "insert",
        "key": {"stop_id": "E1"},
        "values": {
            "stop_name": "Exit",
            "stop_lat": 52.5,
            "stop_lon": 13.4,
            "location_type": 2,
        },
    }
    assert refused(con, [entrance]) == {("location_without_parent_station", "E1")}
    # A stop is no station to hang it from.
    entrance["values"] = {**entrance["values"], "parent_station": "S2"}
    assert refused(con, [entrance]) == {("wrong_parent_location_type", "E1")}


def test_a_station_has_no_parent(con: duckdb.DuckDBPyConnection) -> None:
    assert refused(
        con,
        [
            {
                "role": "stops",
                "op": "insert",
                "key": {"stop_id": "P2"},
                "values": {
                    "stop_name": "Another station",
                    "stop_lat": 52.5,
                    "stop_lon": 13.4,
                    "location_type": 1,
                    "parent_station": "P",
                },
            }
        ],
    ) == {("station_with_parent_station", "P2")}


def test_a_station_made_a_stop_strands_its_platforms(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # S1 is P's platform: P no longer a station, S1's parent is the wrong kind.
    assert refused(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "P"},
                "values": {"location_type": 0},
            }
        ],
    ) == {("wrong_parent_location_type", "S1")}


def test_a_served_stop_stays_a_stop(con: duckdb.DuckDBPyConnection) -> None:
    assert refused(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S4"},
                "values": {"location_type": 1},
            }
        ],
    ) == {("location_with_unexpected_stop_time", "S4")}
    # An unserved one may become a station.
    apply(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "X"},
                "values": {"location_type": 1},
            }
        ],
    )
    assert one(con, "SELECT location_type FROM stops WHERE stop_id = 'X'") == (1,)


def test_a_station_deleted_leaves_its_platforms_on_their_own(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # The platform's station cleared, then the station gone (the Explorer
    # deletes a station's platforms with it, but keeps a stop found under a
    # deleted location this way). S1 keeps its stop times.
    apply(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S1"},
                "values": {"parent_station": None},
            },
            {"role": "stops", "op": "delete", "key": {"stop_id": "P"}},
        ],
    )
    assert one(con, "SELECT count(*) FROM stops WHERE stop_id = 'P'") == (0,)
    assert one(con, "SELECT parent_station FROM stops WHERE stop_id = 'S1'") == (None,)
    assert one(con, "SELECT count(*) > 0 FROM stop_times WHERE stop_id = 'S1'") == (
        True,
    )


def test_a_station_deleted_under_its_platform_is_refused(
    con: duckdb.DuckDBPyConnection,
) -> None:
    assert refused(
        con, [{"role": "stops", "op": "delete", "key": {"stop_id": "P"}}]
    ) == {("foreign_key_violation", "S1")}


def test_a_stop_deleted_takes_its_transfers_with_it(
    con: duckdb.DuckDBPyConnection,
) -> None:
    con.execute(
        "CREATE TABLE transfers AS SELECT * FROM (VALUES "
        "('X', 'S1', 2), ('S1', 'X', 2), ('S1', 'S2', 2)) v(from_stop_id, to_stop_id, transfer_type)"
    )
    applied = apply_changeset(
        con,
        {**TABLES, "transfers": "transfers"},
        ChangeSet(ops=[{"role": "stops", "op": "delete", "key": {"stop_id": "X"}}]),
    )
    assert con.execute("SELECT from_stop_id, to_stop_id FROM transfers").fetchall() == [
        ("S1", "S2")
    ]
    assert applied.rows["transfers"] == {"inserted": 0, "updated": 0, "deleted": 2}


def test_a_moved_stop_takes_the_paths_through_it_along(
    con: duckdb.DuckDBPyConnection,
) -> None:
    def shape(shape_id: str) -> List[Any]:
        return con.execute(
            "SELECT shape_pt_lon, shape_pt_lat FROM shapes WHERE shape_id = $s "
            "ORDER BY shape_pt_sequence",
            {"s": shape_id},
        ).fetchall()

    def dist(trip_id: str, seq: int) -> float:
        return one(
            con,
            f"SELECT shape_dist_traveled FROM stop_times "
            f"WHERE trip_id = '{trip_id}' AND stop_sequence = {seq}",
        )[0]

    sh1 = shape("SH1")
    s4 = dist("T1", 4)
    stretch = {"from": 0.3, "to": 0.6, "points": [[13.42, 52.502]]}
    applied = apply(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S3"},
                "values": {"stop_lat": 52.502, "stop_lon": 13.42},
            },
            {
                "role": "trips",
                "op": "update",
                "key": {"trip_id": "T4"},
                "values": {"shape_id": "SH1_goat1"},
            },
            {
                "role": "shapes",
                "op": "reshape",
                "key": {"shape_id": "SH1_goat1"},
                "source": "SH1",
                "through": "S3",
                "metres_per_unit": 1000,
                "stretches": [{"from": 0.3, "to": None, "points": [[13.42, 52.502]]}],
            },
            {
                "role": "shapes",
                "op": "reshape",
                "key": {"shape_id": "SH1"},
                "source": "SH1",
                "through": "S3",
                "metres_per_unit": 1000,
                "stretches": [stretch],
            },
        ],
    )
    # SH1 runs through S3's new place, its start and end where they were.
    new = shape("SH1")
    assert (13.42, 52.502) in new
    assert new[0] == sh1[0] and new[-1] == sh1[-1]
    # T4's copy ends there; both are drawn.
    assert shape("SH1_goat1")[-1] == (13.42, 52.502)
    assert line(con, "SH1_goat1") is not None
    assert "13.42 52.502" in line(con, "SH1")
    # T1's later stops moved on, in km, by as much as SH1 grew; S1 did not.
    assert dist("T1", 1) == 0
    assert dist("T1", 4) > s4
    assert applied.rows["shapes"]["updated"] == 2


def test_a_moved_stop_on_a_routed_stretch_lies_where_the_route_reaches_it(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """A stretch following the streets: the route runs on before and after
    the stop (``stop_point``), and the stop's distance is the route's there."""
    stop = (13.42, 52.502)
    old_s3 = one(
        con,
        "SELECT shape_dist_traveled FROM stop_times WHERE trip_id = 'T1' AND stop_id = 'S3'",
    )[0]
    applied = apply(
        con,
        [
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S3"},
                "values": {"stop_lat": stop[1], "stop_lon": stop[0]},
            },
            {
                "role": "shapes",
                "op": "reshape",
                "key": {"shape_id": "SH1"},
                "source": "SH1",
                "through": "S3",
                "metres_per_unit": 1000,
                "stretches": [
                    {
                        "from": 0.3,
                        "to": 0.6,
                        # The stop was where the stretch starts.
                        "at": 0.3,
                        "points": [[13.415, 52.501], list(stop), [13.425, 52.503]],
                        "stop_point": 1,
                    }
                ],
            },
        ],
    )
    from goatlib.bundles.explorer.changeset import _metres

    order = con.execute(
        "SELECT shape_pt_lon, shape_pt_lat FROM shapes "
        "WHERE shape_id = 'SH1' ORDER BY shape_pt_sequence"
    ).fetchall()
    # The route, in its order: the point before the stop, the stop, the one after.
    k = order.index(stop)
    assert order[k - 1] == (13.415, 52.501) and order[k + 1] == (13.425, 52.503)
    # The stop moved on by the route's length from the stretch's start (the
    # point before the route's first) to it, through the point before it (km).
    to_stop_km = (
        sum(_metres(order[n - 1], order[n]) for n in range(k - 1, k + 1)) / 1000
    )
    s3 = one(
        con,
        "SELECT shape_dist_traveled FROM stop_times WHERE trip_id = 'T1' AND stop_id = 'S3'",
    )[0]
    assert s3 == pytest.approx(old_s3 + to_stop_km, rel=1e-4)
    assert applied.rows["shapes"]["updated"] == 1


def test_a_stretch_names_a_stop_point_on_it() -> None:
    from goatlib.bundles.explorer.changeset import Stretch

    with pytest.raises(ValueError, match="stop_point"):
        Stretch.model_validate(
            {"from": 0.1, "to": 0.2, "points": [[1, 2]], "stop_point": 1}
        )


def test_a_row_inserted_then_deleted_leaves_no_trace(
    con: duckdb.DuckDBPyConnection,
) -> None:
    before = one(con, "SELECT count(*) FROM stops")
    applied = apply(
        con,
        [
            {
                "role": "stops",
                "op": "insert",
                "key": {"stop_id": "N1"},
                "values": {"stop_name": "New", "stop_lat": 52.5, "stop_lon": 13.4},
            },
            {"role": "stops", "op": "delete", "key": {"stop_id": "N1"}},
        ],
    )
    assert one(con, "SELECT count(*) FROM stops") == before
    assert applied.rows == {}


def test_a_trip_goes_with_its_stop_times(con: duckdb.DuckDBPyConnection) -> None:
    ops = [{"role": "trips", "op": "delete", "key": {"trip_id": "T2"}}] + [
        {
            "role": "stop_times",
            "op": "delete",
            "key": {"trip_id": "T2", "stop_sequence": s},
        }
        for s in range(1, 6)
    ]
    applied = apply(con, ops)
    assert applied.rows["stop_times"]["deleted"] == 5
    assert one(con, "SELECT count(*) FROM stop_times WHERE trip_id = 'T2'") == (0,)


def test_many_rows_are_written_a_statement_per_kind(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """Stop times of two trips at once, as an edit of many trips sends them:
    updates setting different columns, a row deleted and written again (a
    replace), a delete and an insert, each landing as a row's own statement
    would land it."""
    t1 = {"trip_id": "T1"}
    applied = apply(
        con,
        [
            {
                "role": "stop_times",
                "op": "update",
                "key": {**t1, "stop_sequence": 2},
                "values": {"arrival_time": "08:01:00", "departure_time": "08:01:30"},
            },
            {
                "role": "stop_times",
                "op": "update",
                "key": {**t1, "stop_sequence": 3},
                "values": {"departure_time": "08:04:30"},
            },
            {"role": "stop_times", "op": "delete", "key": {**t1, "stop_sequence": 4}},
            {
                "role": "stop_times",
                "op": "insert",
                "key": {**t1, "stop_sequence": 4},
                "values": {
                    "stop_id": "S4",
                    "arrival_time": "08:06:00",
                    "departure_time": "08:06:30",
                    "shape_dist_traveled": 2.04,
                },
            },
            {
                "role": "stop_times",
                "op": "delete",
                "key": {"trip_id": "T3", "stop_sequence": 5},
            },
            {
                "role": "stop_times",
                "op": "insert",
                "key": {"trip_id": "T3", "stop_sequence": 6},
                "values": {
                    "stop_id": "S1",
                    "arrival_time": "08:30:00",
                    "departure_time": "08:30:00",
                },
            },
        ],
    )
    assert applied.rows["stop_times"] == {"inserted": 1, "updated": 3, "deleted": 1}
    times = con.execute(
        "SELECT trip_id, stop_sequence, stop_id, epoch(arrival_time), epoch(departure_time) "
        "FROM stop_times WHERE trip_id IN ('T1', 'T3') ORDER BY trip_id, stop_sequence"
    ).fetchall()

    def hms(seconds: float) -> str:
        s = int(seconds)
        return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}"

    as_text = [(r[0], r[1], r[2], hms(r[3]), hms(r[4])) for r in times]
    assert as_text == [
        ("T1", 1, "S1", "08:00:00", "08:00:00"),
        ("T1", 2, "S2", "08:01:00", "08:01:30"),
        ("T1", 3, "S3", "08:04:00", "08:04:30"),
        ("T1", 4, "S4", "08:06:00", "08:06:30"),
        ("T1", 5, "S5", "08:08:00", "08:08:00"),
        ("T3", 1, "S5", "08:20:00", "08:20:00"),
        ("T3", 2, "S4", "08:22:00", "08:22:00"),
        ("T3", 3, "S3", "08:24:00", "08:24:00"),
        ("T3", 4, "S2", "08:26:00", "08:26:00"),
        ("T3", 6, "S1", "08:30:00", "08:30:00"),
    ]
    # The scratch tables it wrote through are gone.
    assert not con.execute(
        "SELECT table_name FROM duckdb_tables() WHERE temporary AND starts_with(table_name, '_cs_')"
    ).fetchall()


def test_a_trip_without_its_stop_times_is_refused(
    con: duckdb.DuckDBPyConnection,
) -> None:
    with pytest.raises(ChangeSetIntegrityError) as refused:
        apply(con, [{"role": "trips", "op": "delete", "key": {"trip_id": "T2"}}])
    codes = {(n.code, n.role, n.field) for n in refused.value.notices}
    assert codes == {("foreign_key_violation", "stop_times", "trip_id")}
    assert len(refused.value.notices) == 5


def test_a_stop_still_served_cannot_go(con: duckdb.DuckDBPyConnection) -> None:
    with pytest.raises(ChangeSetIntegrityError) as refused:
        apply(con, [{"role": "stops", "op": "delete", "key": {"stop_id": "S4"}}])
    assert {n.code for n in refused.value.notices} == {"foreign_key_violation"}
    assert {dict(n.key)["trip_id"] for n in refused.value.notices} == {
        "T1",
        "T2",
        "T3",
        "F1",
        "F2",
    }


def test_a_stop_time_before_the_previous_departure_is_refused(
    con: duckdb.DuckDBPyConnection,
) -> None:
    with pytest.raises(ChangeSetIntegrityError) as refused:
        apply(
            con,
            [
                {
                    "role": "stop_times",
                    "op": "update",
                    "key": {"trip_id": "T1", "stop_sequence": 3},
                    "values": {
                        "arrival_time": "08:01:00",
                        "departure_time": "08:01:00",
                    },
                }
            ],
        )
    assert [(n.code, dict(n.key)) for n in refused.value.notices] == [
        (
            "stop_time_with_arrival_before_previous_departure_time",
            {"trip_id": "T1", "stop_sequence": 3},
        ),
    ]


def test_times_past_midnight_are_times(con: duckdb.DuckDBPyConnection) -> None:
    apply(
        con,
        [
            {
                "role": "stop_times",
                "op": "update",
                "key": {"trip_id": "U1", "stop_sequence": 2},
                "values": {"arrival_time": "24:12:00", "departure_time": "24:12:00"},
            }
        ],
    )
    assert one(
        con,
        "SELECT epoch(arrival_time) FROM stop_times WHERE trip_id = 'U1' AND stop_sequence = 2",
    ) == (24 * 3600 + 12 * 60,)


def test_problems_the_feed_already_had_are_not_the_change_s(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # U2 calls at NOPE, which does not exist; renaming its headsign is fine.
    applied = apply(
        con,
        [
            {
                "role": "trips",
                "op": "update",
                "key": {"trip_id": "U2"},
                "values": {"trip_headsign": "Second St"},
            }
        ],
    )
    assert applied.rows["trips"]["updated"] == 1


def test_a_trip_given_another_stop_gets_a_new_line(
    con: duckdb.DuckDBPyConnection,
) -> None:
    old = chain(["S5", "S4", "S3", "S2", "S1"])
    new = chain(["S5", "S4", "S3", "S2", "S1", "S6"])
    # T3, which has no shape, runs on past S1 (08:28) to S6.
    apply(
        con,
        [
            {
                "role": "stop_times",
                "op": "insert",
                "key": {"trip_id": "T3", "stop_sequence": 6},
                "values": {
                    "stop_id": "S6",
                    "arrival_time": "08:35:00",
                    "departure_time": "08:35:00",
                },
            }
        ],
    )
    assert line(con, new) is not None
    # No other trip ran T3's old stops: its line goes.
    assert line(con, old) is None


def test_a_shape_point_moved_redraws_the_shape(con: duckdb.DuckDBPyConnection) -> None:
    apply(
        con,
        [
            {
                "role": "shapes",
                "op": "update",
                "key": {"shape_id": "SH1", "shape_pt_sequence": 2},
                "values": {"shape_pt_lat": 52.51},
            }
        ],
    )
    assert "13.405 52.51" in line(con, "SH1")


def test_a_trip_left_with_one_stop_is_a_warning(con: duckdb.DuckDBPyConnection) -> None:
    applied = apply(
        con,
        [
            {
                "role": "stop_times",
                "op": "delete",
                "key": {"trip_id": "Z1", "stop_sequence": 2},
            },
        ],
    )
    assert [n.code for n in applied.warnings] == ["unusable_trip"]


@pytest.mark.parametrize(
    "op, message",
    [
        (
            {
                "role": "stop_times",
                "op": "update",
                "key": {"trip_id": "T1", "stop_sequence": 1},
                "values": {"arrival_time": "8 o'clock"},
            },
            "not a valid GTFS time",
        ),
        (
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S1"},
                "values": {"stop_flavour": "sweet"},
            },
            "has no column stop_flavour",
        ),
        (
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "GONE"},
                "values": {"stop_name": "x"},
            },
            "is not there",
        ),
        (
            {
                "role": "stops",
                "op": "insert",
                "key": {"stop_id": "S1"},
                "values": {"stop_name": "again"},
            },
            "already exists",
        ),
        (
            {
                "role": "calendar_dates",
                "op": "insert",
                "key": {"service_id": "WK", "date": "2026-04-07"},
                "values": {"exception_type": 2},
            },
            "not a valid GTFS date",
        ),
    ],
)
def test_a_malformed_change_set_is_refused_whole(
    con: duckdb.DuckDBPyConnection, op: Dict[str, Any], message: str
) -> None:
    before = one(con, "SELECT count(*), max(stop_name) FROM stops")
    with pytest.raises(ChangeSetError, match=message):
        apply(con, [op])
    assert one(con, "SELECT count(*), max(stop_name) FROM stops") == before


@pytest.mark.parametrize(
    "op",
    [
        {"role": "shape_lines", "op": "delete", "key": {"shape_id": "SH1"}},
        {
            "role": "stops",
            "op": "update",
            "key": {"stop_id": "S1"},
            "values": {"geometry": "POINT (0 0)"},
        },
        {
            "role": "stop_times",
            "op": "update",
            "key": {"trip_id": "T1"},
            "values": {"stop_id": "S2"},
        },
        {
            "role": "stops",
            "op": "update",
            "key": {"stop_id": "S1"},
            "values": {"stop_id": "S9"},
        },
    ],
)
def test_what_a_change_set_may_not_say(op: Dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ChangeSet(ops=[op])


def _reshape_sh1(trips: Any = None) -> Dict[str, Any]:
    return {
        "role": "shapes",
        "op": "reshape",
        "key": {"shape_id": "SH1"},
        "source": "SH1",
        "through": "S3",
        "metres_per_unit": 1000,
        "stretches": [
            {"from": 0.3, "to": 0.6, "at": 0.45, "points": [[13.42, 52.502]]}
        ],
        **({"trips": trips} if trips is not None else {}),
    }


def _dist(con: duckdb.DuckDBPyConnection, trip_id: str, seq: int) -> float:
    return one(
        con,
        f"SELECT shape_dist_traveled FROM stop_times WHERE trip_id = '{trip_id}' AND stop_sequence = {seq}",
    )[0]


def test_a_trip_on_a_redrawn_shape_not_calling_at_the_stop_moves_on_with_it(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # T9: on SH1 from S4 to S5, past where the stretch is redrawn.
    con.execute(
        "INSERT INTO trips SELECT * REPLACE ('T9' AS trip_id) FROM trips WHERE trip_id = 'T1'"
    )
    con.execute(
        "INSERT INTO stop_times SELECT * REPLACE ('T9' AS trip_id) FROM stop_times "
        "WHERE trip_id = 'T1' AND stop_sequence >= 3"
    )
    t1, t9 = _dist(con, "T1", 3), _dist(con, "T9", 3)
    apply(con, [_reshape_sh1()])
    assert _dist(con, "T9", 3) - t9 == pytest.approx(_dist(con, "T1", 3) - t1)
    assert _dist(con, "T9", 3) > t9


def test_a_reshape_follows_the_trips_it_names(con: duckdb.DuckDBPyConnection) -> None:
    # Named, only T1's distances follow, whatever shape the others' rows say.
    t1, t2 = _dist(con, "T1", 3), _dist(con, "T2", 1)
    apply(con, [_reshape_sh1(["T1"])])
    assert _dist(con, "T1", 3) > t1
    assert _dist(con, "T2", 1) == t2


def test_a_shape_whose_distances_measure_nothing_falls_back_to_the_stop_times_unit(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # Every point at 0: no unit; the stop times' (km) measures the shape.
    con.execute("ALTER TABLE shapes ADD COLUMN shape_dist_traveled DOUBLE DEFAULT 0")
    apply(con, [_reshape_sh1()])
    d = [
        r[0]
        for r in con.execute(
            "SELECT shape_dist_traveled FROM stop_times WHERE trip_id = 'T1' ORDER BY stop_sequence"
        ).fetchall()
    ]
    assert all(x < y for x, y in zip(d, d[1:])), d


def test_a_path_rerouted_between_two_stops_moves_the_stops_past_it_on(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # SH1 from S2 to S3 (a quarter to half its length) bent out north: no
    # stop drawn through, S1 and S2 stay, S3 on lie as much further on.
    before = [_dist(con, "T1", k) for k in range(1, 6)]
    times = con.execute(
        "SELECT arrival_time FROM stop_times WHERE trip_id = 'T1' ORDER BY stop_sequence"
    ).fetchall()
    apply(
        con,
        [
            {
                "role": "shapes",
                "op": "reshape",
                "key": {"shape_id": "SH1"},
                "source": "SH1",
                "metres_per_unit": 1000,
                "stretches": [{"from": 0.25, "to": 0.5, "points": [[13.407, 52.51]]}],
            }
        ],
    )
    after = [_dist(con, "T1", k) for k in range(1, 6)]
    assert after[:2] == before[:2]
    moved = [y - x for x, y in zip(before[2:], after[2:])]
    assert moved[0] > 0
    assert moved == pytest.approx([moved[0]] * 3)
    assert (
        con.execute(
            "SELECT arrival_time FROM stop_times WHERE trip_id = 'T1' ORDER BY stop_sequence"
        ).fetchall()
        == times
    )


def _line_deleted(
    con: duckdb.DuckDBPyConnection, route_id: str
) -> List[Dict[str, Any]]:
    trips = [
        r[0]
        for r in con.execute(
            f"SELECT trip_id FROM trips WHERE route_id = '{route_id}'"
        ).fetchall()
    ]
    ops: List[Dict[str, Any]] = [
        {
            "role": "stop_times",
            "op": "delete",
            "key": {"trip_id": t, "stop_sequence": q},
        }
        for t, q in con.execute(
            "SELECT trip_id, stop_sequence FROM stop_times WHERE trip_id IN (SELECT UNNEST($t))",
            {"t": trips},
        ).fetchall()
    ]
    ops += [{"role": "trips", "op": "delete", "key": {"trip_id": t}} for t in trips]
    ops.append({"role": "routes", "op": "delete", "key": {"route_id": route_id}})
    return ops


def test_a_line_deleted_takes_its_shapes_and_fare_rules(
    con: duckdb.DuckDBPyConnection,
) -> None:
    con.execute("CREATE TABLE fare_rules (fare_id VARCHAR, route_id VARCHAR)")
    con.execute("INSERT INTO fare_rules VALUES ('F', 'R1'), ('F', 'R2')")
    applied = apply_changeset(
        con,
        {**TABLES, "fare_rules": "fare_rules"},
        ChangeSet(ops=_line_deleted(con, "R1")),
    )
    assert one(con, "SELECT count(*) FROM routes WHERE route_id = 'R1'") == (0,)
    # SH1, run by R1's trips only, goes, and its line with it.
    assert one(con, "SELECT count(*) FROM shapes WHERE shape_id = 'SH1'") == (0,)
    assert line(con, "SH1") is None
    assert applied.rows["shapes"]["deleted"] == 1
    assert con.execute("SELECT route_id FROM fare_rules").fetchall() == [("R2",)]
    assert applied.rows["fare_rules"]["deleted"] == 1


def test_a_shape_another_trip_runs_stays_when_a_line_goes(
    con: duckdb.DuckDBPyConnection,
) -> None:
    con.execute("UPDATE trips SET shape_id = 'SH1' WHERE trip_id = 'U1'")
    apply(con, _line_deleted(con, "R1"))
    assert one(con, "SELECT count(*) FROM shapes WHERE shape_id = 'SH1'") == (5,)


def test_a_line_extended_past_its_end_runs_on_and_keeps_its_distances(
    con: duckdb.DuckDBPyConnection,
) -> None:
    before = [_dist(con, "T1", k) for k in range(1, 6)]
    apply(
        con,
        [
            {
                "role": "stop_times",
                "op": "insert",
                "key": {"trip_id": "T1", "stop_sequence": 6},
                "values": {
                    "stop_id": "S6",
                    "arrival_time": "08:10:00",
                    "departure_time": "08:10:00",
                    "shape_dist_traveled": 3.4,
                },
            },
            {
                "role": "shapes",
                "op": "reshape",
                "key": {"shape_id": "SH1"},
                "source": "SH1",
                "metres_per_unit": 1000,
                "trips": ["T1", "T2", "T4"],
                "stretches": [{"from": 1.0, "to": None, "points": [[13.45, 52.5]]}],
            },
        ],
    )
    assert [_dist(con, "T1", k) for k in range(1, 7)] == before + [pytest.approx(3.4)]
    assert one(
        con,
        "SELECT shape_pt_lon FROM shapes WHERE shape_id = 'SH1' ORDER BY shape_pt_sequence DESC LIMIT 1",
    ) == (pytest.approx(13.45),)


def test_a_line_extended_before_its_start_moves_its_distances_on(
    con: duckdb.DuckDBPyConnection,
) -> None:
    before = [_dist(con, "T1", k) for k in range(1, 6)]
    apply(
        con,
        [
            {
                "role": "stop_times",
                "op": "insert",
                "key": {"trip_id": "T1", "stop_sequence": 0},
                "values": {
                    "stop_id": "X",
                    "arrival_time": "07:58:00",
                    "departure_time": "07:58:00",
                },
            },
            {
                "role": "shapes",
                "op": "reshape",
                "key": {"shape_id": "SH1"},
                "source": "SH1",
                "metres_per_unit": 1000,
                "trips": ["T1", "T2", "T4"],
                "stretches": [{"from": None, "to": 0.0, "points": [[13.39, 52.5]]}],
            },
        ],
    )
    moved = [_dist(con, "T1", k) - b for k, b in zip(range(1, 6), before)]
    assert moved[0] == pytest.approx(0.677, abs=0.01)
    assert moved == pytest.approx([moved[0]] * 5)


def test_a_line_s_fields_are_edited_its_description_given_its_column(
    con: duckdb.DuckDBPyConnection,
) -> None:
    apply(
        con,
        [
            {
                "role": "routes",
                "op": "update",
                "key": {"route_id": "R1"},
                "values": {
                    "route_long_name": "Main Line East",
                    "route_desc": "Via the centre",
                    "route_color": "00AA55",
                },
            }
        ],
    )
    assert one(
        con,
        "SELECT route_long_name, route_desc, route_color FROM routes WHERE route_id = 'R1'",
    ) == ("Main Line East", "Via the centre", "00AA55")


def test_a_line_left_without_a_name_is_refused(con: duckdb.DuckDBPyConnection) -> None:
    con.begin()
    with pytest.raises(ChangeSetIntegrityError) as caught:
        apply(
            con,
            [
                {
                    "role": "routes",
                    "op": "update",
                    "key": {"route_id": "R1"},
                    "values": {"route_short_name": None, "route_long_name": None},
                }
            ],
        )
    con.rollback()
    assert {n.code for n in caught.value.notices} == {
        "route_both_short_and_long_name_missing"
    }


def test_a_new_line_is_saved_with_its_shapes_trips_and_stop_times(
    con: duckdb.DuckDBPyConnection,
) -> None:
    ops: List[Dict[str, Any]] = [
        {
            "role": "routes",
            "op": "insert",
            "key": {"route_id": "goat_1"},
            "values": {
                "agency_id": "A",
                "route_short_name": "9",
                "route_long_name": "New Line",
                "route_type": 3,
            },
        }
    ]
    ops += [
        {
            "role": "shapes",
            "op": "insert",
            "key": {"shape_id": "goat_1_0", "shape_pt_sequence": k + 1},
            "values": {"shape_pt_lat": 52.5, "shape_pt_lon": lon},
        }
        for k, lon in enumerate([13.41, 13.43, 13.45])
    ]
    ops.append(
        {
            "role": "trips",
            "op": "insert",
            "key": {"trip_id": "goat_1_0_001"},
            "values": {
                "route_id": "goat_1",
                "service_id": "WK",
                "shape_id": "goat_1_0",
                "direction_id": 0,
                "trip_headsign": "Sixth",
            },
        }
    )
    ops += [
        {
            "role": "stop_times",
            "op": "insert",
            "key": {"trip_id": "goat_1_0_001", "stop_sequence": k + 1},
            "values": {"stop_id": stop, "arrival_time": t, "departure_time": t},
        }
        for k, (stop, t) in enumerate(
            [("S2", "07:00:00"), ("S4", "07:05:00"), ("S6", "07:10:00")]
        )
    ]
    applied = apply(con, ops)
    assert applied.rows["trips"]["inserted"] == 1
    assert line(con, "goat_1_0") is not None


def _hms(t: Any) -> str:
    secs = int(t.total_seconds())
    return f"{secs // 3600:02d}:{secs % 3600 // 60:02d}:{secs % 60:02d}"


def test_a_stop_added_between_two_numbered_one_apart_makes_room_for_itself(
    con: duckdb.DuckDBPyConnection,
) -> None:
    def calls() -> List[Any]:
        return con.execute(
            "SELECT stop_sequence, stop_id, departure_time FROM stop_times "
            "WHERE trip_id = 'T1' ORDER BY stop_sequence"
        ).fetchall()

    before = calls()
    seq = [r[0] for r in before]
    a, b = seq[1], seq[2]
    assert b - a == 1
    apply(
        con,
        [
            # Named before the shift, as it was numbered then: S5's time.
            {
                "role": "stop_times",
                "op": "update",
                "key": {"trip_id": "T1", "stop_sequence": seq[-1]},
                "values": {"departure_time": _hms(before[-1][2])},
            },
            {"role": "stop_times", "op": "shift", "key": {"trip_id": "T1"}, "after": a},
            {
                "role": "stop_times",
                "op": "insert",
                "key": {"trip_id": "T1", "stop_sequence": a + 1},
                "values": {"stop_id": "X"},
            },
        ],
    )
    after = calls()
    # X between the second and third stop, untimed; the rest kept, in order.
    assert [r[1] for r in after] == [
        before[0][1],
        before[1][1],
        "X",
        *[r[1] for r in before[2:]],
    ]
    assert after[2][2] is None
    assert [r[2] for r in after if r[1] != "X"] == [r[2] for r in before]
    assert all(x[0] < y[0] for x, y in zip(after, after[1:]))


def test_a_copied_trip_keeps_the_columns_it_does_not_name(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """A departure added by a headway edit (4.1) copies a trip: the Explorer
    sends what it holds (ids, times, the block taken off), and the rest of the
    row (here a bike flag and a stop's pickup type) comes from the trip
    copied."""
    con.execute("ALTER TABLE trips ADD COLUMN bikes_allowed INTEGER")
    con.execute(
        "UPDATE trips SET bikes_allowed = 1, block_id = 'B9' WHERE trip_id = 'T1'"
    )
    con.execute("ALTER TABLE stop_times ADD COLUMN pickup_type INTEGER")
    con.execute(
        "UPDATE stop_times SET pickup_type = 1 WHERE trip_id = 'T1' AND stop_sequence = 2"
    )
    times = con.execute(
        "SELECT stop_sequence, stop_id FROM stop_times WHERE trip_id = 'T1' "
        "ORDER BY stop_sequence"
    ).fetchall()
    ops: List[Dict[str, Any]] = [
        {
            "role": "trips",
            "op": "insert",
            "key": {"trip_id": "goat_t1"},
            "values": {"route_id": "R1", "service_id": "WK", "block_id": None},
            "copy_of": {"trip_id": "T1"},
        }
    ] + [
        {
            "role": "stop_times",
            "op": "insert",
            "key": {"trip_id": "goat_t1", "stop_sequence": seq},
            "values": {
                "stop_id": stop_id,
                "arrival_time": f"09:0{2 * k}:00",
                "departure_time": f"09:0{2 * k}:00",
            },
            "copy_of": {"trip_id": "T1", "stop_sequence": seq},
        }
        for k, (seq, stop_id) in enumerate(times)
    ]
    apply(con, ops)
    assert one(
        con,
        "SELECT route_id, service_id, shape_id, trip_headsign, bikes_allowed, block_id "
        "FROM trips WHERE trip_id = 'goat_t1'",
    ) == ("R1", "WK", "SH1", "Fifth", 1, None)
    copied = con.execute(
        "SELECT stop_sequence, CAST(departure_time AS VARCHAR), pickup_type, "
        "shape_dist_traveled FROM stop_times WHERE trip_id = 'goat_t1' "
        "ORDER BY stop_sequence"
    ).fetchall()
    assert [r[1] for r in copied][:2] == ["09:00:00", "09:02:00"]
    assert [r[2] for r in copied] == [None, 1, None, None, None]
    assert [r[3] for r in copied] == pytest.approx([0, 0.68, 1.36, 2.04, 2.72])


def _copies_of_t1(new: str) -> List[Dict[str, Any]]:
    """Trip T1 copied as ``new``, its stop times with it, an hour later."""
    return [
        {
            "role": "trips",
            "op": "insert",
            "key": {"trip_id": new},
            "values": {"route_id": "R1", "service_id": "WK"},
            "copy_of": {"trip_id": "T1"},
        }
    ] + [
        {
            "role": "stop_times",
            "op": "insert",
            "key": {"trip_id": new, "stop_sequence": seq},
            "values": {
                "stop_id": f"S{seq}",
                "arrival_time": f"09:0{2 * (seq - 1)}:00",
                "departure_time": f"09:0{2 * (seq - 1)}:00",
            },
            "copy_of": {"trip_id": "T1", "stop_sequence": seq},
        }
        for seq in range(1, 6)
    ]


def test_a_row_copied_and_deleted_in_one_change_set_is_copied_as_it_was(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """A departure moved by a headway edit: the trip it copies is deleted in
    the same change set, and the rows a change set deletes go first. The copy
    still takes what it does not name from the trip as it was; so does a row
    replaced by a copy of itself."""
    con.execute("ALTER TABLE trips ADD COLUMN bikes_allowed INTEGER")
    con.execute("UPDATE trips SET bikes_allowed = 1 WHERE trip_id = 'T1'")
    con.execute("ALTER TABLE stop_times ADD COLUMN pickup_type INTEGER")
    con.execute(
        "UPDATE stop_times SET pickup_type = stop_sequence WHERE trip_id = 'T1'"
    )
    con.execute(
        "UPDATE stop_times SET pickup_type = 7 WHERE trip_id = 'T2' AND stop_sequence = 2"
    )
    t2 = {"trip_id": "T2", "stop_sequence": 2}
    applied = apply(
        con,
        _copies_of_t1("goat_t1")
        + [{"role": "trips", "op": "delete", "key": {"trip_id": "T1"}}]
        + [
            {
                "role": "stop_times",
                "op": "delete",
                "key": {"trip_id": "T1", "stop_sequence": seq},
            }
            for seq in range(1, 6)
        ]
        + [
            {"role": "stop_times", "op": "delete", "key": t2},
            {
                "role": "stop_times",
                "op": "insert",
                "key": t2,
                "values": {
                    "stop_id": "S2",
                    "arrival_time": "08:12:30",
                    "departure_time": "08:12:30",
                },
                "copy_of": t2,
            },
        ],
    )
    assert applied.rows["trips"] == {"inserted": 1, "updated": 0, "deleted": 1}
    assert one(
        con,
        "SELECT shape_id, trip_headsign, bikes_allowed FROM trips "
        "WHERE trip_id = 'goat_t1'",
    ) == ("SH1", "Fifth", 1)
    copied = con.execute(
        "SELECT pickup_type, shape_dist_traveled FROM stop_times "
        "WHERE trip_id = 'goat_t1' ORDER BY stop_sequence"
    ).fetchall()
    assert [r[0] for r in copied] == [1, 2, 3, 4, 5]
    assert [r[1] for r in copied] == pytest.approx([0, 0.68, 1.36, 2.04, 2.72])
    assert one(con, "SELECT count(*) FROM stop_times WHERE trip_id = 'T1'") == (0,)
    assert one(
        con,
        "SELECT count(*), any_value(pickup_type), any_value(shape_dist_traveled), "
        "CAST(any_value(departure_time) AS VARCHAR) FROM stop_times "
        "WHERE trip_id = 'T2' AND stop_sequence = 2",
    ) == (1, 7, pytest.approx(0.68), "08:12:30")


def test_a_copy_named_before_a_shift_copies_the_row_it_named(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """Stop times copied, then a stop added to the trip they copy: the rows
    they copy are named as they were numbered then, and renumbered with the
    rest."""
    con.execute("ALTER TABLE stop_times ADD COLUMN pickup_type INTEGER")
    con.execute(
        "UPDATE stop_times SET pickup_type = stop_sequence WHERE trip_id = 'T1'"
    )
    apply(
        con,
        _copies_of_t1("goat_t1")
        + [
            {"role": "stop_times", "op": "shift", "key": {"trip_id": "T1"}, "after": 1},
            {
                "role": "stop_times",
                "op": "insert",
                "key": {"trip_id": "T1", "stop_sequence": 2},
                "values": {"stop_id": "S3"},
            },
        ],
    )
    assert [
        r[0]
        for r in con.execute(
            "SELECT pickup_type FROM stop_times WHERE trip_id = 'goat_t1' "
            "ORDER BY stop_sequence"
        ).fetchall()
    ] == [1, 2, 3, 4, 5]
    assert [
        r[0]
        for r in con.execute(
            "SELECT pickup_type FROM stop_times WHERE trip_id = 'T1' "
            "ORDER BY stop_sequence"
        ).fetchall()
    ] == [1, None, 2, 3, 4, 5]


def test_a_frequency_keyed_by_a_time_held_as_text_is_found(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """A bundle imported before typing holds a frequency's start_time as
    text, its leading zero left out: the change set names it ``06:00:00``,
    and the save finds it, as a row's own statement against a typed value
    found it."""
    con.execute(
        "CREATE OR REPLACE TABLE frequencies AS SELECT trip_id, "
        "'6:00:00' AS start_time, CAST(end_time AS VARCHAR) AS end_time, "
        "headway_secs, exact_times FROM frequencies"
    )
    f1 = {"trip_id": "F1", "start_time": "06:00:00"}
    applied = apply(
        con,
        [
            {
                "role": "frequencies",
                "op": "update",
                "key": f1,
                "values": {"headway_secs": 300},
            }
        ],
    )
    assert applied.rows["frequencies"] == {"inserted": 0, "updated": 1, "deleted": 0}
    assert one(con, "SELECT start_time, headway_secs FROM frequencies") == (
        "6:00:00",
        300,
    )
    applied = apply(
        con,
        [
            {"role": "frequencies", "op": "delete", "key": f1},
            {
                "role": "frequencies",
                "op": "insert",
                "key": f1,
                "values": {"end_time": "10:00:00", "headway_secs": 900},
            },
        ],
    )
    assert applied.rows["frequencies"] == {"inserted": 0, "updated": 1, "deleted": 0}
    assert con.execute(
        "SELECT trip_id, start_time, end_time, headway_secs FROM frequencies"
    ).fetchall() == [("F1", "06:00:00", "10:00:00", 900)]


def test_rows_staged_through_arrow_land_as_parameters_land(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The scratch tables a write goes through are filled through Arrow, in
    one statement. Each value lands as ``executemany`` landed it: a time past
    midnight, a date and a number in a text column included."""
    from datetime import date, timedelta

    from goatlib.bundles.explorer import changeset as cs

    columns = {
        "n": "INTEGER",
        "t_text": "VARCHAR",
        "t_time": "INTERVAL",
        "d_text": "VARCHAR",
        "d_date": "DATE",
        "i_text": "VARCHAR",
        "i_int": "INTEGER",
        "f_text": "VARCHAR",
        "f_double": "DOUBLE",
        "s": "VARCHAR",
    }
    late = timedelta(hours=25, minutes=10, seconds=5)
    day = date(2026, 10, 12)
    rows = [
        (0, late, late, day, day, 7, 7, 1.5, 1.5, "x"),
        (1, timedelta(hours=6), timedelta(0), None, None, None, -3, 2.0, None, ""),
        (2, None, None, None, None, None, None, None, None, None),
    ]
    assert cs._arrow_rows(rows, len(columns)) is not None

    def staged() -> list:
        con = duckdb.connect()
        con.execute(
            "CREATE TABLE src ("
            + ", ".join(f"{c} {ty}" for c, ty in columns.items())
            + ")"
        )
        t = cs._Tables(con, {"stop_times": "src"})
        name = cs._stage(t, "stop_times", list(columns), rows)
        picks = ", ".join(f"typeof({c}), CAST({c} AS VARCHAR)" for c in columns)
        return con.execute(f"SELECT {picks} FROM {name} ORDER BY n").fetchall()

    through_arrow = staged()
    monkeypatch.setattr(cs, "pa", None)
    assert through_arrow == staged()
    assert through_arrow[0][3] == "1 day 01:10:05"


def test_only_an_insert_copies_a_row() -> None:
    with pytest.raises(ValidationError):
        ChangeSet(
            ops=[
                {
                    "role": "trips",
                    "op": "update",
                    "key": {"trip_id": "T1"},
                    "values": {"trip_headsign": "X"},
                    "copy_of": {"trip_id": "T2"},
                }
            ]
        )


def test_room_made_at_once_is_room_made_shift_by_shift() -> None:
    """Shifts made in one statement number a trip's stop times as the same
    shifts made one by one, in order, do: several in a trip included."""
    import random

    from goatlib.bundles.explorer.changeset import _make_room, _Tables

    rng = random.Random(7)
    for _ in range(50):
        trips = {f"T{i}": rng.randint(2, 12) for i in range(3)}
        shifts = [
            (trip, rng.randint(0, n + 3))
            for trip, n in trips.items()
            for _ in range(rng.randint(0, 4))
        ]
        rng.shuffle(shifts)
        rows = [(trip, s) for trip, n in trips.items() for s in range(1, n + 1)]
        # A feed may hold two rows at one place of a trip: both move, once.
        rows += rng.sample(rows, rng.randint(0, 3))

        def numbered(con: duckdb.DuckDBPyConnection) -> list:
            return con.execute(
                "SELECT trip_id, stop_sequence, tag FROM stop_times ORDER BY tag"
            ).fetchall()

        one_by_one = duckdb.connect()
        at_once = duckdb.connect()
        for c in (one_by_one, at_once):
            c.execute(
                "CREATE TABLE stop_times (trip_id VARCHAR, stop_sequence INTEGER, tag VARCHAR)"
            )
            c.executemany(
                "INSERT INTO stop_times VALUES (?, ?, ?)",
                [(trip, s, f"{trip}:{s}:{k:02d}") for k, (trip, s) in enumerate(rows)],
            )
        for trip, after in shifts:
            one_by_one.execute(
                "UPDATE stop_times SET stop_sequence = stop_sequence + 1 "
                "WHERE trip_id = ? AND stop_sequence > ?",
                [trip, after],
            )
        _make_room(_Tables(at_once, {"stop_times": "stop_times"}), shifts)
        assert numbered(at_once) == numbered(one_by_one), shifts
