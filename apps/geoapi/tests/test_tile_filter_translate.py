"""CQL2 tile filters as manby feature filters.

`translate` turns a tile request's CQL2 filter (and `bbox`) into a manby
filter on the stored tiles, or returns None when manby cannot answer it exactly
as DuckDB does: the DuckDB tile then answers. The last test runs a set of
translated filters through manby on a built tile and compares the features with
DuckDB's WHERE clause on the same rows, NULLs included.
"""

import gzip
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import manby
import pytest
from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator
from goatlib.storage.query_builder import build_cql_filter
from pmtiles.reader import MmapSource, Reader, all_tiles

from geoapi.services.tile_filter import TranslatedFilter, translate

COLUMNS = [
    {"name": "n", "type": "BIGINT"},
    {"name": "d", "type": "DOUBLE"},
    {"name": "f", "type": "FLOAT"},
    {"name": "amount", "type": "DECIMAL(18,3)"},
    {"name": "big", "type": "HUGEINT"},
    {"name": "name", "type": "VARCHAR"},
    {"name": "zip", "type": "VARCHAR"},
    {"name": "b", "type": "BOOLEAN"},
    {"name": "day", "type": "DATE"},
    {"name": "ts", "type": "TIMESTAMP"},
    {"name": "tz", "type": "TIMESTAMP WITH TIME ZONE"},
    {"name": "u", "type": "UUID"},
    {"name": "t", "type": "TIME"},
    {"name": "Straße Name", "type": "VARCHAR"},
    {"name": "not_in_tiles", "type": "VARCHAR"},
    {"name": "geometry", "type": "GEOMETRY"},
]
TILE_FIELDS = {c["name"] for c in COLUMNS} - {"not_in_tiles", "geometry"}

POLYGON = {
    "type": "Polygon",
    "coordinates": [[[7.0, 47.0], [8.0, 47.0], [8.0, 48.0], [7.0, 48.0], [7.0, 47.0]]],
}
INNER = {
    "type": "Polygon",
    "coordinates": [[[7.2, 47.2], [7.8, 47.2], [7.8, 47.8], [7.2, 47.8], [7.2, 47.2]]],
}
MULTIPOLYGON = {"type": "MultiPolygon", "coordinates": [POLYGON["coordinates"]]}


def prop(name: str) -> dict:
    return {"property": name}


def op(name: str, *args: Any) -> dict:
    return {"op": name, "args": list(args)}


def run(
    cql: dict | str | None,
    bbox: list[float] | None = None,
    columns: list[dict] = COLUMNS,
    lang: str = "cql2-json",
) -> TranslatedFilter | None:
    cql_filter = None
    if cql is not None:
        text = cql if isinstance(cql, str) else json.dumps(cql)
        cql_filter = {"filter": text, "lang": lang}
    fields = TILE_FIELDS | {c["name"] for c in columns if c["name"] == "id"}
    return translate(cql_filter, bbox, columns, fields)


def attributes(cql: dict | str, lang: str = "cql2-json", **kwargs: Any) -> list:
    translated = run(cql, lang=lang, **kwargs)
    assert translated is not None
    assert translated.area is None
    return translated.attributes


# =====================================================================
#  Attribute tests
# =====================================================================


@pytest.mark.parametrize(
    ("cql", "expected"),
    [
        (op("=", prop("n"), 5), ["==", "n", 5]),
        (op("<>", prop("n"), 5), ["all", ["has", "n"], ["!=", "n", 5]]),
        (op("!=", prop("n"), 5), ["all", ["has", "n"], ["!=", "n", 5]]),
        (op("<", prop("n"), 5), ["<", "n", 5]),
        (op("<=", prop("n"), 5), ["<=", "n", 5]),
        (op(">", prop("d"), 2.5), [">", "d", 2.5]),
        (op(">=", prop("d"), 2.5), [">=", "d", 2.5]),
        # the tiles hold these as doubles
        (op("=", prop("f"), 0.1), ["==", "f", 0.1]),
        (op("<", prop("amount"), 0.5), ["<", "amount", 0.5]),
        (op(">", prop("big"), 5), [">", "big", 5]),
        # text DuckDB casts to an integer or double column without rounding
        (op("=", prop("n"), "5"), ["==", "n", 5]),
        (op("=", prop("n"), "+5"), ["==", "n", 5]),
        (op("=", prop("_rowid"), "7"), ["==", "$id", 7]),
        (op("<", prop("d"), "2.5"), ["<", "d", 2.5]),
    ],
)
def test_comparisons_on_a_number_column(cql: dict, expected: list) -> None:
    assert attributes(cql) == expected


