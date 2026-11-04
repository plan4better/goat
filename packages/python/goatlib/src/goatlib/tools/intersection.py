"""Intersection tool for Windmill.

Computes the geometric intersection of features from input and overlay layers.
"""

import logging
from pathlib import Path
from typing import Any, List, Optional, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.geoprocessing.intersection import IntersectionTool
from goatlib.analysis.schemas.geoprocessing import IntersectionParams
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


class IntersectionToolParams(ToolInputBase, TwoLayerInputMixin, IntersectionParams):
    """Parameters for intersection tool.

    Inherits intersection options from IntersectionParams, adds layer context from ToolInputBase.
    input_path/overlay_path/output_path are not used (we use layer IDs instead).
    """

    # Override model_config to make field_selection section collapsible
    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="overlay", order=2, icon="layers"),
            UISection(
                id="field_selection",
                order=3,
                icon="list",
                collapsible=True,
                collapsed=True,
            ),
            SECTION_RESULT,
            SECTION_OUTPUT,
        )
    )

    input_path: str | None = None  # type: ignore[assignment]
    overlay_path: str | None = None  # type: ignore[assignment]
    output_path: str | None = None

    # Override field selectors to use input_layer_id/overlay_layer_id instead of input_path/overlay_path
    input_fields: Optional[List[str]] = Field(
        None,
        description="List of field names from input layer to keep in output. If None, all fields are kept.",
        json_schema_extra=ui_field(
            section="field_selection",
            field_order=1,
            widget="field-selector",
            widget_options={"source_layer": "input_layer_id", "multiple": True},
        ),
    )
    overlay_fields: Optional[List[str]] = Field(
        None,
        description="List of field names from overlay layer to keep in output. If None, all fields are kept.",
        json_schema_extra=ui_field(
            section="field_selection",
            field_order=2,
            widget="field-selector",
            widget_options={"source_layer": "overlay_layer_id", "multiple": True},
        ),
    )

    # Override result_layer_name with tool-specific defaults
    result_layer_name: str | None = Field(
        default=get_default_layer_name("intersection", "en"),
        description="Name for the intersection result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("intersection", "en"),
                "default_de": get_default_layer_name("intersection", "de"),
            },
        ),
    )


class IntersectionToolRunner(BaseToolRunner[IntersectionToolParams]):
    """Intersection tool runner for Windmill."""

    tool_class = IntersectionTool
    output_geometry_type = None  # Depends on input
    output_geometry_follows_input = True
    default_output_name = get_default_layer_name("intersection", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict intersection output schema: the columns a run writes, in
        order (``IntersectionTool``).

        The input layer's fields under their own names, then every overlay
        field under ``overlay_fields_prefix`` (``intersection_`` when unset or
        empty), then the input's geometry under its name. ``input_fields`` and
        ``overlay_fields`` pick and order each side's fields; an empty list
        picks them all. A name taken already gets ``_1``, ``_2``, ... as
        DuckDB renames it. Nothing is predicted while the input layer's
        columns are unknown.
        """
        input_layer = input_schemas.get("input_layer_id", {})
        if not input_layer:
            return {}
        overlay_layer = input_schemas.get("overlay_layer_id", {})
        prefix = params.get("overlay_fields_prefix") or "intersection_"

        columns: dict[str, str] = {}
        for name, dtype in [
            *carried_fields(input_layer, params.get("input_fields")),
            *(
                (f"{prefix}{name}", dtype)
                for name, dtype in carried_fields(
                    overlay_layer, params.get("overlay_fields")
                )
            ),
            layer_geometry(input_layer),
        ]:
            columns[cls.unique_column_name(columns, name)] = dtype
        return columns

    def process(
        self: Self, params: IntersectionToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run intersection analysis."""
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

        analysis_params = IntersectionParams(
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


def main(params: IntersectionToolParams) -> dict:
    """Windmill entry point for intersection tool."""
    runner = IntersectionToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
