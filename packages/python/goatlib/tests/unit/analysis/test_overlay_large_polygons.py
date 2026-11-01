"""Overlay tools on polygons big enough to be cut into pieces.

clip, difference, union and aggregate_points cut every polygon above
`SUBDIVIDE_MAX_VERTICES` vertices into pieces before testing rows against it.
The results stay those of the plain dissolve-then-overlay SQL the tools ran
before; that SQL is copied here as the reference (`_reference_*`). The
fixtures' overlay is several times the vertex limit, has a hole and two
parts, and its first part's bounding box is exactly [11.0, 11.5] x [48.0, 48.5],
so its first cut lines are x = 11.25 and y = 48.25, where some rows lie exactly.
"""

import math
from collections.abc import Callable
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.geoanalysis.aggregate_points import AggregatePointsTool
from goatlib.analysis.geoprocessing.clip import ClipTool
from goatlib.analysis.geoprocessing.difference import DifferenceTool
from goatlib.analysis.geoprocessing.union import UnionTool
from goatlib.analysis.schemas.aggregate import (
    AggregatePointsParams,
    AggregationAreaType,
)
from goatlib.analysis.schemas.base import FieldStatistic, StatisticOperation
from goatlib.analysis.schemas.geoprocessing import (
    ClipParams,
    DifferenceParams,
    UnionParams,
)

Coords = list[tuple[float, float]]

#: The geometry types each input family keeps (the tools' own rule).
ALLOWED = {
    "points": "('POINT', 'MULTIPOINT')",
    "lines": "('LINESTRING', 'MULTILINESTRING')",
    "polygons": "('POLYGON', 'MULTIPOLYGON')",
}
#: A geometry that differs only by collinear vertices on a cut line, or by
#: the rounding of a point computed on one, stays within these.
AREA_TOLERANCE = 1e-12
LENGTH_TOLERANCE = 1e-9


# --- Fixtures -----------------------------------------------------------------


def _ring(cx: float, cy: float, n: int, radius: Callable[[float], float]) -> Coords:
    """A closed ring of `n` vertices around (cx, cy), counterclockwise."""
    coords = []
    for k in range(n):
        t = 2 * math.pi * k / n
        r = radius(t)
        coords.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return coords + [coords[0]]


def _box(x0: float, y0: float, x1: float, y1: float) -> Coords:
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


def _coords(coords: Coords) -> str:
    return "(" + ", ".join(f"{x!r} {y!r}" for x, y in coords) + ")"


def _polygon(shell: Coords, *holes: Coords) -> str:
    return "POLYGON(" + ", ".join(_coords(r) for r in (shell, *holes)) + ")"


def _line(coords: Coords) -> str:
    return "LINESTRING" + _coords(coords)


def _grid(start: float, step: float, i: int) -> float:
    return round(start + step * i, 6)


#: Its bounding box is [11.0, 11.5] x [48.0, 48.5] exactly: the radius is 0.25
#: on the axes and smaller everywhere else. Wavy, with a hole.
CITY = _polygon(
    _ring(
        11.25,
        48.25,
        1200,
        lambda t: 0.25
        * (1 - 0.08 * math.sin(2 * t) ** 2 - 0.03 * math.sin(20 * t) ** 2),
    ),
    _ring(11.33, 48.33, 300, lambda t: 0.04)[::-1],
)
#: A second part after the dissolve.
TOWN = _polygon(
    _ring(11.75, 48.25, 400, lambda t: 0.1 * (1 - 0.05 * math.sin(8 * t) ** 2))
)
#: Overlaps CITY's edge, so the dissolve merges it.
SQUARE = _polygon(_box(11.40, 48.40, 11.46, 48.46))

#: Points exactly on the first cut lines of CITY.
CUT_LINE_POINTS = [(11.25, 48.25), (11.25, 48.15), (11.10, 48.25)]


def _points() -> list[str]:
    grid = [
        (_grid(10.95, 0.025, a), _grid(47.95, 0.025, b))
        for a in range(40)
        for b in range(24)
    ]
    # On the cut lines, on a vertex of the outer ring, in the hole and on a
    # vertex of the hole.
    special = CUT_LINE_POINTS + [(11.5, 48.25), (11.33, 48.33), (11.37, 48.33)]
    # One row of 300 points across both parts, above the vertex limit itself
    # (a dissolved stops layer is one such row): only some of it is inside.
    multipoint = ", ".join(
        f"({10.9 + 1.1 * k / 299!r} {48.2 + 0.1 * math.sin(k / 7)!r})"
        for k in range(300)
    )
    return [f"POINT({x!r} {y!r})" for x, y in grid + special] + [
        f"MULTIPOINT({multipoint})"
    ]


def _lines() -> list[str]:
    def across(y: float) -> Coords:
        return [(_grid(10.9, 0.05, k), y) for k in range(23)]

    def down(x: float) -> Coords:
        return [(x, _grid(47.9, 0.05, k)) for k in range(15)]

    lines = [_line(across(y)) for y in (47.98, 48.05, 48.13, 48.25, 48.31, 48.33)]
    lines += [_line(across(y)) for y in (48.42, 48.47, 47.5)]
    lines += [_line(down(x)) for x in (11.12, 11.25, 11.75)]
    lines.append(_line([(10.9 + 1.1 * k / 29, 47.9 + 0.7 * k / 29) for k in range(30)]))
    lines.append(_line([(11.32, 48.33), (11.34, 48.33)]))
    lines.append("MULTILINESTRING((11.05 48.25, 11.15 48.3), (12.1 48.25, 12.2 48.3))")
    return lines


#: A line of 400 vertices across both parts, as an overlay.
WAVY_LINE = _line(
    [(10.9 + 1.1 * k / 399, 48.25 + 0.2 * math.sin(k / 10)) for k in range(400)]
)