def test_a_text_column_holding_numbers_keeps_the_string() -> None:
    assert attributes(op("=", prop("zip"), "01234")) == ["==", "zip", "01234"]
    assert attributes(op("in", prop("zip"), ["01234", "09876"])) == [
        "in",
        "zip",
        "01234",
        "09876",
    ]


def test_the_webs_or_of_equals_becomes_in() -> None:
    cql = op(
        "or",
        op("=", prop("zip"), "01234"),
        op("=", prop("zip"), "02345"),
        op("=", prop("zip"), "03456"),
    )
    assert attributes(cql) == ["in", "zip", "01234", "02345", "03456"]


def test_between() -> None:
    # pygeofilter's cql2-json form of between
    assert attributes(op("between", prop("n"), [1, 5])) == [
        "all",
        [">=", "n", 1],
        ["<=", "n", 5],
    ]
    assert attributes(
        "day BETWEEN '2024-05-01' AND '2024-05-31'", lang="cql2-text"
    ) == ["all", [">=", "day", "2024-05-01"], ["<=", "day", "2024-05-31"]]


def test_like_and_not_like() -> None:
    assert attributes(op("like", prop("name"), "Berl%")) == ["ilike", "name", "Berl%"]
    expected = ["all", ["has", "name"], ["!ilike", "name", "%berg%"]]
    # the web's "does not contain"
    assert attributes(op("not", op("like", prop("name"), "%berg%"))) == expected
    assert attributes("NOT name LIKE '%berg%'", lang="cql2-text") == expected


def test_not_in_carries_the_has_guard() -> None:
    expected = ["all", ["has", "zip"], ["!in", "zip", "01234", "02345"]]
    assert attributes(op("not", op("in", prop("zip"), ["01234", "02345"]))) == expected
    assert attributes("NOT zip IN ('01234', '02345')", lang="cql2-text") == expected


def test_is_null() -> None:
    # the web sends args as an object; the CQL2 standard as a list
    assert attributes({"op": "isNull", "args": prop("name")}) == ["!has", "name"]
    assert attributes(op("isNull", prop("name"))) == ["!has", "name"]
    assert attributes(op("not", {"op": "isNull", "args": prop("name")})) == [
        "has",
        "name",
    ]
    assert attributes("name IS NOT NULL", lang="cql2-text") == ["has", "name"]


@pytest.mark.parametrize(
    ("cql", "expected"),
    [
        (
            op("and", op("=", prop("n"), 5), op("like", prop("name"), "B%")),
            ["all", ["==", "n", 5], ["ilike", "name", "B%"]],
        ),
        (
            op("or", op("=", prop("n"), 5), op(">", prop("d"), 2.5)),
            ["any", ["==", "n", 5], [">", "d", 2.5]],
        ),
        # nested and/or chains flatten
        (
            op(
                "and",
                op("=", prop("n"), 5),
                op("<", prop("d"), 3),
                op("isNull", prop("zip")),
            ),
            ["all", ["==", "n", 5], ["<", "d", 3], ["!has", "zip"]],
        ),
        # not: true where SQL gives false (never where it gives NULL), so the
        # negation moves to the tests, each guarded with has
        (op("not", op("<", prop("n"), 3)), [">=", "n", 3]),
        (op("not", op("=", prop("n"), 3)), ["all", ["has", "n"], ["!=", "n", 3]]),
        (op("not", op("not", op("=", prop("n"), 3))), ["==", "n", 3]),
        (
            op("not", op("and", op("=", prop("n"), 1), op("=", prop("name"), "a"))),
            [
                "any",
                ["all", ["has", "n"], ["!=", "n", 1]],
                ["all", ["has", "name"], ["!=", "name", "a"]],
            ],
        ),
        (
            op("not", op("or", op("=", prop("n"), 1), op("<", prop("d"), 2))),
            ["all", ["has", "n"], ["!=", "n", 1], [">=", "d", 2]],
        ),
        (
            op("not", op("between", prop("n"), [1, 5])),
            ["any", ["<", "n", 1], [">", "n", 5]],
        ),
    ],
)
def test_and_or_not(cql: dict, expected: list) -> None:
    assert attributes(cql) == expected


