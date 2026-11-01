"""A statistics tool colours its result by the column the run wrote."""

from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.analysis.schemas.aggregate import AggregationAreaType
from goatlib.tools.aggregate_points import (
    AggregatePointsToolParams,
    AggregatePointsToolRunner,
)
from goatlib.tools.aggregate_polygon import (
    AggregatePolygonToolParams,
    AggregatePolygonToolRunner,
)
from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner

U = "00000000-0000-0000-0000-000000000001"
IDS = {"user_id": U, "folder_id": U}
NAME = "Einwohner im Einzugsbereich"


def _aggregate_points(**stat: Any) -> AggregatePointsToolParams:
    return AggregatePointsToolParams(
        **IDS,
        source_layer_id=U,
        area_type=AggregationAreaType.h3_grid,
        h3_resolution=8,
        column_statistics=[stat],
    )


def _aggregate_polygon(**stat: Any) -> AggregatePolygonToolParams:
    return AggregatePolygonToolParams(
        **IDS,
        source_layer_id=U,
        area_type=AggregationAreaType.h3_grid,
        h3_resolution=8,
        column_statistics=[stat],
    )


def _dissolve(**stat: Any) -> DissolveToolParams:
    return DissolveToolParams(
        **IDS,
        input_layer_id=U,
        calculate_statistics=True,
        field_statistics=[stat],
    )


@pytest.mark.parametrize(
    ("runner_class", "params", "column"),
    [
        (
            AggregatePointsToolRunner,
            _aggregate_points(operation="sum", field="value", result_name=NAME),
            NAME,
        ),
        (
            AggregatePointsToolRunner,
            _aggregate_points(operation="sum", field="value"),
            "value_sum",
        ),
        (
            AggregatePolygonToolRunner,
            _aggregate_polygon(operation="sum", field="value", result_name=NAME),
            NAME,
        ),
        (
            AggregatePolygonToolRunner,
            _aggregate_polygon(operation="sum", field="value"),
            "sum_value",
        ),
        (
            AggregatePolygonToolRunner,
            _aggregate_polygon(operation="count", result_name=NAME),
            NAME,
        ),
        (
            DissolveToolRunner,
            _dissolve(operation="sum", field="value", result_name=NAME),
            NAME,
        ),
        (
            DissolveToolRunner,
            _dissolve(operation="sum", field="value"),
            "sum_value",
        ),
    ],
)
def test_the_style_colours_by_the_result_column(
    tmp_path: Path, runner_class: type, params: Any, column: str
) -> None:
    result = tmp_path / "result.parquet"
    quoted = '"' + column.replace('"', '""') + '"'
    con = duckdb.connect()
    con.execute(
        f"COPY (SELECT range::DOUBLE AS {quoted} FROM range(1, 21)) "
        f"TO '{result}' (FORMAT PARQUET)"
    )
    con.close()

    runner = runner_class()
    runner._duckdb_con = duckdb.connect()
    try:
        style = runner.get_layer_properties(params, None, parquet_path=result)
    finally:
        runner._duckdb_con.close()
        runner._duckdb_con = None

    assert style["color_field"]["name"] == column
    assert style["color_scale_breaks"]["attribute"] == column
