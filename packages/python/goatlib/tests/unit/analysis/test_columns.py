"""Column-identifier handling for the statistics calculators.

The calculators accept a *relation*, not just a table name: the catchment-area
styling passes `read_parquet('...')` for output that is not in DuckLake yet.
Bare `DESCRIBE <relation>` only parses an identifier, so that shape used to
fail with `Parser Error: syntax error at or near "("` and the caller silently
fell back to guessing values from its params.
"""

import duckdb
import pytest
from goatlib.analysis.schemas.statistics import SortOrder
from goatlib.analysis.statistics import calculate_unique_values
from goatlib.analysis.statistics.columns import (
    quote_identifier,
    require_column,
    table_column_names,
)


@pytest.fixture
def con() -> duckdb.DuckDBPyConnection:
    return duckdb.connect()


@pytest.fixture
def parquet(con: duckdb.DuckDBPyConnection, tmp_path) -> str:
    path = tmp_path / "catchment.parquet"
    con.execute(
        "COPY (SELECT * FROM (VALUES (5, 'a'), (10, 'b'), (10, 'c')) "
        f"AS t(cost_step, label)) TO '{path}' (FORMAT parquet)"
    )
    return f"read_parquet('{path}')"


def test_column_names_of_a_plain_table(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("CREATE TABLE plain AS SELECT 1 AS cost_step, 2 AS other")

    assert table_column_names(con, "plain") == {"cost_step", "other"}


def test_column_names_of_a_table_expression(
    con: duckdb.DuckDBPyConnection, parquet: str
) -> None:
    assert table_column_names(con, parquet) == {"cost_step", "label"}


def test_require_column_accepts_a_real_column_of_an_expression(
    con: duckdb.DuckDBPyConnection, parquet: str
) -> None:
    assert require_column(con, parquet, "cost_step") == "cost_step"


def test_require_column_rejects_a_name_the_relation_does_not_have(
    con: duckdb.DuckDBPyConnection, parquet: str
) -> None:
    with pytest.raises(ValueError, match="Unknown column"):
        require_column(con, parquet, "cost_step; DROP TABLE x")


def test_require_column_rejects_an_empty_name(
    con: duckdb.DuckDBPyConnection, parquet: str
) -> None:
    with pytest.raises(ValueError, match="required"):
        require_column(con, parquet, "")


def test_quote_identifier_doubles_embedded_quotes() -> None:
    assert quote_identifier('we"ird') == '"we""ird"'


def test_unique_values_over_a_table_expression(
    con: duckdb.DuckDBPyConnection, parquet: str
) -> None:
    """What the catchment-area styling does with a not-yet-registered output."""
    result = calculate_unique_values(
        con=con,
        table_name=parquet,
        attribute="cost_step",
        order=SortOrder.ascendent,
        limit=20,
    )

    assert [int(v.value) for v in result.values] == [5, 10]