def test_rowid_and_id_are_the_feature_id() -> None:
    assert attributes(op("=", prop("_rowid"), 7)) == ["==", "$id", 7]
    assert attributes(op("in", prop("id"), [7, 8])) == ["in", "$id", 7, 8]
    with_id = [*COLUMNS, {"name": "id", "type": "BIGINT"}]
    assert attributes(op("=", prop("id"), 7), columns=with_id) == ["==", "id", 7]


def test_a_property_resolves_like_a_duckdb_identifier() -> None:
    assert attributes(op("=", prop("N"), 5)) == ["==", "n", 5]


def test_dates_compare_as_the_tiles_text() -> None:
    # DuckDB casts the literal to DATE, dropping the time of day
    assert attributes(op(">=", prop("day"), "2024-05-01T00:00:00")) == [
        ">=",
        "day",
        "2024-05-01",
    ]
    assert attributes(op("<=", prop("day"), "2024-05-01T23:59:59")) == [
        "<=",
        "day",
        "2024-05-01",
    ]
    assert attributes(op(">=", prop("ts"), "2024-05-01T13:45:00")) == [
        ">=",
        "ts",
        "2024-05-01T13:45:00",
    ]
    assert attributes(op("<", prop("ts"), "2024-05-01")) == [
        "<",
        "ts",
        "2024-05-01T00:00:00",
    ]
    assert attributes(op("=", prop("ts"), {"timestamp": "2024-05-01T13:45:00"})) == [
        "==",
        "ts",
        "2024-05-01T13:45:00",
    ]


def test_timestamptz_compares_in_utc_around_the_trailing_z() -> None:
    # "...00.500Z" sorts before "...00Z": the bounds work around it
    second = "2024-05-01T13:45:00"
    assert attributes(op("=", prop("tz"), "2024-05-01T15:45:00+02:00")) == [
        "==",
        "tz",
        f"{second}Z",
    ]
    assert attributes(op("<", prop("tz"), second)) == ["<", "tz", f"{second}."]
    assert attributes(op(">=", prop("tz"), second)) == [">=", "tz", f"{second}."]
    assert attributes(op(">", prop("tz"), second)) == [
        "all",
        [">=", "tz", f"{second}."],
        ["!=", "tz", f"{second}Z"],
    ]
    assert attributes(op("<=", prop("tz"), second)) == [
        "any",
        ["<", "tz", f"{second}."],
        ["==", "tz", f"{second}Z"],
    ]


def test_booleans_avoid_manbys_equal_true() -> None:
    # manby's ["==", k, true] also matches false
    is_true = ["all", ["has", "b"], ["!=", "b", False]]
    assert attributes(op("=", prop("b"), True)) == is_true
    assert attributes(op("=", prop("b"), "true")) == is_true
    assert attributes(op("!=", prop("b"), False)) == is_true
    assert attributes(op("=", prop("b"), False)) == ["==", "b", False]
    assert attributes(op("!=", prop("b"), True)) == ["==", "b", False]


def test_uuid_literals_compare_in_lower_case() -> None:
    assert attributes(op("=", prop("u"), "550E8400-E29B-41D4-A716-446655440000")) == [
        "==",
        "u",
        "550e8400-e29b-41d4-a716-446655440000",
    ]


