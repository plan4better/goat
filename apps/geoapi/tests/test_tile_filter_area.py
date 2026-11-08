"""A filter's area cut per tile, and prepared filters kept per file version.

manby tests a feature clipped to the output tile and its buffer, so of an area
only the part near the tile matters. `PreparedFilter.for_tile` hands manby
that part: nothing (no tile) when the area misses the tile, no area test when
it covers it, otherwise the area cut to the tile. The parity test runs manby
on a built polygon layer with the cut area and with the whole area and
compares the tiles byte for byte.
"""

import gzip
import json
import math
import random
import subprocess
import threading
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import duckdb
import manby
import pytest
import shapely
from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator
from pmtiles.reader import MmapSource, all_tiles

from geoapi.services import tile_filter
from geoapi.services.tile_filter import (
    PreparedFilter,
    TranslatedFilter,
    get_prepared_filter,
)

SQUARE = {
    "type": "Polygon",
    "coordinates": [[[7.0, 47.0], [8.0, 47.0], [8.0, 48.0], [7.0, 48.0], [7.0, 47.0]]],
}
# keeps the squares west of lon 7.534 and drops the strips
ATTRIBUTES = ["<", "n", 1200]
CENTRE = (7.5, 47.5)
# Zooms of the compared tiles; the layer is built to zoom 14, so the tiles of
# zoom 15 are cut from their parents
ZOOMS = (11, 13, 15)


def _ragged_area(vertices: int = 2000, seed: int = 7) -> dict:
    """A polygon around CENTRE with a jagged edge and a hole.

    Star-shaped around CENTRE with a random radius at each vertex, so it is
    valid with any radii.
    """
    rng = random.Random(seed)
    cx, cy = CENTRE
    ring = []
    for i in range(vertices):
        angle = 2 * math.pi * i / vertices
        radius = rng.uniform(0.02, 0.03)
        ring.append([cx + radius * math.cos(angle), cy + radius * math.sin(angle)])
    ring.append(ring[0])
    hole = [[7.508, 47.503], [7.508, 47.507], [7.512, 47.507], [7.512, 47.503]]
    return {"type": "Polygon", "coordinates": [ring, hole + [hole[0]]]}


RAGGED = _ragged_area()


