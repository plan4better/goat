"""Merge tool for Windmill.

Combines multiple vector layers into a single output layer.
"""

import logging
from pathlib import Path
from typing import Any, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.data_management.merge import MergeTool
from goatlib.analysis.schemas.data_management import MergeInputLayer, MergeParams
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
    ToolInputBase,
    get_default_layer_name,
)

logger = logging.getLogger(__name__)


class MergeToolParams(ToolInputBase, MergeParams):
    """Parameters for merge tool.

    Inherits merge options from MergeParams; layer context comes from ToolInputBase.
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(
                id="merge_options",
                order=2,
                icon="settings",
                collapsible=True,
                collapsed=True,
            ),
            SECTION_RESULT,
            SECTION_OUTPUT,
        )
    )

    input_paths: list[MergeInputLayer] = Field(
        default_factory=list,
        min_length=0,
        description="Layers to merge (at least 2 — set via canvas handles in workflow).",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            repeatable=True,
            min_items=2,
        ),
    )

    input_path_1: str | None = Field(
        None,
        description="First input layer (connected from workflow).",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
            label_key="input_path_1",
            hidden=True,
        ),
    )
    input_path_1_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter for the first input layer.",
        json_schema_extra=ui_field(section="input", field_order=2, hidden=True),
    )
    input_path_2: str | None = Field(
        None,
        description="Second input layer (connected from workflow).",
        json_schema_extra=ui_field(
            section="input",
            field_order=3,
            widget="layer-selector",
            label_key="input_path_2",
            hidden=True,
        ),
    )
    input_path_2_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter for the second input layer.",
        json_schema_extra=ui_field(section="input", field_order=4, hidden=True),
    )

    output_path: str | None = None
    output_crs: str | None = Field(
        None,
        description=(
            "Target CRS for output (for example, 'EPSG:4326'). "
            "If omitted, uses the CRS of the first input layer."
        ),
        json_schema_extra=ui_field(section="merge_options", field_order=1),
    )
    add_source_column: bool = Field(
        True,
        description="If True, adds a layer_source column indicating source layer index.",
        json_schema_extra=ui_field(section="merge_options", field_order=2),
    )
    validate_geometry_types: bool = Field(
        True,
        description="If True, ensures all layers belong to compatible geometry families.",
        json_schema_extra=ui_field(section="merge_options", field_order=3),
    )
    promote_to_multi: bool = Field(
        True,
        description="If True, promotes single-part geometries to multi-part geometries.",
        json_schema_extra=ui_field(section="merge_options", field_order=4),
    )

    result_layer_name: str | None = Field(
        default=get_default_layer_name("merge", "en"),
        description="Name for the merge result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("merge", "en"),
                "default_de": get_default_layer_name("merge", "de"),
            },
        ),
    )


class MergeToolRunner(BaseToolRunner[MergeToolParams]):
    """Merge tool runner for Windmill."""

    tool_class = MergeTool
    output_geometry_type = None
    output_geometry_follows_input = True
    default_output_name = get_default_layer_name("merge", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict merge output schema.

        Merge maps same-name fields into a single output column and retains
        fields unique to each input.
        """
        columns: dict[str, str] = {}

        ordered_schemas: list[dict[str, str]] = []
        input_paths = params.get("input_paths") or []
        if isinstance(input_paths, list):
            for item in input_paths:
                if isinstance(item, dict):
                    layer_id = item.get("input_path")
                elif hasattr(item, "input_path"):
                    layer_id = item.input_path
                else:
                    layer_id = item
                if isinstance(layer_id, str) and layer_id in input_schemas:
                    ordered_schemas.append(input_schemas[layer_id])

        if not ordered_schemas:
            ordered_schemas = list(input_schemas.values())

        has_geometry = False
        for schema in ordered_schemas:
            for col, dtype in schema.items():
                if col == "geometry":
                    has_geometry = True
                    continue

                if col not in columns:
                    columns[col] = dtype

        if params.get("add_source_column", True):
            columns[cls.unique_column_name(columns, "layer_source")] = "INTEGER"

        if has_geometry:
            columns["geometry"] = "GEOMETRY"
        return columns

    def process(
        self: Self, params: MergeToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run merge analysis."""
        resolved_items = self.resolve_layer_paths(
            params.input_paths,
            params.user_id,
            "input_path",
            "input_layer_filter",
        )

        output_path = temp_dir / "output.parquet"

        analysis_params = MergeParams(
            **params.model_dump(
                exclude={
                    "input_paths",
                    "output_path",
                    "user_id",
                    "folder_id",
                    "project_id",
                    "output_name",
                }
            ),
            input_paths=resolved_items,
            output_path=str(output_path),
        )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: MergeToolParams) -> dict:
    """Windmill entry point for merge tool."""
    runner = MergeToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
