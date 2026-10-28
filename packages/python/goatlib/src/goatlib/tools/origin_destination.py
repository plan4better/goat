"""Origin-Destination tool for Windmill.

Creates origin-destination lines and points from a geometry layer and OD matrix.
"""

import asyncio
import logging
import tempfile
import uuid as uuid_module
from pathlib import Path
from typing import Any, Optional, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.geoanalysis import OriginDestinationTool
from goatlib.analysis.schemas.geoprocessing import OriginDestinationParams
from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner, drops_unrecorded_tables
from goatlib.tools.schemas import (
    ToolInputBase,
    ToolOutputBase,
    get_default_layer_name,
)
from goatlib.tools.style import classified

logger = logging.getLogger(__name__)

# Result section for OD tool
SECTION_RESULT_OD = UISection(
    id="result",
    order=7,
    icon="save",
    label_key="result_layer_section",
    depends_on={"geometry_layer_id": {"$ne": None}},
)


class OriginDestinationToolParams(ToolInputBase, OriginDestinationParams):
    """Parameters for origin-destination tool.

    Inherits OD options from OriginDestinationParams, adds layer context from ToolInputBase.
    geometry_path/matrix_path/output_paths are not used (we use layer IDs instead).
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="matrix", order=2, icon="grid", label_key="matrix"),
            UISection(id="columns", order=3, icon="list", label_key="columns"),
            SECTION_RESULT_OD,
            SECTION_OUTPUT,
        )
    )

    # Hide base path fields - we use layer IDs instead
    geometry_path: str | None = Field(
        None,
        json_schema_extra=ui_field(section="input", hidden=True),
    )  # type: ignore[assignment]
    matrix_path: str | None = Field(
        None,
        json_schema_extra=ui_field(section="input", hidden=True),
    )  # type: ignore[assignment]
    output_path_lines: str | None = Field(
        None,
        json_schema_extra=ui_field(section="output", hidden=True),
    )
    output_path_points: str | None = Field(
        None,
        json_schema_extra=ui_field(section="output", hidden=True),
    )

    # Layer IDs for the tool
    geometry_layer_id: str = Field(
        ...,
        description="Layer with origin/destination geometries (points or polygons).",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    geometry_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the geometry layer",
        json_schema_extra=ui_field(section="input", field_order=2, hidden=True),
    )

    matrix_layer_id: str = Field(
        ...,
        description="Layer containing the origin-destination matrix data.",
        json_schema_extra=ui_field(
            section="matrix",
            field_order=1,
            widget="layer-selector",
        ),
    )
    matrix_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the matrix layer",
        json_schema_extra=ui_field(section="matrix", field_order=2, hidden=True),
    )

    # Override column selectors to reference the correct layer IDs
    unique_id_column: str = Field(
        ...,
        description="The column that contains the unique IDs in geometry layer.",
        json_schema_extra=ui_field(
            section="input",
            field_order=2,
            widget="field-selector",
            widget_options={"source_layer": "geometry_layer_id"},
        ),
    )

    origin_column: str = Field(
        ...,
        description="The column that contains the origins in the origin destination matrix.",
        json_schema_extra=ui_field(
            section="columns",
            field_order=1,
            widget="field-selector",
            widget_options={"source_layer": "matrix_layer_id"},
        ),
    )

    destination_column: str = Field(
        ...,
        description="The column that contains the destinations in the origin destination matrix.",
        json_schema_extra=ui_field(
            section="columns",
            field_order=2,
            widget="field-selector",
            widget_options={"source_layer": "matrix_layer_id"},
        ),
    )

    weight_column: str = Field(
        ...,
        description="The column that contains the weights in the origin destination matrix.",
        json_schema_extra=ui_field(
            section="columns",
            field_order=3,
            widget="field-selector",
            widget_options={
                "source_layer": "matrix_layer_id",
                "field_types": ["number"],
            },
        ),
    )

    # =========================================================================
    # Result Layer Naming Section
    # =========================================================================
    # Hide the generic result_layer_name from ToolInputBase
    result_layer_name: str | None = Field(
        default=None,
        json_schema_extra=ui_field(section="result", hidden=True),
    )

    lines_layer_name: str | None = Field(
        default=get_default_layer_name("origin_destination_lines", "en"),
        description="Custom name for the OD lines layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="lines_layer_name",
            widget_options={
                "default_en": get_default_layer_name("origin_destination_lines", "en"),
                "default_de": get_default_layer_name("origin_destination_lines", "de"),
            },
        ),
    )
    points_layer_name: str | None = Field(
        default=get_default_layer_name("origin_destination_points", "en"),
        description="Custom name for the OD points layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=2,
            label_key="points_layer_name",
            widget_options={
                "default_en": get_default_layer_name("origin_destination_points", "en"),
                "default_de": get_default_layer_name("origin_destination_points", "de"),
            },
        ),
    )

    # Hide output CRS
    output_crs: Optional[str] = Field(
        None,
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=3, hidden=True),
    )


class OriginDestinationToolRunner(BaseToolRunner[OriginDestinationToolParams]):
    """Origin-Destination tool runner for Windmill.

    Creates two output layers:
    1. OD Lines - with weight-based color styling
    2. OD Points - aggregated destination points
    """

    tool_class = OriginDestinationTool
    output_geometry_type = "LineString"  # Primary output
    default_lines_name = get_default_layer_name("origin_destination_lines", "en")
    default_points_name = get_default_layer_name("origin_destination_points", "en")
    # Keep for backward compatibility
    default_output_name = get_default_layer_name("origin_destination_lines", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """Predict origin-destination output schema (lines layer).

        OD Lines output:
        - origin: origin ID
        - destination: destination ID
        - weight: aggregated weight value
        - geometry: LineString connecting origin to destination
        """
        return {
            "origin": "VARCHAR",
            "destination": "VARCHAR",
            "weight": "DOUBLE",
            "geometry": "GEOMETRY",
        }

    def process(
        self: Self, params: OriginDestinationToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Run origin-destination analysis and return lines output."""
        # Export geometry layer
        geometry_path = self.export_layer_to_parquet(
            layer_id=params.geometry_layer_id,
            user_id=params.user_id,
            cql_filter=params.geometry_layer_filter,
        )

        # Export matrix layer
        matrix_path = self.export_layer_to_parquet(
            layer_id=params.matrix_layer_id,
            user_id=params.user_id,
            cql_filter=params.matrix_layer_filter,
        )

        output_path_lines = temp_dir / "output_lines.parquet"
        output_path_points = temp_dir / "output_points.parquet"

        analysis_params = OriginDestinationParams(
            **params.model_dump(
                exclude={
                    "geometry_path",
                    "matrix_path",
                    "output_path_lines",
                    "output_path_points",
                    "user_id",
                    "folder_id",
                    "project_id",
                    "output_name",
                    "geometry_layer_id",
                    "geometry_layer_filter",
                    "matrix_layer_id",
                    "matrix_layer_filter",
                }
            ),
            geometry_path=str(geometry_path),
            matrix_path=str(matrix_path),
            output_path_lines=str(output_path_lines),
            output_path_points=str(output_path_points),
        )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            # Store both results for multi-output handling
            self._lines_result = results[0]
            self._points_result = results[1]
            # Return lines as primary output for standard processing
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()

    def get_layer_style(
        self: Self,
        params: OriginDestinationToolParams,
        metadata: DatasetMetadata,
        geometry: str | None,
        relation: str,
    ) -> dict[str, Any] | None:
        """The OD lines: colored by weight classes, wider with more weight."""
        return classified(
            "weight",
            "colorbrewer:OrRd",
            "line",
            count=5,
            symbol={
                "line": {
                    "opacity": 0.8,
                    "width": {"field": "weight", "range": [1, 10]},
                }
            },
        )

    def points_style(self: Self) -> dict[str, Any]:
        """The OD points: colored by weight classes, larger with more weight."""
        return classified(
            "weight",
            "colorbrewer:OrRd",
            "point",
            count=5,
            symbol={
                "marker": {
                    "opacity": 0.8,
                    "size": {"field": "weight", "range": [10, 50]},
                }
            },
        )

    @drops_unrecorded_tables
    def run(self: Self, params: OriginDestinationToolParams) -> dict[str, Any]:
        """Run OD analysis and create both lines and points layers.

        Overrides base run() to handle dual-output creation.

        Args:
            params: Tool parameters

        Returns:
            Dict with primary layer info and secondary_layers list
        """
        # Check if we're in temp mode (for workflow preview)
        temp_mode = getattr(params, "temp_mode", False)

        output_layer_id_lines = str(uuid_module.uuid4())
        output_layer_id_points = str(uuid_module.uuid4())

        # Use custom names or defaults
        output_name_lines = (
            params.lines_layer_name
            or params.result_layer_name
            or params.output_name
            or self.default_lines_name
        )
        output_name_points = params.points_layer_name or self.default_points_name

        logger.info(
            f"Starting OD tool: {self.__class__.__name__} "
            f"(user={params.user_id}, lines={output_layer_id_lines}, "
            f"points={output_layer_id_points}, temp_mode={temp_mode})"
        )

        # Initialize db_service
        asyncio.get_event_loop().run_until_complete(self._init_db_service())

        with tempfile.TemporaryDirectory(
            prefix=f"{self.__class__.__name__.lower()}_"
        ) as temp_dir:
            temp_path = Path(temp_dir)

            # Step 1: Run analysis (creates both outputs)
            output_parquet_lines, metadata_lines = self.process(params, temp_path)
            output_parquet_points, metadata_points = self._points_result

            logger.info(
                f"Analysis complete: lines={output_parquet_lines}, points={output_parquet_points}"
            )

            # Temp mode: write primary (lines) output only, skip DB records
            if temp_mode:
                result = self._write_temp_result(
                    params=params,
                    output_parquet=output_parquet_lines,
                    output_name=output_name_lines,
                    output_layer_id=output_layer_id_lines,
                    metadata=metadata_lines,
                )
                asyncio.get_event_loop().run_until_complete(self._close_db_service())
                return result

            # Step 2: Ingest lines to DuckLake
            table_info_lines = self._ingest_to_ducklake(
                user_id=params.user_id,
                layer_id=output_layer_id_lines,
                parquet_path=output_parquet_lines,
            )
            logger.info(f"Lines DuckLake table: {table_info_lines['table_name']}")

            # Step 3: Ingest points to DuckLake
            table_info_points = self._ingest_to_ducklake(
                user_id=params.user_id,
                layer_id=output_layer_id_points,
                parquet_path=Path(output_parquet_points),
            )
            logger.info(f"Points DuckLake table: {table_info_points['table_name']}")

            # Refresh database pool
            asyncio.get_event_loop().run_until_complete(self._close_db_service())

            # Step 4: Create lines layer record
            result_info_lines = asyncio.get_event_loop().run_until_complete(
                self._create_db_records(
                    output_layer_id=output_layer_id_lines,
                    params=params,
                    output_name=output_name_lines,
                    metadata=metadata_lines,
                    table_info=table_info_lines,
                )
            )

            # Step 5: Create points layer record
            result_info_points = asyncio.get_event_loop().run_until_complete(
                self._create_db_records(
                    output_layer_id=output_layer_id_points,
                    params=params,
                    output_name=output_name_points,
                    metadata=metadata_points,
                    table_info=table_info_points,
                    style=self.points_style(),
                )
            )

        # Close db service
        asyncio.get_event_loop().run_until_complete(self._close_db_service())

        # Build wm_labels for Windmill job tracking
        wm_labels: list[str] = []
        if params.triggered_by_email:
            wm_labels.append(params.triggered_by_email)

        # Build primary output (lines)
        detected_geom_type_lines = table_info_lines.get("geometry_type")
        output_lines = ToolOutputBase(
            layer_id=output_layer_id_lines,
            name=output_name_lines,
            folder_id=result_info_lines["folder_id"],
            user_id=params.user_id,
            project_id=params.project_id,
            layer_project_id=result_info_lines.get("layer_project_id"),
            type="feature",
            feature_layer_type="tool",
            geometry_type=detected_geom_type_lines,
            feature_count=table_info_lines.get("feature_count", 0),
            extent=table_info_lines.get("extent"),
            table_name=table_info_lines["table_name"],
            wm_labels=wm_labels,
        )

        # Build secondary output (points)
        detected_geom_type_points = table_info_points.get("geometry_type")
        output_points = ToolOutputBase(
            layer_id=output_layer_id_points,
            name=output_name_points,
            folder_id=result_info_points["folder_id"],
            user_id=params.user_id,
            project_id=params.project_id,
            layer_project_id=result_info_points.get("layer_project_id"),
            type="feature",
            feature_layer_type="tool",
            geometry_type=detected_geom_type_points,
            feature_count=table_info_points.get("feature_count", 0),
            extent=table_info_points.get("extent"),
            table_name=table_info_points["table_name"],
            wm_labels=wm_labels,
        )

        logger.info(
            f"OD tool completed: lines={output_layer_id_lines}, points={output_layer_id_points}"
        )

        # Return primary layer with secondary_layers list
        result = output_lines.model_dump()
        result["secondary_layers"] = [output_points.model_dump()]
        return result


def main(params: OriginDestinationToolParams) -> dict:
    """Windmill entry point for origin-destination tool.

    Creates two output layers:
    - OD Lines: Lines connecting origins to destinations, colored by weight
    - OD Points: Aggregated destination points, sized and colored by weight

    Args:
        params: Parameters matching OriginDestinationToolParams schema

    Returns:
        Dict with output layer metadata including secondary_layers
    """
    runner = OriginDestinationToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
