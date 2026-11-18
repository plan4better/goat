"""Decoration points of line tiles: start, end and center points of each line,
with the bearing of the line there, also for multipart lines."""

import json
import math
import subprocess
from pathlib import Path
from types import SimpleNamespace

import duckdb
import manby
import pytest

Z = 14

COLUMNS = [
    {"name": "name", "type": "VARCHAR"},
    {"name": "geometry", "type": "GEOMETRY"},
]


def _tile_of(lng: float, lat: float) -> tuple[int, int]:
    n = 2**Z
    x = int((lng + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


@pytest.fixture
def multipart() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    # Lines inside one z14 tile in Munich, all drawn west to east. Route M's
    # parts join end to end; Route S's parts lie apart, the longer one east.
    # Multipart lines come this way from GeoPackage and Shapefile imports.
    con.execute(
        "CREATE TABLE routes AS SELECT * FROM (VALUES "
        "('Route M', ST_GeomFromText('MULTILINESTRING((11.5700 48.1440, 11.5720 48.1440), "
        "(11.5720 48.1440, 11.5740 48.1440))')), "
        "('Route A', ST_GeomFromText('LINESTRING(11.5700 48.1400, 11.5740 48.1400)')), "
        "('Route B', ST_GeomFromText('LINESTRING(11.5700 48.1420, 11.5740 48.1420)')), "
        "('Route S', ST_GeomFromText('MULTILINESTRING((11.5700 48.1460, 11.5710 48.1460), "
        "(11.5720 48.1460, 11.5750 48.1460))'))"
        ") t(name, geometry)"
    )
    return con


def _tile_layers(
    duck: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    decoration: str,
) -> dict[str, list[dict]]:
    """The features of the tile around the routes, by MVT layer."""
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
        columns=COLUMNS,
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


KINDS = {
    "start": ["start"],
    "end": ["end"],
    "start_and_end": ["start", "end"],
    "center": ["center"],
}


@pytest.mark.parametrize("decoration", list(KINDS))
def test_a_multipart_line_gets_its_decoration_points(
    multipart, monkeypatch, tmp_path, decoration
) -> None:
    layers = _tile_layers(multipart, monkeypatch, tmp_path, decoration)
    # The tile's database still answers.
    assert multipart.execute("SELECT 1").fetchone() == (1,)

    # Decoration points share the ids of their lines.
    names = {f["id"]: f["properties"]["name"] for f in layers["default"]}
    points: dict[str, list[tuple[float, float]]] = {}
    for f in layers.get("default_decoration", []):
        lng, _ = f["geometry"]["coordinates"]
        points.setdefault(names[f["id"]], []).append((lng, f["properties"]["bearing"]))
    kinds = KINDS[decoration]
    assert sorted(points) == ["Route A", "Route B", "Route M", "Route S"]
    assert all(len(found) == len(kinds) for found in points.values())

    # Joined parts are one line; of parts that lie apart, the longest stands
    # for the line. Drawn west to east, the start lies west of the end.
    where = {"start": 0, "center": 1, "end": 2}
    expected_lng = {
        "Route M": (11.5700, 11.5720, 11.5740),
        "Route S": (11.5720, 11.5735, 11.5750),
    }
    for line, found in points.items():
        found.sort()
        for kind, (lng, bearing) in zip(kinds, found):
            if line in expected_lng:
                assert lng == pytest.approx(expected_lng[line][where[kind]], abs=2e-5)
            assert abs(bearing - 90) < 1
