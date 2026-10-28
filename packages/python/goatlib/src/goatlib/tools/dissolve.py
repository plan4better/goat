"""Dissolve tool for Windmill.

Merges polygon features that share common attribute values,
optionally computing statistics on dissolved groups.
Equivalent to QGIS "Auflösen" or ArcGIS "Dissolve".
"""

import logging
from pathlib import Path
from typing import Any, List, Optional, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.geoprocessing.dissolve import DissolveTool
from goatlib.analysis.schemas.base import FieldStatistic
from goatlib.analysis.schemas.geoprocessing import DissolveParams
from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    SECTION_RESULT,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import (
    LayerInputMixin,
    ToolInputBase,
    get_default_layer_name,
)
from goatlib.tools.style import TEAL, classified

logger = logging.getLogger(__name__)


class DissolveToolParams(ToolInputBase, LayerInputMixin, DissolveParams):
    """Parameters for dissolve tool.

    Inherits dissolve options from DissolveParams, adds layer context from ToolInputBase.
    input_path/output_path are not used (we use input_layer_id instead).
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(
                id="dissolve_settings",
                order=2,
                icon="aggregate",
                depends_on={"input_layer_id": {"$ne": None}},
            ),
            UISection(
                id="statistics",
                order=3,
                icon="chart",
                depends_on={"input_layer_id": {"$ne": None}},
            ),
            SECTION_RESULT,
            SECTION_OUTPUT,
        )
    )

    # Override file paths as optional - we use layer IDs instead
    input_path: str | None = None  # type: ignore[assignment]
    output_path: str | None = None  # type: ignore[assignment]

    # Override dissolve_fields with proper UI metadata
    dissolve_fields: Optional[List[str]] = Field(
        None,
        description="Fields to group by when dissolving. Features with matching values will be merged. If empty, all features are merged into one.",
        json_schema_extra=ui_field(
            section="dissolve_settings",
            field_order=1,
            widget="field-selector",
            widget_options={
                "source_layer": "input_layer_id",
                "multiple": True,
                "max": 3,
            },
        ),
    )

    # Toggle controlling whether statistics are computed (mirrors JoinToolParams).
    # Persisted in node.data.config so the workflow node restores the user's
    # choice on refresh, unlike the section-collapse state.
    calculate_statistics: bool = Field(
        False,
        description="Calculate statistics for each dissolved group.",
        json_schema_extra=ui_field(
            section="statistics",
            field_order=1,
            widget="switch",
        ),
    )

    # Override field_statistics with proper UI metadata
    field_statistics: Optional[List[FieldStatistic]] = Field(
        None,
        description="Statistics to calculate for each dissolved group.",
        json_schema_extra=ui_field(
            section="statistics",
            field_order=2,
            widget="field-statistics-selector",
            widget_options={"source_layer": "input_layer_id"},
            visible_when={"calculate_statistics": True},
        ),
    )

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("dissolve", "en"),
        description="Name for the dissolve result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("dissolve", "en"),
                "default_de": get_default_layer_name("dissolve", "de"),
            },
        ),
    )


class DissolveToolRunner(BaseToolRunner[DissolveToolParams]):
    """Dissolve tool runner for Windmill."""

    tool_class = DissolveTool
    output_geometry_type = None  # Dynamic based on input geometry
    default_output_name = get_default_layer_name("dissolve", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict dissolve output schema.

        Dissolve outputs:
        - dissolve_fields (group by columns)
        - Statistics columns (operation_field for each statistic)
        - count column (always added)
        - geometry column (merged polygons)
        """
        input_layer = input_schemas.get("input_layer_id", {})
        columns = {}

        # Add dissolve_fields (group by columns)
        dissolve_fields = params.get("dissolve_fields") or []
        for field in dissolve_fields:
            if field in input_layer:
                columns[field] = input_layer[field]

        # Add count column (always present)
        count_col = cls.unique_column_name(columns, "count")
        columns[count_col] = "BIGINT"

        # Add statistics columns (only when the toggle is on)
        calculate_statistics = params.get("calculate_statistics", False)
        field_statistics = (
            (params.get("field_statistics") or []) if calculate_statistics else []
        )
        for stat in field_statistics:
            operation = stat.get("operation", "count")
            field = stat.get("field")
            result_name = stat.get("result_name")
            if operation == "count":
                # count is already added above
                continue
            elif field:
                base_name = result_name if result_name else f"{field}_{operation}"
                col_name = cls.unique_column_name(columns, base_name)
                columns[col_name] = "DOUBLE"

        # Add geometry
        columns["geometry"] = "GEOMETRY"

        return columns

    def get_layer_style(
        self: Self,
        params: DissolveToolParams,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        """Dissolved features classified by their first statistic, in teal; the
        default style without statistics."""
        if not (params.calculate_statistics and params.field_statistics):
            return None
        first_stat = params.field_statistics[0]
        if first_stat.operation.value == "count":
            field = "count"
        else:
            field = f"{first_stat.operation.value}_{first_stat.field}"
        return classified(field, TEAL, geometry)

    def process(
        self: Self, params: DissolveToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run dissolve analysis."""
        input_path = self.export_layer_to_parquet(
            layer_id=params.input_layer_id,
            user_id=params.user_id,
            cql_filter=params.input_layer_filter,
        )
        output_path = temp_dir / "output.parquet"

        dumped = params.model_dump(
            exclude={
                "input_path",
                "output_path",
                "user_id",
                "folder_id",
                "project_id",
                "output_name",
                "input_layer_id",
                "input_layer_filter",
                "calculate_statistics",
            }
        )
        if not params.calculate_statistics:
            dumped["field_statistics"] = None
        analysis_params = DissolveParams(
            **dumped,
            input_path=str(input_path),
            output_path=str(output_path),
        )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: DissolveToolParams) -> dict:
    """Windmill entry point for dissolve tool.

    This function is called by Windmill with parameters from the job.
    Environment variables provide database connection settings.

    Args:
        params: Parameters matching DissolveToolParams schema

    Returns:
        Dict with output layer metadata
    """
    runner = DissolveToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
