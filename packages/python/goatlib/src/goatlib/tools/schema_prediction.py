"""Output schema prediction for workflow nodes.

This module provides functionality to predict the output schema (columns, geometry type)
of a tool node BEFORE execution. This enables:
- Field selectors to show available fields from upstream nodes
- Geometry-dependent UI configuration
- Workflow validation

Each tool can implement `predict_output_schema()` to define its output based on inputs.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


class SchemaColumn:
    """Represents a column in a predicted schema."""

    def __init__(
        self: "SchemaColumn", name: str, dtype: str, source: str = "input"
    ) -> None:
        """Initialize column.

        Args:
            name: Column name
            dtype: DuckDB data type (VARCHAR, INTEGER, DOUBLE, GEOMETRY, etc.)
            source: Where this column comes from (input, computed, join)
        """
        self.name = name
        self.dtype = dtype
        self.source = source

    def to_dict(self: "SchemaColumn") -> dict[str, str]:
        return {"name": self.name, "type": self.dtype, "source": self.source}


class PredictedSchema:
    """Predicted output schema for a tool."""

    def __init__(
        self: "PredictedSchema",
        columns: dict[str, str],
        geometry_type: str | None = None,
        geometry_column: str = "geometry",
    ) -> None:
        """Initialize predicted schema.

        Args:
            columns: Column name -> type mapping
            geometry_type: Output geometry type (Point, Polygon, etc.)
            geometry_column: Name of geometry column
        """
        self.columns = columns
        self.geometry_type = geometry_type
        self.geometry_column = geometry_column

    def to_dict(self: "PredictedSchema") -> dict[str, Any]:
        return {
            "columns": self.columns,
            "geometry_type": self.geometry_type,
            "geometry_column": self.geometry_column,
        }


def predict_join_schema(
    target_schema: dict[str, str],
    join_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for join tool.

    Output includes:
    - All target layer columns
    - Selected join layer columns (with optional prefix)
    - Computed statistics columns
    """
    columns = dict(target_schema)

    # Add join layer columns (all non-geometry columns)
    for col_name, col_type in join_schema.items():
        if "GEOMETRY" not in col_type.upper():
            # Prefix with join_ if there's a conflict
            output_name = col_name
            if col_name in columns:
                output_name = f"join_{col_name}"
            columns[output_name] = col_type

    # Add statistics columns if configured
    field_statistics = params.get("field_statistics") or params.get("column_statistics")
    if field_statistics:
        for stat in field_statistics:
            # Support both old and new field naming conventions
            field_name = stat.get("field") or stat.get("column")
            # Support 'operation' (new) and 'statistic'/'type' (old)
            stat_operation = (
                stat.get("operation") or stat.get("statistic") or stat.get("type")
            )

            # Check for custom result_name first
            result_name = stat.get("result_name")
            if result_name:
                stat_col_name = result_name
            elif stat_operation == "count":
                stat_col_name = "count"
            elif field_name and stat_operation:
                # Default naming convention: {field}_{operation}
                stat_col_name = f"{field_name}_{stat_operation}"
            else:
                continue

            # Determine appropriate type
            if stat_operation == "count":
                columns[stat_col_name] = "BIGINT"
            else:
                columns[stat_col_name] = "DOUBLE"

    # Always add count if statistics enabled (unless already added via field_statistics)
    if params.get("calculate_statistics"):
        if "count" not in columns:
            columns["count"] = "BIGINT"

    # Geometry type comes from target layer
    target_geom_type = None
    for col_name, col_type in target_schema.items():
        if "GEOMETRY" in col_type.upper():
            # Try to extract geometry type from type string
            # e.g., "GEOMETRY(POLYGON)" -> "Polygon"
            if "POLYGON" in col_type.upper():
                target_geom_type = "Polygon"
            elif "POINT" in col_type.upper():
                target_geom_type = "Point"
            elif "LINE" in col_type.upper():
                target_geom_type = "LineString"
            break

    return PredictedSchema(
        columns=columns,
        geometry_type=target_geom_type,
    )


def predict_clip_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for clip tool.

    Clip keeps all input columns with same geometry type.
    """
    columns = dict(input_schema)
    geom_type = _extract_geometry_type(input_schema)
    return PredictedSchema(columns=columns, geometry_type=geom_type)


def predict_centroid_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for centroid tool.

    Centroid keeps all input columns and changes geometry to Point.
    """
    columns = dict(input_schema)
    return PredictedSchema(columns=columns, geometry_type="Point")


