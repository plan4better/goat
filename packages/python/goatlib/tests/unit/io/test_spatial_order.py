"""Rows sorted by `hilbert_key` sit next to their neighbours on the map.

ST_Hilbert without a box maps the coordinates' raw float bits onto the curve,
which leaves rows a few kilometres apart far apart in the file: every row
group of a layer then spanned the whole of Germany and no spatial query
skipped any. The key computes the curve over the rows' own extent.
"""

from pathlib import Path

import duckdb
import pytest
from fixtures.spatial_spread import SCATTERED_POINTS, block_spread
from goatlib.io.spatial_order import hilbert_key


@pytest.fixture
def con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    return con


def test_blocks_of_sorted_rows_cover_a_small_part_of_the_extent(
    con: duckdb.DuckDBPyConnection, tmp_path: Path
) -> None:
    con.execute(f"CREATE TABLE points AS {SCATTERED_POINTS}")
    out = tmp_path / "sorted.parquet"
    con.execute(
        f"COPY (SELECT * FROM points ORDER BY {hilbert_key('geometry', 'points')}) "
        f"TO '{out}' (FORMAT PARQUET)"
    )

    spread = block_spread(
        con,
        f"SELECT file_row_number AS pos, geometry "
        f"FROM read_parquet('{out}', file_row_number=true)",
        block=500,
    )

    # 40 blocks: a compact block covers about 1/40 of the extent, an unsorted
    # one nearly all of it.
    assert spread < 0.1


@pytest.mark.parametrize(
    "rows",
    [
        "SELECT ST_Point(8, 50) AS geometry",
        "SELECT ST_Point(8, 50) AS geometry FROM range(3)",
        "SELECT NULL::GEOMETRY AS geometry FROM range(2)",
        "SELECT ST_GeomFromText('POINT EMPTY') AS geometry UNION ALL "
        "SELECT ST_Point(1, 1) UNION ALL SELECT NULL",
        "SELECT ST_Point(1, 1) AS geometry WHERE false",
    ],
    ids=["one point", "one location", "no geometry", "empty and null", "no rows"],
)
def test_the_key_takes_any_rows(con: duckdb.DuckDBPyConnection, rows: str) -> None:
    con.execute(f"CREATE TABLE t AS {rows}")

    keys = con.execute(
        f"SELECT {hilbert_key('geometry', 't')} FROM t "
        f"ORDER BY {hilbert_key('geometry', 't')}"
    ).fetchall()

    assert len(keys) == con.execute("SELECT count(*) FROM t").fetchone()[0]


def test_rows_without_a_location_sort_last(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        "CREATE TABLE t AS SELECT * FROM (VALUES (1, ST_GeomFromText('POINT EMPTY')), "
        "(2, ST_Point(3, 3)), (3, NULL), (4, ST_Point(1, 1))) v(id, geometry)"
    )

    ids = [
        r[0]
        for r in con.execute(
            f"SELECT id FROM t ORDER BY {hilbert_key('geometry', 't')}"
        ).fetchall()
    ]

    assert set(ids[:2]) == {2, 4}
