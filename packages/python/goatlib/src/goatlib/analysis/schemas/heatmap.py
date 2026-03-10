import logging
from enum import StrEnum
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from goatlib.analysis.schemas.ui import (
    SECTION_CONFIGURATION,
    SECTION_DEMAND,
    SECTION_OPPORTUNITIES,
    SECTION_ROUTING,
    ui_field,
    ui_sections,
)

logger = logging.getLogger(__name__)


class RoutingMode(StrEnum):
    """All routing modes including public transport.

    Note: For heatmap tools in the processes API, use HeatmapRoutingMode
    which excludes public_transport (PT uses database-backed matrices,
    not file-based OD matrices).
    """

    walking = "walking"
    bicycle = "bicycle"
    pedelec = "pedelec"
    public_transport = "public_transport"
    car = "car"


class HeatmapRoutingMode(StrEnum):
    """Routing modes supported for heatmap tools in the processes API.

    Excludes public_transport because PT traveltime matrices are stored
    in the database (basic.traveltime_matrix_pt), not as file-based
    Parquet OD matrices used by the processes API.
    """

    walking = "walking"
    bicycle = "bicycle"
    pedelec = "pedelec"
    car = "car"


# Travel time limit options (3-30 minutes)
TravelTimeLimit = Literal[
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
]

# Sensitivity options (50k-1M in 50k increments)
SensitivityValue = Literal[
    50000,
    100000,
    150000,
    200000,
    250000,
    300000,
    350000,
    400000,
    450000,
    500000,
    550000,
    600000,
    650000,
    700000,
    750000,
    800000,
    850000,
    900000,
    950000,
    1000000,
]


class PotentialType(StrEnum):
    """Type of potential value source."""

    field = "field"
    constant = "constant"
    expression = "expression"


class PotentialExpression(StrEnum):
    """Expression options for computing potential from polygon geometry."""

    area = "area"
    perimeter = "perimeter"


# Icon mapping for routing modes (matches @p4b/ui ICON_NAME values)
# Values must be lowercase to match the enum values in Icon.tsx
ROUTING_MODE_ICONS: dict[str, str] = {
    "walking": "run",
    "bicycle": "bicycle",
    "pedelec": "pedelec",
    "car": "car",
}

# Routing mode labels for i18n (maps enum values to translation keys)
ROUTING_MODE_LABELS: dict[str, str] = {
    "walking": "routing_modes.walk",
    "bicycle": "routing_modes.bicycle",
    "pedelec": "routing_modes.pedelec",
    "car": "routing_modes.car",
}


class ImpedanceFunction(StrEnum):
    gaussian = "gaussian"
    linear = "linear"
    exponential = "exponential"
    power = "power"