def _polygons() -> list[str]:
    cells = [
        _polygon(
            _box(
                _grid(10.95, 0.05, a),
                _grid(47.95, 0.05, b),
                _grid(10.95, 0.05, a + 1),
                _grid(47.95, 0.05, b + 1),
            )
        )
        for a in range(19)
        for b in range(12)
    ]
    return cells + [
        # Touches every piece of the overlay, with a hole of its own.
        _polygon(
            _box(10.9, 47.9, 12.0, 48.6), _ring(11.12, 48.12, 40, lambda t: 0.02)[::-1]
        ),
        "MULTIPOLYGON(((11.05 48.2, 11.08 48.2, 11.08 48.23, 11.05 48.23, 11.05 48.2)),"
        " ((11.6 48.2, 11.63 48.2, 11.63 48.23, 11.6 48.23, 11.6 48.2)))",
        # Around the overlay's hole, with a hole of its own.
        _polygon(
            _box(11.28, 48.28, 11.38, 48.38), _box(11.31, 48.31, 11.35, 48.35)[::-1]
        ),
        # Inside the overlay's hole.
        _polygon(_box(11.32, 48.32, 11.34, 48.34)),
    ]


@pytest.fixture(scope="module")
def layers(tmp_path_factory: pytest.TempPathFactory) -> dict[str, str]:
    """Paths of the fixture layers."""
    base = tmp_path_factory.mktemp("overlay_large")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    paths = {}

    def write(name: str, select: str, rows: list[tuple]) -> None:
        con.execute(
            "CREATE OR REPLACE TEMP TABLE layer (a INTEGER, b VARCHAR, wkt VARCHAR)"
        )
        con.executemany("INSERT INTO layer VALUES (?, ?, ?)", rows)
        paths[name] = str(base / f"{name}.parquet")
        con.execute(
            f"COPY (SELECT {select}, ST_GeomFromText(wkt) AS geometry FROM layer"
            f" ORDER BY a) TO '{paths[name]}' (FORMAT PARQUET)"
        )

    overlay = [(1, "city", CITY), (2, "town", TOWN), (3, "square", SQUARE)]
    write("overlay", "a AS boundary_id, b AS name", overlay)
    write("line_overlay", "a AS id", [(1, None, WAVY_LINE)])
    write(
        "points",
        "a AS id, CAST(b AS INTEGER) AS value",
        [(i, str(i % 10 + 1), w) for i, w in enumerate(_points(), start=1)],
    )
    write("lines", "a AS id", [(i, None, w) for i, w in enumerate(_lines(), start=1)])
    write(
        "polygons",
        "a AS id, CAST(b AS INTEGER) AS value",
        [(i, str(i % 10 + 1), w) for i, w in enumerate(_polygons(), start=1)],
    )
    write(
        "cut_line_points",
        "a AS id, CAST(b AS INTEGER) AS value",
        [
            (i, str(10 ** (i - 1)), f"POINT({x!r} {y!r})")
            for i, (x, y) in enumerate(CUT_LINE_POINTS, start=1)
        ],
    )
    write(
        "empty_polygons",
        "a AS id, CAST(b AS INTEGER) AS value",
        [(1, "1", "POLYGON EMPTY"), (2, "2", "POLYGON EMPTY")],
    )
    paths["dissolved"] = str(base / "dissolved.parquet")
    con.execute(
        f"COPY (SELECT 1 AS area_id, ST_Union_Agg(geometry) AS geometry"
        f" FROM read_parquet('{paths['overlay']}'))"
        f" TO '{paths['dissolved']}' (FORMAT PARQUET)"
    )
    con.close()
    return paths


# --- The SQL the tools ran before (reference) ---------------------------------


def _type_filter(expression: str, allowed: str | None) -> str:
    return f"AND ST_GeometryType({expression}) IN {allowed}" if allowed else ""


def _with_bbox(con: duckdb.DuckDBPyConnection, path: str, view: str) -> None:
    """The layer as `import_input` registers it: with a bbox struct."""
    con.execute(f"""
        CREATE OR REPLACE VIEW {view} AS
        SELECT *, {{
            'xmin': ST_XMin(geometry), 'xmax': ST_XMax(geometry),
            'ymin': ST_YMin(geometry), 'ymax': ST_YMax(geometry)
        }} AS bbox
        FROM read_parquet('{path}')
    """)


def _unified_overlay(con: duckdb.DuckDBPyConnection, overlay_path: str) -> None:
    con.execute(f"""
        CREATE OR REPLACE TABLE unified_overlay AS
        WITH unified AS (
            SELECT ST_Union_Agg(geometry) as geom
            FROM read_parquet('{overlay_path}')
            WHERE ST_IsValid(geometry)
        )
        SELECT
            geom as unified_geom,
            {{
                'xmin': ST_XMin(geom),
                'xmax': ST_XMax(geom),
                'ymin': ST_YMin(geom),
                'ymax': ST_YMax(geom)
            }} AS bbox
        FROM unified
    """)


def _reference_clip(
    con: duckdb.DuckDBPyConnection,
    input_path: str,
    overlay_path: str,
    allowed: str | None,
) -> None:
    """clip.py before the pieces: the overlay dissolved into one geometry and
    every input row intersected with it."""
    _with_bbox(con, input_path, "input_data")
    _unified_overlay(con, overlay_path)
    con.execute(f"""
        CREATE OR REPLACE TABLE expected AS
        SELECT
            i.* EXCLUDE (geometry, bbox),
            ST_Intersection(i.geometry, u.unified_geom) AS geometry
        FROM input_data i
        CROSS JOIN unified_overlay u
        WHERE ST_IsValid(i.geometry)
            AND ST_Intersects(i.geometry, u.unified_geom)
            AND i.bbox.xmin <= u.bbox.xmax
            AND i.bbox.xmax >= u.bbox.xmin
            AND i.bbox.ymin <= u.bbox.ymax
            AND i.bbox.ymax >= u.bbox.ymin
            AND NOT ST_IsEmpty(ST_Intersection(i.geometry, u.unified_geom))
            {_type_filter("ST_Intersection(i.geometry, u.unified_geom)", allowed)}
    """)


