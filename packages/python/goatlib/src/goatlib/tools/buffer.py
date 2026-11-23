"""Buffer tool for Windmill.

This is an example implementation showing how to create a Windmill tool
using the BaseToolRunner infrastructure.

The tool creates buffer zones around features from an input layer.
"""

import logging
from pathlib import Path
from typing import Any, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.geoprocessing.buffer import BufferTool
from goatlib.analysis.schemas.geoprocessing import BufferParams, DistanceType
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
from goatlib.tools.style import categories

logger = logging.getLogger(__name__)


class BufferToolParams(ToolInputBase, LayerInputMixin, BufferParams):
    """Parameters for buffer tool.

    Inherits buffer options from BufferParams, adds layer context from ToolInputBase.
    input_path/output_path are not used (we use input_layer_id instead).
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(
                id="configuration",
                order=2,
                icon="settings",
                depends_on={"input_layer_id": {"$ne": None}},
            ),
            SECTION_RESULT,
            SECTION_OUTPUT,
        )
    )

    # Override file paths as optional - we use layer IDs instead
    input_path: str | None = None  # type: ignore[assignment]
    output_path: str | None = None  # type: ignore[assignment]

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("buffer", "en"),
        description="Name for the buffer result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("buffer", "en"),
                "default_de": get_default_layer_name("buffer", "de"),
            },
        ),
    )


class BufferToolRunner(BaseToolRunner[BufferToolParams]):
    """Buffer tool runner for Windmill."""

    tool_class = BufferTool
    output_geometry_type = "polygon"
    default_output_name = get_default_layer_name("buffer", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict buffer output schema.

        Buffer outputs:
        - All input columns (unless polygon_union is enabled)
        - buffer_distance column (always added)
        - geometry as Polygon
        """
        polygon_union = params.get("polygon_union", False)

        if polygon_union:
            # Union mode: only buffer_distance and geometry
            return {
                "buffer_distance": "INTEGER",
                "geometry": "GEOMETRY",
            }

        # Normal mode: all input columns plus buffer_distance
        primary_input = input_schemas.get("input_layer_id", {})
        columns = dict(primary_input)
        col_name = cls.unique_column_name(columns, "buffer_distance")
        columns[col_name] = "INTEGER"
        return columns

    def get_layer_style(
        self: Self,
        params: BufferToolParams,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        """One class per buffer distance, in orange-red; the default style for
        distances read from a field."""
        if params.distance_type != DistanceType.constant or not params.distances:
            return None
        from goatlib.utils.helper import UNIT_TO_METERS

        unit_mult = UNIT_TO_METERS.get(params.units, 1.0)
        # Whole meters, as the distances are stored in the parquet
        distances = sorted({int(round(d * unit_mult)) for d in params.distances})
        return categories(
            "buffer_distance",
            distances,
            "colorbrewer:OrRd",
            geometry,
            symbol={"fill": {"opacity": 0.7}},
        )

    def process(
        self: Self, params: BufferToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run buffer analysis."""
        input_path = self.export_layer_to_parquet(
            layer_id=params.input_layer_id,
            user_id=params.user_id,
            cql_filter=params.input_layer_filter,
        )
        output_path = temp_dir / "output.parquet"

        analysis_params = BufferParams(
            **params.model_dump(
                exclude={
                    "input_path",
                    "output_path",
                    "user_id",
                    "folder_id",
                    "project_id",
                    "output_name",
                    "input_layer_id",
                    "input_layer_filter",
                }
            ),
            input_path=input_path,
            output_path=str(output_path),
        )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: BufferToolParams) -> dict:
    """Windmill entry point for buffer tool.

    This function is called by Windmill with parameters from the job.
    Environment variables provide database connection settings.

    Args:
        params: Parameters matching BufferToolParams schema

    Returns:
        Dict with output layer metadata
    """
    runner = BufferToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