def test_a_column_name_with_a_space_and_an_umlaut() -> None:
    expected = ["==", "Straße Name", "Hauptstraße"]
    assert attributes(op("=", prop("Straße Name"), "Hauptstraße")) == expected
    assert attributes("\"Straße Name\" = 'Hauptstraße'", lang="cql2-text") == expected


# =====================================================================
#  Areas
# =====================================================================


def test_s_intersects_becomes_the_area() -> None:
    assert run(op("s_intersects", prop("geom"), POLYGON)) == TranslatedFilter(
        attributes=None, area=POLYGON
    )
    assert run(op("s_intersects", prop("geometry"), MULTIPOLYGON)) == TranslatedFilter(
        attributes=None, area=MULTIPOLYGON
    )


def test_bbox_becomes_a_rectangle() -> None:
    rectangle = {
        "type": "Polygon",
        "coordinates": [
            [[6.0, 46.0], [6.0, 49.0], [9.0, 49.0], [9.0, 46.0], [6.0, 46.0]]
        ],
    }
    assert run(None, bbox=[6.0, 46.0, 9.0, 49.0]) == TranslatedFilter(
        attributes=None, area=rectangle
    )
    assert run(op("=", prop("n"), 5), bbox=[6.0, 46.0, 9.0, 49.0]) == TranslatedFilter(
        attributes=["==", "n", 5], area=rectangle
    )


def test_an_and_of_attribute_and_area_gives_both() -> None:
    cql = op("and", op("=", prop("n"), 5), op("s_intersects", prop("geom"), POLYGON))
    assert run(cql) == TranslatedFilter(attributes=["==", "n", 5], area=POLYGON)


def test_two_areas_keep_the_one_inside_the_other() -> None:
    # intersecting the inner area implies intersecting the outer one
    two = op(
        "and",
        op("s_intersects", prop("geom"), POLYGON),
        op("s_intersects", prop("geom"), INNER),
    )
    assert run(two) == TranslatedFilter(attributes=None, area=INNER)
    covering = [6.0, 46.0, 9.0, 49.0]
    assert run(op("s_intersects", prop("geom"), POLYGON), bbox=covering) == (
        TranslatedFilter(attributes=None, area=POLYGON)
    )


def test_two_areas_neither_inside_the_other_are_left_to_duckdb() -> None:
    # neither their union nor their intersection is the same test
    assert (
        run(op("s_intersects", prop("geom"), POLYGON), bbox=[7.5, 47.5, 9, 49]) is None
    )
    assert run(op("s_intersects", prop("geom"), POLYGON), bbox=[10, 50, 11, 51]) is None


# =====================================================================
#  Left to DuckDB
# =====================================================================

POINT = {"type": "Point", "coordinates": [7.5, 47.5]}
LINE = {"type": "LineString", "coordinates": [[7.5, 47.5], [7.6, 47.6]]}
AREA = op("s_intersects", prop("geom"), POLYGON)


