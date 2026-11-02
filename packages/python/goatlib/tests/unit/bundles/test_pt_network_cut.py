"""GOAT's public transport network: its tables, and a cut of them to an area.

The tables are the importer's output, so a cut is ingested as an import is. A
cut keeps whole lines and every reference intact: what it writes is a feed in
its own right, read back by the importer like any upload.
"""

import json
import zipfile
from pathlib import Path

import duckdb
import pytest
from goatlib.bundles.artifacts.gtfs import _write_feed_from_layers
from goatlib.bundles.importers.pt_network import store
from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter
from goatlib.io.fetch import pt_network

# The area: lon 11.0-11.2, lat 48.0-48.2.
AREA = {
    "type": "Polygon",
    "coordinates": [
        [[11.0, 48.0], [11.2, 48.0], [11.2, 48.2], [11.0, 48.2], [11.0, 48.0]]
    ],
}

FEED = {
    "agency.txt": (
        "agency_id,agency_name,agency_url,agency_timezone\n"
        "A,Local,https://a.example,Europe/Berlin\n"
        "B,Long distance,https://b.example,Europe/Berlin\n"
        "C,Elsewhere,https://c.example,Europe/Berlin\n"
    ),
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,zone_id\n"
        # A station in the area, its platform just outside it, and an entrance.
        "ST1,Station one,48.1,11.1,1,,\n"
        "P1,Platform one,48.1,11.21,0,ST1,Z1\n"
        "E1,Entrance one,48.1,11.1,2,ST1,\n"
        "S2,In the area,48.15,11.15,0,,Z1\n"
        "S3,Where line 1 runs on to,48.5,12.0,0,,Z2\n"
        "S8,Where line 1's other trip runs,48.6,12.1,0,,Z2\n"
        # A station outside the area with its platform inside it.
        "ST5,Station five,48.1,11.25,1,,\n"
        "P5,Platform five,48.1,11.19,0,ST5,\n"
        "S6,Far away on the long-distance line,50.0,14.0,0,,\n"
        "S4,Only line 2,49.0,13.0,0,,\n"
        "S7,Only line 4,51.0,15.0,0,,\n"
        "S9,Lines 2 and 4,51.5,15.5,0,,Z9\n"
    ),
    "routes.txt": (
        "route_id,agency_id,route_short_name,route_type\n"
        "R1,A,1,3\nR2,A,2,3\nR3,B,ICE,2\nR4,C,4,3\n"
    ),
    "trips.txt": (
        "route_id,service_id,trip_id,shape_id\n"
        "R1,WK,T1,SH1\nR1,SA,T1b,\nR2,WK,T2,SH2\nR3,LD,T3,SH3\nR4,WK,T4,\n"
    ),
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T1,08:00:00,08:00:00,P1,1\nT1,08:05:00,08:05:00,S2,2\nT1,08:30:00,08:30:00,S3,3\n"
        "T1b,09:00:00,09:00:00,S3,1\nT1b,09:10:00,09:10:00,S8,2\n"
        "T2,08:00:00,08:00:00,S4,1\nT2,09:00:00,09:00:00,S9,2\n"
        "T3,07:00:00,07:00:00,P5,1\nT3,25:10:00,25:10:00,S6,2\n"
        "T4,08:00:00,08:00:00,S7,1\nT4,08:20:00,08:20:00,S9,2\n"
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "WK,1,1,1,1,1,0,0,20260101,20261231\nXX,1,1,1,1,1,1,1,20260101,20261231\n"
    ),
    "calendar_dates.txt": (
        "service_id,date,exception_type\nSA,20260110,1\nLD,20260105,1\nXX,20260106,2\n"
    ),
    "shapes.txt": (
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
        "SH1,48.1,11.21,1\nSH1,48.15,11.15,2\nSH1,48.5,12.0,3\n"
        "SH2,49.0,13.0,1\nSH2,51.5,15.5,2\n"
        "SH3,48.1,11.19,1\nSH3,50.0,14.0,2\n"
    ),
    "frequencies.txt": (
        "trip_id,start_time,end_time,headway_secs\n"
        "T1,08:00:00,10:00:00,600\nT2,08:00:00,10:00:00,900\n"
    ),
    "transfers.txt": (
        "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n"
        "P1,S2,2,120\nS2,S4,2,300\n"
    ),
    "pathways.txt": (
        "pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional\n"
        "W1,E1,P1,1,1\n"
    ),
    "fare_attributes.txt": (
        "fare_id,price,currency_type,payment_method,transfers,agency_id\n"
        "F1,2.50,EUR,0,,A\nF2,3.00,EUR,0,,C\n"
    ),
    "fare_rules.txt": (
        "fare_id,route_id,origin_id\n" "F1,R1,\nF1,R2,\nF2,R4,\nF1,,Z1\nF1,,Z9\n"
    ),
    "translations.txt": (
        "table_name,field_name,language,translation,record_id\n"
        "stops,stop_name,en,In the area,S2\n"
        "stops,stop_name,en,Lines two and four,S9\n"
        "feed_info,feed_publisher_name,en,Publisher,\n"
    ),
    "feed_info.txt": (
        "feed_publisher_name,feed_publisher_url,feed_lang\n"
        "GOAT,https://goat.example,de\n"
    ),
    # Not a file the reference names: a cut cannot know what it refers to.
    "route_directions.txt": "route_id,direction_id,direction_name\nR1,0,North\n",
}


