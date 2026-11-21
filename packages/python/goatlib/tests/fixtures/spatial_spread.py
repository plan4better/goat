"""How far apart the rows stored next to each other are.

A spatial query skips a row group when the group's bounding box misses the
query window, so rows written in a useful order fill each group from a small
part of the map. `block_spread` measures that on rows in their stored order.
"""

import duckdb

#: 20,000 points scattered over about the extent of Germany, in no spatial order.
SCATTERED_POINTS = """
    SELECT i AS id,
           ST_Point(5.8 + (i * 7919 % 10007) / 10007.0 * 9.3,
                    47.2 + (i * 104729 % 10009) / 10009.0 * 7.9) AS geometry
    FROM range(20000) r(i)
"""


def block_spread(
    con: duckdb.DuckDBPyConnection, ordered: str, block: int, geometry: str = "geometry"
) -> float:
    """The median share of the whole extent's area that a block of `block`
    consecutive rows covers. `ordered` yields the rows in stored order with a
    `pos` column numbering them (file_row_number, rowid)."""
    return con.execute(
        f"""
        WITH rows AS (SELECT pos, ST_X({geometry}) x, ST_Y({geometry}) y FROM ({ordered})),
        whole AS (SELECT (max(x) - min(x)) * (max(y) - min(y)) area FROM rows)
        SELECT median((max_x - min_x) * (max_y - min_y)) / any_value(whole.area)
        FROM (SELECT pos // {block} b, max(x) max_x, min(x) min_x, max(y) max_y, min(y) min_y
              FROM rows GROUP BY b), whole
        """
    ).fetchone()[0]