@pytest.mark.parametrize(
    "cql",
    [
        op("or", op("=", prop("n"), 5), AREA),
        op("not", AREA),
        op("and", op("=", prop("n"), 5), op("not", AREA)),
        {"op": "s_dwithin", "args": [prop("geom"), POINT, 100, "meters"]},
        op("s_within", prop("geom"), POLYGON),
        op("t_before", prop("ts"), {"timestamp": "2024-05-01T00:00:00Z"}),
        op("=", op("+", prop("n"), 1), 5),
        op("=", {"function": {"name": "lower", "arguments": [prop("name")]}}, "a"),
        op("=", {"lower": prop("name")}, "a"),
        op("s_intersects", prop("geom"), POINT),
        op("s_intersects", prop("geom"), LINE),
        op("s_intersects", prop("geom"), {"bbox": [7, 47, 8, 48]}),
        op("=", prop("not_in_tiles"), "a"),
        op("=", prop("unknown"), "a"),
        op("=", prop("geom"), "a"),
        op("=", 5, prop("n")),
        op("=", prop("n"), prop("d")),
        # DuckDB casts the text column to the number's type
        op("=", prop("zip"), 1234),
        op("=", prop("n"), "abc"),
        # text DuckDB rounds to the column's type: "1.5" is 2 for an integer,
        # "0.1234" is 0.123 for a DECIMAL(18,3), "0.1" a 32-bit float
        op("=", prop("n"), "1.5"),
        op("<=", prop("n"), "2.5"),
        op("=", prop("n"), "5.0"),
        op("=", prop("_rowid"), "1.5"),
        op("=", prop("big"), "5.5"),
        op("=", prop("big"), "5"),
        op("=", prop("amount"), "0.1234"),
        op("=", prop("amount"), "0.5"),
        op("=", prop("f"), "0.1"),
        op("=", prop("d"), "1e3"),
        op("=", prop("n"), True),
        op("=", prop("n"), 2**53),
        # a cast to text gives "5.0" for 5.0 in DuckDB, "5" in manby
        op("like", prop("d"), "5%"),
        op("like", prop("amount"), "1%"),
        op("like", prop("ts"), "2024%"),
        op("<", prop("b"), True),
        op("in", prop("b"), [True]),
        op("<", prop("u"), "550e8400-e29b-41d4-a716-446655440000"),
        op("=", prop("u"), "not-a-uuid"),
        op("=", prop("t"), "13:45:00"),
        op("=", prop("ts"), "2024-05-01T13:45:00.5"),
        op("=", prop("ts"), "2024-05-01T13:45:00+02:00"),
        op("=", prop("day"), "2024-05-01T13:45:00+02:00"),
        op("=", prop("day"), "yesterday"),
        op("in", prop("zip"), []),
        '{"op": "=", "args": [',
        op("frobnicate", prop("n"), 5),
    ],
)
def test_left_to_duckdb(cql: dict | str) -> None:
    assert run(cql) is None


def test_nothing_to_filter() -> None:
    assert run(None) is None


# =====================================================================
#  manby answers as DuckDB does
# =====================================================================


SCHEMA = """
    n INTEGER, d DOUBLE, f FLOAT, amount DECIMAL(18, 3), big HUGEINT,
    name VARCHAR, zip VARCHAR, b BOOLEAN, day DATE, ts TIMESTAMP,
    tz TIMESTAMPTZ, "Straße Name" VARCHAR
"""
EMPTY = "NULL, NULL, NULL, NULL, NULL"

ROWS = rf"""
    (1, 1.5, 0.1, 0.123, 5, 'Berlin', '01234', true, DATE '2024-05-01',
     TIMESTAMP '2024-05-01 13:45:00', TIMESTAMPTZ '2024-05-01 13:45:00+00',
     'Hauptstraße'),
    (2, 2.0, 0.5, 0.5, 6, 'Hamberg', '02345', false, DATE '2024-05-02',
     TIMESTAMP '2024-05-01 13:45:00.5', TIMESTAMPTZ '2024-05-01 13:45:00.5+00',
     'Nebenweg'),
    ({EMPTY}, NULL, {EMPTY}, NULL),
    (5, NULL, NULL, NULL, NULL, 'hamburg', NULL, NULL, DATE '2024-04-30',
     TIMESTAMP '2024-05-01 23:59:59', TIMESTAMPTZ '2024-05-01 15:44:59+02', NULL),
    (NULL, 0.5, 2.5, 1.5, -7, '', '1234', false, NULL, NULL, NULL, ''),
    (3, NULL, NULL, NULL, NULL, 'a%b', {EMPTY}, NULL),
    ({EMPTY}, 'x%y%z', {EMPTY}, NULL),
    ({EMPTY}, 'x%y%zq', {EMPTY}, NULL),
    ({EMPTY}, '50%x', {EMPTY}, NULL),
    ({EMPTY}, '50%[x](y)\z', {EMPTY}, NULL),
    ({EMPTY}, '50', {EMPTY}, NULL)
"""