def _tile_of(lon: float, lat: float, z: int) -> tuple[int, int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return z, x, y


def _tiles_near(area: dict, z: int) -> list[tuple[int, int, int]]:
    """The tiles of zoom z over the area's bounds and one tile around them."""
    minx, miny, maxx, maxy = shapely.from_geojson(json.dumps(area)).bounds
    _, x0, y0 = _tile_of(minx, maxy, z)
    _, x1, y1 = _tile_of(maxx, miny, z)
    return [(z, x, y) for x in range(x0 - 1, x1 + 2) for y in range(y0 - 1, y1 + 2)]


@pytest.fixture(autouse=True)
def empty_cache() -> None:
    tile_filter._prepared.clear()


# =====================================================================
#  The filter for one tile
# =====================================================================


def test_a_tile_outside_the_area_gets_no_tile(tmp_path: Path) -> None:
    prepared = PreparedFilter(TranslatedFilter(attributes=ATTRIBUTES, area=SQUARE))

    assert prepared.for_tile(*_tile_of(0.5, 0.5, 10), tmp_path) is False
    assert list(tmp_path.iterdir()) == []


def test_a_tile_inside_the_area_gets_only_the_attribute_test(tmp_path: Path) -> None:
    prepared = PreparedFilter(TranslatedFilter(attributes=ATTRIBUTES, area=SQUARE))

    path = prepared.for_tile(*_tile_of(7.5, 47.5, 12), tmp_path)

    assert isinstance(path, Path) and path.parent == tmp_path
    assert json.loads(path.read_text()) == {"*": ATTRIBUTES}


def test_a_tile_inside_the_area_without_attributes_needs_no_filter(
    tmp_path: Path,
) -> None:
    prepared = PreparedFilter(TranslatedFilter(attributes=None, area=SQUARE))

    assert prepared.for_tile(*_tile_of(7.5, 47.5, 12), tmp_path) is None
    assert list(tmp_path.iterdir()) == []


def test_without_an_area_every_tile_gets_the_attribute_test(tmp_path: Path) -> None:
    attributes = ["==", "Straße Name", "Hauptstraße"]
    prepared = PreparedFilter(TranslatedFilter(attributes=attributes, area=None))

    for z, x, y in (_tile_of(0.5, 0.5, 3), _tile_of(7.5, 47.5, 14)):
        path = prepared.for_tile(z, x, y, tmp_path)
        assert isinstance(path, Path)
        assert json.loads(path.read_text(encoding="utf-8")) == {"*": attributes}


def test_a_border_tile_gets_the_area_near_the_tile(tmp_path: Path) -> None:
    prepared = PreparedFilter(TranslatedFilter(attributes=ATTRIBUTES, area=RAGGED))
    # on the area's eastern edge
    path = prepared.for_tile(*_tile_of(7.525, 47.5, 15), tmp_path)

    assert isinstance(path, Path)
    attributes, (operator, area) = json.loads(path.read_text())["*"][1:]
    assert attributes == ATTRIBUTES and operator == "intersects"
    vertices = shapely.get_num_coordinates(shapely.from_geojson(json.dumps(area)))
    assert 0 < vertices < 2000 / 10


# =====================================================================
#  manby gives the same tiles as with the whole area
# =====================================================================


@dataclass
class Layer:
    tiles: dict[tuple[int, int, int], bytes]  # the stored tiles, uncompressed
    folder: Path

    def stored_or_parent(
        self, z: int, x: int, y: int
    ) -> tuple[tuple[int, int, int], Path] | None:
        """The stored tile geoapi would cut (z, x, y) from, as a file."""
        while (z, x, y) not in self.tiles:
            if z == 0:
                return None
            z, x, y = z - 1, x >> 1, y >> 1
        path = self.folder / f"{z}-{x}-{y}.mvt"
        if not path.exists():
            path.write_bytes(self.tiles[(z, x, y)])
        return (z, x, y), path


@pytest.fixture(scope="module")
def layer(tmp_path_factory: pytest.TempPathFactory) -> Layer:
    """Small numbered squares around CENTRE and two strips across it, built
    by manby to zoom 14."""
    features = []
    for i in range(48):
        for j in range(32):
            x, y = 7.44 + 0.0025 * i, 47.46 + 0.0025 * j
            features.append(shapely.box(x, y, x + 0.002, y + 0.002))
    features.append(shapely.box(7.43, 47.4995, 7.57, 47.5005))
    features.append(shapely.box(7.4995, 47.45, 7.5005, 47.55))
    tmp = tmp_path_factory.mktemp("area-layer")
    source = tmp / "polygons.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"n": n},
                        "geometry": json.loads(shapely.to_geojson(feature)),
                    }
                    for n, feature in enumerate(features)
                ],
            }
        )
    )
    archive = tmp / "polygons.pmtiles"
    manby.tile(str(source), archive, "-z14", layer="polygons")
    with open(archive, "rb") as f:
        tiles = {
            zxy: gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
            for zxy, data in all_tiles(MmapSource(f))
        }
    return Layer(tiles, tmp)


def _overzoom(
    layer: Layer, z: int, x: int, y: int, filter_path: Path | None, out: Path
) -> bytes:
    """The tile as geoapi's `_run_overzoom` cuts it, uncompressed."""
    found = layer.stored_or_parent(z, x, y)
    assert found is not None
    (pz, px, py), stored = found
    out.unlink(missing_ok=True)
    argv = [manby.binary(), "overzoom", "-o", str(out), "-b", "5", "-d", "16"]
    if filter_path is not None:
        argv += ["--feature-filter-file", str(filter_path)]
    argv += [str(stored), f"{pz}/{px}/{py}", f"{z}/{x}/{y}"]
    subprocess.run(argv, capture_output=True, check=True, timeout=10)
    data = out.read_bytes() if out.exists() else b""
    return gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data


