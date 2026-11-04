"""Difference tool for Windmill.

Computes the geometric difference of features from input and overlay layers.
"""

import logging
from pathlib import Path
from typing import Any, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.geoprocessing.difference import DifferenceTool
from goatlib.analysis.schemas.geoprocessing import DifferenceParams
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
from goatlib.tools.schema_prediction import carried_fields, layer_geometry
from goatlib.tools.schemas import (
    ToolInputBase,
    TwoLayerInputMixin,
    get_default_layer_name,
)

logger = logging.getLogger(__name__)


class DifferenceToolParams(ToolInputBase, TwoLayerInputMixin, DifferenceParams):
    """Parameters for difference tool.

    Inherits difference options from DifferenceParams, adds layer context from ToolInputBase.
    input_path/overlay_path/output_path are not used (we use layer IDs instead).
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="overlay", order=2, icon="layers"),
            SECTION_RESULT,
            SECTION_OUTPUT,
        )
    )

    input_path: str | None = None  # type: ignore[assignment]
    overlay_path: str | None = None  # type: ignore[assignment]
    output_path: str | None = None

    # Override overlay_layer_id to restrict to polygon geometry types only
    overlay_layer_id: str = Field(
        ...,
        description="Overlay layer UUID (must be polygon geometry)",
        json_schema_extra=ui_field(
            section="overlay",
            field_order=1,
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("difference", "en"),
        description="Name for the difference result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("difference", "en"),
                "default_de": get_default_layer_name("difference", "de"),
            },
        ),
    )


class DifferenceToolRunner(BaseToolRunner[DifferenceToolParams]):
    """Difference tool runner for Windmill."""

    tool_class = DifferenceTool
    output_geometry_type = None  # Depends on input
    output_geometry_follows_input = True
    default_output_name = get_default_layer_name("difference", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict difference output schema: the columns a run writes, in
        order (``DifferenceTool``): the input layer's fields, then its
        geometry. Nothing is predicted while the input layer's columns are
        unknown.
        """
        input_layer = input_schemas.get("input_layer_id", {})
        if not input_layer:
            return {}
        name, dtype = layer_geometry(input_layer)
        return {**dict(carried_fields(input_layer)), name: dtype}

    def process(
        self: Self, params: DifferenceToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run difference analysis."""
        input_path = self.export_layer_to_parquet(
            layer_id=params.input_layer_id,
            user_id=params.user_id,
            cql_filter=params.input_layer_filter,
        )
        overlay_path = self.export_layer_to_parquet(
            layer_id=params.overlay_layer_id,
            user_id=params.user_id,
            cql_filter=params.overlay_layer_filter,
        )
        output_path = temp_dir / "output.parquet"

        analysis_params = DifferenceParams(
            **params.model_dump(
                exclude={
                    "input_path",
                    "overlay_path",
                    "output_path",
                    "user_id",
                    "folder_id",
                    "project_id",
                    "output_name",
                    "input_layer_id",
                    "input_layer_filter",
                    "overlay_layer_id",
                    "overlay_layer_filter",
                }
            ),
            input_path=input_path,
            overlay_path=overlay_path,
            output_path=str(output_path),
        )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: DifferenceToolParams) -> dict:
    """Windmill entry point for difference tool."""
    runner = DifferenceToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