class HeatmapCommon(BaseModel):
    """Base parameters shared by all heatmap analysis types."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_ROUTING,
            SECTION_CONFIGURATION,
            SECTION_DEMAND,
            SECTION_OPPORTUNITIES,
        )
    )

    # Prefer routing_mode; support legacy aliases
    routing_mode: HeatmapRoutingMode = Field(
        description="Transport mode selecting the OD matrix.",
        json_schema_extra=ui_field(
            section="routing",
            field_order=1,
            enum_icons=ROUTING_MODE_ICONS,
            enum_labels=ROUTING_MODE_LABELS,
        ),
    )
    od_matrix_path: str = Field(
        ...,
        description=(
            "Path, directory, glob pattern, or S3 URI to OD matrix Parquet file(s). "
            "Needs columns: orig_id, dest_id, cost. "
            "Supports local files, directories, globs, and S3 paths."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
            hidden=True,  # Internal field, typically derived from routing_mode
        ),
    )
    od_column_map: dict[str, str] = Field(
        default_factory=lambda: {
            "orig_id": "orig_id",
            "dest_id": "dest_id",
            "cost": "cost",
        },
        description=(
            "Column mapping for the OD matrix. "
            "Keys are the expected standard names: 'orig_id', 'dest_id', 'cost'. "
            "Values are the actual column names in the user-provided dataset."
        ),
        examples=[{"orig_id": "from_zone", "dest_id": "to_zone", "cost": "time_min"}],
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            hidden=True,  # Advanced setting, rarely changed
        ),
    )

    @field_validator("od_column_map")
    @classmethod
    def validate_od_column_map(cls: Self, v: dict[str, str]) -> dict[str, str]:
        required_keys = {"orig_id", "dest_id", "cost"}
        missing = required_keys - v.keys()
        if missing:
            raise ValueError(f"Missing required mapping keys: {missing}")
        return v

    output_path: str = Field(
        ...,
        description="Output GeoParquet path.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=99,
            hidden=True,  # Internal field
        ),
    )


class OpportunityBase(BaseModel):
    """Base parameters for opportunity datasets."""

    input_path: str = Field(
        ...,
        description="Path to opportunity dataset.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=1,
            widget="layer-selector",
        ),
    )
    input_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the opportunity layer",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=2,
            hidden=True,
        ),
    )
    name: str | None = Field(
        None,
        description=(
            "Optional name for the opportunity dataset; "
            "if not set, the filename without extension is used."
        ),
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=3,
            hidden=True,  # Auto-populated from layer filename
        ),
    )
    max_cost: TravelTimeLimit = Field(
        default=20,
        description="Travel time limit in minutes.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=4,
            label_key="max_cost",
            visible_when={"input_path": {"$ne": None}},
        ),
    )


class OpportunityGravity(OpportunityBase):
    """Opportunity dataset parameters for gravity-based heatmaps."""

    sensitivity: SensitivityValue = Field(
        default=300000,
        description="Sensitivity parameter for gravity decay function.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=10,
            visible_when={"input_path": {"$ne": None}},
        ),
    )
    potential_type: PotentialType = Field(
        default=PotentialType.constant,
        description="How to determine the potential value for each opportunity.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=4,
            visible_when={"input_path": {"$ne": None}},
            widget_options={
                # Only show "expression" option when input_path is a polygon layer
                "enum_geometry_filter": {
                    "source_layer": "input_path",
                    "expression": ["Polygon", "MultiPolygon"],
                }
            },
        ),
    )
    potential_field: str | None = Field(
        None,
        description="Field name to use as potential.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=5,
            widget="field-selector",
            widget_options={"source_layer": "input_path", "field_types": ["number"]},
            visible_when={"input_path": {"$ne": None}, "potential_type": "field"},
        ),
    )
    potential_constant: float | None = Field(
        1.0,
        gt=0.0,
        description="Constant potential value applied to all features.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=6,
            widget="number",
            visible_when={"input_path": {"$ne": None}, "potential_type": "constant"},
        ),
    )
    potential_expression: PotentialExpression | None = Field(
        None,
        description="Expression to compute potential for polygon layers (e.g. area or perimeter).",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=7,
            visible_when={"input_path": {"$ne": None}, "potential_type": "expression"},
        ),
    )

    @model_validator(mode="after")
    def validate_potential_fields(self: Self) -> Self:
        """Validate that the correct potential field is set based on potential_type."""
        if self.potential_type == PotentialType.field:
            if not self.potential_field:
                raise ValueError(
                    "potential_field must be set when potential_type is 'field'."
                )
        elif self.potential_type == PotentialType.constant:
            if self.potential_constant is None:
                raise ValueError(
                    "potential_constant must be set when potential_type is 'constant'."
                )
        elif self.potential_type == PotentialType.expression:
            if not self.potential_expression:
                raise ValueError(
                    "potential_expression must be set when potential_type is 'expression'."
                )
        return self


class HeatmapGravityParams(HeatmapCommon):
    """Parameters for gravity-based accessibility heatmaps."""

    impedance: ImpedanceFunction = Field(
        default=ImpedanceFunction.gaussian,
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
        ),
    )
    max_sensitivity: float = Field(
        1000000,
        gt=0.0,
        description="Max sensitivity used for normalization.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            hidden=True,  # Internal normalization constant
        ),
    )
    opportunities: list[OpportunityGravity] = Field(
        ...,
        json_schema_extra=ui_field(
            section="opportunities",
            repeatable=True,
            min_items=1,
        ),
    )


class OpportunityClosestAverage(OpportunityBase):
    """Opportunity dataset parameters for closest-average heatmaps."""

    n_destinations: Literal[1, 2, 3, 4, 5, 6, 7, 8, 9, 10] = Field(
        1,
        description="Number of closest destinations to average",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=5,
            visible_when={"input_path": {"$ne": None}},
        ),
    )


class HeatmapClosestAverageParams(HeatmapCommon):
    """Parameters for closest-average accessibility heatmaps."""

    opportunities: list[OpportunityClosestAverage] = Field(
        ...,
        json_schema_extra=ui_field(
            section="opportunities",
            repeatable=True,
            min_items=1,
        ),
    )


class HeatmapConnectivityParams(HeatmapCommon):
    """Parameters for connectivity-based heatmaps."""

    max_cost: TravelTimeLimit = Field(
        default=20,
        description="Travel time limit in minutes.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=3,
            label_key="max_cost",
        ),
    )
    reference_area_path: str = Field(
        ...,
        description="Path to reference area polygon dataset",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=4,
            label_key="reference_area_path",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )


class Opportunity2SFCA(OpportunityBase):
    """Opportunity dataset parameters for 2SFCA heatmaps."""
    sensitivity: SensitivityValue = Field(
        default=300000,
        description="Sensitivity parameter for enhanced 2SFCA methods.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=3,
            visible_when={
                "$and": [
                    {"input_path": {"$ne": None}},
                    {"two_sfca_type": {"$in": ["e2sfca", "m2sfca"]}},
                ]
            },
        ),
    )

    capacity_type: PotentialType = Field(
        default=PotentialType.constant,
        description="How to determine the capacity value for each opportunity.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=4,
            visible_when={"input_path": {"$ne": None}},
            widget_options={
                # Only show "expression" option when input_path is a polygon layer
                "enum_geometry_filter": {
                    "source_layer": "input_path",
                    "expression": ["Polygon", "MultiPolygon"],
                }
            },
        ),
    )

    capacity_constant: float | None = Field(
        1.0,
        gt=0.0,
        description="Constant capacity value applied to all features.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=6,
            widget="number",
            visible_when={"input_path": {"$ne": None}, "capacity_type": "constant"},
        ),
    )

    capacity_field: str | None = Field(
        None,
        description="Field from the opportunity layer that contains the capacity value (e.g., number of beds, seats).",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=5,
            label_key="capacity_field",
            widget="field-selector",
            widget_options={"source_layer": "input_path", "field_types": ["number"]},
            visible_when={"input_path": {"$ne": None},  "capacity_type": "field"},
        ),
    )

    capacity_expression: PotentialExpression | None = Field(
        None,
        description="Expression to compute capacity for polygon layers (e.g. area or perimeter).",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=7,
            visible_when={"input_path": {"$ne": None}, "capacity_type": "expression"},
        ),
    )

    @model_validator(mode="after")
    def validate_capacity_fields(self: Self) -> Self:
        """Validate that the correct capacity field is set based on capacity_type."""
        if self.capacity_type == PotentialType.field:
            if not self.capacity_field:
                raise ValueError(
                    "capacity_field must be set when capacity_type is 'field'."
                )
        elif self.capacity_type == PotentialType.constant:
            if self.capacity_constant is None:
                raise ValueError(
                    "capacity_constant must be set when capacity_type is 'constant'."
                )
        elif self.capacity_type == PotentialType.expression:
            if not self.potential_expression:
                raise ValueError(
                    "potential_expression must be set when capacity_type is 'expression'."
                )
        return self


class TwoSFCAType(StrEnum):
    """Type of 2SFCA method."""
    twosfca = "twosfca"
    e2sfca = "e2sfca"
    m2sfca = "m2sfca"

TwoSFCAType_LABELS: dict[str, str] = {
    "twosfca": "two_sfca_type.twosfca",
    "e2sfca": "two_sfca_type.e2sfca",
    "m2sfca": "two_sfca_type.m2sfca",
}


class Heatmap2SFCAParams(HeatmapCommon):
    """Parameters for 2SFCA heatmaps."""

    two_sfca_type: TwoSFCAType = Field(
        default=TwoSFCAType.twosfca,
        description="Type of 2SFCA method to use.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=5,
            enum_labels=TwoSFCAType_LABELS
        ),
    )

    demand_path: str = Field(
        ...,
        description="Path to demand layer dataset.",
        json_schema_extra=ui_field(
            section="demand",
            field_order=1,
            label_key="demand_path",
            widget="layer-selector",
        ),
    )
    demand_field: str = Field(
        ...,
        description="Field from the demand layer that contains the demand value (e.g., population).",
        json_schema_extra=ui_field(
            section="demand",
            field_order=4,
            label_key="demand_field",
            widget="field-selector",
            widget_options={
                "source_layer": "demand_path",
                "field_types": ["number"],
            },
            visible_when={"demand_path": {"$ne": None}},
        ),
    )

    impedance: ImpedanceFunction | None = Field(
        default=ImpedanceFunction.gaussian,
        description="Impedance function for distance decay weighting in enhanced 2SFCA methods.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=7,
            visible_when={"two_sfca_type": {"$in": ["e2sfca", "m2sfca"]}},
            widget_options={"default": "gaussian"},
        ),
    )

    max_sensitivity: float = Field(
        1000000,
        gt=0.0,
        description="Max sensitivity used for normalization.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            hidden=True,  # Internal normalization constant
        ),
    )
    opportunities: list[Opportunity2SFCA] = Field(
        ...,
        json_schema_extra=ui_field(
            section="opportunities",
            repeatable=True,
            min_items=1,
        ),
    )


class HuffmodelParams(HeatmapCommon):
    """Parameters for Huff heatmaps."""

    reference_area_path: str = Field(
        ...,
        description="Path to reference area polygon dataset",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
            label_key="reference_area_path",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )
    demand_path: str = Field(
        ...,
        description="Path to demand layer dataset.",
        json_schema_extra=ui_field(
            section="demand",
            field_order=2,
            label_key="demand_path",
            widget="layer-selector",
        ),
    )
    demand_field: str = Field(
        ...,
        description="Field from the demand layer that contains the demand value (e.g., population).",
        json_schema_extra=ui_field(
            section="demand",
            field_order=3,
            label_key="demand_field",
            widget="field-selector",
            widget_options={
                "source_layer": "demand_path",
                "field_types": ["number"],
            },
            visible_when={"demand_path": {"$ne": None}},
        ),
    )


    opportunity_path: str = Field(
        ...,
        description="Path to opportunity layer dataset.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=4,
            label_key="opportunity_path",
            widget="layer-selector",
        ),
    )

    attractivity: str = Field(
        ...,
        description="Field from the opportunity layer that has the attractivity value.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=5,
            label_key="attractivity",
            widget="field-selector",
            widget_options={"source_layer": "opportunity_path", "field_types": ["number"]},
            visible_when={"opportunity_path": {"$ne": None}},
        ),
    )
    max_cost: TravelTimeLimit = Field(
        default=20,
        description="Travel time limit in minutes.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=4,
            label_key="max_cost",
        ),
    )


    attractiveness_param: float = Field(
        default=1.0,
        gt=0.0,
        description="Attractiveness parameter for the Huff model gravity function.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=6,
            label_key="attractiveness_param",
            advanced=True,
        ),
    )

    distance_decay: float = Field(
        default=2.0,
        gt=0.0,
        description="Distance decay parameter for the Huff model gravity function.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=7,
            label_key="distance_decay",
            advanced=True,
        ),
    )