"""Aggregate Points tool for Windmill.

Aggregates point features onto polygons or H3 hexagonal grids,
computing statistics like count, sum, mean, min, or max.
"""

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, List, Optional, Self

from pydantic import Field, field_validator, model_validator

from goatlib.analysis.geoanalysis.aggregate_points import AggregatePointsTool
from goatlib.analysis.schemas.aggregate import (
    AGGREGATION_AREA_TYPE_LABELS,
    AggregateFieldStatistic,
    AggregatePointsParams,
    AggregationAreaType,
    validate_area_type_config,
)
from goatlib.analysis.schemas.ui import (
    SECTION_AREA,
    SECTION_INPUT_AGGREGATE,
    SECTION_RESULT_AGGREGATE,
    SECTION_STATISTICS,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import (
    ToolInputBase,
    get_default_layer_name,
)

logger = logging.getLogger(__name__)


def _statistic_name(stat: dict[str, Any], field_first: bool) -> str | None:
    """The column a statistic writes: its result name, ``count`` for a
    count, else its field and operation; None for one without a field."""
    if stat.get("result_name"):
        return str(stat["result_name"])
    operation = stat.get("operation") or "count"
    operation = str(getattr(operation, "value", operation))
    if operation == "count":
        return "count"
    field = stat.get("field")
    if not field:
        return None
    return f"{field}_{operation}" if field_first else f"{operation}_{field}"


def field_first_statistic_name(stat: dict[str, Any]) -> str | None:
    """``{field}_{operation}`` (``FieldStatistic.get_result_column_name``)."""
    return _statistic_name(stat, field_first=True)


def operation_first_statistic_name(stat: dict[str, Any]) -> str | None:
    """``{operation}_{field}``
    (``FieldStatistic.get_operation_first_column_name``)."""
    return _statistic_name(stat, field_first=False)


def predict_aggregation_columns(
    input_schemas: dict[str, dict[str, str]],
    params: dict[str, Any],
    statistic_name: Callable[[dict[str, Any]], str | None],
) -> dict[str, str]:
    """The columns an aggregation of points or polygons writes, in the run's
    order: the geometry; the area layer's columns, or on an H3 grid each
    cell's id as ``h3_<resolution>``; one column per statistic; and with
    group fields one JSON column ``<statistic>_grouped`` per statistic. The
    group fields themselves are not written, and a count only when a count
    statistic asks for one. A name already taken gets DuckDB's suffix."""
    columns: dict[str, str] = {}

    def add(name: str, dtype: str) -> None:
        columns[BaseToolRunner.unique_column_name(columns, name)] = dtype

    add("geometry", "GEOMETRY")
    if params.get("area_type", AggregationAreaType.polygon) == (
        AggregationAreaType.h3_grid
    ):
        resolution = params.get("h3_resolution")
        if resolution is not None:
            add(f"h3_{resolution}", "VARCHAR")
    else:
        for col, dtype in input_schemas.get("area_layer_id", {}).items():
            if "GEOMETRY" not in dtype.upper() and col not in ("geometry", "bbox"):
                add(col, dtype)

    statistics = params.get("column_statistics") or []
    if isinstance(statistics, dict):
        statistics = [statistics]
    names: list[str] = []
    for stat in statistics:
        name = statistic_name(stat) if isinstance(stat, dict) else None
        if name is None:
            continue
        names.append(name)
        operation = stat.get("operation") or "count"
        counted = str(getattr(operation, "value", operation)) == "count"
        add(name, "BIGINT" if counted else "DOUBLE")
    if params.get("group_by_field"):
        for name in names:
            add(f"{name}_grouped", "JSON")
    return columns


class AggregatePointsToolParams(ToolInputBase, AggregatePointsParams):
    """Parameters for aggregate points tool.

    Inherits aggregate options from AggregatePointsParams, adds layer context from ToolInputBase.
    source_path/area_layer_path/output_path are not used (we use layer IDs instead).
    """

    model_config = {
        "json_schema_extra": ui_sections(
            SECTION_INPUT_AGGREGATE,
            SECTION_AREA,
            SECTION_STATISTICS,
            SECTION_RESULT_AGGREGATE,
        )
    }

    # Override file paths as optional - we use layer IDs instead
    source_path: str | None = Field(
        None,
        description="Path to the point layer (auto-populated from source_layer_id).",
        json_schema_extra=ui_field(section="input", hidden=True),
    )
    area_layer_path: str | None = Field(
        None,
        description="Path to the area layer (auto-populated from area_layer_id).",
        json_schema_extra=ui_field(section="area", hidden=True),
    )
    output_path: str | None = Field(
        None,
        description="Output path (auto-generated).",
        json_schema_extra=ui_field(section="output", hidden=True),
    )

    # ---- Layer ID fields (UI uses these instead of paths) ----
    source_layer_id: str = Field(
        ...,
        description="Layer ID for the point layer to be aggregated.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            label_key="select_source_point_layer",
            widget="layer-selector",
            widget_options={"geometry_types": ["Point", "MultiPoint"]},
        ),
    )
    source_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the source layer",
        json_schema_extra=ui_field(section="input", field_order=2, hidden=True),
    )

    area_layer_id: Optional[str] = Field(
        None,
        description="Layer ID for the polygon layer used for aggregation. Required when area_type is 'polygon'.",
        json_schema_extra=ui_field(
            section="area",
            field_order=2,
            label_key="select_area_layer",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
            visible_when={"area_type": "polygon"},
        ),
    )
    area_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the area layer",
        json_schema_extra=ui_field(section="area", field_order=3, hidden=True),
    )

    # Override UI metadata for inherited fields
    area_type: AggregationAreaType = Field(
        ...,
        description="Type of area to aggregate points into: polygon layer or H3 hexagonal grid.",
        json_schema_extra=ui_field(
            section="area",
            field_order=1,
            label_key="select_area_type",
            enum_labels=AGGREGATION_AREA_TYPE_LABELS,
        ),
    )

    column_statistics: List[AggregateFieldStatistic] = Field(
        ...,
        description="Statistical operations to perform on the aggregated points.",
        min_length=1,
        json_schema_extra=ui_field(
            section="statistics",
            field_order=1,
            label_key="select_statistics_configuration",
            repeatable=True,
            min_items=1,
            max_items=30,
        ),
    )

    @field_validator("column_statistics", mode="before")
    @classmethod
    def wrap_column_statistics_in_list(cls, value: dict | List[dict]) -> List[dict]:
        """Convert a single column_statistics dict to a list for backwards compatibility."""
        if isinstance(value, dict):
            return [value]
        return value

    # Override group_by_field to use source_layer_id instead of source_path
    group_by_field: Optional[List[str]] = Field(
        None,
        description="Optional field(s) in the source layer to group aggregated results by (max 3 fields).",
        json_schema_extra=ui_field(
            section="statistics",
            field_order=10,
            advanced=True,
            label_key="select_group_fields",
            widget="field-selector",
            widget_options={
                "source_layer": "source_layer_id",
                "multiple": True,
                "max": 3,
            },
        ),
    )

    @model_validator(mode="after")
    def validate_area_configuration(self: Self) -> "AggregatePointsToolParams":
        """Override parent validator to check area_layer_id instead of area_layer_path."""
        validate_area_type_config(
            area_type=self.area_type,
            area_layer=self.area_layer_id,
            h3_resolution=self.h3_resolution,
            area_layer_field_name="area_layer_id",
        )
        return self

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("aggregate_points", "en"),
        description="Name for the aggregate points result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("aggregate_points", "en"),
                "default_de": get_default_layer_name("aggregate_points", "de"),
            },
        ),
    )