PARITY = [
    op("=", prop("n"), 5),
    op("<>", prop("n"), 5),
    op("<", prop("d"), 2),
    op(">=", prop("d"), 1.5),
    # text DuckDB casts to integer and double columns without rounding
    op("=", prop("n"), "2"),
    op("<=", prop("n"), "2"),
    op("=", prop("d"), "2.0"),
    op("=", prop("_rowid"), "2"),
    # number literals on columns the tiles hold as doubles
    op("=", prop("f"), 0.1),
    op(">", prop("f"), 0.1),
    op("<=", prop("f"), 0.5),
    op("=", prop("amount"), 0.123),
    op(">=", prop("amount"), 0.5),
    op("=", prop("big"), 6),
    op("<", prop("big"), 0),
    op("=", prop("zip"), "01234"),
    op("<>", prop("zip"), "01234"),
    op("or", op("=", prop("zip"), "01234"), op("=", prop("zip"), "1234")),
    op("not", op("in", prop("zip"), ["01234", "1234"])),
    op("between", prop("n"), [2, 5]),
    op("not", op("between", prop("n"), [2, 5])),
    op("like", prop("name"), "%berg%"),
    op("not", op("like", prop("name"), "%berg%")),
    op("like", prop("n"), "5%"),
    # stored text with a literal % (and brackets, a backslash)
    op("like", prop("name"), "a%"),
    op("like", prop("name"), "a%b"),
    op("like", prop("name"), "x%z"),
    op("like", prop("name"), "X%Z"),
    op("like", prop("name"), "%y%"),
    op("like", prop("name"), "50%"),
    op("like", prop("name"), "50%x"),
    op("like", prop("name"), "50_[x]%"),
    op("like", prop("name"), "%\\z"),
    op("not", op("like", prop("name"), "50%")),
    {"op": "isNull", "args": prop("name")},
    op("not", {"op": "isNull", "args": prop("name")}),
    op("=", prop("b"), True),
    op("=", prop("b"), False),
    op("<>", prop("b"), True),
    op("not", op("=", prop("b"), False)),
    op("=", prop("_rowid"), 2),
    op("<>", prop("_rowid"), 2),
    op("in", prop("id"), [1, 4]),
    op(">=", prop("day"), "2024-05-01T00:00:00"),
    op("<=", prop("day"), "2024-05-01T23:59:59"),
    op(">", prop("ts"), "2024-05-01T13:45:00"),
    op("<=", prop("ts"), "2024-05-01T13:45:00"),
    op("=", prop("tz"), "2024-05-01T13:45:00"),
    op(">", prop("tz"), "2024-05-01T13:45:00"),
    op(">=", prop("tz"), "2024-05-01T13:45:00"),
    op("<", prop("tz"), "2024-05-01T13:45:00"),
    op("<=", prop("tz"), "2024-05-01T13:45:00"),
    op("<=", prop("tz"), "2024-05-01T15:44:59+02:00"),
    op("not", op("and", op("=", prop("n"), 1), op("=", prop("name"), "x"))),
    op("not", op("or", op("=", prop("n"), 1), op("<", prop("d"), 1))),
    op("and", op(">", prop("n"), 1), op("like", prop("name"), "h%")),
    op("=", prop("Straße Name"), "Hauptstraße"),
    op("=", prop("Straße Name"), ""),
]

# Text DuckDB rounds to the column's type, with the manby test that reading it
# as a number would give
ROUNDED = [
    (op("=", prop("n"), "1.5"), ["==", "n", 1.5]),
    (op("<=", prop("n"), "2.5"), ["<=", "n", 2.5]),
    (op("=", prop("big"), "5.5"), ["==", "big", 5.5]),
    (op("=", prop("amount"), "0.1234"), ["==", "amount", 0.1234]),
    (op("=", prop("f"), "0.1"), ["==", "f", 0.1]),
]


@dataclass
class Layer:
    con: duckdb.DuckDBPyConnection
    columns: list[dict]
    tile_fields: set[str]
    tiles: list[tuple[Path, str]]


