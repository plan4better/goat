"""Filtered stored tiles hold the features DuckDB's filter selects.

A seeded city of points, lines and polygons is built by goatlib's manby
recipes and filtered tile by tile with geoapi's stored-tile path
(`TileService.get_filtered_tile_from_pmtiles`). The feature ids of the tiles
are compared with `SELECT rowid + 1` under the WHERE clause GOAT's dynamic
tiles use (`build_filters`).

- Points: each branch of the variable-depth pyramid ends at its own zoom, so
  the tiles compared are the archive's leaves (the stored tiles without
  children), each filtered as itself. They hold the ids DuckDB keeps.
- Lines and polygons: the lines fit one stored tile of zoom 0, which manby
  cuts at detail 16 like every tile; at zoom 0 that drops streets smaller
  than a tile unit (about 0.005 degrees). The polygons are stored at every
  zoom down to the one manby guesses, below CUT_ZOOM. Both are compared on
  the tiles of zoom 13 cut from the deepest stored tiles, as a map of the
  city requests them, and hold the ids DuckDB keeps. With an area a tile tests
  the feature's piece in it, so a feature crossing the area's border is
  missing from the tiles where its piece misses the area (spec 6.3), but not
  from all of them.
"""

import asyncio
import gzip
import json
import math
import random
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch

import duckdb
import pyarrow as pa
import pytest
from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator
from goatlib.storage import build_filters
from pmtiles.reader import MmapSource, all_tiles

from geoapi.dependencies import LayerInfo
from geoapi.services import tile_filter
from geoapi.services.tile_service import TileService

# `geoapi.services.tile_service` resolves to the singleton instance, not the
# module. Go through sys.modules instead.
tile_service_module = sys.modules["geoapi.services.tile_service"]

CENTRE = (11.575, 48.14)
# Lines and polygons are cut to tiles of this zoom from their stored tiles
CUT_ZOOM = 13


def prop(name: str) -> dict:
    return {"property": name}


def op(name: str, *args: Any) -> dict:
    return {"op": name, "args": list(args)}


# =====================================================================
#  The city
# =====================================================================


def _ring(
    rng: random.Random, x: float, y: float, radius: float, vertices: int
) -> list[list[float]]:
    """A closed ring around (x, y) with a random radius at each vertex.

    Star-shaped around its centre, so valid with any radii; the latitude
    radius is shortened to look round at 48 degrees north.
    """
    ring = []
    for i in range(vertices):
        angle = 2 * math.pi * i / vertices
        r = radius * rng.uniform(0.7, 1.0)
        ring.append([x + r * math.cos(angle), y + 0.67 * r * math.sin(angle)])
    return ring + [ring[0]]


def _wkt_ring(ring: list[list[float]]) -> str:
    return "(" + ", ".join(f"{x!r} {y!r}" for x, y in ring) + ")"


def _point(rng: random.Random, i: int) -> str:
    """Two of three points in the centre, the others over the region."""
    cx, cy = CENTRE
    if i % 3:
        x, y = rng.gauss(cx, 0.003), rng.gauss(cy, 0.002)
    else:
        x, y = rng.uniform(cx - 0.3, cx + 0.3), rng.uniform(cy - 0.15, cy + 0.15)
    return f"POINT ({x!r} {y!r})"


def _start(rng: random.Random, i: int) -> tuple[float, float]:
    """Half the lines and polygons near the centre, the others over the city."""
    cx, cy = CENTRE
    if i % 2:
        return rng.gauss(cx, 0.01), rng.gauss(cy, 0.007)
    return rng.uniform(cx - 0.15, cx + 0.15), rng.uniform(cy - 0.075, cy + 0.075)