def _reference_difference(
    con: duckdb.DuckDBPyConnection,
    input_path: str,
    overlay_path: str,
    allowed: str | None,
) -> None:
    """difference.py before the pieces."""
    _with_bbox(con, input_path, "input_data")
    _unified_overlay(con, overlay_path)
    type_filter = _type_filter("ST_Difference(i.geometry, u.unified_geom)", allowed)
    con.execute(f"""
        CREATE OR REPLACE TABLE expected AS
        SELECT
            i.* EXCLUDE (geometry, bbox),
            CASE
                WHEN u.unified_geom IS NOT NULL
                    AND ST_Intersects(i.geometry, u.unified_geom)
                    AND i.bbox.xmin <= u.bbox.xmax
                    AND i.bbox.xmax >= u.bbox.xmin
                    AND i.bbox.ymin <= u.bbox.ymax
                    AND i.bbox.ymax >= u.bbox.ymin
                THEN ST_Difference(i.geometry, u.unified_geom)
                ELSE i.geometry
            END AS geometry
        FROM input_data i
        LEFT JOIN unified_overlay u ON TRUE
        WHERE ST_IsValid(i.geometry)
            AND (
                u.unified_geom IS NULL
                OR NOT ST_IsEmpty(
                    CASE
                        WHEN ST_Intersects(i.geometry, u.unified_geom)
                        THEN ST_Difference(i.geometry, u.unified_geom)
                        ELSE i.geometry
                    END
                )
            )
            AND (u.unified_geom IS NULL OR true {type_filter})
    """)


def _attributes(con: duckdb.DuckDBPyConnection, path: str) -> list[str]:
    rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
    return [r[0] for r in rows if r[0] not in ("geometry", "bbox")]


def _reference_union(
    con: duckdb.DuckDBPyConnection,
    input_path: str,
    overlay_path: str,
    allowed: str | None,
    prefix: str,
) -> None:
    """union.py's two-layer union before the pieces: the overlapping parts of
    each pair, each input row minus the dissolved overlay, each overlay row
    minus the dissolved input."""
    input_cols = _attributes(con, input_path)
    overlay_cols = _attributes(con, overlay_path)
    input_fields = [f'i."{c}"' for c in input_cols]
    null_input_fields = [f'NULL AS "{c}"' for c in input_cols]
    overlay_fields = [f'o."{c}" AS "{prefix}{c}"' for c in overlay_cols]
    null_overlay_fields = [f'NULL AS "{prefix}{c}"' for c in overlay_cols]

    def select(*parts: list[str] | str) -> str:
        return ", ".join(c for p in parts for c in ([p] if isinstance(p, str) else p))

    con.execute(f"""
        CREATE OR REPLACE TABLE unified_overlay AS
        SELECT ST_Union_Agg(geometry) as geom
        FROM read_parquet('{overlay_path}') WHERE ST_IsValid(geometry)
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE unified_input AS
        SELECT ST_Union_Agg(geometry) as geom
        FROM read_parquet('{input_path}') WHERE ST_IsValid(geometry)
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE expected AS
        SELECT {select(input_fields, overlay_fields, "ST_Intersection(i.geometry, o.geometry) AS geometry")}
        FROM read_parquet('{input_path}') i
        INNER JOIN read_parquet('{overlay_path}') o
            ON ST_Intersects(i.geometry, o.geometry)
        WHERE ST_IsValid(i.geometry)
            AND ST_IsValid(o.geometry)
            AND NOT ST_IsEmpty(ST_Intersection(i.geometry, o.geometry))
            {_type_filter("ST_Intersection(i.geometry, o.geometry)", allowed)}
        UNION ALL
        SELECT {select(input_fields, null_overlay_fields, "ST_Difference(i.geometry, u.geom) AS geometry")}
        FROM read_parquet('{input_path}') i
        CROSS JOIN unified_overlay u
        WHERE ST_IsValid(i.geometry)
            AND NOT ST_IsEmpty(ST_Difference(i.geometry, u.geom))
            {_type_filter("ST_Difference(i.geometry, u.geom)", allowed)}
        UNION ALL
        SELECT {select(null_input_fields, overlay_fields, "ST_Difference(o.geometry, u.geom) AS geometry")}
        FROM read_parquet('{overlay_path}') o
        CROSS JOIN unified_input u
        WHERE ST_IsValid(o.geometry)
            AND NOT ST_IsEmpty(ST_Difference(o.geometry, u.geom))
            {_type_filter("ST_Difference(o.geometry, u.geom)", allowed)}
    """)


def _reference_aggregate(
    con: duckdb.DuckDBPyConnection, points_path: str, areas_path: str, key: str
) -> dict[Any, tuple[int, int]]:
    """Count and sum of `value` per area, each point once per area it
    intersects."""
    rows = con.execute(f"""
        SELECT a.{key}, count(p.id), coalesce(sum(p.value), 0)
        FROM read_parquet('{areas_path}') a
        LEFT JOIN read_parquet('{points_path}') p
            ON ST_Intersects(a.geometry, p.geometry)
        GROUP BY a.{key}
    """).fetchall()
    return {r[0]: (r[1], r[2]) for r in rows}


# --- Comparison ---------------------------------------------------------------


