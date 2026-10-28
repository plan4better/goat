"""Aggregate Polygon tool for Windmill.

Aggregates polygon features onto polygons or H3 hexagonal grids,
computing statistics like count, sum, mean, min, or max.
Supports weighting by intersection area ratio.
"""

import logging
from pathlib import Path
from typing import Any, List, Optional, Self

from pydantic import Field, field_validator, model_validator

from goatlib.analysis.geoanalysis.aggregate_polygon import AggregatePolygonTool
from goatlib.analysis.schemas.aggregate import (
    AGGREGATION_AREA_TYPE_LABELS,
    AggregateFieldStatistic,
    AggregatePolygonParams,
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
from goatlib.tools.style import classified

logger = logging.getLogger(__name__)


class AggregatePolygonToolParams(ToolInputBase, AggregatePolygonParams):
    """Parameters for aggregate polygon tool.

    Inherits aggregate options from AggregatePolygonParams, adds layer context from ToolInputBase.
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
        description="Path to the polygon layer (auto-populated from source_layer_id).",
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
        description="Layer ID for the polygon layer to be aggregated.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            label_key="select_source_polygon_layer",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
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
        description="Type of area to aggregate polygons into: polygon layer or H3 hexagonal grid.",
        json_schema_extra=ui_field(
            section="area",
            field_order=1,
            label_key="select_area_type",
            enum_labels=AGGREGATION_AREA_TYPE_LABELS,
        ),
    )

    column_statistics: List[AggregateFieldStatistic] = Field(
        ...,
        description="Statistical operations to perform on the aggregated polygons.",
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

    weighted_by_intersecting_area: bool = Field(
        False,
        description="If true, statistics are weighted by the intersection area ratio between source and area polygons.",
        json_schema_extra=ui_field(
            section="statistics",
            field_order=3,
            label_key="weighted_by_intersecting_area",
        ),
    )

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
    def validate_area_configuration(self: Self) -> "AggregatePolygonToolParams":
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
        default=get_default_layer_name("aggregate_polygon", "en"),
        description="Name for the aggregate polygon result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("aggregate_polygon", "en"),
                "default_de": get_default_layer_name("aggregate_polygon", "de"),
            },
        ),
    )


class AggregatePolygonToolRunner(BaseToolRunner[AggregatePolygonToolParams]):
    """Aggregate Polygon tool runner for Windmill."""

    tool_class = AggregatePolygonTool
    output_geometry_type = "polygon"
    default_output_name = get_default_layer_name("aggregate_polygons", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict aggregate polygon output schema.

        Aggregate outputs:
        - h3_index (if area_type is h3) or area layer columns
        - group_by_field columns (if specified)
        - count column (always present)
        - Statistics columns (operation_field for each statistic)
        - geometry column
        """
        columns = {}

        # Add h3_index for H3 aggregation
        area_type = params.get("area_type", "polygon")
        if area_type == "h3":
            columns["h3_index"] = "VARCHAR"
        else:
            # For polygon aggregation, area layer columns are preserved
            area_layer = input_schemas.get("area_layer_id", {})
            for col, dtype in area_layer.items():
                if col != "geometry":
                    columns[col] = dtype

        # Add group_by_field columns
        group_by_fields = params.get("group_by_field") or []
        source_layer = input_schemas.get("source_layer_id", {})
        for field in group_by_fields:
            if field in source_layer:
                columns[field] = source_layer[field]

        # Add count column (always present)
        count_col = cls.unique_column_name(columns, "count")
        columns[count_col] = "BIGINT"

        # Add statistics columns
        column_statistics = params.get("column_statistics") or []
        for stat in column_statistics:
            operation = stat.get("operation", "count")
            field = stat.get("field")
            result_name = stat.get("result_name")
            if operation == "count":
                continue  # count already added
            elif field:
                base_name = result_name if result_name else f"{operation}_{field}"
                col_name = cls.unique_column_name(columns, base_name)
                columns[col_name] = "DOUBLE"

        # Add geometry
        columns["geometry"] = "GEOMETRY"

        return columns

    def get_layer_style(
        self: Self,
        params: AggregatePolygonToolParams,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        """Aggregates classified by their first statistic, in oranges."""
        stat = params.column_statistics[0]
        stat_op = stat.operation
        if stat.result_name:
            field = stat.result_name
        elif stat_op.value == "count":
            field = "count"
        else:
            # For sum/mean/min/max, the output column is named after the operation
            field = f"{stat_op.value}_{stat.field}" if stat.field else stat_op.value

        return classified(field, "colorbrewer:Oranges", geometry)

    def process(
        self: Self, params: AggregatePolygonToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run aggregate polygon analysis."""
        output_path = temp_dir / "output.parquet"

        # Export source polygon layer
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
        analysis_params = AggregatePolygonParams(
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


def main(params: AggregatePolygonToolParams) -> dict:
    """Windmill entry point for aggregate polygon tool.

    This function is called by Windmill with parameters from the job.
    Environment variables provide database connection settings.

    Args:
        params: Parameters matching AggregatePolygonToolParams schema

    Returns:
        Dict with output layer metadata
    """
    runner = AggregatePolygonToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