def predict_intersection_schema(
    input_schema: dict[str, str],
    overlay_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for intersection tool.

    Intersection outputs columns from both layers.
    Geometry type depends on input types (usually Polygon for polygon intersection).
    """
    columns = dict(input_schema)

    # Add overlay layer columns (non-geometry)
    for col_name, col_type in overlay_schema.items():
        if "GEOMETRY" not in col_type.upper():
            output_name = col_name
            if col_name in columns:
                output_name = f"overlay_{col_name}"
            columns[output_name] = col_type

    # Intersection of polygons = polygon, point & polygon = point, etc.
    input_geom = _extract_geometry_type(input_schema)
    overlay_geom = _extract_geometry_type(overlay_schema)

    # Conservative: if either is Point, result is Point; otherwise Polygon
    if input_geom == "Point" or overlay_geom == "Point":
        geom_type = "Point"
    else:
        geom_type = "Polygon"

    return PredictedSchema(columns=columns, geometry_type=geom_type)


def predict_dissolve_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for dissolve tool.

    Dissolve outputs:
    - Dissolve field(s) (group by columns)
    - Optional statistics columns
    - Geometry (merged polygons)
    """
    columns: dict[str, str] = {}

    # Add dissolve fields
    dissolve_field = params.get("dissolve_field")
    if dissolve_field:
        fields = [dissolve_field] if isinstance(dissolve_field, str) else dissolve_field
        for field in fields:
            if field in input_schema:
                columns[field] = input_schema[field]

    # Add statistics columns
    field_statistics = params.get("field_statistics") or params.get("statistics")
    if field_statistics:
        for stat in field_statistics:
            field_name = stat.get("field") or stat.get("column")
            stat_operation = (
                stat.get("operation") or stat.get("statistic") or stat.get("type")
            )

            # Check for custom result_name first
            result_name = stat.get("result_name")
            if result_name:
                stat_col_name = result_name
            elif stat_operation == "count":
                stat_col_name = "count"
            elif field_name and stat_operation:
                stat_col_name = f"{field_name}_{stat_operation}"
            else:
                continue

            if stat_operation == "count":
                columns[stat_col_name] = "BIGINT"
            else:
                columns[stat_col_name] = "DOUBLE"

    # Always add count if not already added
    if "count" not in columns:
        columns["count"] = "BIGINT"

    # Add geometry column
    columns["geometry"] = "GEOMETRY"

    return PredictedSchema(columns=columns, geometry_type="Polygon")


def predict_union_schema(
    input_schema: dict[str, str],
    overlay_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for union tool.

    Union outputs columns from both layers with Polygon geometry.
    """
    columns = dict(input_schema)

    # Add overlay layer columns (non-geometry)
    for col_name, col_type in overlay_schema.items():
        if "GEOMETRY" not in col_type.upper():
            output_name = col_name
            if col_name in columns:
                output_name = f"overlay_{col_name}"
            columns[output_name] = col_type

    return PredictedSchema(columns=columns, geometry_type="Polygon")


def predict_difference_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for difference/erase tool.

    Difference keeps input columns with same geometry type.
    """
    columns = dict(input_schema)
    geom_type = _extract_geometry_type(input_schema)
    return PredictedSchema(columns=columns, geometry_type=geom_type)


def predict_aggregate_points_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for aggregate_points tool.

    Aggregates points onto polygons or H3 grid with statistics.
    """
    columns: dict[str, str] = {}

    # If aggregating to H3, add h3_index
    area_type = params.get("area_type", "polygon")
    if area_type == "h3_grid":
        columns["h3_index"] = "VARCHAR"

    # Add count column (always present, unless overridden by custom result_name)
    has_custom_count = False

    # Add statistics columns
    field_statistics = params.get("field_statistics") or params.get("statistics")
    if field_statistics:
        for stat in field_statistics:
            field_name = stat.get("field") or stat.get("column")
            stat_operation = (
                stat.get("operation") or stat.get("statistic") or stat.get("type")
            )

            # Check for custom result_name first
            result_name = stat.get("result_name")
            if result_name:
                stat_col_name = result_name
                if stat_operation == "count":
                    has_custom_count = True
            elif stat_operation == "count":
                stat_col_name = "count"
                has_custom_count = True
            elif field_name and stat_operation:
                stat_col_name = f"{field_name}_{stat_operation}"
            else:
                continue

            if stat_operation == "count":
                columns[stat_col_name] = "BIGINT"
            else:
                columns[stat_col_name] = "DOUBLE"

    # Add default count column if no custom count was added
    if not has_custom_count:
        columns["count"] = "BIGINT"

    # Add geometry
    columns["geometry"] = "GEOMETRY"

    return PredictedSchema(columns=columns, geometry_type="Polygon")


def predict_aggregate_polygon_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for aggregate_polygon tool.

    Aggregates polygons onto target polygons or H3 grid with weighted statistics.
    """
    columns: dict[str, str] = {}

    # If aggregating to H3, add h3_index
    area_type = params.get("area_type", "polygon")
    if area_type == "h3_grid":
        columns["h3_index"] = "VARCHAR"

    # Track if a custom count was added
    has_custom_count = False

    # Add statistics columns
    field_statistics = params.get("field_statistics") or params.get("statistics")
    if field_statistics:
        for stat in field_statistics:
            field_name = stat.get("field") or stat.get("column")
            stat_operation = (
                stat.get("operation") or stat.get("statistic") or stat.get("type")
            )

            # Check for custom result_name first
            result_name = stat.get("result_name")
            if result_name:
                stat_col_name = result_name
                if stat_operation == "count":
                    has_custom_count = True
            elif stat_operation == "count":
                stat_col_name = "count"
                has_custom_count = True
            elif field_name and stat_operation:
                stat_col_name = f"{field_name}_{stat_operation}"
            else:
                continue

            if stat_operation == "count":
                columns[stat_col_name] = "BIGINT"
            else:
                columns[stat_col_name] = "DOUBLE"

    # Add default count column if no custom count was added
    if not has_custom_count:
        columns["count"] = "BIGINT"

    # Add geometry
    columns["geometry"] = "GEOMETRY"

    return PredictedSchema(columns=columns, geometry_type="Polygon")


def predict_origin_destination_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for origin_destination tool.

    Creates OD lines or points from matrix data.
    """
    columns: dict[str, str] = {}

    # Standard OD output columns
    columns["origin_id"] = "VARCHAR"
    columns["destination_id"] = "VARCHAR"
    columns["value"] = "DOUBLE"

    # Geometry type depends on output_type param
    output_type = params.get("output_type", "line")
    if output_type == "origin":
        geom_type = "Point"
    elif output_type == "destination":
        geom_type = "Point"
    else:
        geom_type = "LineString"

    columns["geometry"] = "GEOMETRY"

    return PredictedSchema(columns=columns, geometry_type=geom_type)


def predict_catchment_area_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for catchment_area tool.

    Creates isochrone polygons around input points.
    """
    columns: dict[str, str] = {}

    # Standard catchment output columns
    columns["id"] = "VARCHAR"
    columns["travel_cost"] = "DOUBLE"
    columns["geometry"] = "GEOMETRY"

    return PredictedSchema(columns=columns, geometry_type="Polygon")


def predict_heatmap_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for heatmap tools (gravity, closest_average, connectivity).

    All heatmap tools output H3 grid cells with accessibility values.
    """
    columns: dict[str, str] = {}

    columns["h3_index"] = "VARCHAR"
    columns["accessibility"] = "DOUBLE"
    columns["geometry"] = "GEOMETRY"

    return PredictedSchema(columns=columns, geometry_type="Polygon")


def predict_geocoding_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Predict output schema for geocoding tool.

    Adds geocoded location columns to input.
    """
    columns = dict(input_schema)

    # Add geocoding result columns
    columns["geocoded_address"] = "VARCHAR"
    columns["geocoded_confidence"] = "DOUBLE"
    columns["geometry"] = "GEOMETRY"

    return PredictedSchema(columns=columns, geometry_type="Point")


def predict_passthrough_schema(
    input_schema: dict[str, str],
    params: dict[str, Any],
) -> PredictedSchema:
    """Default predictor that passes through input schema unchanged.

    Used for tools that don't modify columns.
    """
    columns = dict(input_schema)
    geom_type = _extract_geometry_type(input_schema)
    return PredictedSchema(columns=columns, geometry_type=geom_type)


def predict_huff_schema(input_schemas: dict[str, dict[str, str]]) -> dict[str, str]:
    """The columns a Huff model run writes, both versions (each
    ``_export_original_geom``): every opportunity keeps its own fields and
    gets ``probability`` on its own geometry, which is renamed ``geometry``.
    Read from the opportunity layer's input, whichever layer was connected
    first."""
    opportunities = input_schemas.get("opportunity_layer_id", {})
    columns = {
        name: dtype
        for name, dtype in opportunities.items()
        if "GEOMETRY" not in dtype.upper()
    }
    columns["probability"] = "DOUBLE"
    columns["geometry"] = "GEOMETRY"
    return columns


def _extract_geometry_type(schema: dict[str, str]) -> str | None:
    """Extract geometry type from a schema's geometry column."""
    for col_name, col_type in schema.items():
        if "GEOMETRY" in col_type.upper():
            col_upper = col_type.upper()
            if "POLYGON" in col_upper or "MULTIPOLYGON" in col_upper:
                return "Polygon"
            elif "POINT" in col_upper or "MULTIPOINT" in col_upper:
                return "Point"
            elif "LINE" in col_upper or "MULTILINE" in col_upper:
                return "LineString"
            return None  # Generic geometry
    return None


# Registry of schema predictors by process_id
# Tools with two layer inputs use tuple functions: (target_schema, overlay_schema, params)
# Tools with single input use: (input_schema, params)
SCHEMA_PREDICTORS: dict[str, Any] = {
    # Geoprocessing tools (buffer uses runner.predict_output_schema)
    "clip": predict_clip_schema,
    "centroid": predict_centroid_schema,
    "intersection": predict_intersection_schema,  # two-input
    "dissolve": predict_dissolve_schema,
    "union": predict_union_schema,  # two-input
    "difference": predict_difference_schema,
    # Data management tools
    "join": predict_join_schema,  # two-input
    # Geoanalysis tools
    "aggregate_points": predict_aggregate_points_schema,
    "aggregate_polygon": predict_aggregate_polygon_schema,
    "origin_destination": predict_origin_destination_schema,
    "geocoding": predict_geocoding_schema,
    # Accessibility tools
    "catchment_area": predict_catchment_area_schema,
    "heatmap_gravity_legacy": predict_heatmap_schema,
    "heatmap_closest_average_legacy": predict_heatmap_schema,
    "heatmap_connectivity_legacy": predict_heatmap_schema,
}

# Tools that take two layer inputs (need special handling for legacy predictors)
TWO_INPUT_TOOLS = {
    "join": ("target_layer_id", "join_layer_id"),
    "intersection": ("input_layer_id", "overlay_layer_id"),
    "union": ("input_layer_id", "overlay_layer_id"),
}


def _get_runner_for_tool(process_id: str) -> type | None:
    """Get the tool runner class from the registry.

    Args:
        process_id: Tool/process ID (e.g., "buffer", "join")

    Returns:
        Tool runner class or None if not found
    """
    try:
        from goatlib.tools.registry import TOOL_REGISTRY

        for tool_def in TOOL_REGISTRY:
            if tool_def.name == process_id:
                return tool_def.get_runner_class()
    except Exception as e:
        logger.warning(f"Failed to get runner for {process_id}: {e}")
    return None


def predicts_own_output(process_id: str) -> bool:
    """Whether the tool's runner predicts its output itself. The default
    (``BaseToolRunner.predict_output_schema``) passes the first input's
    columns through, which for a tool of several inputs can be any of them;
    a runner without the method gets the legacy predictors below."""
    from goatlib.tools.base import BaseToolRunner

    runner = _get_runner_for_tool(process_id)
    method = getattr(runner, "predict_output_schema", None)
    default = BaseToolRunner.predict_output_schema.__func__
    return method is not None and getattr(method, "__func__", None) is not default


def predict_node_output_schema(
    process_id: str,
    input_schemas: dict[str, dict[str, str]],
    params: dict[str, Any],
) -> PredictedSchema | None:
    """Predict output schema for a tool node.

    Uses the tool's predict_output_schema classmethod if available,
    falling back to legacy hardcoded predictors.

    Args:
        process_id: Tool/process ID (e.g., "buffer", "join")
        input_schemas: Map of input name -> column schema
            e.g., {"input_layer_id": {"id": "INTEGER", "name": "VARCHAR"}}
        params: Tool configuration parameters

    Returns:
        PredictedSchema or None if prediction not available
    """
    try:
        # First, try to get the runner class and use its predict_output_schema
        runner_class = _get_runner_for_tool(process_id)
        if runner_class and hasattr(runner_class, "predict_output_schema"):
            columns = runner_class.predict_output_schema(input_schemas, params)

            # Get geometry type from runner class
            geometry_type = getattr(runner_class, "output_geometry_type", None)
            # Normalize geometry type to title case
            if geometry_type:
                geometry_type = geometry_type.title()  # "polygon" -> "Polygon"

            return PredictedSchema(
                columns=columns,
                geometry_type=geometry_type,
            )

        # Fall back to legacy hardcoded predictors for tools that haven't been updated
        # Check if this is a two-input tool
        if process_id in TWO_INPUT_TOOLS:
            input1_key, input2_key = TWO_INPUT_TOOLS[process_id]
            input1_schema = input_schemas.get(input1_key, {})
            input2_schema = input_schemas.get(input2_key, {})

            if process_id == "join":
                return predict_join_schema(input1_schema, input2_schema, params)
            elif process_id == "intersection":
                return predict_intersection_schema(input1_schema, input2_schema, params)
            elif process_id == "union":
                return predict_union_schema(input1_schema, input2_schema, params)

        # Single input tools - legacy predictors
        input_schema = (
            input_schemas.get("input_layer_id")
            or input_schemas.get("layer_id")
            or input_schemas.get("source_layer_id")
            or next(iter(input_schemas.values()), {})
        )

        predictor = SCHEMA_PREDICTORS.get(process_id)
        if predictor:
            return predictor(input_schema, params)

        # Use passthrough as default for unknown tools
        logger.info(f"No specific predictor for {process_id}, using passthrough")
        return predict_passthrough_schema(input_schema, params)

    except Exception as e:
        logger.error(f"Schema prediction failed for {process_id}: {e}")
        return None