def _compare(
    con: duckdb.DuckDBPyConnection, actual_path: str, key: list[str]
) -> dict[str, Any]:
    """How the tool's output differs from table `expected`, row by row
    (matched on `key`)."""
    con.execute(
        f"CREATE OR REPLACE TABLE actual AS SELECT * EXCLUDE (bbox)"
        f" FROM read_parquet('{actual_path}')"
    )
    columns = {
        t: sorted(r[0] for r in con.execute(f"DESCRIBE {t}").fetchall())
        for t in ("expected", "actual")
    }
    keys = ", ".join(key)

    def key_counts(table: str) -> dict:
        rows = con.execute(
            f"SELECT {keys}, count(*) FROM {table} GROUP BY ALL"
        ).fetchall()
        return {tuple(r[:-1]): r[-1] for r in rows}

    on = " AND ".join(f"e.{k} IS NOT DISTINCT FROM a.{k}" for k in key)
    others = [c for c in columns["expected"] if c not in key and c != "geometry"]
    attribute_mismatch = " OR ".join(f"e.{c} IS DISTINCT FROM a.{c}" for c in others)
    row = con.execute(f"""
        SELECT
            count(*),
            count(*) FILTER ({attribute_mismatch or 'false'}),
            count(*) FILTER (ST_GeometryType(e.geometry) <> ST_GeometryType(a.geometry)),
            max(ST_Area(ST_SymDifference(e.geometry, a.geometry)))
                FILTER (ST_Dimension(e.geometry) = 2),
            max(ST_Length(ST_SymDifference(e.geometry, a.geometry)))
                FILTER (ST_Dimension(e.geometry) = 1),
            count(*) FILTER (
                ST_Dimension(e.geometry) = 0 AND NOT ST_Equals(e.geometry, a.geometry)
            )
        FROM expected e JOIN actual a ON {on}
    """).fetchone()
    assert row is not None
    expected_keys, actual_keys = key_counts("expected"), key_counts("actual")
    return {
        "columns_equal": columns["expected"] == columns["actual"],
        "expected_rows": sum(expected_keys.values()),
        "matched_rows": row[0],
        "missing": sorted(set(expected_keys) - set(actual_keys)),
        "extra": sorted(set(actual_keys) - set(expected_keys)),
        "duplicate_keys": [k for k, n in actual_keys.items() if n > 1],
        "attribute_mismatches": row[1],
        "type_mismatches": row[2],
        "max_area_difference": row[3] or 0.0,
        "max_length_difference": row[4] or 0.0,
        "point_mismatches": row[5],
    }


def _assert_same(diff: dict[str, Any], rows_expected: bool = True) -> None:
    assert diff["columns_equal"], diff
    assert (diff["expected_rows"] > 0) == rows_expected, diff
    assert diff["missing"] == [] and diff["extra"] == [], diff
    assert diff["duplicate_keys"] == [], diff
    assert diff["matched_rows"] == diff["expected_rows"], diff
    assert diff["attribute_mismatches"] == 0, diff
    assert diff["type_mismatches"] == 0, diff
    assert diff["max_area_difference"] <= AREA_TOLERANCE, diff
    assert diff["max_length_difference"] <= LENGTH_TOLERANCE, diff
    assert diff["point_mismatches"] == 0, diff


def _run(tool_class: type[AnalysisTool], params: Any) -> str:
    tool = tool_class()
    try:
        [(path, _)] = tool.run(params)
    finally:
        tool.cleanup()
    return str(path)


@pytest.fixture
def con() -> duckdb.DuckDBPyConnection:
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    yield connection
    connection.close()


# --- Tests --------------------------------------------------------------------


def test_the_overlay_is_cut_several_times(
    layers: dict[str, str], con: duckdb.DuckDBPyConnection
) -> None:
    """The fixtures exercise the pieces: the dissolved overlay is several times
    the vertex limit, and CITY's first cut lines are x = 11.25, y = 48.25."""
    vertices, parts = con.execute(f"""
        SELECT ST_NPoints(geometry), ST_NumGeometries(geometry)
        FROM read_parquet('{layers['dissolved']}')
    """).fetchone()
    assert vertices > 4 * 256
    assert parts == 2
    bbox = con.execute(f"""
        SELECT ST_XMin(p), ST_XMax(p), ST_YMin(p), ST_YMax(p)
        FROM (SELECT UNNEST(ST_Dump(geometry)).geom AS p
              FROM read_parquet('{layers['dissolved']}'))
        WHERE ST_XMin(p) < 11.25
    """).fetchall()
    assert bbox == [(11.0, 11.5, 48.0, 48.5)]


