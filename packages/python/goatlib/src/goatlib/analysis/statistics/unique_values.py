"""Unique values statistics calculation."""

import logging
from typing import Any

import duckdb

from goatlib.analysis.schemas.statistics import (
    SortOrder,
    UniqueValue,
    UniqueValuesResult,
)
from goatlib.analysis.statistics.columns import quote_identifier, require_column
from goatlib.utils.column_types import column_types

logger = logging.getLogger(__name__)


def calculate_unique_values(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    attribute: str,
    where_clause: str = "TRUE",
    params: list[Any] | None = None,
    order: SortOrder = SortOrder.descendent,
    limit: int = 100,
    offset: int = 0,
) -> UniqueValuesResult:
    """Get unique values of an attribute with their occurrence counts.

    Args:
        con: DuckDB connection
        table_name: Fully qualified table name (e.g., "lake.my_table")
        attribute: Column name to analyze
        where_clause: SQL WHERE clause condition (default: "TRUE" for all rows)
        params: Optional query parameters for prepared statement
        order: Sort order by count (ascendent or descendent)
        limit: Maximum number of unique values to return
        offset: Offset for pagination

    Returns:
        UniqueValuesResult with the list of unique values and their counts

    Raises:
        ValueError: If `attribute` is not a column of the table.
    """
    types = column_types(con, table_name)
    attribute = require_column(con, table_name, attribute, "attribute", set(types))
    attr_col = quote_identifier(attribute)
    # A 32-bit float is written as the double it holds, the number vector tiles
    # and the map read (and a filter on it matches), not as the float's short
    # text: DuckDB writes REAL 30745.38 as "30745.38", the value is 30745.380859375.
    text_of = (
        f"CAST({attr_col} AS DOUBLE)"
        if types[attribute].strip().upper() == "FLOAT"
        else attr_col
    )

    # Add null check to where clause
    full_where = f"({where_clause}) AND {attr_col} IS NOT NULL"

    # Map order
    order_dir = "DESC" if order == SortOrder.descendent else "ASC"

    # Get total count of unique values
    count_query = f"""
        SELECT COUNT(DISTINCT {attr_col})
        FROM {table_name}
        WHERE {full_where}
    """

    # Both are written into the SQL, so they must be numbers whatever the
    # caller passed: a string here would be SQL.
    limit, offset = max(int(limit), 0), max(int(offset), 0)

    # Get unique values with counts
    # Values as text, as aggregation_stats writes its groups (it writes a 32-bit
    # float as the float's short text)
    data_query = f"""
        SELECT CAST({text_of} AS VARCHAR) AS value, COUNT(*) AS cnt
        FROM {table_name}
        WHERE {full_where}
        GROUP BY {attr_col}
        ORDER BY cnt {order_dir}, {attr_col}
        LIMIT {limit} OFFSET {offset}
    """

    logger.debug("Unique values query: %s with params: %s", data_query, params)

    # Get total
    if params:
        total_result = con.execute(count_query, params).fetchone()
    else:
        total_result = con.execute(count_query).fetchone()
    total = total_result[0] if total_result else 0

    # Get values
    if params:
        result = con.execute(data_query, params).fetchall()
    else:
        result = con.execute(data_query).fetchall()

    values = [UniqueValue(value=row[0], count=row[1]) for row in result]

    return UniqueValuesResult(
        attribute=attribute,
        total=total,
        values=values,
    )
