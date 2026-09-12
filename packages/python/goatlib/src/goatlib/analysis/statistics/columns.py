"""Column-identifier handling shared by the statistics calculators.

The calculators splice a caller-supplied column name into their SQL. Several
of them are reachable from unauthenticated HTTP processes, so a name is only
accepted when the target table actually has such a column, and it is always
emitted as a quoted identifier with embedded quotes doubled.
"""

import duckdb


def quote_identifier(name: str) -> str:
    """Quote a SQL identifier, doubling any embedded double quotes."""
    return '"' + name.replace('"', '""') + '"'


def table_column_names(con: duckdb.DuckDBPyConnection, table_name: str) -> set[str]:
    """Column names of a table or table expression.

    DESCRIBE loads only this relation's metadata; information_schema.columns
    would lazily load every table in the catalog to answer.

    Described as a SELECT because bare `DESCRIBE <relation>` only parses an
    identifier: callers legitimately pass an expression such as
    `read_parquet('...')`, and `DESCRIBE read_parquet('...')` is a parser error
    ("syntax error at or near \"(\""). `DESCRIBE SELECT * FROM ...` binds the
    same metadata for both shapes without scanning either.
    """
    return {
        str(row[0])
        for row in con.execute(f"DESCRIBE SELECT * FROM {table_name}").fetchall()
        if row
    }


def require_column(
    con: duckdb.DuckDBPyConnection,
    table_name: str,
    column: str,
    param_name: str = "column",
    columns: set[str] | None = None,
) -> str:
    """Return `column` when the relation has it, else raise.

    Membership is the whole check: a name equal to a real column cannot break
    out of its quotes, and — unlike an identifier-shape pattern — it accepts the
    spaces, dashes and non-ASCII letters that uploaded layers legitimately
    carry. Pass `columns` to reuse a column set already resolved by the caller
    instead of paying for another DESCRIBE.

    Raises:
        ValueError: If `column` is empty or is not a column of the relation.
            Callers on an HTTP path map this to a 400.
    """
    if not column:
        raise ValueError(f"{param_name} is required")
    if columns is None:
        columns = table_column_names(con, table_name)
    if column not in columns:
        raise ValueError(f"Unknown column for {param_name}: {column}")
    return column