class AggregatePointsToolRunner(BaseToolRunner[AggregatePointsToolParams]):
    """Aggregate Points tool runner for Windmill."""

    tool_class = AggregatePointsTool
    output_geometry_type = "polygon"
    default_output_name = get_default_layer_name("aggregate_points", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """The columns the run writes (``predict_aggregation_columns``), each
        statistic named ``{field}_{operation}``, as
        ``FieldStatistic.get_result_column_name`` names it in the run."""
        return predict_aggregation_columns(
            input_schemas, params, field_first_statistic_name
        )

    def get_layer_properties(
        self: Self,
        params: AggregatePointsToolParams,
        metadata: DatasetMetadata,
        table_info: dict[str, Any] | None = None,
        parquet_path: Path | str | None = None,
    ) -> dict[str, Any] | None:
        """Return style for aggregated output with quantile breaks."""
        # Style by the column the first statistic wrote
        color_field = params.column_statistics[0].get_result_column_name()

        # Compute quantile breaks from the DuckLake table
        color_scale_breaks = None
        table_name = table_info["table_name"] if table_info else None
        if table_name or parquet_path:
            color_scale_breaks = self.compute_quantile_breaks(
                table_name=table_name,
                column_name=color_field,
                num_breaks=6,
                strip_zeros=True,
                parquet_path=parquet_path,
            )
            if color_scale_breaks:
                logger.info(
                    "Computed quantile breaks for %s: %s",
                    color_field,
                    color_scale_breaks,
                )

        # Import here to avoid circular imports
        from goatlib.tools.style import get_heatmap_style

        # Use Orange for aggregation - represents count/sum data
        return get_heatmap_style(
            color_field_name=color_field,
            color_scale_breaks=color_scale_breaks,
            color_range_name="Oranges",
        )

    def process(
        self: Self, params: AggregatePointsToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run aggregate points analysis."""
        output_path = temp_dir / "output.parquet"

        # Export source point layer
        source_path = str(
            self.export_layer_to_parquet(
                layer_id=params.source_layer_id,
                user_id=params.user_id,
                cql_filter=params.source_layer_filter,
            )
        )

        # Export area layer if polygon aggregation
        area_layer_path = None
        if params.area_type == AggregationAreaType.polygon and params.area_layer_id:
            area_layer_path = str(
                self.export_layer_to_parquet(
                    layer_id=params.area_layer_id,
                    user_id=params.user_id,
                    cql_filter=params.area_layer_filter,
                )
            )

        # Build analysis params using model_dump pattern (like other tools)
        analysis_params = AggregatePointsParams(
            **params.model_dump(
                exclude={
                    "source_path",
                    "area_layer_path",
                    "output_path",
                    "output_crs",
                    "user_id",
                    "folder_id",
                    "project_id",
                    "output_name",
                    "source_layer_id",
                    "source_layer_filter",
                    "area_layer_id",
                    "area_layer_filter",
                    "accepted_source_geometry_types",
                    "accepted_area_geometry_types",
                }
            ),
            source_path=source_path,
            area_layer_path=area_layer_path,
            output_path=str(output_path),
        )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: AggregatePointsToolParams) -> dict:
    """Windmill entry point for aggregate points tool.

    This function is called by Windmill with parameters from the job.
    Environment variables provide database connection settings.

    Args:
        params: Parameters matching AggregatePointsToolParams schema

    Returns:
        Dict with output layer metadata
    """
    runner = AggregatePointsToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
