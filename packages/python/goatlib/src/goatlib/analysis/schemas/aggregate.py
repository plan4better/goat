"""Aggregate analysis schemas.

This module contains parameter schemas for aggregating point and polygon data
onto polygons or H3 grids with statistical operations.
"""

from enum import StrEnum
from typing import List, Literal, Optional, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from goatlib.analysis.schemas.base import (
    FieldStatistic,
    GeometryType,
    operation_first_result_name,
)
from goatlib.analysis.schemas.ui import (
    SECTION_AREA,
    SECTION_INPUT,
    SECTION_OUTPUT,
    SECTION_STATISTICS,
    UISection,
    ui_field,
    ui_sections,
)


def validate_area_type_config(
    area_type: "AggregationAreaType",
    area_layer: Optional[str],
    h3_resolution: Optional[int],
    area_layer_field_name: str = "area_layer_path",
) -> None:
    """Validate area type configuration is consistent.

    Reusable validation for both AggregatePointsParams and tool params.

    Args:
        area_type: The aggregation area type
        area_layer: The area layer path/id (or None)
        h3_resolution: The H3 resolution (or None)
        area_layer_field_name: Field name for error messages

    Raises:
        ValueError: If configuration is invalid
    """
    if area_type == AggregationAreaType.polygon:
        if not area_layer:
            raise ValueError(
                f"{area_layer_field_name} is required when area_type is 'polygon'."
            )
        if h3_resolution is not None:
            raise ValueError(
                "h3_resolution should not be provided when area_type is 'polygon'."
            )
    elif area_type == AggregationAreaType.h3_grid:
        if h3_resolution is None:
            raise ValueError("h3_resolution is required when area_type is 'h3_grid'.")
        if area_layer is not None:
            raise ValueError(
                f"{area_layer_field_name} should not be provided when area_type is 'h3_grid'."
            )


class AggregationAreaType(StrEnum):
    """Type of area used for aggregation."""

    polygon = "polygon"
    h3_grid = "h3_grid"


# Area type labels for i18n (maps enum values to translation keys)
AGGREGATION_AREA_TYPE_LABELS: dict[str, str] = {
    "polygon": "enums.aggregation_area_type.polygon",
    "h3_grid": "enums.aggregation_area_type.h3_grid",
}


# H3 resolution options (3-10 as in GOAT Core)
H3Resolution = Literal[3, 4, 5, 6, 7, 8, 9, 10]


class AggregateFieldStatistic(FieldStatistic):
    """Aggregate column statistic with UI wiring to source_layer_id."""

    field: Optional[str] = Field(
        None,
        description="Field name to compute statistics on. Required for all operations except 'count'.",
        json_schema_extra={
            "x-ui": {
                "label_key": "statistic_field",
                "widget": "field-selector",
                "widget_options": {
                    "source_layer": "source_layer_id",
                    "field_types": ["number"],
                },
                "visible_when": {"operation": {"$ne": "count"}},
            }
        },
    )
    result_name: Optional[str] = Field(
        None,
        description="Custom name for the result column. If not provided, defaults to '{field}_{operation}' or 'count' for count operations.",
        json_schema_extra={
            "x-ui": {
                "label_key": "statistic_result_name",
                "widget_options": {"placeholder_template": "{field}_{operation}"},
            }
        },
    )


class AggregatePolygonFieldStatistic(AggregateFieldStatistic):
    """Aggregate polygon statistic: named ``{operation}_{field}`` by default."""

    result_name: Optional[str] = operation_first_result_name()