def _line(rng: random.Random, i: int) -> str:
    """Short streets, and every 20th a long road of about 6 km."""
    x, y = _start(rng, i)
    vertices, step = (100, 0.0008) if i % 20 == 0 else (rng.randint(2, 6), 0.001)
    heading = rng.uniform(0, 2 * math.pi)
    points = [(x, y)]
    for _ in range(vertices - 1):
        heading += rng.uniform(-0.3, 0.3)
        x, y = x + step * math.cos(heading), y + 0.67 * step * math.sin(heading)
        points.append((x, y))
    return "LINESTRING (" + ", ".join(f"{x!r} {y!r}" for x, y in points) + ")"


def _polygon(rng: random.Random, i: int) -> str:
    """Buildings, and every 20th a district of a few kilometres."""
    x, y = _start(rng, i)
    if i % 20 == 0:
        ring = _ring(rng, x, y, rng.uniform(0.01, 0.025), 120)
    else:
        ring = _ring(rng, x, y, rng.uniform(0.0002, 0.0006), rng.randint(4, 10))
    return f"POLYGON ({_wkt_ring(ring)})"


def _nullable(rng: random.Random, value: Any) -> Any:
    return None if rng.random() < 0.1 else value


NAMES = ["Hauptstraße", "Bahnhofstraße", "Lindenweg", "Am Anger", "Isarring", ""]
# Text holding numbers, with and without the leading zero
ZIPS = ["01234", "1234", "08150", "80331", "80333"]


def _attributes(rng: random.Random) -> dict[str, Any]:
    return {
        "name": _nullable(rng, rng.choice(NAMES)),
        "zip": _nullable(rng, rng.choice(ZIPS)),
        "n": _nullable(rng, rng.randrange(100)),
        "d": _nullable(rng, round(rng.uniform(0, 10), 2)),
        "b": _nullable(rng, rng.random() < 0.5),
        "day": _nullable(rng, date(2024, 1, 1) + timedelta(days=rng.randrange(366))),
    }


_SCHEMA = pa.schema(
    [
        ("name", pa.string()),
        ("zip", pa.string()),
        ("n", pa.int32()),
        ("d", pa.float64()),
        ("b", pa.bool_()),
        ("day", pa.date32()),
        ("wkt", pa.string()),
    ]
)
_LAYERS = {"points": (_point, 3000), "lines": (_line, 500), "polygons": (_polygon, 500)}


@dataclass
class Layer:
    info: LayerInfo
    table: str
    columns: list[dict]
    rows: int
    # Stored tiles without children: (z, x, y) -> the tile, uncompressed
    leaves: dict[tuple[int, int, int], bytes]


@dataclass
class City:
    con: duckdb.DuckDBPyConnection
    tiles_dir: Path
    layers: dict[str, Layer]


@pytest.fixture(scope="module")
def city(tmp_path_factory: pytest.TempPathFactory) -> City:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    tiles_dir = tmp_path_factory.mktemp("tiles")
    generator = PMTilesGenerator(tiles_data_dir=tiles_dir, config=PMTilesConfig())
    layers = {}
    for seed, (kind, (geometry, rows)) in enumerate(_LAYERS.items()):
        rng = random.Random(seed)
        records = [{**_attributes(rng), "wkt": geometry(rng, i)} for i in range(rows)]
        con.register("source", pa.Table.from_pylist(records, schema=_SCHEMA))
        con.execute(
            f"""
            CREATE TABLE {kind} AS
            SELECT * EXCLUDE (wkt), ST_GeomFromText(wkt) AS geometry FROM source
            """
        )
        con.unregister("source")
        layer_id = f"{seed + 1:032x}"
        path = generator.generate_from_table(con, kind, layer_id)
        assert path is not None
        with open(path, "rb") as f:
            stored = {
                zxy: gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
                for zxy, data in all_tiles(MmapSource(f))
            }
        leaves = {
            (z, x, y): tile
            for (z, x, y), tile in stored.items()
            if not any(
                (z + 1, 2 * x + i, 2 * y + j) in stored for i in (0, 1) for j in (0, 1)
            )
        }
        columns = [
            {"name": name, "type": type_}
            for name, type_, *_ in con.execute(f"DESCRIBE {kind}").fetchall()
        ]
        info = LayerInfo(layer_id=layer_id, schema_name="user_x", table_name=path.stem)
        layers[kind] = Layer(info, kind, columns, rows, leaves)
    return City(con, tiles_dir, layers)