def _zip(path: Path, feed: dict) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, text in feed.items():
            zf.writestr(name, text)
    return path


@pytest.fixture
def tables(tmp_path: Path) -> Path:
    out = tmp_path / "gtfs_tables"
    store.build_store(
        str(_zip(tmp_path / "combined_gtfs.zip", FEED)),
        str(out),
        lineage="GOAT's combined feed",
        license="CC-BY-4.0",
    )
    return out


@pytest.fixture
def cut(tables: Path, tmp_path: Path) -> dict:
    workdir = tmp_path / "cut"
    workdir.mkdir()
    con = duckdb.connect()
    layers = pt_network.export_pt_network(
        con, area=AREA, store_dir=str(tables), workdir=str(workdir)
    )
    return {layer.role: layer.file_path for layer in layers}


def _values(path: str, column: str) -> set:
    con = duckdb.connect()
    return {
        r[0]
        for r in con.execute(
            f"SELECT \"{column}\" FROM read_parquet('{path}')"
        ).fetchall()
    }


def test_the_tables_are_the_importers_output(tables: Path, tmp_path: Path) -> None:
    workdir = tmp_path / "import"
    workdir.mkdir()
    imported = {
        layer.role: layer
        for layer in GtfsImporter().extract_layers(
            str(_zip(tmp_path / "again_gtfs.zip", FEED)), str(workdir)
        )
    }
    info = json.loads((tables / store.INFO_FILENAME).read_text())
    by_role = {t["role"]: t for t in info["tables"]}

    # Every file the reference names; not the extra file, nor the drawn lines,
    # which every cut draws again.
    assert set(by_role) == set(imported) - {"route_directions.txt", "shape_lines"}
    con = duckdb.connect()
    con.execute("LOAD spatial")
    for role, layer in imported.items():
        if role not in by_role:
            continue
        ours = tables / by_role[role]["file"]
        assert by_role[role]["layer_type"] == layer.layer_type
        assert by_role[role]["geometry_type"] == layer.geometry_type
        # The same rows, typed the same: a cut is ingested as an import is.
        assert (
            con.execute(f"DESCRIBE SELECT * FROM read_parquet('{ours}')").fetchall()
            == con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{layer.file_path}')"
            ).fetchall()
        )
        diff = con.execute(
            f"SELECT count(*) FROM (SELECT * FROM read_parquet('{ours}') "
            f"EXCEPT ALL SELECT * FROM read_parquet('{layer.file_path}'))"
        ).fetchone()[0]
        assert diff == 0, role
        assert (
            by_role[role]["rows"]
            == con.execute(f"SELECT count(*) FROM read_parquet('{ours}')").fetchone()[0]
        )

    # Sorted for the cut, which reads stop times by trip.
    trips = [
        r[0]
        for r in con.execute(
            f"SELECT trip_id FROM read_parquet('{tables / 'stop_times.parquet'}')"
        ).fetchall()
    ]
    assert trips == sorted(trips)
    assert info["schema"] == store.STORE_SCHEMA and info["license"] == "CC-BY-4.0"
    assert len(info["source"]["sha256"]) == 64


def test_an_existing_store_is_not_overwritten(tables: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="not empty"):
        store.build_store(str(_zip(tmp_path / "x_gtfs.zip", FEED)), str(tables))


def test_a_server_without_tables_is_told_what_to_do(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="sync_base_data"):
        store.read_store(tmp_path)