class AggregatePointsParams(BaseModel):
    """Parameters for aggregating points onto polygons or H3 grids.

    This tool aggregates point features within polygon areas or H3 hexagons,
    computing statistics like count, sum, mean, min, or max of point attributes.
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            SECTION_AREA,
            SECTION_STATISTICS,
            UISection(
                id="grouping",
                order=4,
                icon="group",
                collapsible=True,
                collapsed=True,
            ),
            SECTION_OUTPUT,
        )
    )

    # ---- Input Configuration ----
    source_path: str = Field(
        ...,
        description="Path to the point layer to be aggregated.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
            widget_options={"geometry_types": ["Point", "MultiPoint"]},
        ),
    )

    # ---- Area Configuration ----
    area_type: AggregationAreaType = Field(
        ...,
        description="Type of area to aggregate points into: polygon layer or H3 hexagonal grid.",
        json_schema_extra=ui_field(
            section="area",
            field_order=1,
            enum_labels=AGGREGATION_AREA_TYPE_LABELS,
        ),
    )

    area_layer_path: Optional[str] = Field(
        None,
        description="Path to the polygon layer used for aggregation. Required when area_type is 'polygon'.",
        json_schema_extra=ui_field(
            section="area",
            field_order=2,
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
            visible_when={"area_type": "polygon"},
        ),
    )

    h3_resolution: Optional[H3Resolution] = Field(
        None,
        description="H3 grid resolution (3-10). Higher values create smaller hexagons. Required when area_type is 'h3_grid'.",
        json_schema_extra=ui_field(
            section="area",
            field_order=3,
            visible_when={"area_type": "h3_grid"},
        ),
    )

    # ---- Statistics Configuration ----
    column_statistics: List[FieldStatistic] = Field(
        ...,
        description="Statistical operations to perform on the aggregated points.",
        json_schema_extra=ui_field(
            section="statistics",
            field_order=1,
        ),
    )

    # ---- Grouping Configuration ----
    group_by_field: Optional[List[str]] = Field(
        None,
        description="Optional field(s) in the source layer to group aggregated results by (max 3 fields).",
        json_schema_extra=ui_field(
            section="grouping",
            field_order=1,
            widget="field-selector",
            widget_options={"source": "source_path", "multiple": True, "max": 3},
        ),
    )

    # ---- Output Configuration ----
    output_path: Optional[str] = Field(
        None,
        description="Path for the output aggregated polygon layer. Auto-generated if not provided.",
        json_schema_extra=ui_field(
            section="output",
            field_order=1,
            hidden=True,
        ),
    )
    output_crs: Optional[str] = Field(
        None,
        description="Target CRS for output. Defaults to source CRS or EPSG:4326.",
        json_schema_extra=ui_field(
            section="output",
            field_order=2,
            hidden=True,
        ),
    )

    # ---- Geometry Type Constraints (for validation) ----
    accepted_source_geometry_types: List[GeometryType] = Field(
        default=[GeometryType.point, GeometryType.multipoint],
        description="Accepted geometry types for source layer.",
        json_schema_extra=ui_field(section="input", hidden=True),
    )
    accepted_area_geometry_types: List[GeometryType] = Field(
        default=[GeometryType.polygon, GeometryType.multipolygon],
        description="Accepted geometry types for area layer.",
        json_schema_extra=ui_field(section="input", hidden=True),
    )

    # ---- Validators ----
    @field_validator("group_by_field", mode="after")
    @classmethod
    def validate_group_by_field(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        """Validate group_by_field has at most 3 fields."""
        if value is not None and len(value) > 3:
            raise ValueError("group_by_field can have at most 3 fields.")
        return value

    @model_validator(mode="after")
    def validate_area_configuration(self: Self) -> "AggregatePointsParams":
        """Validate that area configuration is consistent."""
        validate_area_type_config(
            area_type=self.area_type,
            area_layer=self.area_layer_path,
            h3_resolution=self.h3_resolution,
            area_layer_field_name="area_layer_path",
        )
        return self


class AggregatePolygonParams(AggregatePointsParams):
    """Parameters for aggregating polygons onto polygons or H3 grids.

    This tool aggregates polygon features within polygon areas or H3 hexagons,
    computing statistics like count, sum, mean, min, or max of polygon attributes.

    The main difference from AggregatePointsParams is:
    - Accepts polygon source layers instead of points
    - Supports weighted statistics based on intersection area
    """

    # ---- Source Input Override ----
    source_path: str = Field(
        ...,
        description="Path to the polygon layer to be aggregated.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )

    # ---- Polygon-specific Configuration ----
    weighted_by_intersecting_area: bool = Field(
        False,
        description=(
            "If enabled, the value of each source polygon is weighted by its share "
            "inside the area (the share of each source polygon's area that lies in "
            "it). A plain count stays unweighted; min and max, the standard "
            "deviation, and an H3 grid (each polygon goes to the cell of its "
            "centroid), are not weighted either."
        ),
        json_schema_extra=ui_field(
            section="statistics",
            field_order=3,
            label_key="weighted_by_intersecting_area",
        ),
    )

    # ---- Override Geometry Type Constraints ----
    accepted_source_geometry_types: List[GeometryType] = Field(
        default=[GeometryType.polygon, GeometryType.multipolygon],
        description="Accepted geometry types for source layer.",
        json_schema_extra=ui_field(section="input", hidden=True),
    )
