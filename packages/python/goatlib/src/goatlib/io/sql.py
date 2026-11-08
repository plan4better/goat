"""Values from files written into DuckDB SQL.

A path, a layer or sheet name and a column name all come from what a user
uploaded (an archive member's name is the user's own text), so each goes into a
statement as a bound parameter where DuckDB takes one, and otherwise through
these two helpers, never pasted in as it is. Standard library only.
"""


def sql_literal(value: object) -> str:
    """`value` as a SQL string literal: in single quotes, embedded ones doubled."""
    return "'" + str(value).replace("'", "''") + "'"


def sql_identifier(name: object) -> str:
    """`name` as a quoted SQL identifier: in double quotes, embedded ones doubled."""
    return '"' + str(name).replace('"', '""') + '"'
