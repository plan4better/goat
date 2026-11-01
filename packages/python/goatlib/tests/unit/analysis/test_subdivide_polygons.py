"""The pieces the overlay tools cut big polygons into.

DuckDB spatial copies a geometry for every row it tests against it, so a big
polygon tested row by row needs a copy per row. `AnalysisTool` cuts polygons
above a vertex limit into pieces (`subdivide_polygons`), and per input row
unions only the pieces that row touches (`create_touched_pieces`,
`local_union_cte`).
"""

import math
from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.core.base import (
    LIST_UNION_MAX_PIECES,
    SUBDIVIDE_MAX_VERTICES,
    AnalysisTool,
)


def _ring(cx: float, cy: float, n: int, r: float, wave: float = 0.0) -> str:
    coords = []
    for k in range(n):
        t = 2 * math.pi * k / n
        radius = r * (1 - wave * math.sin(12 * t) ** 2)
        coords.append(f"{cx + radius * math.cos(t)!r} {cy + radius * math.sin(t)!r}")
    return "(" + ", ".join(coords + [coords[0]]) + ")"


#: About 1,000 vertices, wavy, with a hole.
BIG = f"POLYGON({_ring(0, 0, 900, 10, 0.2)}, {_ring(3, 3, 100, 1)})"


class _Recorder:
    """Forwards to a DuckDB connection and keeps the SQL it was given."""

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self._con = con
        self.statements: list[str] = []

    def execute(self, sql: str, *args: object) -> duckdb.DuckDBPyConnection:
        self.statements.append(sql)
        return self._con.execute(sql, *args)

    def __getattr__(self, name: str) -> object:
        return getattr(self._con, name)


@pytest.fixture
def tool() -> AnalysisTool:
    analysis = AnalysisTool(db_path=None)
    yield analysis
    analysis.cleanup()


def _table(tool: AnalysisTool, rows: list[tuple[int, str, str]]) -> None:
    tool.con.execute(
        "CREATE OR REPLACE TEMP TABLE shapes (id INTEGER, name VARCHAR, wkt VARCHAR)"
    )
    tool.con.executemany("INSERT INTO shapes VALUES (?, ?, ?)", rows)
    tool.con.execute("""
        CREATE OR REPLACE TEMP TABLE shapes AS
        SELECT id, name, ST_GeomFromText(wkt) AS geom FROM shapes
    """)


def test_a_big_polygon_is_cut_into_pieces_that_cover_it_exactly(
    tool: AnalysisTool,
) -> None:
    _table(tool, [(1, "big", BIG)])
    assert tool.subdivide_polygons("shapes", "geom") is True
    row = tool.con.execute(f"""
        SELECT
            count(*),
            max(ST_NPoints(geom)),
            count(*) FILTER (ST_GeometryType(geom) <> 'POLYGON'),
            list(DISTINCT id), list(DISTINCT name),
            sum(ST_Area(geom)),
            ST_Area(ST_SymDifference(ST_Union_Agg(geom), ST_GeomFromText('{BIG}'))),
            ST_Area(ST_GeomFromText('{BIG}'))
        FROM shapes
    """).fetchone()
    pieces, most_vertices, not_polygons, ids, names, area_sum, gap, area = row
    assert pieces > 4
    assert most_vertices <= SUBDIVIDE_MAX_VERTICES
    assert not_polygons == 0
    assert ids == [1] and names == ["big"]
    # They do not overlap, and together they are the polygon.
    assert area_sum == pytest.approx(area, rel=1e-12)
    assert gap == pytest.approx(0, abs=1e-9)


def test_the_vertex_limit_can_be_lower(tool: AnalysisTool) -> None:
    _table(tool, [(1, "big", BIG)])
    tool.subdivide_polygons("shapes", "geom", max_vertices=64)
    assert (
        tool.con.execute("SELECT max(ST_NPoints(geom)) FROM shapes").fetchone()[0] <= 64
    )


def test_a_multipolygon_is_split_into_its_parts_before_it_is_cut(
    tool: AnalysisTool,
) -> None:
    """Two parts of 200 vertices each: above the limit together, below it
    alone, so they become two pieces and are not cut."""
    multi = f"MULTIPOLYGON(({_ring(0, 0, 199, 1)}), ({_ring(5, 0, 199, 1)}))"
    _table(tool, [(7, "two", multi)])
    tool.subdivide_polygons("shapes", "geom")
    rows = tool.con.execute("""
        SELECT id, ST_GeometryType(geom), ST_NPoints(geom) FROM shapes ORDER BY ST_XMin(geom)
    """).fetchall()
    assert rows == [(7, "POLYGON", 200), (7, "POLYGON", 200)]


