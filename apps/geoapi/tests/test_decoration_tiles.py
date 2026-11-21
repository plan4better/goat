"""Decoration points of line tiles (style spec 15): the kinds asked for, each point
naming its kind, with the attributes of its line, so markers, arrows and labels at
points of a line can be styled per feature."""

import json
import math
import subprocess
from pathlib import Path
from types import SimpleNamespace

import duckdb
import manby
import pytest
from fastapi import HTTPException

from geoapi.routers.tiles import decoration_kinds

Z = 14


def _tile_of(lng: float, lat: float) -> tuple[int, int]:
    n = 2**Z
    x = int((lng + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


@pytest.fixture
def duck() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    # Two short routes inside one z14 tile in Munich, drawn west to east.
    con.execute(
        "CREATE TABLE routes AS SELECT * FROM (VALUES "
        "('Route A', 1200, ST_GeomFromText('LINESTRING(11.5700 48.1400, 11.5740 48.1400)')), "
        "('Route B', 3900, ST_GeomFromText('LINESTRING(11.5700 48.1420, 11.5740 48.1420)'))"
        ") t(name, traffic, geometry)"
    )
    return con


COLUMNS = [
    {"name": "name", "type": "VARCHAR"},
    {"name": "traffic", "type": "INTEGER"},
    {"name": "geometry", "type": "GEOMETRY"},
]


def _tile_layers(
    duck: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    decoration: str,
    columns: list[dict] = COLUMNS,
    limit: int | None = None,
) -> dict[str, list[dict]]:
    """The features of the routes tile around the two routes, by MVT layer."""
    import importlib

    service = importlib.import_module("geoapi.services.tile_service")

    def execute(sql, params=None, **_):
        return duck.execute(sql, params or []).fetchone()

    monkeypatch.setattr(service.ducklake_pool, "execute_with_retry", execute)
    x, y = _tile_of(11.572, 48.141)
    tile = service.TileService()._generate_dynamic_tile(
        layer_info=SimpleNamespace(table_name="routes", full_table_name="routes"),
        z=Z,
        x=x,
        y=y,
        limit=limit,
        columns=columns,
        geometry_column="geometry",
        geometry_type="LineString",
        decoration=decoration,
    )
    path = tmp_path / "tile.mvt"
    path.write_bytes(tile)
    decoded = subprocess.run(
        [manby.binary(), "decode", str(path), str(Z), str(x), str(y)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return {
        layer["properties"]["layer"]: layer["features"]
        for layer in json.loads(decoded)["features"]
    }


def _decoration_points(
    duck: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    decoration: str,
    columns: list[dict] = COLUMNS,
) -> list[dict]:
    layers = _tile_layers(duck, monkeypatch, tmp_path, decoration, columns)
    return [f["properties"] for f in layers.get("default_decoration", [])]


def test_center_points_carry_their_line_attributes(duck, monkeypatch, tmp_path) -> None:
    points = _decoration_points(duck, monkeypatch, tmp_path, "center")
    assert sorted((p["name"], p["traffic"], p["_decoration"]) for p in points) == [
        ("Route A", 1200, "center"),
        ("Route B", 3900, "center"),
    ]
    # Drawn west to east: the bearing points east.
    assert all(abs(p["bearing"] - 90) < 1 for p in points)


def test_several_kinds_in_one_tile_each_name_their_kind(
    duck, monkeypatch, tmp_path
) -> None:
    points = _decoration_points(duck, monkeypatch, tmp_path, "start,end,center")
    kinds = sorted((p["name"], p["_decoration"]) for p in points)
    assert kinds == [
        ("Route A", "center"),
        ("Route A", "end"),
        ("Route A", "start"),
        ("Route B", "center"),
        ("Route B", "end"),
        ("Route B", "start"),
    ]


def test_start_and_end_still_asks_for_both_ends(duck, monkeypatch, tmp_path) -> None:
    points = _decoration_points(duck, monkeypatch, tmp_path, "start_and_end")
    assert sorted(p["_decoration"] for p in points) == ["end", "end", "start", "start"]


def test_decoration_kinds() -> None:
    assert decoration_kinds(None) is None
    assert decoration_kinds("center") == ["center"]
    assert decoration_kinds("start_and_end") == ["start", "end"]
    assert decoration_kinds("center,end,start,end") == ["start", "end", "center"]
    for bad in ("middle", "", "center,", "start;end"):
        with pytest.raises(HTTPException):
            decoration_kinds(bad)


@pytest.fixture
def multipart(duck: duckdb.DuckDBPyConnection) -> duckdb.DuckDBPyConnection:
    # Multipart lines as GeoPackage and Shapefile imports give them: one whose
    # parts join end to end, one whose parts lie apart (the longer one east).
    duck.execute(
        "INSERT INTO routes VALUES "
        "('Route M', 10, ST_GeomFromText('MULTILINESTRING((11.5700 48.1440, 11.5720 48.1440), "
        "(11.5720 48.1440, 11.5740 48.1440))')), "
        "('Route S', 20, ST_GeomFromText('MULTILINESTRING((11.5700 48.1460, 11.5710 48.1460), "
        "(11.5720 48.1460, 11.5750 48.1460))'))"
    )
    return duck


def _points_by_line(
    duck: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    decoration: str,
) -> dict[tuple[str, str], list[tuple[float, float, float]]]:
    """(line, kind) -> [(lng, lat, bearing)] of the tile's decoration points."""
    layers = _tile_layers(duck, monkeypatch, tmp_path, decoration)
    points: dict[tuple[str, str], list[tuple[float, float, float]]] = {}
    for f in layers.get("default_decoration", []):
        p = f["properties"]
        lng, lat = f["geometry"]["coordinates"]
        points.setdefault((p["name"], p["_decoration"]), []).append(
            (lng, lat, p["bearing"])
        )
    return points


@pytest.mark.parametrize("decoration", ["start", "end", "center", "start,end,center"])
def test_a_multipart_line_gets_one_point_of_each_kind(
    multipart, monkeypatch, tmp_path, decoration
) -> None:
    points = _points_by_line(multipart, monkeypatch, tmp_path, decoration)
    # The tile's database still answers.
    assert multipart.execute("SELECT 1").fetchone() == (1,)
    kinds = decoration.split(",")
    assert sorted(points) == sorted(
        (line, kind)
        for line in ("Route A", "Route B", "Route M", "Route S")
        for kind in kinds
    )
    assert all(len(found) == 1 for found in points.values())
    # Joined parts are one line; of parts that lie apart, the longest stands
    # for the line. All are drawn west to east.
    where = {"start": 0, "center": 1, "end": 2}
    expected_lng = {
        "Route M": (11.5700, 11.5720, 11.5740),
        "Route S": (11.5720, 11.5735, 11.5750),
    }
    for (line, kind), [(lng, _, bearing)] in points.items():
        if line in expected_lng:
            assert lng == pytest.approx(expected_lng[line][where[kind]], abs=2e-5)
        assert abs(bearing - 90) < 1


@pytest.mark.parametrize("column", ["kind", "geom"])
def test_line_attributes_named_like_internal_columns_stay_the_lines(
    monkeypatch, tmp_path, column
) -> None:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        f"CREATE TABLE routes AS SELECT * FROM (VALUES "
        f"('Route A', 'primary', ST_GeomFromText('LINESTRING(11.5700 48.1400, 11.5740 48.1400)'))"
        f') t(name, "{column}", geometry)'
    )
    columns = [
        {"name": "name", "type": "VARCHAR"},
        {"name": column, "type": "VARCHAR"},
        {"name": "geometry", "type": "GEOMETRY"},
    ]
    points = _decoration_points(con, monkeypatch, tmp_path, "center,end", columns)
    assert sorted(p["_decoration"] for p in points) == ["center", "end"]
    assert all(p[column] == "primary" for p in points)
    assert all(abs(p["bearing"] - 90) < 1 for p in points)


def test_decoration_points_have_the_ids_and_rowid_attribute_of_their_lines(
    monkeypatch, tmp_path
) -> None:
    # A column named rowid hides DuckDB's own row id from every query; the
    # decoration points then use the same ids as the lines.
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "CREATE TABLE routes AS SELECT * FROM (VALUES "
        "('Route A', 100, ST_GeomFromText('LINESTRING(11.5700 48.1400, 11.5740 48.1400)')), "
        "('Route B', 200, ST_GeomFromText('LINESTRING(11.5700 48.1420, 11.5740 48.1420)'))"
        ") t(name, rowid, geometry)"
    )
    columns = [
        {"name": "name", "type": "VARCHAR"},
        {"name": "rowid", "type": "INTEGER"},
        {"name": "geometry", "type": "GEOMETRY"},
    ]
    layers = _tile_layers(con, monkeypatch, tmp_path, "start,center", columns)
    line_ids = {f["properties"]["name"]: f["id"] for f in layers["default"]}
    points = layers["default_decoration"]
    assert len(points) == 4
    for point in points:
        p = point["properties"]
        assert point["id"] == line_ids[p["name"]]
        assert p["rowid"] == {"Route A": 100, "Route B": 200}[p["name"]]


def test_decoration_points_come_from_the_lines_of_the_main_layer(
    monkeypatch, tmp_path
) -> None:
    """The same bounding box pruning and feature limit as the main layer."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    # Route C's bounding box columns say it lies elsewhere: the row groups
    # they describe are skipped, by both layers.
    con.execute(
        "CREATE TABLE routes AS SELECT name, geometry, "
        'ST_XMin(geometry) + shift AS "$minx", ST_YMin(geometry) AS "$miny", '
        'ST_XMax(geometry) + shift AS "$maxx", ST_YMax(geometry) AS "$maxy" '
        "FROM (VALUES "
        "('Route A', 0, ST_GeomFromText('LINESTRING(11.5700 48.1400, 11.5740 48.1400)')), "
        "('Route B', 0, ST_GeomFromText('LINESTRING(11.5700 48.1420, 11.5740 48.1420)')), "
        "('Route C', 50, ST_GeomFromText('LINESTRING(11.5700 48.1440, 11.5740 48.1440)'))"
        ") t(name, shift, geometry)"
    )
    columns = [
        {"name": "name", "type": "VARCHAR"},
        {"name": "geometry", "type": "GEOMETRY"},
        *({"name": c, "type": "DOUBLE"} for c in ("$minx", "$miny", "$maxx", "$maxy")),
    ]

    def lines_and_points(limit: int | None) -> tuple[set[str], list[str]]:
        layers = _tile_layers(con, monkeypatch, tmp_path, "center", columns, limit)
        return (
            {f["properties"]["name"] for f in layers["default"]},
            [f["properties"]["name"] for f in layers["default_decoration"]],
        )

    lines, points = lines_and_points(None)
    assert lines == {"Route A", "Route B"}
    assert sorted(points) == ["Route A", "Route B"]
    lines, points = lines_and_points(1)
    assert len(lines) == 1
    assert points == list(lines)