@pytest.fixture(scope="module")
def layer(tmp_path_factory: pytest.TempPathFactory) -> Layer:
    """A table, its columns as geoapi reads them, and its stored tiles.

    `tiles` are the tiles of the deepest zoom of its manby build, as files
    with their z/x/y.
    """
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; SET TimeZone = 'UTC'")
    con.execute(f"CREATE TABLE layer ({SCHEMA}, geometry GEOMETRY)")
    con.execute(
        f"""
        INSERT INTO layer
        SELECT v.*, ST_Point(7.5 + 0.001 * row_number() OVER (), 47.5)
        FROM (VALUES {ROWS}) AS v
        """
    )
    columns = [
        {"name": name, "type": type_}
        for name, type_, *_ in con.execute("DESCRIBE layer").fetchall()
    ]
    tmp = tmp_path_factory.mktemp("tiles")
    generator = PMTilesGenerator(tiles_data_dir=tmp, config=PMTilesConfig())
    path = generator.generate_from_table(con, "layer", "layer1")
    assert path is not None
    with open(path, "rb") as f:
        (vector_layer,) = Reader(MmapSource(f)).metadata()["vector_layers"]
        stored = list(all_tiles(MmapSource(f)))
    deepest = max(z for (z, _, _), _ in stored)
    tiles = []
    for (z, x, y), data in stored:
        if z == deepest:
            tile = tmp / f"{z}-{x}-{y}.mvt"
            tile.write_bytes(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)
            tiles.append((tile, f"{z}/{x}/{y}"))
    return Layer(con, columns, set(vector_layer["fields"]), tiles)


def _manby_ids(layer: Layer, expression: list, tmp_path: Path) -> set[int]:
    filter_file = tmp_path / "filter.json"
    filter_file.write_text(json.dumps({"*": expression}))
    out = tmp_path / "out.mvt"
    ids = set()
    for tile, zxy in layer.tiles:
        out.unlink(missing_ok=True)
        subprocess.run(
            [manby.binary(), "overzoom", "-o", str(out), "-b", "5", "-d", "16"]
            + ["--feature-filter-file", str(filter_file), str(tile), zxy, zxy],
            capture_output=True,
            check=True,
        )
        if not out.exists() or out.stat().st_size == 0:
            continue
        decoded = subprocess.run(
            [manby.binary(), "decode", str(out), *zxy.split("/")],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        for vector_layer in json.loads(decoded)["features"]:
            ids.update(f["id"] for f in vector_layer["features"])
    return ids


def _duckdb_ids(layer: Layer, cql: dict) -> set[int]:
    names = [c["name"] for c in layer.columns]
    where = build_cql_filter({"filter": json.dumps(cql)}, names)
    assert where.clauses, "DuckDB did not take the filter"
    rows = layer.con.execute(
        f"SELECT rowid + 1 FROM layer WHERE {where.to_full_where()}", where.params
    ).fetchall()
    return {row[0] for row in rows}


def _translate(layer: Layer, cql: dict) -> TranslatedFilter | None:
    cql_filter = {"filter": json.dumps(cql), "lang": "cql2-json"}
    return translate(cql_filter, None, layer.columns, layer.tile_fields)


def test_the_layer_tiles_hold_every_row(layer: Layer, tmp_path: Path) -> None:
    assert _manby_ids(layer, ["all"], tmp_path) == set(range(1, 12))
    assert {"f", "amount", "big", "Straße Name"} <= layer.tile_fields


@pytest.mark.parametrize("cql", PARITY, ids=json.dumps)
def test_manby_matches_duckdb(cql: dict, layer: Layer, tmp_path: Path) -> None:
    translated = _translate(layer, cql)
    assert translated is not None and translated.area is None
    assert _manby_ids(layer, translated.attributes, tmp_path) == _duckdb_ids(layer, cql)


@pytest.mark.parametrize(("cql", "as_number"), ROUNDED, ids=str)
def test_text_duckdb_rounds_is_left_to_duckdb(
    cql: dict, as_number: list, layer: Layer, tmp_path: Path
) -> None:
    assert _translate(layer, cql) is None
    assert _manby_ids(layer, as_number, tmp_path) != _duckdb_ids(layer, cql)