def test_whole_lines_are_kept(cut: dict) -> None:
    # Line 1 from the platform outside the area whose station is in it, line
    # 3 from the platform inside it whose station is not. Line 2 is the same
    # operator's but serves no stop here; line 4 another operator's.
    assert _values(cut["routes"], "route_id") == {"R1", "R3"}
    # Line 1's trip that never enters the area comes with it.
    assert _values(cut["trips"], "trip_id") == {"T1", "T1b", "T3"}
    assert _values(cut["agency"], "agency_id") == {"A", "B"}
    assert _values(cut["stops"], "stop_id") == {
        "ST1",
        "P1",
        "E1",
        "S2",
        "S3",
        "S8",
        "ST5",
        "P5",
        "S6",
    }
    assert _values(cut["calendar"], "service_id") == {"WK"}
    assert _values(cut["calendar_dates"], "service_id") == {"SA", "LD"}
    assert _values(cut["shapes"], "shape_id") == {"SH1", "SH3"}
    assert _values(cut["frequencies"], "trip_id") == {"T1"}
    assert _values(cut["transfers"], "to_stop_id") == {"S2"}
    assert _values(cut["pathways"], "pathway_id") == {"W1"}
    assert _values(cut["fare_attributes"], "fare_id") == {"F1"}
    con = duckdb.connect()
    rules = con.execute(
        f"SELECT fare_id, route_id, origin_id FROM read_parquet('{cut['fare_rules']}')"
    ).fetchall()
    assert sorted(rules, key=str) == sorted(
        [("F1", "R1", None), ("F1", None, "Z1")], key=str
    )
    assert _values(cut["translations"], "record_id") == {"S2", None}
    assert _values(cut["feed_info"], "feed_publisher_name") == {"GOAT"}
    # Drawn again from the cut: line 1's shape, line 3's, and a line through
    # the stops for line 1's trip without a shape.
    assert _values(cut["shape_lines"], "shape_id") >= {"SH1", "SH3"}
    assert "SH2" not in _values(cut["shape_lines"], "shape_id")


def test_every_reference_holds(cut: dict) -> None:
    def ids(role: str, column: str) -> set:
        return _values(cut[role], column) - {None, ""}

    stops = ids("stops", "stop_id")
    assert ids("stop_times", "stop_id") <= stops
    assert ids("stop_times", "trip_id") <= ids("trips", "trip_id")
    assert ids("trips", "route_id") <= ids("routes", "route_id")
    assert ids("trips", "service_id") <= ids("calendar", "service_id") | ids(
        "calendar_dates", "service_id"
    )
    assert ids("trips", "shape_id") <= ids("shapes", "shape_id")
    assert ids("routes", "agency_id") <= ids("agency", "agency_id")
    assert ids("stops", "parent_station") <= stops
    for column in ("from_stop_id", "to_stop_id"):
        assert ids("transfers", column) <= stops
        assert ids("pathways", column) <= stops
    assert ids("fare_rules", "fare_id") <= ids("fare_attributes", "fare_id")
    assert ids("fare_rules", "origin_id") <= ids("stops", "zone_id")


def test_the_cut_is_a_feed_the_importer_reads(cut: dict, tmp_path: Path) -> None:
    feed_dir = tmp_path / "feed"
    feed_dir.mkdir()
    _write_feed_from_layers(cut, str(feed_dir))
    archive = tmp_path / "cut_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for path in feed_dir.iterdir():
            zf.write(path, path.name)
    importer = GtfsImporter()
    assert importer.validate(str(archive)).valid
    workdir = tmp_path / "reimport"
    workdir.mkdir()
    roles = {
        layer.role for layer in importer.extract_layers(str(archive), str(workdir))
    }
    assert {"stops", "routes", "trips", "stop_times", "shape_lines"} <= roles


def test_an_area_without_stops_is_refused(tables: Path, tmp_path: Path) -> None:
    empty = {
        "type": "Polygon",
        "coordinates": [
            [[1.0, 40.0], [1.1, 40.0], [1.1, 40.1], [1.0, 40.1], [1.0, 40.0]]
        ],
    }
    with pytest.raises(ValueError, match="no stops in this area"):
        pt_network.export_pt_network(
            duckdb.connect(), area=empty, store_dir=str(tables), workdir=str(tmp_path)
        )


def test_a_large_area_is_refused_before_anything_is_read(tmp_path: Path) -> None:
    big = {
        "type": "Polygon",
        "coordinates": [
            [[11.0, 47.0], [12.5, 47.0], [12.5, 48.5], [11.0, 48.5], [11.0, 47.0]]
        ],
    }
    with pytest.raises(ValueError, match="too large for a public transport network"):
        pt_network.export_pt_network(
            duckdb.connect(), area=big, store_dir=str(tmp_path), workdir=str(tmp_path)
        )
