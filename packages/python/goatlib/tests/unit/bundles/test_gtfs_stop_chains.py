"""Trips without a shape are drawn through their stops.

A GTFS feed need not have shapes, and many have none or some. The bundle's
``shape_lines`` member draws the feed's shapes and, for every trip without a
usable one, a line through its stops (``stop_chains``), named after the stops
so the Explorer's snapshot gives those trips the same line as their shape.
"""

import zipfile
from pathlib import Path

import duckdb
from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter
from goatlib.bundles.importers.pt_network.stop_chains import stop_chain_id

FEED = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nA,Agency,https://a.example,Europe/Berlin\n",
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
        "S1,First,48.1,11.5,0,\nS2,Second,48.2,11.6,0,\nS3,Third,48.3,11.7,0,\n"
        "ST,Station,48.4,11.8,1,\nP1,Platform,,,0,ST\nN1,Nowhere,,,0,\n"
    ),
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
    "trips.txt": "route_id,service_id,trip_id\nR1,WK,T1\nR1,WK,T2\nR1,WK,T3\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        # T1 and T2 call at the same stops; T3 the other way, via a platform
        # placed by its station.
        "T1,08:00:00,08:00:00,S1,1\nT1,08:05:00,08:05:00,S2,2\nT1,08:09:00,08:09:00,S3,3\n"
        "T2,09:00:00,09:00:00,S1,1\nT2,09:05:00,09:05:00,S2,2\nT2,09:09:00,09:09:00,S3,3\n"
        "T3,10:00:00,10:00:00,S3,1\nT3,10:04:00,10:04:00,P1,2\nT3,10:09:00,10:09:00,S1,3\n"
    ),
    "calendar_dates.txt": "service_id,date,exception_type\nWK,20260105,1\n",
}


def _zip(tmp_path: Path, **changes: str | None) -> str:
    """The feed with files added, replaced or (with None) removed."""
    files = {**FEED, **changes}
    path = tmp_path / "gtfs.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for name, text in files.items():
            if text is not None:
                zf.writestr(name, text)
    return str(path)


def _lines(feed: str, tmp_path: Path) -> dict[str, list[tuple[float, float]]]:
    """The shape_lines member: each line's vertices by id."""
    work = tmp_path / "work"
    work.mkdir()
    layer = next(
        layer
        for layer in GtfsImporter().extract_layers(feed, str(work))
        if layer.role == "shape_lines"
    )
    assert layer.layer_type == "feature" and layer.geometry_type == "line"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    rows = con.execute(
        f"""SELECT shape_id, list(struct_pack(x := ST_X(p.geom), y := ST_Y(p.geom)))
            FROM (SELECT shape_id, UNNEST(ST_Dump(ST_Points(geometry))) AS p
                  FROM read_parquet('{layer.file_path}'))
            GROUP BY shape_id"""
    ).fetchall()
    return {
        shape_id: [(pt["x"], pt["y"]) for pt in points] for shape_id, points in rows
    }


def test_a_feed_without_shapes_is_drawn_through_its_stops(tmp_path: Path) -> None:
    lines = _lines(_zip(tmp_path), tmp_path)
    # T1 and T2 share one line; T3 has its own, its platform placed at the
    # station's position.
    assert lines == {
        stop_chain_id(["S1", "S2", "S3"]): [(11.5, 48.1), (11.6, 48.2), (11.7, 48.3)],
        stop_chain_id(["S3", "P1", "S1"]): [(11.7, 48.3), (11.8, 48.4), (11.5, 48.1)],
    }


def test_the_feeds_shapes_stay_and_the_rest_are_drawn_through_their_stops(
    tmp_path: Path,
) -> None:
    feed = _zip(
        tmp_path,
        **{
            "trips.txt": (
                "route_id,service_id,trip_id,shape_id\n"
                # A shape, none, an empty one, and one the feed does not have.
                "R1,WK,T1,SH1\nR1,WK,T2,\nR1,WK,T3,\nR1,WK,T4,GONE\n"
            ),
            "stop_times.txt": FEED["stop_times.txt"]
            + "T4,11:00:00,11:00:00,S1,1\nT4,11:05:00,11:05:00,S2,2\n",
            "shapes.txt": (
                "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
                "SH1,48.1,11.5,1\nSH1,48.15,11.52,2\nSH1,48.3,11.7,3\n"
            ),
        },
    )
    lines = _lines(feed, tmp_path)
    assert set(lines) == {
        "SH1",
        stop_chain_id(["S1", "S2", "S3"]),  # T2
        stop_chain_id(["S3", "P1", "S1"]),  # T3
        stop_chain_id(["S1", "S2"]),  # T4
    }
    assert len(lines["SH1"]) == 3


def test_a_header_only_shapes_file_draws_every_trip_through_its_stops(
    tmp_path: Path,
) -> None:
    feed = _zip(
        tmp_path,
        **{
            "trips.txt": "route_id,service_id,trip_id,shape_id\nR1,WK,T1,SH1\nR1,WK,T2,\nR1,WK,T3,\n",
            "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n",
        },
    )
    assert set(_lines(feed, tmp_path)) == {
        stop_chain_id(["S1", "S2", "S3"]),
        stop_chain_id(["S3", "P1", "S1"]),
    }


def test_a_trip_with_fewer_than_two_placed_stops_gets_no_line(tmp_path: Path) -> None:
    # N1 has no position and no station: T3 keeps S3 alone.
    feed = _zip(
        tmp_path,
        **{
            "stop_times.txt": FEED["stop_times.txt"].replace(
                "T3,10:04:00,10:04:00,P1,2\nT3,10:09:00,10:09:00,S1,3\n",
                "T3,10:04:00,10:04:00,N1,2\n",
            )
        },
    )
    assert set(_lines(feed, tmp_path)) == {stop_chain_id(["S1", "S2", "S3"])}


def test_the_lines_are_never_written_back_to_the_feed() -> None:
    from goatlib.models.bundle import SPECS, BundleTypeName

    role = SPECS[BundleTypeName.pt_network_gtfs].role("shape_lines")
    assert role is not None and role.derived_from