def test_a_table_without_big_polygons_is_left_alone(tool: AnalysisTool) -> None:
    """One check, no rewrite: small inputs cost what they cost before."""
    small = f"POLYGON({_ring(0, 0, 100, 1)})"
    _table(tool, [(1, "a", small), (2, "b", "POINT(3 3)")])
    recorder = _Recorder(tool.con)
    tool.con = recorder
    try:
        cut = tool.subdivide_polygons("shapes", "geom")
    finally:
        tool.con = recorder._con
    assert cut is False
    assert len(recorder.statements) == 1
    assert not any("CREATE" in s or "DELETE" in s for s in recorder.statements)
    assert tool.con.execute("SELECT count(*) FROM shapes").fetchone()[0] == 2


def test_rows_that_are_not_polygons_are_not_cut(tool: AnalysisTool) -> None:
    """A long line keeps every vertex; only polygons are cut."""
    line = "LINESTRING(" + ", ".join(f"{k} {math.sin(k)!r}" for k in range(400)) + ")"
    _table(tool, [(1, "line", line), (2, "big", BIG)])
    tool.subdivide_polygons("shapes", "geom")
    rows = tool.con.execute(f"""
        SELECT count(*), any_value(ST_NPoints(geom)),
               bool_and(ST_Equals(geom, ST_GeomFromText('{line}')))
        FROM shapes WHERE id = 1
    """).fetchone()
    assert rows == (1, 400, True)


def test_lines_are_cut_too_when_asked(tool: AnalysisTool) -> None:
    """For finding the pieces a row touches, a long line is cut as well: its
    parts are within the limit and together are the line, up to the rounding
    of the points computed on the cut lines."""
    line = "LINESTRING(" + ", ".join(f"{k} {math.sin(k)!r}" for k in range(400)) + ")"
    _table(tool, [(1, "line", line)])
    tool.subdivide_polygons("shapes", "geom", cut_lines=True)
    row = tool.con.execute(f"""
        WITH l AS (SELECT ST_GeomFromText('{line}') AS line)
        SELECT count(*), max(ST_NPoints(geom)), list(DISTINCT id),
            sum(ST_Length(geom)), any_value(ST_Length(line)),
            bool_and(ST_Covers(ST_Buffer(line, 1e-6), geom)),
            ST_Covers(ST_Buffer(ST_Union_Agg(geom), 1e-6), any_value(line))
        FROM shapes, l
    """).fetchone()
    parts, most_vertices, ids, length_sum, length, on_line, covered = row
    assert parts > 1
    assert most_vertices <= SUBDIVIDE_MAX_VERTICES
    assert ids == [1]
    assert length_sum == pytest.approx(length, rel=1e-12)
    assert on_line and covered


def test_an_invalid_polygon_is_not_cut(tool: AnalysisTool) -> None:
    """Cutting needs a valid polygon; an invalid one stays as it is, as the
    tools used it before."""
    zigzag = ", ".join(f"{k} {(k % 2) * 2 - 1}" for k in range(300))
    bowtie = f"POLYGON((0 0, {zigzag}, 300 5, 300 -5, -1 5, 0 0))"
    _table(tool, [(1, "bowtie", bowtie)])
    assert not tool.con.execute("SELECT ST_IsValid(geom) FROM shapes").fetchone()[0]
    tool.subdivide_polygons("shapes", "geom")
    assert tool.con.execute(
        f"SELECT count(*), bool_and(ST_NPoints(geom) = {bowtie.count(',') + 1})"
        " FROM shapes"
    ).fetchone() == (1, True)


def _pieces_in_a_row(tool: AnalysisTool, n: int) -> None:
    """Pieces 1..n: unit squares side by side along the x axis."""
    tool.con.execute(f"""
        CREATE OR REPLACE TEMP TABLE pieces AS
        SELECT i AS piece_id,
               ST_MakeEnvelope(i - 1, 0, i, 1) AS geom
        FROM range(1, {n + 1}) t(i)
    """)