def _with_area(attributes: list | None, area: dict) -> dict:
    """The filter of the whole area, one `intersects` per part as `for_tile`
    writes the cut."""
    polygons = (
        area["coordinates"] if area["type"] == "MultiPolygon" else [area["coordinates"]]
    )
    tests = [["intersects", {"type": "Polygon", "coordinates": p}] for p in polygons]
    test = tests[0] if len(tests) == 1 else ["any", *tests]
    return {"*": test if attributes is None else ["all", attributes, test]}


# Tiles of zoom 18 across the area's eastern and northern edges, cut from
# their parents of zoom 14 as geoapi cuts deep tiles
_EDGE_TILES = list(
    dict.fromkeys(
        [_tile_of(7.515 + 0.0007 * i, 47.5, 18) for i in range(30)]
        + [_tile_of(7.5, 47.515 + 0.0005 * i, 18) for i in range(40)]
    )
)


def _area_in(filter_path: Path) -> dict | None:
    """The area of the filter file's `intersects` tests, if it has any: one
    per part, under `any` when there are several."""
    expression = json.loads(filter_path.read_text())["*"]
    for test in expression[1:] if expression[0] == "all" else [expression]:
        parts = test[1:] if test[0] == "any" else [test]
        if all(part[0] == "intersects" for part in parts):
            polygons = [part[1]["coordinates"] for part in parts]
            return {"type": "MultiPolygon", "coordinates": polygons}
    return None


@pytest.mark.parametrize("attributes", [None, ATTRIBUTES], ids=["area", "both"])
def test_the_cut_area_gives_the_tiles_of_the_whole_area(
    attributes: list | None, layer: Layer, tmp_path: Path
) -> None:
    prepared = PreparedFilter(TranslatedFilter(attributes=attributes, area=RAGGED))
    whole = tmp_path / "whole.json"
    whole.write_text(json.dumps(_with_area(attributes, RAGGED)))
    out = tmp_path / "out.mvt.gz"
    outcomes: Counter[tuple[int, str]] = Counter()
    cut_vertices: dict[int, int] = {}

    tiles = [tile for z in ZOOMS for tile in _tiles_near(RAGGED, z)] + _EDGE_TILES
    for z, x, y in tiles:
        folder = tmp_path / f"{z}-{x}-{y}"
        folder.mkdir()
        expected = _overzoom(layer, z, x, y, whole, out)
        cut = prepared.for_tile(z, x, y, folder)
        if cut is False:
            assert expected == b"", (z, x, y)
            outcomes[(z, "no tile")] += 1
            continue
        assert _overzoom(layer, z, x, y, cut, out) == expected, (z, x, y)
        area = None if cut is None else _area_in(cut)
        if area is None:
            outcomes[(z, "no area test")] += 1
            continue
        vertices = shapely.get_num_coordinates(shapely.from_geojson(json.dumps(area)))
        cut_vertices[z] = max(cut_vertices.get(z, 0), vertices)
        outcomes[(z, "cut, features kept" if expected else "cut, none kept")] += 1

    # every way through at zoom 15, and cut tiles along the edges at zoom 18
    assert {o for z, o in outcomes if z == 15} >= {
        "no tile",
        "no area test",
        "cut, features kept",
    }
    assert outcomes[(15, "cut, features kept")] >= 10
    assert cut_vertices[15] < 2000 / 5
    assert outcomes[(18, "cut, features kept")] >= 5


def test_an_area_touching_only_the_margin_gives_no_tile(
    layer: Layer, tmp_path: Path
) -> None:
    z, x, y = _tile_of(*CENTRE, 13)
    _, south, east, north = tile_filter._lonlat_box(z, x, y)
    # east of the tile, its western edge on the box's eastern edge
    ring = [[east, south], [east + 0.05, south], [east + 0.05, north], [east, north]]
    area = {"type": "Polygon", "coordinates": [ring + [ring[0]]]}
    whole = tmp_path / "whole.json"
    whole.write_text(json.dumps(_with_area(None, area)))

    prepared = PreparedFilter(TranslatedFilter(attributes=None, area=area))

    assert prepared.for_tile(z, x, y, tmp_path) is False
    assert _overzoom(layer, z, x, y, None, tmp_path / "out.mvt.gz") != b""
    assert _overzoom(layer, z, x, y, whole, tmp_path / "out.mvt.gz") == b""


