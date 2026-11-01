"""Geoprocessing analysis schemas.

This module contains parameter schemas for geoprocessing operations like
buffer, clip, intersection, union, difference, centroid, merge, and
origin-destination analysis.

Includes UI metadata for dynamic form rendering via x-ui fields.
"""

from enum import StrEnum
from typing import List, Literal, Optional, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from goatlib.analysis.schemas.base import (
    ALL_GEOMETRY_TYPES,
    POLYGON_TYPES,
    FieldStatistic,
    GeometryType,
    operation_first_result_name,
)
from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    UISection,
    ui_field,
    ui_sections,
)


class DistanceType(StrEnum):
    """Type of distance value source for buffer."""

    constant = "constant"
    field = "field"


class BufferParams(BaseModel):
    """Parameters for performing buffer operation."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(
                id="configuration",
                order=2,
                icon="settings",
                depends_on={"input_layer_id": {"$ne": None}},
            ),
            SECTION_OUTPUT,
        )
    )

    # Input and output configuration
    input_path: str = Field(
        ...,
        description="Path to the input dataset.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    output_path: str = Field(
        ...,
        description="Destination file path or table for buffered output.",
        json_schema_extra=ui_field(section="output", field_order=99, hidden=True),
    )

    # Distance type selector
    distance_type: DistanceType = Field(
        default=DistanceType.constant,
        description="How to determine the buffer distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
            enum_labels={
                "constant": "enums.distance_type.constant",
                "field": "enums.distance_type.field",
            },
        ),
    )

    # Buffer distance parameters
    distances: Optional[List[float]] = Field(
        None,
        description="List of buffer distances. "
        "Each distance should be a positive number using the specified 'units'.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            visible_when={"distance_type": "constant"},
        ),
    )
    distance_field: Optional[str] = Field(
        None,
        description="Field name that provides a per-feature buffer distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            widget_options={
                "source_layer": "input_layer_id",
                "field_types": ["number"],
            },
            visible_when={"distance_type": "field"},
        ),
    )

    units: Literal[
        "meters", "kilometers", "feet", "miles", "nautical_miles", "yards"
    ] = Field(
        "meters",
        description="Measurement units for buffer distances.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=3,
            enum_labels={
                "meters": "enums.units.meters",
                "kilometers": "enums.units.kilometers",
                "feet": "enums.units.feet",
                "miles": "enums.units.miles",
                "nautical_miles": "enums.units.nautical_miles",
                "yards": "enums.units.yards",
            },
        ),
    )

    # Controls whether overlapping buffers are merged (unioned) into a single geometry per distance
    polygon_union: bool = Field(
        False,
        description="If True, overlapping buffers at the same distance will be merged "
        "(unioned) into a single geometry.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=4,
            label_key="polygon_union",
        ),
    )

    # Controls whether to create incremental (difference) polygons between buffer steps
    polygon_difference: bool = Field(
        False,
        description="If True, creates incremental polygons showing the difference between "
        "consecutive buffer steps (like catchment area rings). Requires polygon_union to be enabled.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=5,
            visible_when={"polygon_union": True},
        ),
    )

    # Advanced buffer parameters (GEOS / ST_Buffer options)
    num_triangles: int = Field(
        8,
        description="Number of triangles used to approximate a quarter circle. "
        "Higher values yield smoother buffer edges but increase computation cost.",
        json_schema_extra=ui_field(
            section="configuration", field_order=10, advanced=True
        ),
    )
    cap_style: Literal["CAP_ROUND", "CAP_FLAT", "CAP_SQUARE"] = Field(
        "CAP_ROUND",
        description="Style for line endpoints: 'CAP_ROUND', 'CAP_FLAT', or 'CAP_SQUARE'.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=11,
            advanced=True,
            enum_labels={
                "CAP_ROUND": "enums.cap_style.CAP_ROUND",
                "CAP_FLAT": "enums.cap_style.CAP_FLAT",
                "CAP_SQUARE": "enums.cap_style.CAP_SQUARE",
            },
        ),
    )
    join_style: Literal["JOIN_ROUND", "JOIN_MITRE", "JOIN_BEVEL"] = Field(
        "JOIN_ROUND",
        description="Corner join style between line segments: 'JOIN_ROUND', 'JOIN_MITRE', 'JOIN_BEVEL'.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=12,
            advanced=True,
            enum_labels={
                "JOIN_ROUND": "enums.join_style.JOIN_ROUND",
                "JOIN_MITRE": "enums.join_style.JOIN_MITRE",
                "JOIN_BEVEL": "enums.join_style.JOIN_BEVEL",
            },
        ),
    )
    mitre_limit: float = Field(
        1.0,
        description="Ratio controlling the length of mitred joins. "
        "Only applicable when join_style='JOIN_MITRE'.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=13,
            advanced=True,
            visible_when={"join_style": "JOIN_MITRE"},
        ),
    )

    # Output metadata
    output_crs: Optional[str] = Field(
        "EPSG:4326",
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )
    output_name: Optional[str] = Field(
        None,
        description="Optional name of the output dataset.",
        json_schema_extra=ui_field(section="output", field_order=1),
    )

    # Validation logic
    @model_validator(mode="after")
    def validate_all(self: Self) -> "BufferParams":
        # Validate based on distance_type
        if self.distance_type == DistanceType.constant:
            if not self.distances:
                raise ValueError(
                    "distances must be set when distance_type is 'constant'."
                )
            if not all(isinstance(d, (int, float)) and d > 0 for d in self.distances):
                raise ValueError("All buffer distances must be positive numbers.")
            if len(set(self.distances)) != len(self.distances):
                raise ValueError(
                    "Give each buffer distance once: each one draws a ring of its own."
                )
        elif self.distance_type == DistanceType.field:
            if not self.distance_field:
                raise ValueError(
                    "distance_field must be set when distance_type is 'field'."
                )

        # Validate polygon_difference requires polygon_union
        if self.polygon_difference and not self.polygon_union:
            raise ValueError(
                "polygon_difference can only be True when polygon_union is also True."
            )

        # Validate mitre_limit usage
        if self.join_style != "JOIN_MITRE" and self.mitre_limit != 1.0:
            raise ValueError(
                "mitre_limit is only applicable when join_style='JOIN_MITRE'."
            )

        # num_triangles must be > 0
        if self.num_triangles <= 0:
            raise ValueError("'num_triangles' must be greater than 0.")

        return self


class ClipParams(BaseModel):
    """Parameters for performing clip (zuschneiden) operation."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="overlay", order=2, icon="layers"),
            SECTION_OUTPUT,
        )
    )

    input_path: str = Field(
        ...,
        description="Path to the input dataset to be clipped.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    overlay_path: str = Field(
        ...,
        description="Path to the overlay dataset used for clipping.",
        json_schema_extra=ui_field(
            section="overlay",
            field_order=1,
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )
    output_path: Optional[str] = Field(
        None,
        description="Destination file path for clipped output. If not provided, will be auto-generated.",
        json_schema_extra=ui_field(section="output", field_order=99, hidden=True),
    )
    output_crs: Optional[str] = Field(
        None,
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )

    # Hardcoded accepted geometry types for each layer
    @property
    def accepted_input_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for input layer in clip operation."""
        return ALL_GEOMETRY_TYPES

    @property
    def accepted_overlay_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for overlay layer in clip operation (must be polygon)."""
        return POLYGON_TYPES


class IntersectionParams(BaseModel):
    """Parameters for performing intersection (verschneiden) operation."""

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
            SECTION_OUTPUT,
        )
    )

    input_path: str = Field(
        ...,
        description="Path to the input dataset.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    overlay_path: str = Field(
        ...,
        description="Path to the overlay dataset to intersect with.",
        json_schema_extra=ui_field(
            section="overlay",
            field_order=1,
            widget="layer-selector",
        ),
    )
    input_fields: Optional[List[str]] = Field(
        None,
        description="List of field names from input layer to keep in output. If None, all fields are kept.",
        json_schema_extra=ui_field(
            section="field_selection",
            field_order=1,
            widget="field-selector",
            widget_options={"source_layer": "input_path", "multi": True},
        ),
    )
    overlay_fields: Optional[List[str]] = Field(
        None,
        description="List of field names from overlay layer to keep in output. If None, all fields are kept.",
        json_schema_extra=ui_field(
            section="field_selection",
            field_order=2,
            widget="field-selector",
            widget_options={"source_layer": "overlay_path", "multi": True},
        ),
    )
    overlay_fields_prefix: Optional[str] = Field(
        "intersection_",
        description="Prefix to add to overlay field names to avoid naming conflicts. Default is 'intersection_'.",
        json_schema_extra=ui_field(section="field_selection", field_order=3),
    )
    output_path: Optional[str] = Field(
        None,
        description="Destination file path for intersection output. If not provided, will be auto-generated.",
        json_schema_extra=ui_field(section="output", field_order=99, hidden=True),
    )
    output_crs: Optional[str] = Field(
        None,
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )

    # Hardcoded accepted geometry types for each layer
    @property
    def accepted_input_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for input layer in intersection operation."""
        return ALL_GEOMETRY_TYPES

    @property
    def accepted_overlay_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for overlay layer in intersection operation."""
        return ALL_GEOMETRY_TYPES


