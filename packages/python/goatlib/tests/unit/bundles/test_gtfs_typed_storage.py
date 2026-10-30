"""GTFS member layers are stored typed where the GTFS reference types a field.

Times, dates, numbers and enums are parsed strictly; ids and text stay as
published. A value that does not parse fails the file when the field is
required, and is dropped (and logged) when it is optional.
"""

import logging
import zipfile
from pathlib import Path
from typing import Dict

import duckdb
import pytest
from goatlib.bundles.artifacts.gtfs import (
    GtfsArtifactBuilder,
    _write_feed_from_layers,
)
from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter

FEED = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nA,Agency,https://a.example,Europe/Berlin\n",
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon,location_type,wheelchair_boarding,vendor_code\n"
        "007,First, 48.1 ,11.5,0,1,x1\n"
        "S2,Second,48.2,11.6,,yes,x2\n"
    ),
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
    "trips.txt": "route_id,service_id,trip_id,direction_id\nR1,WK,T1,0\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T1,7:5:00,7:5:00,007,1\n"
        "T1,25:10:00,25:10:00,S2,2\n"
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "WK,1,1,1,1,1,0,0,20260105,20260630\n"
    ),
    "calendar_dates.txt": "service_id,date,exception_type\nWK,20260106,2\n",
    "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nT1,06:00:00,24:30:00,600\n",
}


def _extract(tmp_path: Path, **changes: str) -> Dict[str, str]:
    archive = tmp_path / "feed_gtfs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for name, text in {**FEED, **changes}.items():
            zf.writestr(name, text)
    work = tmp_path / "work"
    work.mkdir()
    layers = GtfsImporter().extract_layers(str(archive), str(work))
    return {layer.role: layer.file_path for layer in layers}


def _types(path: str) -> Dict[str, str]:
    return {
        row[0]: str(row[1])
        for row in duckdb.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{path}')"
        ).fetchall()
    }


def _column(path: str, column: str, order: str = "file_row_number") -> list:
    """A column's values, in file order unless ``order`` names a column
    (stops are written in spatial order, not the feed's)."""
    return [
        row[0]
        for row in duckdb.execute(
            f"SELECT \"{column}\" FROM read_parquet('{path}', file_row_number=true) "
            f"ORDER BY {order}"
        ).fetchall()
    ]


def test_reference_fields_are_typed_and_the_rest_stay_text(tmp_path: Path) -> None:
    paths = _extract(tmp_path)

    stops = _types(paths["stops"])
    assert stops["stop_id"] == "VARCHAR"
    assert stops["stop_lat"] == "DOUBLE"
    assert stops["location_type"] == "INTEGER"
    assert stops["vendor_code"] == "VARCHAR"  # not in the reference
    st = _types(paths["stop_times"])
    assert st["arrival_time"] == "INTERVAL"
    assert st["stop_sequence"] == "INTEGER"
    assert st["trip_id"] == "VARCHAR"
    assert _types(paths["calendar"])["start_date"] == "DATE"
    assert _types(paths["calendar_dates"])["exception_type"] == "INTEGER"
    assert _types(paths["frequencies"])["end_time"] == "INTERVAL"
    # A file the schema does not describe stays text throughout.
    assert set(_types(paths["agency"]).values()) == {"VARCHAR"}


def test_values_parse_as_gtfs_means_them(tmp_path: Path) -> None:
    paths = _extract(tmp_path)

    # An id that looks like a number keeps its leading zeros.
    assert _column(paths["stops"], "stop_id", "stop_id") == ["007", "S2"]
    assert _column(paths["stops"], "stop_lat", "stop_id") == [48.1, 48.2]  # trimmed
    # Times past midnight are kept; leading zeros may be left out.
    seconds = duckdb.execute(
        f"SELECT CAST(epoch(arrival_time) AS INT) FROM read_parquet('{paths['stop_times']}')"
    ).fetchall()
    assert [s for (s,) in seconds] == [7 * 3600 + 5 * 60, 25 * 3600 + 10 * 60]
    # An empty value is no value.
    assert _column(paths["stops"], "location_type", "stop_id") == [0, None]


def test_an_optional_value_that_does_not_parse_is_dropped_and_logged(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        paths = _extract(tmp_path)

    assert _column(paths["stops"], "wheelchair_boarding", "stop_id") == [1, None]
    assert any(
        "stops.txt: 1 value(s) in wheelchair_boarding" in r.message
        and r.message.endswith("; dropped")
        and "'yes'" in r.message
        for r in caplog.records
    )


def test_a_required_value_that_does_not_parse_fails_an_essential_file(
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="routes.txt could not be read: 1 value"):
        _extract(
            tmp_path,
            **{
                "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,A,1,bus\n"
            },
        )


def test_a_required_value_that_does_not_parse_skips_an_optional_file(
    tmp_path: Path,
) -> None:
    paths = _extract(
        tmp_path,
        **{
            "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nT1,06:00:00,07:00:00,ten\n"
        },
    )
    assert "frequencies" not in paths
    assert "stop_times" in paths


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("stop_sequence", "1.0"),  # an integer field takes no decimals
        ("arrival_time", "-1:00:00"),  # nor a negative time
        ("arrival_time", "07:05"),  # a time has seconds
        ("arrival_time", "08:61:00"),
    ],
)
def test_parsing_is_stricter_than_duckdbs_own_casts(
    tmp_path: Path, column: str, value: str
) -> None:
    row = {"stop_sequence": "1", "arrival_time": "08:00:00"} | {column: value}
    text = (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        f"T1,{row['arrival_time']},08:00:00,007,{row['stop_sequence']}\n"
        "T1,08:05:00,08:05:00,S2,2\n"
    )
    if column == "stop_sequence":
        # Required: the file the feed cannot do without fails.
        with pytest.raises(ValueError, match="stop_sequence"):
            _extract(tmp_path, **{"stop_times.txt": text})
    else:
        paths = _extract(tmp_path, **{"stop_times.txt": text})
        assert _column(paths["stop_times"], column)[0] is None


def test_write_back_restores_gtfs_text(tmp_path: Path) -> None:
    paths = _extract(tmp_path)
    feed = tmp_path / "feed"
    feed.mkdir()
    _write_feed_from_layers(paths, str(feed))

    stop_times = (feed / "stop_times.txt").read_text().splitlines()
    assert stop_times[1:] == ["T1,07:05:00,07:05:00,007,1", "T1,25:10:00,25:10:00,S2,2"]
    calendar = (feed / "calendar.txt").read_text().splitlines()
    assert calendar[1] == "WK,1,1,1,1,1,0,0,20260105,20260630"
    assert (feed / "calendar_dates.txt").read_text().splitlines()[1] == "WK,20260106,2"
    assert (feed / "frequencies.txt").read_text().splitlines()[
        1
    ] == "T1,06:00:00,24:30:00,600"


def test_service_window_reads_typed_dates(tmp_path: Path) -> None:
    """The window comes from the feed's own dates, not the no-dates fallback
    a typed DATE would fall through to if it were read as text."""
    paths = _extract(tmp_path)
    assert GtfsArtifactBuilder._window_from_layers(
        paths
    ) == GtfsArtifactBuilder._window_from_dates(["20260105", "20260630", "20260106"])
    assert GtfsArtifactBuilder._window_from_layers(
        paths
    ) != GtfsArtifactBuilder._window_from_dates([])
