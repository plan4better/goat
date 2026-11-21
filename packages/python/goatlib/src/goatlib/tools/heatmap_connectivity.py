"""Heatmap Connectivity tool for Windmill.

Computes connectivity heatmap - total area reachable within max cost.
"""

import logging
from pathlib import Path
from typing import Any, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.accessibility import HeatmapConnectivityTool
from goatlib.analysis.schemas.heatmap import HeatmapConnectivityParams
from goatlib.analysis.schemas.ui import (
    SECTION_CONFIGURATION,
    SECTION_RESULT_ROUTING,
    SECTION_ROUTING,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import (
    ToolInputBase,
    get_default_layer_name,
)
from goatlib.tools.style import TEAL, classified

logger = logging.getLogger(__name__)


class HeatmapConnectivityToolParams(ToolInputBase, HeatmapConnectivityParams):
    """Parameters for heatmap connectivity tool.

    Inherits heatmap options from HeatmapConnectivityParams, adds layer context from ToolInputBase.
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_ROUTING,
            SECTION_CONFIGURATION,
            SECTION_RESULT_ROUTING,
        )
    )

    # Override file paths as optional - they will be resolved internally
    od_matrix_path: str | None = Field(
        default=None,
        description="Path to OD matrix (auto-populated from routing_mode if not provided)",
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    output_path: str | None = None  # type: ignore[assignment]
    reference_area_path: str | None = None  # type: ignore[assignment]

    # Layer ID for the reference area (replaces reference_area_path for tools)
    reference_area_layer_id: str = Field(
        description="Layer ID for the reference area polygon",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=4,
            label_key="reference_area_path",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )
    reference_area_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the reference area layer",
        json_schema_extra=ui_field(section="configuration", field_order=5, hidden=True),
    )

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("heatmap_connectivity", "en"),
        description="Name for the heatmap connectivity result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("heatmap_connectivity", "en"),
                "default_de": get_default_layer_name("heatmap_connectivity", "de"),
            },
        ),
    )


class HeatmapConnectivityToolRunner(BaseToolRunner[HeatmapConnectivityToolParams]):
    """Heatmap Connectivity tool runner for Windmill."""

    tool_class = HeatmapConnectivityTool
    output_geometry_type = "polygon"  # H3 cells
    default_output_name = get_default_layer_name("heatmap_connectivity", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict heatmap connectivity output schema.

        Heatmap connectivity outputs:
        - h3_index: H3 cell index
        - accessibility: total area reachable within max travel cost
        - geometry: H3 cell polygon
        """
        return {
            "h3_index": "VARCHAR",
            "accessibility": "DOUBLE",
            "geometry": "GEOMETRY",
        }

    def get_layer_style(
        self: Self,
        params: HeatmapConnectivityToolParams,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        """Connectivity in teal: the area reached."""
        return classified("accessibility", TEAL, geometry)

    def process(
        self: Self, params: HeatmapConnectivityToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run heatmap connectivity analysis."""
        output_path = temp_dir / "output.parquet"

        # Export reference area layer
        reference_area_path = str(
            self.export_layer_to_parquet(
                layer_id=params.reference_area_layer_id,
                user_id=params.user_id,
                cql_filter=params.reference_area_layer_filter,
            )
        )

        # Auto-resolve od_matrix_path from routing_mode if not provided
        od_matrix_path = params.od_matrix_path
        if not od_matrix_path:
            od_matrix_path = (
                f"{self.settings.od_matrix_base_path}/{params.routing_mode.value}/"
            )

        # Build analysis params
        analysis_params = HeatmapConnectivityParams(
            **params.model_dump(
                exclude={
                    "output_path",
                    "od_matrix_path",
                    "reference_area_path",
                    "reference_area_layer_id",
                    "reference_area_layer_filter",
                    "user_id",
                    "folder_id",
                    "project_id",
                    "output_name",
                }
            ),
            od_matrix_path=od_matrix_path,
            reference_area_path=reference_area_path,
            output_path=str(output_path),
        )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: HeatmapConnectivityToolParams) -> dict:
    """Windmill entry point for heatmap connectivity tool."""
    runner = HeatmapConnectivityToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