# =====================================================================
#  An area of several parts
# =====================================================================

# manby finds an area wholly inside a polygon feature by one vertex of the
# area's first part, so `for_tile` writes one test per part. The forest holds
# one part of the area and touches no other, in either order.
FOREST = shapely.box(7.0, 47.0, 8.0, 48.0)
FAR = shapely.box(9.0, 46.0, 9.1, 46.1)
# Parts of an area: one beside the forest, one wholly inside it
BESIDE_FOREST = shapely.box(8.2, 47.2, 8.25, 47.25)
IN_FOREST = shapely.box(7.4, 47.4, 7.45, 47.45)


@dataclass
class Woods:
    con: duckdb.DuckDBPyConnection  # the table `woods`: name, geometry
    layer: Layer


@pytest.fixture(scope="module")
def woods(tmp_path_factory: pytest.TempPathFactory) -> Woods:
    """The forest and a square far from it, built by goatlib's polygon recipe."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute(
        "CREATE TABLE woods AS SELECT * FROM (VALUES "
        "('forest', ST_GeomFromText(?)), ('far', ST_GeomFromText(?))"
        ") AS v(name, geometry)",
        [FOREST.wkt, FAR.wkt],
    )
    tmp = tmp_path_factory.mktemp("woods")
    generator = PMTilesGenerator(tiles_data_dir=tmp, config=PMTilesConfig())
    archive = generator.generate_from_table(con, "woods", "1" * 32, show_progress=False)
    assert archive is not None
    with open(archive, "rb") as f:
        tiles = {
            zxy: gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
            for zxy, data in all_tiles(MmapSource(f))
        }
    return Woods(con, Layer(tiles, tmp))


def _names(tile: bytes, z: int, x: int, y: int, folder: Path) -> set[str]:
    """The `name` of each feature in the tile."""
    if not tile:
        return set()
    path = folder / "decode.mvt"
    path.write_bytes(tile)
    decoded = subprocess.run(
        [manby.binary(), "decode", str(path), str(z), str(x), str(y)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return {
        feature["properties"]["name"]
        for layer in json.loads(decoded)["features"]
        for feature in layer["features"]
    }


@pytest.mark.parametrize(
    "parts",
    [(BESIDE_FOREST, IN_FOREST), (IN_FOREST, BESIDE_FOREST)],
    ids=["inner part second", "inner part first"],
)
def test_a_polygon_holding_any_part_of_the_area_is_kept(
    parts: tuple[shapely.Polygon, ...], woods: Woods, tmp_path: Path
) -> None:
    area = shapely.to_geojson(shapely.MultiPolygon(parts))
    expected = {
        name
        for (name,) in woods.con.execute(
            "SELECT name FROM woods "
            "WHERE ST_Intersects(geometry, ST_GeomFromGeoJSON(?))",
            [area],
        ).fetchall()
    }
    assert expected == {"forest"}
    z, x, y = _tile_of(7.5, 47.5, 6)  # holds both parts and FAR
    out = tmp_path / "out.mvt.gz"
    unfiltered = _overzoom(woods.layer, z, x, y, None, out)
    assert _names(unfiltered, z, x, y, tmp_path) == {"forest", "far"}

    prepared = PreparedFilter(TranslatedFilter(attributes=None, area=json.loads(area)))
    cut = prepared.for_tile(z, x, y, tmp_path)

    assert isinstance(cut, Path)
    tile = _overzoom(woods.layer, z, x, y, cut, out)
    assert _names(tile, z, x, y, tmp_path) == expected


# =====================================================================
#  Threads
# =====================================================================


def test_the_cut_reads_a_copy_that_is_not_prepared() -> None:
    # only the area's tests run under the lock, so the cut must not read the
    # geometry they prepare
    prepared = PreparedFilter(TranslatedFilter(attributes=None, area=RAGGED))

    assert shapely.is_prepared(prepared.area)
    assert not shapely.is_prepared(prepared._area_for_cut)
    assert shapely.equals_exact(prepared._area_for_cut, prepared.area, tolerance=0)


def test_threads_share_one_prepared_filter(tmp_path: Path) -> None:
    tiles = [t for z in (14, 15) for t in _tiles_near(RAGGED, z)]
    translated = TranslatedFilter(attributes=ATTRIBUTES, area=RAGGED)
    expected = {}
    single = PreparedFilter(translated)
    for i, tile in enumerate(tiles):
        folder = tmp_path / "single" / str(i)
        folder.mkdir(parents=True)
        path = single.for_tile(*tile, folder)
        expected[tile] = path.read_text() if isinstance(path, Path) else path

    threads = 16
    for round_ in range(5):
        # a new one each round: the prepared index is built on its first use
        prepared = PreparedFilter(translated)
        start = threading.Barrier(threads)
        results: dict[tuple[int, int, int], str | None | bool] = {}
        errors: list[BaseException] = []

        def cut(worker: int) -> None:
            try:
                start.wait()
                for i in range(worker, len(tiles), threads):
                    folder = tmp_path / f"round-{round_}" / str(i)
                    folder.mkdir(parents=True)
                    path = prepared.for_tile(*tiles[i], folder)
                    results[tiles[i]] = (
                        path.read_text() if isinstance(path, Path) else path
                    )
            except BaseException as e:  # reported below
                errors.append(e)

        workers = [threading.Thread(target=cut, args=(w,)) for w in range(threads)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()

        assert errors == []
        assert results == expected


# =====================================================================
#  Prepared once per file version and filter
# =====================================================================


def test_the_same_version_and_filter_share_one_prepared_filter() -> None:
    translated = TranslatedFilter(attributes=ATTRIBUTES, area=SQUARE)
    # the same filter, its keys in another order
    reordered = TranslatedFilter(
        attributes=list(ATTRIBUTES),
        area={"coordinates": SQUARE["coordinates"], "type": "Polygon"},
    )

    prepared = get_prepared_filter("1700000000", translated)

    assert isinstance(prepared, PreparedFilter)
    assert get_prepared_filter("1700000000", reordered) is prepared
    assert get_prepared_filter("1700000001", translated) is not prepared
    other = TranslatedFilter(attributes=[">", "n", 1], area=SQUARE)
    assert get_prepared_filter("1700000000", other) is not prepared


def test_the_least_recently_used_prepared_filter_goes_first() -> None:
    def translated(i: int) -> TranslatedFilter:
        return TranslatedFilter(attributes=["==", "n", i], area=None)

    first = get_prepared_filter("v", translated(0))
    second = get_prepared_filter("v", translated(1))
    for i in range(2, 128):
        get_prepared_filter("v", translated(i))
    assert get_prepared_filter("v", translated(0)) is first  # used again

    get_prepared_filter("v", translated(128))  # one too many

    assert get_prepared_filter("v", translated(0)) is first
    assert get_prepared_filter("v", translated(1)) is not second


def test_a_key_from_the_caller_replaces_the_digest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    translated = TranslatedFilter(attributes=ATTRIBUTES, area=SQUARE)

    def no_digest(_: TranslatedFilter) -> str:
        raise AssertionError("filter_digest serialised the filter")

    monkeypatch.setattr(tile_filter, "filter_digest", no_digest)
    prepared = get_prepared_filter("v", translated, key="digest of the request")

    assert get_prepared_filter("v", translated, key="digest of the request") is prepared
    assert get_prepared_filter("v", translated, key="another") is not prepared
    assert get_prepared_filter("w", translated, key="digest of the request") is not (
        prepared
    )
