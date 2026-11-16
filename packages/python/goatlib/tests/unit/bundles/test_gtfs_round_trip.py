"""A GTFS feed written back out of its member layers is the feed that was uploaded.

The member layers are the only copy of the feed once the import has finished —
the upload is not kept — so anything the import does not store is gone for good.
"""

import csv
import zipfile
from pathlib import Path

import duckdb
from goatlib.bundles.artifacts.gtfs import _write_feed_from_layers
from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter

FEED = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nA,Agency,https://a.example,Europe/Berlin\n",
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
        'S1,"Town, Street",48.1,11.5,0,ST\n'
        "S2,Second,48.2,11.6,0,ST\n"
        "ST,Station,48.15,11.55,1,\n"
        # A generic node: GTFS leaves its coordinates empty.
        "N1,Node,,,3,ST\n"
    ),
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
    "trips.txt": "route_id,service_id,trip_id,shape_id\nR1,WK,T1,SH1\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T1,08:00:00,08:00:00,S1,1\nT1,08:05:00,08:05:00,S2,2\n"
    ),
    "calendar_dates.txt": "service_id,date,exception_type\nWK,20260105,1\n",
    "shapes.txt": (
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n"
        "SH1,48.1,11.5,1,0.0\nSH1,48.15,11.55,2,512.3\nSH1,48.2,11.6,3,1024.9\n"
        # One point only: no line, but still a row of the feed.
        "SH2,48.3,11.7,1,0.0\n"
    ),
    # Not a file the spec names; kept all the same.
    "route_directions.txt": "route_id,direction_id,direction_name\nR1,0,Northbound\n",
}


def _rows(text: str) -> list[dict[str, str]]:
    """A file's rows in a fixed order: GTFS orders rows by its sequence fields,
    not by their place in the file, and the import stores the rows of a layer
    with geometry in spatial order."""
    rows = [
        {k: (v or "") for k, v in row.items()}
        for row in csv.DictReader(text.splitlines())
    ]
    return sorted(rows, key=lambda row: sorted(row.items()))


def test_every_file_survives_import_and_write_back(tmp_path: Path) -> None:
    archive = tmp_path / "feed_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for name, text in FEED.items():
            zf.writestr(name, text)

    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = GtfsImporter().extract_layers(str(archive), str(workdir))
    by_role = {layer.role: layer for layer in layers}

    # The shape lines are drawn from the points, one per shape that has two.
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    lines = con.execute(
        f"SELECT shape_id, ST_NPoints(geometry) FROM read_parquet('{by_role['shape_lines'].file_path}')"
    ).fetchall()
    assert lines == [("SH1", 3)]

    feed_dir = tmp_path / "feed"
    feed_dir.mkdir()
    written = _write_feed_from_layers(
        {role: layer.file_path for role, layer in by_role.items()}, str(feed_dir)
    )

    assert sorted(written) == sorted(FEED)
    for name, text in FEED.items():
        back = (feed_dir / name).read_text()
        assert _rows(back) == _rows(text), name
