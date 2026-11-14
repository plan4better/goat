"""A filter's area, as the web writes it, run by DuckDB.

The web writes an area as one `s_intersects` on the geometry column against a
Polygon or MultiPolygon, first in the filter's top-level `and`, under `not`
for "outside". The MultiPolygon is its pieces put side by side (drawn shapes,
the map view, picked features), so its polygons may overlap, and a polygon may
cover another one's hole: not a valid MultiPolygon. Against such a constant
area DuckDB reads a point in two pieces as outside, so the evaluator binds the
area's union (`goatlib.filter.area`). These tests run `build_cql_filter`'s SQL
on a real table and pin which rows it keeps.
"""

import json

import duckdb
import pytest
from goatlib.storage import build_cql_filter, cql_to_where_clause

COLUMNS = ["id", "kind", "geometry"]

# Two squares that overlap in [2, 4] x [2, 4]
OVERLAPPING = {
    "type": "MultiPolygon",
    "coordinates": [
        [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
        [[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]],
    ],
}
# id: (x, y, kind); None is a row without a geometry
POINTS = {
    1: (1, 1, "a"),  # only in the first square
    2: (1, 3, "b"),  # only in the first square
    3: (5, 5, "a"),  # only in the second square
    4: (3, 3, "a"),  # in both
    5: (2.5, 3.5, "b"),  # in both
    6: (8, 8, "a"),  # in neither
    7: (5, 1, "b"),  # in neither, inside the area's bounds
    8: None,
}
IN_EITHER = {1, 2, 3, 4, 5}
IN_NEITHER = {6, 7}

# A square with a hole, and a second square that covers the hole and overlaps
# the first square around it
HOLE_COVERED = {
    "type": "MultiPolygon",
    "coordinates": [
        [
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
        ],
        [[[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]]],
    ],
}
HOLE_POINTS = {
    1: (5, 5, "a"),  # in the hole, covered by the second square
    2: (4.5, 5.5, "b"),  # in the hole, covered by the second square
    3: (1, 1, "a"),  # only in the first square
    4: (3.5, 3.5, "b"),  # in both
    5: (11, 11, "a"),  # in neither
    6: None,
}


def _area(geometry: dict) -> dict:
    return {"op": "s_intersects", "args": [{"property": "geom"}, geometry]}


def _kind(value: str) -> dict:
    return {"op": "=", "args": [{"property": "kind"}, value]}


@pytest.fixture(scope="module")
def con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    for table, points in (("points", POINTS), ("hole_points", HOLE_POINTS)):
        con.execute(
            f"CREATE TABLE {table} (id INTEGER, kind VARCHAR, geometry GEOMETRY)"
        )
        for id_, point in points.items():
            if point is None:
                con.execute(f"INSERT INTO {table} VALUES (?, 'a', NULL)", [id_])
            else:
                x, y, kind = point
                con.execute(
                    f"INSERT INTO {table} VALUES (?, ?, ST_Point(?, ?))",
                    [id_, kind, x, y],
                )
    return con


def _ids(con: duckdb.DuckDBPyConnection, cql: dict, table: str = "points") -> set:
    """The ids of the rows `build_cql_filter`'s SQL keeps."""
    filters = build_cql_filter({"filter": json.dumps(cql)}, COLUMNS, "geometry")
    # build_cql_filter drops a filter it cannot read, which would keep every row
    assert len(filters.clauses) == 1
    rows = con.execute(
        f"SELECT id FROM {table} WHERE {filters.to_full_where()}", filters.params
    ).fetchall()
    return {id_ for (id_,) in rows}


def test_the_area_is_one_st_intersects_on_the_geometry_column() -> None:
    square = {"type": "Polygon", "coordinates": OVERLAPPING["coordinates"][0]}
    filters = build_cql_filter(
        {"filter": json.dumps(_area(square))}, COLUMNS, "geometry"
    )

    assert filters.clauses == ['(ST_Intersects("geometry", ST_GeomFromGeoJSON(?)))']
    # a valid area reaches DuckDB as it was written
    assert json.loads(filters.params[0]) == square


def test_the_area_reaches_duckdb_as_one_valid_polygon(
    con: duckdb.DuckDBPyConnection,
) -> None:
    for area in (OVERLAPPING, HOLE_COVERED):
        (written,) = con.execute(
            "SELECT ST_IsValid(ST_GeomFromGeoJSON(?))", [json.dumps(area)]
        ).fetchone()
        assert written is False
        filters = build_cql_filter(
            {"filter": json.dumps(_area(area))}, COLUMNS, "geometry"
        )
        (bound,) = con.execute(
            "SELECT ST_IsValid(ST_GeomFromGeoJSON(?))", filters.params
        ).fetchone()
        assert bound is True


@pytest.mark.parametrize(
    "op, args, expected",
    [
        ("s_intersects", ["geom", "area"], IN_EITHER),
        ("s_intersects", ["area", "geom"], IN_EITHER),
        ("s_within", ["geom", "area"], IN_EITHER),
        ("s_contains", ["area", "geom"], IN_EITHER),
        ("s_disjoint", ["geom", "area"], IN_NEITHER),
    ],
    ids=["intersects", "intersects, area first", "within", "contains", "disjoint"],
)
def test_every_spatial_test_reads_the_area_as_its_union(
    op: str, args: list[str], expected: set, con: duckdb.DuckDBPyConnection
) -> None:
    operands = {"geom": {"property": "geom"}, "area": OVERLAPPING}
    cql = {"op": op, "args": [operands[a] for a in args]}

    assert _ids(con, cql) == expected


def test_the_inlined_where_clause_reads_the_area_as_its_union(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # the form COPY and the workflow tools use
    where = cql_to_where_clause(_area(OVERLAPPING), COLUMNS, "geometry", inline=True)

    rows = con.execute(f"SELECT id FROM points WHERE {where}").fetchall()
    assert {id_ for (id_,) in rows} == IN_EITHER


def test_an_overlapping_area_keeps_the_points_in_either_polygon(
    con: duckdb.DuckDBPyConnection,
) -> None:
    assert _ids(con, _area(OVERLAPPING)) == IN_EITHER


def test_outside_an_overlapping_area_keeps_the_points_in_neither_polygon(
    con: duckdb.DuckDBPyConnection,
) -> None:
    # NOT of a NULL test is NULL, so the row without a geometry is in neither
    # the area nor outside it
    outside = _ids(con, {"op": "not", "args": [_area(OVERLAPPING)]})

    assert outside == IN_NEITHER
    assert 8 not in outside and 8 not in _ids(con, _area(OVERLAPPING))


def test_an_area_and_any_of_two_conditions(con: duckdb.DuckDBPyConnection) -> None:
    cql = {
        "op": "and",
        "args": [
            _area(OVERLAPPING),
            {
                "op": "or",
                "args": [_kind("b"), {"op": "=", "args": [{"property": "id"}, 3]}],
            },
        ],
    }

    assert _ids(con, cql) == {2, 3, 5}


def test_an_area_and_two_conditions(con: duckdb.DuckDBPyConnection) -> None:
    cql = {
        "op": "and",
        "args": [
            _area(OVERLAPPING),
            _kind("a"),
            {"op": ">", "args": [{"property": "id"}, 2]},
        ],
    }

    assert _ids(con, cql) == {3, 4}


def test_outside_an_area_and_a_condition(con: duckdb.DuckDBPyConnection) -> None:
    cql = {
        "op": "and",
        "args": [{"op": "not", "args": [_area(OVERLAPPING)]}, _kind("b")],
    }

    # 8 is of kind a; without a geometry it would not be kept either way
    assert _ids(con, cql) == {7}


def test_a_hole_covered_by_another_polygon_is_in_the_area(
    con: duckdb.DuckDBPyConnection,
) -> None:
    inside = _ids(con, _area(HOLE_COVERED), "hole_points")
    outside = _ids(con, {"op": "not", "args": [_area(HOLE_COVERED)]}, "hole_points")

    assert inside == {1, 2, 3, 4}
    assert outside == {5}


def test_an_area_without_area_keeps_no_point(con: duckdb.DuckDBPyConnection) -> None:
    # a ring that collapses to a line is bound as an empty MultiPolygon
    line = {"type": "Polygon", "coordinates": [[[0, 0], [3, 3], [6, 6], [0, 0]]]}

    assert _ids(con, _area(line)) == set()
    assert _ids(con, {"op": "not", "args": [_area(line)]}) == IN_EITHER | IN_NEITHER