class UnionParams(BaseModel):
    """Parameters for performing union (vereinigen) operation."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="overlay", order=2, icon="layers"),
            SECTION_OUTPUT,
        )
    )

    input_path: str = Field(
        ...,
        description="Path to the input dataset.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    overlay_path: Optional[str] = Field(
        None,
        description="Path to the overlay dataset to union with. If None, performs self-union on input.",
        json_schema_extra=ui_field(
            section="overlay",
            field_order=1,
            widget="layer-selector",
        ),
    )
    overlay_fields_prefix: Optional[str] = Field(
        None,
        description="Prefix to add to overlay field names to avoid naming conflicts.",
        json_schema_extra=ui_field(
            section="overlay",
            field_order=2,
            visible_when={"overlay_path": {"$ne": None}},
        ),
    )
    output_path: Optional[str] = Field(
        None,
        description="Destination file path for union output. If not provided, will be auto-generated.",
        json_schema_extra=ui_field(section="output", field_order=99, hidden=True),
    )
    output_crs: Optional[str] = Field(
        None,
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )

    # Hardcoded accepted geometry types for each layer
    @property
    def accepted_input_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for input layer in union operation."""
        return ALL_GEOMETRY_TYPES

    @property
    def accepted_overlay_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for overlay layer in union operation."""
        return ALL_GEOMETRY_TYPES


class DifferenceParams(BaseModel):
    """Parameters for performing difference (differenz) operation."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="overlay", order=2, icon="layers"),
            SECTION_OUTPUT,
        )
    )

    input_path: str = Field(
        ...,
        description="Path to the input dataset to subtract from.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    overlay_path: str = Field(
        ...,
        description="Path to the overlay dataset to subtract.",
        json_schema_extra=ui_field(
            section="overlay",
            field_order=1,
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )
    output_path: Optional[str] = Field(
        None,
        description="Destination file path for difference output. If not provided, will be auto-generated.",
        json_schema_extra=ui_field(section="output", field_order=99, hidden=True),
    )
    output_crs: Optional[str] = Field(
        None,
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )

    # Hardcoded accepted geometry types for each layer
    @property
    def accepted_input_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for input layer in difference operation."""
        return ALL_GEOMETRY_TYPES

    @property
    def accepted_overlay_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for overlay layer in difference operation (typically polygon)."""
        return POLYGON_TYPES


class DissolveFieldStatistic(FieldStatistic):
    """Dissolve statistic: named ``{operation}_{field}`` by default."""

    result_name: Optional[str] = operation_first_result_name()


class DissolveParams(BaseModel):
    """Parameters for performing dissolve (auflösen) operation.

    Dissolve merges features that share common attribute values into single
    features, optionally computing statistics on other fields.

    This is equivalent to:
    - QGIS: Vector > Geoprocessing Tools > Dissolve (Auflösen)
    - ArcGIS: Dissolve
    - PostGIS: ST_Union with GROUP BY
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="dissolve_settings", order=2, icon="aggregate"),
            UISection(id="statistics", order=3, icon="chart"),
            SECTION_OUTPUT,
        )
    )

    input_path: str = Field(
        ...,
        description="Path to the input dataset to dissolve.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    dissolve_fields: Optional[List[str]] = Field(
        None,
        description="Fields to group by when dissolving. Features with matching values will be merged. If empty, all features are merged into one.",
        json_schema_extra=ui_field(
            section="dissolve_settings",
            field_order=1,
            widget="field-selector",
            widget_options={"source_layer": "input_path", "multiple": True, "max": 3},
        ),
    )
    field_statistics: Optional[List["FieldStatistic"]] = Field(
        None,
        description="Statistics to calculate for each dissolved group.",
        json_schema_extra=ui_field(
            section="statistics",
            field_order=1,
            widget="field-statistics-selector",
            widget_options={"source_layer": "input_path"},
        ),
    )
    output_path: Optional[str] = Field(
        None,
        description="Destination file path for dissolved output. If not provided, will be auto-generated.",
        json_schema_extra=ui_field(section="output", field_order=99, hidden=True),
    )
    output_crs: Optional[str] = Field(
        None,
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )

    @property
    def accepted_input_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for input layer in dissolve operation."""
        return ALL_GEOMETRY_TYPES


class CentroidParams(BaseModel):
    """Parameters for computing centroid of features."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            SECTION_OUTPUT,
        )
    )

    input_path: str = Field(
        ...,
        description="Path to the input dataset.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    output_path: Optional[str] = Field(
        None,
        description="Destination file path for centroid output. If not provided, will be auto-generated.",
        json_schema_extra=ui_field(section="output", field_order=99, hidden=True),
    )
    output_crs: Optional[str] = Field(
        None,
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )

    @property
    def accepted_input_geometry_types(self: Self) -> List[GeometryType]:
        """Geometry types accepted for input layer."""
        return ALL_GEOMETRY_TYPES


class OriginDestinationParams(BaseModel):
    """Parameters for performing origin-destination analysis."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            UISection(id="matrix", order=2, icon="grid"),
            UISection(id="columns", order=3, icon="list"),
            SECTION_OUTPUT,
        )
    )

    geometry_path: str = Field(
        ...,
        description="Path to the geometry layer (points or polygons) containing origins and destinations.",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    unique_id_column: str = Field(
        ...,
        description="The column that contains the unique IDs in geometry layer.",
        json_schema_extra=ui_field(
            section="input",
            field_order=2,
            widget="field-selector",
            widget_options={"source_layer": "geometry_path"},
        ),
    )
    matrix_path: str = Field(
        ...,
        description="Path to the origin-destination matrix file (parquet/csv).",
        json_schema_extra=ui_field(
            section="matrix",
            field_order=1,
            widget="file-selector",
            widget_options={"file_types": [".parquet", ".csv"]},
        ),
    )
    origin_column: str = Field(
        ...,
        description="The column that contains the origins in the origin destination matrix.",
        json_schema_extra=ui_field(
            section="columns",
            field_order=1,
            widget="field-selector",
            widget_options={"source_layer": "matrix_path"},
        ),
    )
    destination_column: str = Field(
        ...,
        description="The column that contains the destinations in the origin destination matrix.",
        json_schema_extra=ui_field(
            section="columns",
            field_order=2,
            widget="field-selector",
            widget_options={"source_layer": "matrix_path"},
        ),
    )
    weight_column: str = Field(
        ...,
        description="The column that contains the weights in the origin destination matrix.",
        json_schema_extra=ui_field(
            section="columns",
            field_order=3,
            widget="field-selector",
            widget_options={"source_layer": "matrix_path", "field_types": ["number"]},
        ),
    )
    output_path_lines: Optional[str] = Field(
        None,
        description="Destination file path for the lines output. If not provided, will be auto-generated.",
        json_schema_extra=ui_field(section="output", field_order=1, hidden=True),
    )
    output_path_points: Optional[str] = Field(
        None,
        description="Destination file path for the points output. If not provided, will be auto-generated.",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )
    output_crs: Optional[str] = Field(
        None,
        description="Target coordinate reference system for the output geometry.",
        json_schema_extra=ui_field(section="output", field_order=3, hidden=True),
    )
