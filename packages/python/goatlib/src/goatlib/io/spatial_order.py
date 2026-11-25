"""The order a layer's rows are written in: along a Hilbert curve over the
rows' own extent.

A spatial query skips a row group whose bounding box misses its window, so
rows that are neighbours on the map should be neighbours in the file. DuckDB's
ST_Hilbert does that only with a box: without one it maps the coordinates'
raw float bits onto the curve, and every row group of a German layer spanned
the whole country. The box here is the extent of the rows being written, read
from `relation` in a scalar subquery (one more pass over the source, cheaper
than a window over all rows). Standard library only.
"""


def hilbert_key(geometry: str, relation: str) -> str:
    """An ORDER BY key for the rows of `relation` (a table, a parquet read or a
    parenthesized query with an alias) by `geometry`, a quoted column name or
    expression. Rows without a location (NULL or an empty geometry, which
    ST_Hilbert with a box refuses) get no key and sort last."""
    extent = f"(SELECT ST_Extent(ST_Extent_Agg({geometry})) FROM {relation})"
    return (
        f"CASE WHEN ST_IsEmpty({geometry}) THEN NULL "
        f"ELSE ST_Hilbert({geometry}, {extent}) END"
    )
