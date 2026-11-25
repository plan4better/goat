"""Heatmap 2SFCA tool for Windmill.

Computes Two-Step Floating Catchment Area (2SFCA) accessibility analysis.
Measures spatial accessibility considering both supply (opportunities/capacity)
and demand (population).
"""

import logging
from pathlib import Path
from typing import Any, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.accessibility.two_step_catchment_area import Heatmap2SFCATool
from goatlib.analysis.schemas.heatmap import (
    Heatmap2SFCAParams,
)
from goatlib.analysis.schemas.ui import (
    SECTION_CONFIGURATION,
    SECTION_DEMAND,
    SECTION_OPPORTUNITIES,
    SECTION_RESULT_ROUTING,
    SECTION_ROUTING,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools._opportunity_handles import (
    WORKFLOW_ONLY_OPPORTUNITY_FIELDS,
    NumberedOpportunityLayersMixin,
)
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import (
    ToolInputBase,
    get_default_layer_name,
)
from goatlib.tools.style import SUNSET, classified

logger = logging.getLogger(__name__)


class Heatmap2SFCAToolParams(
    NumberedOpportunityLayersMixin,
    ToolInputBase,
    Heatmap2SFCAParams,
):
    """Parameters for heatmap 2SFCA tool.

    Inherits heatmap options from Heatmap2SFCAParams, adds layer context from ToolInputBase.
    The Two-Step Floating Catchment Area method measures spatial accessibility
    by considering both supply (capacity of opportunities) and demand (population).
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_ROUTING,
            SECTION_CONFIGURATION,
            SECTION_DEMAND,
            SECTION_OPPORTUNITIES,
            SECTION_RESULT_ROUTING,
        )
    )

    # Layer IDs for the tool
    demand_layer_id: str = Field(
        ...,
        description="Layer containing demand data (e.g., population).",
        json_schema_extra=ui_field(
            section="demand",
            field_order=1,
            label_key="demand_path",
            widget="layer-selector",
        ),
    )
    demand_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the demand layer",
        json_schema_extra=ui_field(section="demand", field_order=2, hidden=True),
    )

    # Override demand_field to reference the correct layer ID
    demand_field: str = Field(
        ...,
        description="Field from the demand layer that contains the demand value (e.g., population).",
        json_schema_extra=ui_field(
            section="demand",
            field_order=3,
            label_key="demand_field",
            widget="field-selector",
            widget_options={
                "source_layer": "demand_layer_id",
                "field_types": ["number"],
            },
            visible_when={"demand_layer_id": {"$ne": None}},
        ),
    )

    # Override file paths as optional - they will be resolved internally
    od_matrix_path: str | None = Field(
        default=None,
        description="Path to OD matrix (auto-populated from routing_mode if not provided)",
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    demand_path: str | None = Field(  # type: ignore[assignment]
        default=None,
        json_schema_extra=ui_field(section="demand", hidden=True),
    )

    output_path: str | None = None  # type: ignore[assignment]
    reference_area_path: str | None = None  # type: ignore[assignment]

    # Layer ID for the reference area (replaces reference_area_path for tools)
    reference_area_layer_id: str | None = Field(
        None,
        description="Layer ID for the reference area polygon",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=4,
            label_key="reference_area_path",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
            advanced=True,
        ),
    )
    reference_area_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the reference area layer",
        json_schema_extra=ui_field(section="configuration", field_order=5, hidden=True),
    )

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("heatmap_2sfca", "en"),
        description="Name for the heatmap 2SFCA result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("heatmap_2sfca", "en"),
                "default_de": get_default_layer_name("heatmap_2sfca", "de"),
            },
        ),
    )


class Heatmap2SFCAToolRunner(BaseToolRunner[Heatmap2SFCAToolParams]):
    """Heatmap 2SFCA tool runner for Windmill."""

    tool_class = Heatmap2SFCATool
    output_geometry_type = "polygon"  # H3 cells
    default_output_name = get_default_layer_name("heatmap_2sfca", "en")

    def get_layer_style(
        self: Self,
        params: Heatmap2SFCAToolParams,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        """The 2SFCA index in sunset colors: the supply-demand ratio."""
        return classified("total_accessibility", SUNSET, geometry)

    def process(
        self: Self, params: Heatmap2SFCAToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run heatmap 2SFCA analysis."""
        output_path = temp_dir / "output.parquet"

        # Resolve opportunity layer IDs to parquet paths
        resolved_opportunities = self.resolve_layer_paths(
            params.opportunities, params.user_id, "input_path"
        )

        # Resolve demand layer ID to parquet path
        demand_path = self.export_layer_to_parquet(
            params.demand_layer_id,
            user_id=params.user_id,
            cql_filter=params.demand_layer_filter,
        )

        # Export reference area layer
        reference_area_path = None
        if params.reference_area_layer_id is not None:
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
        analysis_params = Heatmap2SFCAParams(
            **params.model_dump(
                exclude={
                    "output_path",
                    "od_matrix_path",
                    "user_id",
                    "folder_id",
                    "project_id",
                    "output_name",
                    "opportunities",
                    "demand_path",
                    "demand_layer_id",
                    "demand_layer_filter",
                    # Canvas-only plumbing, already folded into opportunities
                    *WORKFLOW_ONLY_OPPORTUNITY_FIELDS,
                    "reference_area_path",
                    "reference_area_layer_id",
                    "reference_area_layer_filter",
                }
            ),
            opportunities=resolved_opportunities,
            demand_path=demand_path,
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


def main(params: Heatmap2SFCAToolParams) -> dict:
    """Windmill entry point for heatmap 2SFCA tool."""
    runner = Heatmap2SFCAToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