# =====================================================================
#  Tiles
# =====================================================================


def _varint(data: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, i
        shift += 7


def _fields(data: bytes) -> Iterator[tuple[int, Any]]:
    """The fields of a protobuf message: (number, varint or bytes)."""
    i = 0
    while i < len(data):
        key, i = _varint(data, i)
        number, wire_type = key >> 3, key & 7
        if wire_type == 0:
            value, i = _varint(data, i)
            yield number, value
        elif wire_type == 2:
            length, i = _varint(data, i)
            yield number, data[i : i + length]
            i += length
        elif wire_type in (1, 5):  # fixed64, fixed32
            i += 8 if wire_type == 1 else 4
        else:
            raise ValueError(f"wire type {wire_type}")


def _feature_ids(tile: bytes) -> set[int]:
    """The feature ids of an MVT tile (Tile.layers = 3, Layer.features = 2,
    Feature.id = 1)."""
    if tile[:2] == b"\x1f\x8b":
        tile = gzip.decompress(tile)
    return {
        value
        for number, layer in _fields(tile)
        if number == 3
        for number, feature in _fields(layer)
        if number == 2
        for number, value in _fields(feature)
        if number == 1
    }


def _tile_of(lon: float, lat: float, z: int) -> tuple[int, int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return z, x, y


def _tiles_over(city: City, layer: Layer, z: int) -> list[tuple[int, int, int]]:
    """The tiles of zoom z over the layer's data."""
    west, south, east, north = city.con.execute(
        f"""
        SELECT min(ST_XMin(geometry)), min(ST_YMin(geometry)),
               max(ST_XMax(geometry)), max(ST_YMax(geometry))
        FROM {layer.table}
        """
    ).fetchone()
    _, x0, y0 = _tile_of(west, north, z)
    _, x1, y1 = _tile_of(east, south, z)
    return [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


@pytest.fixture(autouse=True)
def empty_caches() -> Iterator[None]:
    tile_filter._prepared.clear()
    tile_service_module._pmtiles_reader_cache.clear()
    yield
    tile_filter._prepared.clear()
    tile_service_module._pmtiles_reader_cache.clear()


@pytest.fixture
def service(city: City) -> Iterator[TileService]:
    service = TileService()
    service.tiles_data_dir = city.tiles_dir
    with (
        patch("geoapi.tile_cache.get_redis_client", return_value=None),
        # the module's semaphore binds to the first loop that waits on it
        patch.object(
            tile_service_module,
            "_manby_slots",
            asyncio.Semaphore(tile_service_module._manby_concurrency()),
        ),
    ):
        yield service


# =====================================================================
#  Filters
# =====================================================================


def _area(x: float, y: float, radius: float, seed: int) -> list[list[float]]:
    return _ring(random.Random(seed), x, y, radius, 160)


cx, cy = CENTRE
# Over the centre, with a hole over the densest points
DISTRICT = {
    "type": "Polygon",
    "coordinates": [
        _area(cx + 0.01, cy, 0.08, 1),
        [[cx - 0.003, cy - 0.002], [cx + 0.003, cy - 0.002], [cx + 0.003, cy + 0.002],
         [cx - 0.003, cy + 0.002], [cx - 0.003, cy - 0.002]],
    ],
}  # fmt: skip
TWO_PARTS = {
    "type": "MultiPolygon",
    "coordinates": [
        [_area(cx - 0.07, cy + 0.03, 0.03, 2)],
        [_area(cx + 0.004, cy - 0.003, 0.02, 3)],
    ],
}
BBOX = [cx - 0.06, cy - 0.04, cx + 0.08, cy + 0.035]
# Inside BBOX
INNER = {"type": "Polygon", "coordinates": [_area(cx, cy, 0.02, 4)]}


@dataclass(frozen=True)
class Case:
    """A tile request's filter: attributes, areas for s_intersects, bbox."""

    name: str
    attributes: dict | None = None
    areas: tuple[dict, ...] = ()
    bbox: list[float] | None = None

    def cql(self, area_op: str = "s_intersects") -> dict | None:
        tests = [op(area_op, prop("geometry"), area) for area in self.areas]
        if self.attributes is not None:
            tests.insert(0, self.attributes)
        if not tests:
            return None
        text = json.dumps(tests[0] if len(tests) == 1 else op("and", *tests))
        return {"filter": text, "lang": "cql2-json"}


ATTRIBUTE_CASES = [
    Case("n < 30", op("<", prop("n"), 30)),
    Case("n <> 50", op("<>", prop("n"), 50)),
    Case("d >= 7.5", op(">=", prop("d"), 7.5)),
    Case("n between", op("between", prop("n"), [20, 60])),
    Case("name =", op("=", prop("name"), "Hauptstraße")),
    Case("like", op("like", prop("name"), "%straße")),
    Case("not like", op("not", op("like", prop("name"), "%weg%"))),
    Case("zip in", op("in", prop("zip"), ["01234", "08150"])),
    Case(
        "or of =", op("or", op("=", prop("zip"), "01234"), op("=", prop("zip"), "1234"))
    ),
    Case("is null", {"op": "isNull", "args": prop("name")}),
    Case("not is null", op("not", {"op": "isNull", "args": prop("d")})),
    Case("b = true", op("=", prop("b"), True)),
    Case("b <> true", op("<>", prop("b"), True)),
    Case("day >=", op(">=", prop("day"), "2024-07-01T00:00:00")),
    Case("not or", op("not", op("or", op("<", prop("n"), 10), op(">", prop("d"), 9)))),
    Case("id in", op("in", prop("id"), [1, 2, 3, 50, 77, 250, 499])),
    Case("and", op("and", op(">=", prop("n"), 50), op("like", prop("name"), "%str%"))),
]
AREA_CASES = [
    Case("district", areas=(DISTRICT,)),
    Case("two parts", areas=(TWO_PARTS,)),
    Case("bbox", bbox=BBOX),
    Case("n < 50 in district", op("<", prop("n"), 50), (DISTRICT,)),
    Case(
        "b = false or d < 2 in two parts",
        op("or", op("=", prop("b"), False), op("<", prop("d"), 2)),
        (TWO_PARTS,),
    ),
    Case("like in inner and bbox", op("like", prop("name"), "%str%"), (INNER,), BBOX),
    Case("d >= 5 and bbox", op(">=", prop("d"), 5), bbox=BBOX),
]


def _duckdb_ids(city: City, layer: Layer, case: Case, inside: bool = False) -> set[int]:
    """The ids DuckDB keeps, or with `inside` those lying inside the areas."""
    cql, bbox = case.cql(), case.bbox
    if inside:
        rectangle = [tile_filter._rectangle(bbox)] if bbox else []
        cql = Case(case.name, case.attributes, (*case.areas, *rectangle)).cql(
            "s_within"
        )
        bbox = None
    names = [c["name"] for c in layer.columns]
    where = build_filters(bbox=bbox, cql_filter=cql, column_names=names)
    assert where.clauses, "DuckDB did not take the filter"
    rows = city.con.execute(
        f"SELECT rowid + 1 FROM {layer.table} WHERE {where.to_full_where()}",
        where.params,
    ).fetchall()
    return {row[0] for row in rows}


async def _tile_ids(
    service: TileService,
    layer: Layer,
    case: Case,
    tiles: list[tuple[int, int, int]],
) -> set[int]:
    """The ids in the tiles as geoapi filters them from the stored tiles."""

    async def tile(z: int, x: int, y: int) -> set[int]:
        result = await service.get_filtered_tile_from_pmtiles(
            layer.info,
            z,
            x,
            y,
            cql_filter=case.cql(),
            bbox=case.bbox,
            columns=layer.columns,
            label=False,
        )
        assert result is not None and result.tile is not None, "DuckDB answered"
        data, _, _ = result.tile
        return _feature_ids(data) if data else set()

    found = await asyncio.gather(*(tile(*zxy) for zxy in tiles))
    return set().union(*found)


# =====================================================================
#  The fixture
# =====================================================================


def test_the_leaves_hold_every_feature(city: City) -> None:
    for layer in city.layers.values():
        ids = set().union(*(_feature_ids(tile) for tile in layer.leaves.values()))
        assert ids == set(range(1, layer.rows + 1))


def test_the_points_end_at_several_zooms_and_drop_above(city: City) -> None:
    points = city.layers["points"]
    leaf_zooms = {z for z, _, _ in points.leaves}
    assert len(leaf_zooms) >= 3
    with open(city.tiles_dir / f"{points.info.table_name}.pmtiles", "rb") as f:
        stored = dict(all_tiles(MmapSource(f)))
    # the tile of zoom 0 holds a sample of the points
    assert len(_feature_ids(stored[(0, 0, 0)])) < points.rows


def test_lines_and_polygons_are_cut_from_the_stored_tiles(city: City) -> None:
    assert list(city.layers["lines"].leaves) == [(0, 0, 0)]
    # every zoom is stored down to the guessed one, below CUT_ZOOM
    deepest = max(z for z, _, _ in city.layers["polygons"].leaves)
    assert 0 < deepest < CUT_ZOOM


# =====================================================================
#  Points: the leaves of the pyramid
# =====================================================================


@pytest.mark.parametrize(
    "case", ATTRIBUTE_CASES + AREA_CASES, ids=lambda case: case.name
)
async def test_the_point_leaves_hold_the_ids_duckdb_keeps(
    case: Case, city: City, service: TileService
) -> None:
    points = city.layers["points"]
    expected = _duckdb_ids(city, points, case)
    assert 0 < len(expected) < points.rows

    assert await _tile_ids(service, points, case, list(points.leaves)) == expected


# =====================================================================
#  Lines and polygons: the tiles of a city map
# =====================================================================


@pytest.mark.parametrize("case", ATTRIBUTE_CASES, ids=lambda case: case.name)
@pytest.mark.parametrize("kind", ["lines", "polygons"])
async def test_attribute_filters_on_lines_and_polygons(
    kind: str, case: Case, city: City, service: TileService
) -> None:
    layer = city.layers[kind]
    expected = _duckdb_ids(city, layer, case)
    assert 0 < len(expected) < layer.rows

    tiles = _tiles_over(city, layer, CUT_ZOOM)
    assert await _tile_ids(service, layer, case, tiles) == expected


@pytest.mark.parametrize("case", AREA_CASES, ids=lambda case: case.name)
@pytest.mark.parametrize("kind", ["lines", "polygons"])
async def test_area_filters_on_lines_and_polygons(
    kind: str, case: Case, city: City, service: TileService
) -> None:
    layer = city.layers[kind]
    expected = _duckdb_ids(city, layer, case)
    # the area's border crosses features
    assert _duckdb_ids(city, layer, case, inside=True) < expected

    # A tile tests the piece of a feature in it, so a feature crossing the
    # area's border is missing from the tiles where its piece misses the area
    # (spec 6.3). Over all tiles of a zoom it is there: its piece in the tile
    # where it meets the area meets the area.
    tiles = _tiles_over(city, layer, CUT_ZOOM)
    assert await _tile_ids(service, layer, case, tiles) == expected
