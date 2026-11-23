"""Column types of a DuckDB relation and what kind of value each holds.

geoapi (queryables, formula columns) and the style's data description read the
same answer from here. Light on purpose: geoapi imports it, and
`goatlib.analysis` is slow to import.
"""

from typing import Literal

import duckdb

TypeClass = Literal[
    "integer",
    "number",
    "boolean",
    "date",
    "datetime",
    "time",
    "geometry",
    "object",
    "string",
]

_INTEGER = {
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "HUGEINT",
    "UTINYINT",
    "USMALLINT",
    "UINTEGER",
    "UBIGINT",
    "UHUGEINT",
}
_NUMBER = {"FLOAT", "DOUBLE", "DECIMAL"}
_GEOMETRY = ("GEOMETRY", "GEOGRAPHY", "POINT_", "LINESTRING_", "POLYGON_", "BOX_")


def column_types(con: duckdb.DuckDBPyConnection, relation: str) -> dict[str, str]:
    """Column names of a table or table expression with their DuckDB types, in order.

    DESCRIBE loads only this relation's metadata; information_schema.columns
    would lazily load every table in the catalog to answer.

    Described as a SELECT because bare `DESCRIBE <relation>` only parses an
    identifier: callers legitimately pass an expression such as
    `read_parquet('...')`, and `DESCRIBE read_parquet('...')` is a parser error
    ("syntax error at or near \"(\""). `DESCRIBE SELECT * FROM ...` binds the
    same metadata for both shapes without scanning either.
    """
    return {
        str(row[0]): str(row[1])
        for row in con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()
        if row
    }


def type_class(duckdb_type: str) -> TypeClass:
    """What kind of value a DuckDB type holds, read from the type's name as
    DESCRIBE writes it: lists, structs, maps and JSON are objects, the spatial
    types geometry, and every type not named here is text."""
    t = duckdb_type.strip().upper()
    if t.endswith("]") or t.startswith(("STRUCT", "MAP", "UNION")) or t == "JSON":
        return "object"
    base = t.split("(")[0].strip()
    if base in _INTEGER:
        return "integer"
    if base in _NUMBER:
        return "number"
    if base == "BOOLEAN":
        return "boolean"
    if base == "DATE":
        return "date"
    if base.startswith("TIMESTAMP"):
        return "datetime"
    if base.startswith("TIME"):
        return "time"
    if base.startswith(_GEOMETRY):
        return "geometry"
    return "string"