@pytest.mark.parametrize("kind", ["points", "lines", "polygons"])
def test_clip_gives_the_dissolved_overlay_clip(
    layers: dict[str, str], con: duckdb.DuckDBPyConnection, kind: str, tmp_path: Path
) -> None:
    path = _run(
        ClipTool,
        ClipParams(
            input_path=layers[kind],
            overlay_path=layers["overlay"],
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    _reference_clip(con, layers[kind], layers["overlay"], ALLOWED[kind])
    _assert_same(_compare(con, path, ["id"]))


@pytest.mark.parametrize("kind", ["points", "lines", "polygons"])
def test_difference_gives_the_dissolved_overlay_difference(
    layers: dict[str, str], con: duckdb.DuckDBPyConnection, kind: str, tmp_path: Path
) -> None:
    path = _run(
        DifferenceTool,
        DifferenceParams(
            input_path=layers[kind],
            overlay_path=layers["overlay"],
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    _reference_difference(con, layers[kind], layers["overlay"], ALLOWED[kind])
    _assert_same(_compare(con, path, ["id"]))


@pytest.mark.parametrize("kind", ["points", "lines", "polygons"])
def test_union_gives_the_union_of_pairs_and_remainders(
    layers: dict[str, str], con: duckdb.DuckDBPyConnection, kind: str, tmp_path: Path
) -> None:
    path = _run(
        UnionTool,
        UnionParams(
            input_path=layers[kind],
            overlay_path=layers["overlay"],
            overlay_fields_prefix="overlay_",
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    _reference_union(con, layers[kind], layers["overlay"], ALLOWED[kind], "overlay_")
    _assert_same(_compare(con, path, ["id", "overlay_boundary_id"]))


def test_union_with_the_big_polygons_as_input(
    layers: dict[str, str], con: duckdb.DuckDBPyConnection, tmp_path: Path
) -> None:
    """The big polygons on the other side: each of them minus the dissolved
    small ones, and paired with each small one."""
    path = _run(
        UnionTool,
        UnionParams(
            input_path=layers["overlay"],
            overlay_path=layers["polygons"],
            overlay_fields_prefix="overlay_",
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    _reference_union(
        con, layers["overlay"], layers["polygons"], ALLOWED["polygons"], "overlay_"
    )
    _assert_same(_compare(con, path, ["boundary_id", "overlay_id"]))


def test_union_with_a_long_line_as_overlay(
    layers: dict[str, str], con: duckdb.DuckDBPyConnection, tmp_path: Path
) -> None:
    """A line above the vertex limit is not cut, and none of it is lost."""
    path = _run(
        UnionTool,
        UnionParams(
            input_path=layers["polygons"],
            overlay_path=layers["line_overlay"],
            overlay_fields_prefix="overlay_",
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    _reference_union(
        con, layers["polygons"], layers["line_overlay"], ALLOWED["polygons"], "overlay_"
    )
    _assert_same(_compare(con, path, ["id", "overlay_id"]))


@pytest.mark.parametrize("empty_side", ["input", "overlay"])
@pytest.mark.parametrize("tool", ["clip", "difference"])
def test_empty_geometries_give_what_they_gave_before(
    layers: dict[str, str],
    con: duckdb.DuckDBPyConnection,
    tool: str,
    empty_side: str,
    tmp_path: Path,
) -> None:
    """Rows whose geometries are all empty touch nothing, and the dissolve
    of them is one empty geometry."""
    input_path, overlay_path = layers["polygons"], layers["overlay"]
    if empty_side == "input":
        input_path = layers["empty_polygons"]
    else:
        overlay_path = layers["empty_polygons"]
    output = str(tmp_path / "out.parquet")
    if tool == "clip":
        params: Any = ClipParams(
            input_path=input_path, overlay_path=overlay_path, output_path=output
        )
        path = _run(ClipTool, params)
        _reference_clip(con, input_path, overlay_path, ALLOWED["polygons"])
    else:
        params = DifferenceParams(
            input_path=input_path, overlay_path=overlay_path, output_path=output
        )
        path = _run(DifferenceTool, params)
        _reference_difference(con, input_path, overlay_path, ALLOWED["polygons"])
    rows_expected = tool == "difference" and empty_side == "overlay"
    _assert_same(_compare(con, path, ["id"]), rows_expected=rows_expected)


@pytest.mark.parametrize("empty_side", ["input", "overlay"])
def test_a_union_with_empty_geometries_keeps_the_other_side(
    layers: dict[str, str],
    con: duckdb.DuckDBPyConnection,
    empty_side: str,
    tmp_path: Path,
) -> None:
    """As a union with a layer without rows: the other layer's rows, as they
    are. (The SQL before the pieces crashed DuckDB here: its spatial join
    met only empty geometries on one side.)"""
    input_path, overlay_path = layers["polygons"], layers["overlay"]
    if empty_side == "input":
        input_path = layers["empty_polygons"]
        con.execute(f"""
            CREATE OR REPLACE TABLE expected AS
            SELECT NULL::INTEGER AS id, NULL::INTEGER AS value,
                boundary_id AS overlay_boundary_id, name AS overlay_name, geometry
            FROM read_parquet('{overlay_path}')
        """)
        key = ["id", "overlay_boundary_id"]
    else:
        overlay_path = layers["empty_polygons"]
        con.execute(f"""
            CREATE OR REPLACE TABLE expected AS
            SELECT id, value, NULL::INTEGER AS overlay_id,
                NULL::INTEGER AS overlay_value, geometry
            FROM read_parquet('{input_path}')
        """)
        key = ["id", "overlay_id"]
    path = _run(
        UnionTool,
        UnionParams(
            input_path=input_path,
            overlay_path=overlay_path,
            overlay_fields_prefix="overlay_",
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    _assert_same(_compare(con, path, key))


def _rotated_cells(angle: float, n: int = 60) -> tuple[list[Any], list[bool]]:
    """An n x n grid of cells rotated by `angle` degrees, and which of them
    form the overlay: the cells inside a wavy circle with a hole."""
    import shapely
    from shapely import affinity

    size = 0.24 / n
    cells, inside = [], []
    for a in range(n):
        for b in range(n):
            cell = shapely.box(
                11.0 + a * size,
                48.0 + b * size,
                11.0 + (a + 1) * size,
                48.0 + (b + 1) * size,
            )
            cells.append(affinity.rotate(cell, angle, origin=(11.12, 48.12)))
            cx, cy = a - n / 2 + 0.5, b - n / 2 + 0.5
            r, t = math.hypot(cx, cy), math.atan2(cy, cx)
            in_ring = r < (n / 2 - 4) * (1 - 0.15 * math.sin(9 * t) ** 2)
            in_hole = abs(cx - n / 27) < 3 and abs(cy - n / 27) < 3
            inside.append(in_ring and not in_hole)
    return cells, inside


@pytest.fixture(scope="module")
def shared_edges(tmp_path_factory: pytest.TempPathFactory) -> dict[float, dict]:
    """Per angle, a layer of rotated cells and an overlay made of some of the
    same cells: the dissolve is cut, and its cut lines cross edges that input
    rows share with it at computed points."""
    import shapely

    base = tmp_path_factory.mktemp("shared_edges")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    layers_by_angle = {}
    for angle in (17.0, 33.3):
        cells, inside = _rotated_cells(angle)
        paths = {
            "cells": str(base / f"cells_{angle}.parquet"),
            "overlay": str(base / f"overlay_{angle}.parquet"),
        }
        for name, rows in (
            ("cells", list(enumerate(cells, start=1))),
            (
                "overlay",
                list(enumerate([c for c, i in zip(cells, inside) if i], start=1)),
            ),
        ):
            con.execute("CREATE OR REPLACE TEMP TABLE layer (k INTEGER, wkb BLOB)")
            con.executemany(
                "INSERT INTO layer VALUES (?, ?)",
                [(k, shapely.to_wkb(c)) for k, c in rows],
            )
            key = "id" if name == "cells" else "oid"
            con.execute(
                f"COPY (SELECT k AS {key}, ST_GeomFromWKB(wkb) AS geometry"
                f" FROM layer ORDER BY k) TO '{paths[name]}' (FORMAT PARQUET)"
            )
        # The overlay as one dissolved row, which union cuts as a row of its own.
        paths["dissolved"] = str(base / f"dissolved_{angle}.parquet")
        con.execute(f"""
            COPY (
                SELECT 1 AS oid, ST_Union_Agg(geometry) AS geometry
                FROM read_parquet('{paths["overlay"]}')
            ) TO '{paths["dissolved"]}' (FORMAT PARQUET)
        """)
        layers_by_angle[angle] = paths
    con.close()
    return layers_by_angle


@pytest.mark.parametrize("angle", [17.0, 33.3])
@pytest.mark.parametrize(
    "tool", ["clip", "difference", "union", "union with one overlay row"]
)
def test_rows_along_the_overlay_edges_give_what_they_gave_before(
    shared_edges: dict[float, dict],
    con: duckdb.DuckDBPyConnection,
    tool: str,
    angle: float,
    tmp_path: Path,
) -> None:
    """A cut line crossing a slanted edge adds a vertex computed in floating
    point, just off that edge. A cell sharing the edge must not come back as
    a sliver where the dissolved overlay leaves it nothing (or only a line)."""
    paths = shared_edges[angle]
    output = str(tmp_path / "out.parquet")
    if tool == "clip":
        path = _run(
            ClipTool,
            ClipParams(
                input_path=paths["cells"],
                overlay_path=paths["overlay"],
                output_path=output,
            ),
        )
        _reference_clip(con, paths["cells"], paths["overlay"], ALLOWED["polygons"])
        key = ["id"]
    elif tool == "difference":
        path = _run(
            DifferenceTool,
            DifferenceParams(
                input_path=paths["cells"],
                overlay_path=paths["overlay"],
                output_path=output,
            ),
        )
        _reference_difference(
            con, paths["cells"], paths["overlay"], ALLOWED["polygons"]
        )
        key = ["id"]
    else:
        overlay = paths["overlay" if tool == "union" else "dissolved"]
        path = _run(
            UnionTool,
            UnionParams(
                input_path=paths["cells"],
                overlay_path=overlay,
                overlay_fields_prefix="overlay_",
                output_path=output,
            ),
        )
        _reference_union(con, paths["cells"], overlay, ALLOWED["polygons"], "overlay_")
        key = ["id", "overlay_oid"]
    _assert_same(_compare(con, path, key))


def _aggregate(points: str, areas: str, output: Path) -> dict[Any, tuple[int, int]]:
    path = _run(
        AggregatePointsTool,
        AggregatePointsParams(
            source_path=points,
            area_type=AggregationAreaType.polygon,
            area_layer_path=areas,
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.count),
                FieldStatistic(operation=StatisticOperation.sum, field="value"),
            ],
            output_path=str(output),
        ),
    )
    con = duckdb.connect()
    try:
        con.execute("LOAD spatial;")
        rows = con.execute(f"SELECT * FROM read_parquet('{path}')").fetchdf()
    finally:
        con.close()
    key = "boundary_id" if "boundary_id" in rows.columns else "area_id"
    return {r[key]: (int(r["count"]), int(r["value_sum"])) for _, r in rows.iterrows()}


@pytest.mark.parametrize("areas", ["overlay", "dissolved"])
def test_aggregate_points_counts_each_point_once_per_area(
    layers: dict[str, str], con: duckdb.DuckDBPyConnection, areas: str, tmp_path: Path
) -> None:
    key = "boundary_id" if areas == "overlay" else "area_id"
    expected = _reference_aggregate(con, layers["points"], layers[areas], key)
    assert all(count > 0 for count, _ in expected.values())
    assert _aggregate(layers["points"], layers[areas], tmp_path / "out.parquet") == (
        expected
    )


def test_a_point_on_a_cut_line_counts_once_in_aggregate_points(
    layers: dict[str, str], tmp_path: Path
) -> None:
    """Values 1, 10 and 100: each point is counted once, not once per piece
    it touches."""
    result = _aggregate(
        layers["cut_line_points"], layers["dissolved"], tmp_path / "out.parquet"
    )
    assert result == {1: (3, 111)}


def test_a_point_on_a_cut_line_is_clipped_once(
    layers: dict[str, str], con: duckdb.DuckDBPyConnection, tmp_path: Path
) -> None:
    path = _run(
        ClipTool,
        ClipParams(
            input_path=layers["cut_line_points"],
            overlay_path=layers["dissolved"],
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    rows = con.execute(
        f"SELECT id, ST_X(geometry), ST_Y(geometry) FROM read_parquet('{path}')"
        " ORDER BY id"
    ).fetchall()
    assert rows == [(i, x, y) for i, (x, y) in enumerate(CUT_LINE_POINTS, start=1)]


# --- Memory -------------------------------------------------------------------
#
# A polygon of 200,000 vertices (a dissolved city-wide catchment has as many)
# tested row by row needs a copy of it per row of a vector, memory DuckDB
# cannot spill. Under a 512 MB limit and two threads the tools only pass when
# they test rows against small pieces.

MEMORY_LIMIT = "512MB"
HUGE_VERTICES = 200_000
#: Enough rows that recomputing them all in one statement, each with a copy
#: of the huge polygon, would not fit under MEMORY_LIMIT.
RIM_SQUARES = 160


@pytest.fixture(scope="module")
def large(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """A wavy polygon of 200,000 vertices in [11.0, 11.5] x [48.0, 48.5],
    5,000 points and 500 squares tiling that box, the same squares shrunk to
    leave gaps, and the box itself; with shapely copies for the expected
    values."""
    import shapely

    base = tmp_path_factory.mktemp("overlay_huge")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    paths = {
        name: str(base / f"{name}.parquet")
        for name in ("huge", "points", "squares", "gapped", "box", "line", "rim")
    }
    con.execute(f"""
        COPY (
            SELECT 1 AS id, ST_MakePolygon(ST_MakeLine(
                list(ST_Point(11.25 + r * cos(t), 48.25 + r * sin(t)) ORDER BY k)
            )) AS geometry
            FROM (
                SELECT k, t, 0.25 * (1 - 0.1 * sin(400 * t) ^ 2) AS r
                FROM (
                    SELECT k, 2 * pi() * (k % {HUGE_VERTICES}) / {HUGE_VERTICES} AS t
                    FROM range({HUGE_VERTICES} + 1) r(k)
                )
            )
        ) TO '{paths['huge']}' (FORMAT PARQUET)
    """)
    con.execute(f"""
        COPY (
            SELECT a * 50 + b + 1 AS id, 1 AS value,
                   ST_Point(11.0025 + 0.005 * a, 48.005 + 0.01 * b) AS geometry
            FROM range(100) x(a), range(50) y(b)
        ) TO '{paths['points']}' (FORMAT PARQUET)
    """)
    for name, inset in (("squares", 0.0), ("gapped", 0.25)):
        con.execute(f"""
            COPY (
                SELECT a * 20 + b + 1 AS id, ST_MakeEnvelope(
                    round(11.0 + 0.02 * (a + {inset}), 6),
                    round(48.0 + 0.025 * (b + {inset}), 6),
                    round(11.0 + 0.02 * (a + 1 - {inset}), 6),
                    round(48.0 + 0.025 * (b + 1 - {inset}), 6)
                ) AS geometry
                FROM range(25) x(a), range(20) y(b)
            ) TO '{paths[name]}' (FORMAT PARQUET)
        """)
    con.execute(f"""
        COPY (SELECT 1 AS id, ST_MakeEnvelope(11.0, 48.0, 11.5, 48.5) AS geometry)
        TO '{paths['box']}' (FORMAT PARQUET)
    """)
    # A route or a river stored as one line: 20,000 vertices zigzagging
    # across the box.
    con.execute(f"""
        COPY (
            SELECT 1 AS id, ST_MakeLine(list(ST_Point(
                11.0 + 0.5 * k / 20000, 48.0 + 0.5 * ((k * 37) % 1000) / 1000.0
            ) ORDER BY k)) AS geometry
            FROM range(20000) r(k)
        ) TO '{paths['line']}' (FORMAT PARQUET)
    """)
    # Squares across the huge polygon's boundary.
    con.execute(f"""
        COPY (
            SELECT k + 1 AS id, ST_MakeEnvelope(
                11.25 + 0.2375 * cos(t) - 0.02, 48.25 + 0.2375 * sin(t) - 0.02,
                11.25 + 0.2375 * cos(t) + 0.02, 48.25 + 0.2375 * sin(t) + 0.02
            ) AS geometry
            FROM (SELECT k, 2 * pi() * k / {RIM_SQUARES} AS t FROM range({RIM_SQUARES}) r(k))
        ) TO '{paths['rim']}' (FORMAT PARQUET)
    """)

    def shapes(name: str) -> Any:
        rows = con.execute(
            f"SELECT ST_AsWKB(geometry) FROM read_parquet('{paths[name]}') ORDER BY id"
        ).fetchall()
        return shapely.from_wkb([bytes(r[0]) for r in rows])

    huge = shapes("huge")[0]
    assert shapely.get_num_coordinates(huge) == HUGE_VERTICES + 1
    shapely.prepare(huge)
    result = {"paths": paths, "huge": huge}
    result.update(
        {name: shapes(name) for name in ("points", "squares", "gapped", "line", "rim")}
    )
    con.close()
    return result


def _run_capped(tool_class: type[AnalysisTool], params: Any) -> str:
    tool = tool_class()
    try:
        tool.con.execute(f"SET threads = 2; SET memory_limit = '{MEMORY_LIMIT}'")
        [(path, _)] = tool.run(params)
    finally:
        tool.cleanup()
    return str(path)


def _sums(path: str, where: str = "true") -> tuple[int, float]:
    con = duckdb.connect()
    try:
        con.execute("LOAD spatial;")
        row = con.execute(
            f"SELECT count(*), coalesce(sum(ST_Area(geometry)), 0)"
            f" FROM read_parquet('{path}') WHERE {where}"
        ).fetchone()
    finally:
        con.close()
    assert row is not None
    return int(row[0]), float(row[1])


def test_clip_of_many_points_by_a_huge_polygon_fits_in_memory(
    large: dict[str, Any], tmp_path: Path
) -> None:
    import shapely

    paths = large["paths"]
    path = _run_capped(
        ClipTool,
        ClipParams(
            input_path=paths["points"],
            overlay_path=paths["huge"],
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    inside = int(shapely.intersects(large["huge"], large["points"]).sum())
    assert 0 < inside < 5000
    assert _sums(path)[0] == inside


def test_aggregate_points_in_a_huge_polygon_fits_in_memory(
    large: dict[str, Any], tmp_path: Path
) -> None:
    import shapely

    paths = large["paths"]
    path = _run_capped(
        AggregatePointsTool,
        AggregatePointsParams(
            source_path=paths["points"],
            area_type=AggregationAreaType.polygon,
            area_layer_path=paths["huge"],
            column_statistics=[FieldStatistic(operation=StatisticOperation.count)],
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    inside = int(shapely.intersects(large["huge"], large["points"]).sum())
    con = duckdb.connect()
    try:
        counts = con.execute(f"SELECT count FROM read_parquet('{path}')").fetchall()
    finally:
        con.close()
    assert counts == [(inside,)]


def test_difference_of_many_polygons_and_a_huge_polygon_fits_in_memory(
    large: dict[str, Any], tmp_path: Path
) -> None:
    import shapely

    paths = large["paths"]
    path = _run_capped(
        DifferenceTool,
        DifferenceParams(
            input_path=paths["squares"],
            overlay_path=paths["huge"],
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    squares = large["squares"]
    left = int((~shapely.covered_by(squares, large["huge"])).sum())
    rows, area = _sums(path)
    assert rows == left
    assert area == pytest.approx(0.5 * 0.5 - large["huge"].area, abs=1e-9)


def test_union_of_many_polygons_and_a_huge_polygon_fits_in_memory(
    large: dict[str, Any], tmp_path: Path
) -> None:
    paths = large["paths"]
    path = _run_capped(
        UnionTool,
        UnionParams(
            input_path=paths["squares"],
            overlay_path=paths["huge"],
            overlay_fields_prefix="overlay_",
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    huge_area = large["huge"].area
    assert _sums(path, "overlay_id IS NOT NULL")[1] == pytest.approx(
        huge_area, abs=1e-9
    )
    assert _sums(path, "overlay_id IS NULL")[1] == pytest.approx(
        0.5 * 0.5 - huge_area, abs=1e-9
    )


def test_one_row_touching_every_piece_fits_in_memory(
    large: dict[str, Any], tmp_path: Path
) -> None:
    paths = large["paths"]
    clipped = _run_capped(
        ClipTool,
        ClipParams(
            input_path=paths["box"],
            overlay_path=paths["huge"],
            output_path=str(tmp_path / "clip.parquet"),
        ),
    )
    erased = _run_capped(
        DifferenceTool,
        DifferenceParams(
            input_path=paths["box"],
            overlay_path=paths["huge"],
            output_path=str(tmp_path / "difference.parquet"),
        ),
    )
    huge_area = large["huge"].area
    assert _sums(clipped)[1] == pytest.approx(huge_area, abs=1e-9)
    assert _sums(erased)[1] == pytest.approx(0.5 * 0.5 - huge_area, abs=1e-9)


def test_a_huge_polygon_minus_many_polygons_fits_in_memory(
    large: dict[str, Any], tmp_path: Path
) -> None:
    """The huge polygon is the input row here: it is tested against hundreds
    of pieces of the overlay."""
    import shapely

    paths = large["paths"]
    path = _run_capped(
        DifferenceTool,
        DifferenceParams(
            input_path=paths["huge"],
            overlay_path=paths["gapped"],
            output_path=str(tmp_path / "out.parquet"),
        ),
    )
    gapped = shapely.union_all(large["gapped"])
    expected = large["huge"].area - shapely.intersection(large["huge"], gapped).area
    assert _sums(path) == (1, pytest.approx(expected, abs=1e-9))


def _lengths(path: str) -> tuple[int, float]:
    con = duckdb.connect()
    try:
        con.execute("LOAD spatial;")
        row = con.execute(
            f"SELECT count(*), coalesce(sum(ST_Length(geometry)), 0)"
            f" FROM read_parquet('{path}')"
        ).fetchone()
    finally:
        con.close()
    assert row is not None
    return int(row[0]), float(row[1])


def test_a_long_line_clipped_or_erased_by_a_huge_polygon_fits_in_memory(
    large: dict[str, Any], tmp_path: Path
) -> None:
    """A big line is cut as well to find the pieces it touches; whole, it
    would be copied once per piece."""
    import shapely

    paths = large["paths"]
    clipped = _run_capped(
        ClipTool,
        ClipParams(
            input_path=paths["line"],
            overlay_path=paths["huge"],
            output_path=str(tmp_path / "clip.parquet"),
        ),
    )
    erased = _run_capped(
        DifferenceTool,
        DifferenceParams(
            input_path=paths["line"],
            overlay_path=paths["huge"],
            output_path=str(tmp_path / "difference.parquet"),
        ),
    )
    line = large["line"][0]
    assert _lengths(clipped) == (
        1,
        pytest.approx(shapely.intersection(line, large["huge"]).length, abs=1e-9),
    )
    assert _lengths(erased) == (
        1,
        pytest.approx(shapely.difference(line, large["huge"]).length, abs=1e-9),
    )


class _Statements:
    """Forwards to a DuckDB connection and counts the statements that
    recompute rows against the whole overlay."""

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self._con = con
        self.recomputes = 0

    def execute(self, sql: str, *args: Any) -> duckdb.DuckDBPyConnection:
        if sql.lstrip().upper().startswith("UPDATE"):
            self.recomputes += 1
        return self._con.execute(sql, *args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._con, name)


@pytest.mark.parametrize("tool", ["clip", "difference"])
def test_rows_recomputed_against_the_whole_overlay_fit_in_memory(
    large: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    tool: str,
) -> None:
    """A row whose result looks like a sliver is recomputed against the whole
    overlay, a copy of it per row. Taking every row for one here, the rows
    across the huge polygon's edge still fit, in batches, and give the
    overlay's result."""
    import shapely
    from goatlib.analysis.core import base

    monkeypatch.setattr(base, "NEAR_EMPTY_WIDTH_RATIO", float("inf"))
    paths = large["paths"]
    tool_class: type[AnalysisTool] = ClipTool if tool == "clip" else DifferenceTool
    params_class: Any = ClipParams if tool == "clip" else DifferenceParams
    analysis = tool_class()
    statements = _Statements(analysis.con)
    try:
        statements.execute(f"SET threads = 2; SET memory_limit = '{MEMORY_LIMIT}'")
        analysis.con = statements
        [(path, _)] = analysis.run(
            params_class(
                input_path=paths["rim"],
                overlay_path=paths["huge"],
                output_path=str(tmp_path / "out.parquet"),
            )
        )
    finally:
        analysis.cleanup()
    assert statements.recomputes >= RIM_SQUARES / base.RECOMPUTE_BATCH_ROWS
    operation = shapely.intersection if tool == "clip" else shapely.difference
    expected = operation(large["rim"], large["huge"])
    assert _sums(str(path)) == (
        RIM_SQUARES,
        pytest.approx(shapely.area(expected).sum(), abs=1e-9),
    )