def test_each_row_gets_the_union_of_the_pieces_it_touches(tool: AnalysisTool) -> None:
    """Few pieces are folded together, many are unioned at once; a point
    needs no union, and a row touching nothing gets no row."""
    _pieces_in_a_row(tool, 20)
    circle = _ring(10, 0.5, 1000, 1.6)
    _table(
        tool,
        [
            (1, "in piece 3", "POLYGON((2.2 0.2, 2.8 0.2, 2.8 0.8, 2.2 0.8, 2.2 0.2))"),
            (
                2,
                "across all",
                "POLYGON((0.5 0.4, 19.5 0.4, 19.5 0.6, 0.5 0.6, 0.5 0.4))",
            ),
            (3, "point", "POINT(4.5 0.5)"),
            (4, "far away", "POLYGON((50 50, 51 50, 51 51, 50 51, 50 50))"),
            # Above the vertex limit itself: pieces 9 to 12.
            (5, "big circle", f"POLYGON({circle})"),
        ],
    )
    tool.create_touched_pieces("pairs", "shapes", "id", "geom", "pieces")
    # The cut parts of the big circle were only needed for the join.
    tables = {r[0] for r in tool.con.execute("SHOW TABLES").fetchall()}
    assert not any(t.startswith("pairs_") for t in tables), tables
    union = tool.local_union_cte("pairs", "pieces", "id")
    # Row 2 touches all 20 pieces, more than a list fold takes: it goes to the
    # ST_Union_Agg branch, which stays fast for many pieces.
    assert LIST_UNION_MAX_PIECES < 20
    assert tool.con.execute(f"""
        WITH {union} SELECT max(n) FROM __exploded WHERE id = 2
    """).fetchone() == (20,)
    assert f"WHERE n > {LIST_UNION_MAX_PIECES} GROUP BY" in " ".join(union.split())
    tool.con.execute(f"""
        CREATE TEMP TABLE local AS
        WITH {union}
        SELECT * FROM local_overlays
    """)
    rows = dict(
        tool.con.execute("""
            SELECT id, CASE WHEN local_overlay IS NULL THEN NULL
                            ELSE ST_AsText(ST_Normalize(local_overlay)) END
            FROM local
        """).fetchall()
    )
    expected = {
        1: "ST_MakeEnvelope(2, 0, 3, 1)",
        2: "ST_MakeEnvelope(0, 0, 20, 1)",
        5: "ST_MakeEnvelope(8, 0, 12, 1)",
    }
    assert set(rows) == {1, 2, 3, 5}
    assert rows[3] is None
    for row_id, envelope in expected.items():
        assert tool.con.execute(f"""
            SELECT ST_Equals(local_overlay, {envelope}) FROM local WHERE id = {row_id}
        """).fetchone() == (True,), (row_id, rows[row_id])


def test_overlay_pieces_keep_their_owner(tool: AnalysisTool, tmp_path: Path) -> None:
    """With a key, each row is cut on its own and its pieces keep its key;
    without one, the rows are dissolved first."""
    _table(
        tool,
        [
            (1, "big", BIG),
            (2, "small", "POLYGON((20 20, 21 20, 21 21, 20 21, 20 20))"),
            (3, "invalid", "POLYGON((30 30, 31 31, 31 30, 30 31, 30 30))"),
        ],
    )
    tool.create_overlay_pieces("by_row", "shapes", "geom", key="id")
    tool.create_overlay_pieces("dissolved", "shapes", "geom")
    by_row = tool.con.execute("""
        SELECT id, count(*), count(DISTINCT piece_id), max(ST_NPoints(geom))
        FROM by_row GROUP BY id ORDER BY id
    """).fetchall()
    assert [r[0] for r in by_row] == [1, 2]
    assert by_row[0][1] > 4 and by_row[0][1] == by_row[0][2]
    assert by_row[1][1] == 1
    assert max(r[3] for r in by_row) <= SUBDIVIDE_MAX_VERTICES
    dissolved = tool.con.execute("""
        SELECT count(*), count(DISTINCT piece_id), sum(ST_Area(geom)) FROM dissolved
    """).fetchone()
    big_area = tool.con.execute(f"SELECT ST_Area(ST_GeomFromText('{BIG}'))").fetchone()
    assert dissolved[0] == dissolved[1] > 4
    assert dissolved[2] == pytest.approx(big_area[0] + 1, rel=1e-12)
