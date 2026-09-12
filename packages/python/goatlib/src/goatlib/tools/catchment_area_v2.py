"""Catchment Area V2 tool for Windmill.

Uses the local C++ routing backend for all modes. Mirrors the v1 tool runner
structure but builds CatchmentAreaV2Params with cost_type/max_cost.
"""

import logging
import tempfile
from enum import StrEnum
from pathlib import Path
from typing import Any, Self

import duckdb
from pydantic import Field, model_validator

from goatlib.analysis.accessibility import CatchmentAreaToolV2
from goatlib.analysis.schemas.catchment_area import (
    CATCHMENT_AREA_TYPE_LABELS,
    ROUTING_MODE_ICONS,
    ROUTING_MODE_LABELS,
    WEEKDAY_LABELS,
    CatchmentAreaRoutingMode,
    StartingPoints,
)
from goatlib.analysis.schemas.catchment_area_v2 import (
    AccessEgressMode,
    CatchmentAreaV2Params,
    CatchmentType,
    CostType,
    OutputFormat,
    PTMode,
    PTTimeWindow,
    RoutingMode,
    ShapeStyle,
    Weekday,
)
from goatlib.analysis.schemas.ui import (
    SECTION_ROUTING,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.bundles.artifacts.gtfs import fetch_pt_timetable
from goatlib.bundles.artifacts.street_network import (
    fetch_linked_routing_network,
    fetch_routing_network,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.catchment_area import CatchmentAreaToolRunner
from goatlib.tools.pt_network import pt_date_field
from goatlib.tools.schemas import ToolInputBase, get_default_layer_name

logger = logging.getLogger(__name__)


class StepsStyle(StrEnum):
    separate = "separate"
    cumulative = "cumulative"


# Per-mode budget defaults + hard caps come from a shared module so the
# catchment_area_v2 and heatmap_v2 form schemas stay in lockstep.
from goatlib.tools._routing_limits import (  # noqa: E402
    DEFAULT_MAX_DISTANCE_ACTIVE_M,
    DEFAULT_MAX_DISTANCE_CAR_M,
    DEFAULT_MAX_TIME_ACTIVE_MIN,
    DEFAULT_MAX_TIME_CAR_MIN,
    DEFAULT_MAX_TIME_PT_MIN,
    budget_widget_options,
    leg_budget_widget_options,
    resolve_budget_input,
    resolve_leg_budget_input,
    validate_budget,
    validate_cost_type,
    validate_leg_budget,
)

__all__ = [
    "DEFAULT_MAX_DISTANCE_ACTIVE_M",
    "DEFAULT_MAX_DISTANCE_CAR_M",
    "DEFAULT_MAX_TIME_ACTIVE_MIN",
    "DEFAULT_MAX_TIME_CAR_MIN",
    "DEFAULT_MAX_TIME_PT_MIN",
]


# =========================================================================
# UI Sections
# =========================================================================

SECTION_CONFIGURATION = UISection(
    id="configuration",
    order=2,
    icon="settings",
    label_key="configuration",
    depends_on={"routing_mode": {"$ne": None}},
)

SECTION_STARTING = UISection(
    id="starting",
    order=3,
    icon="location",
    label_key="starting_points",
    depends_on={"routing_mode": {"$ne": None}},
)


SECTION_RESULT_CATCHMENT = UISection(
    id="result",
    order=7,
    icon="save",
    label_key="result_layer_section",
    depends_on={"routing_mode": {"$ne": None}},
)


# =========================================================================
# Label Mappings
# =========================================================================

STEPS_STYLE_LABELS: dict[str, str] = {
    "separate": "enums.steps_style.separate",
    "cumulative": "enums.steps_style.cumulative",
}

SHAPE_STYLE_LABELS: dict[str, str] = {
    "combined": "enums.shape_style.combined",
    "separated": "enums.shape_style.separated",
}

COST_TYPE_LABELS: dict[str, str] = {
    "time": "enums.cost_type.time",
    "distance": "enums.cost_type.distance",
}

COST_TYPE_ICONS: dict[str, str] = {
    "time": "clock",
    "distance": "ruler-horizontal",
}

PT_MODE_ICONS: dict[str, str] = {
    "bus": "bus",
    "tram": "tram",
    "rail": "rail",
    "subway": "subway",
    "ferry": "ferry",
    "cable_car": "cable-car",
    "gondola": "gondola",
    "funicular": "funicular",
}

PT_MODE_LABELS: dict[str, str] = {
    "bus": "routing_modes.bus",
    "tram": "routing_modes.tram",
    "rail": "routing_modes.rail",
    "subway": "routing_modes.subway",
    "ferry": "routing_modes.ferry",
    "cable_car": "routing_modes.cable_car",
    "gondola": "routing_modes.gondola",
    "funicular": "routing_modes.funicular",
}

ACCESS_EGRESS_MODE_LABELS: dict[str, str] = {
    "walk": "routing_modes.walk",
    "bicycle": "routing_modes.bicycle",
    "pedelec": "routing_modes.pedelec",
    "car": "routing_modes.car",
}

ACCESS_EGRESS_MODE_ICONS: dict[str, str] = {
    "walk": "run",
    "bicycle": "bicycle",
    "pedelec": "pedelec",
    "car": "car",
}

OUTPUT_FORMAT_LABELS: dict[str, str] = {
    "geojson": "GeoJSON",
    "parquet": "Parquet",
}

CATCHMENT_TYPE_LABELS: dict[str, str] = {
    **CATCHMENT_AREA_TYPE_LABELS,
    "point_grid": "enums.catchment_area_type.point_grid",
}


# =========================================================================
# Windmill Params
# =========================================================================


class CatchmentAreaV2WindmillParams(ToolInputBase):
    """Catchment areas show how far people can travel within a set travel time or distance from one or more selected points.

    This schema extends ToolInputBase with catchment area specific parameters.
    The frontend renders this dynamically based on x-ui metadata.
    """

    model_config = {
        "json_schema_extra": ui_sections(
            SECTION_ROUTING,
            SECTION_CONFIGURATION,
            SECTION_STARTING,
            SECTION_RESULT_CATCHMENT,
        )
    }

    # =========================================================================
    # Result Section
    # =========================================================================

    result_layer_name: str | None = Field(
        default=get_default_layer_name("catchment_area", "en"),
        description="Name for the catchment area result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("catchment_area", "en"),
                "default_de": get_default_layer_name("catchment_area", "de"),
            },
        ),
    )

    starting_points_layer_name: str | None = Field(
        default=get_default_layer_name("catchment_area_starting_points", "en"),
        description="Name for the starting points layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=2,
            label_key="starting_points_layer_name",
            widget_options={
                "default_en": get_default_layer_name(
                    "catchment_area_starting_points", "en"
                ),
                "default_de": get_default_layer_name(
                    "catchment_area_starting_points", "de"
                ),
            },
        ),
    )

    # =========================================================================
    # Routing Section
    # =========================================================================

    routing_mode: CatchmentAreaRoutingMode = Field(
        ...,
        description="Transport mode for the catchment area calculation.",
        json_schema_extra=ui_field(
            section="routing",
            field_order=1,
            label_key="routing_mode",
            enum_icons=ROUTING_MODE_ICONS,
            enum_labels=ROUTING_MODE_LABELS,
            # Changing the transport mode restarts the form: it decides which
            # measures, budgets and legs apply, so nothing should carry over.
            widget_options={"resets_form": True},
        ),
    )

    pt_modes: list[PTMode] | None = Field(
        default=list(PTMode),
        description="Public transport modes to include.",
        json_schema_extra=ui_field(
            section="routing",
            field_order=2,
            label_key="choose_pt_mode",
            enum_labels=PT_MODE_LABELS,
            visible_when={"routing_mode": "pt"},
        ),
    )

    pt_max_transfers: int = Field(
        default=5,
        description="Maximum number of transit transfers.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=16,
            label_key="max_transfers",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                ]
            },
            widget_options={
                "max_value_from": {
                    "fields": [],
                    "message": "max_transfers_limit_message",
                    "max": 5,
                    "min": 0,
                },
            },
        ),
    )

    pt_network_bundle_id: str | None = Field(
        default=None,
        description=(
            "Choose a custom Public Transport Network bundle to use for routing. "
            "If unset, the default bundle will be used."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=18,
            label_key="pt_network_bundle_id",
            widget="bundle-selector",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                ]
            },
            # The selector lists only public-transport bundles that have a ready
            # routing graph.
            widget_options={
                "bundle_type": "pt_network_gtfs",
                "artifact_kind": "pt_network_graph",
            },
        ),
    )

    street_network_bundle_id: str | None = Field(
        default=None,
        description=(
            "Choose a custom Street Network bundle to use for routing. "
            "If unset, the default network will be used."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=19,
            label_key="street_network_bundle_id",
            widget="bundle-selector",
            # Street modes only — not because a PT run needs no street
            # network (its access and egress legs are routed live on one), but
            # because for PT the answer is not the user's to give: it follows
            # the PT bundle, which either names the network its stops were
            # connected to or was built against the default. Offering a choice
            # there is only a chance to pick one that disagrees.
            visible_when={
                "$and": [
                    {"routing_mode": {"$in": ["walking", "bicycle", "pedelec", "car"]}},
                    {"show_advanced": True},
                ]
            },
            # Only street networks whose routing graph is built and ready.
            widget_options={
                "bundle_type": "street_network",
                "artifact_kind": "street_network_graph",
            },
        ),
    )

    # =========================================================================
    # Starting Points Section
    # =========================================================================

    starting_points: StartingPoints = Field(
        ...,
        description="Starting point(s) for the catchment area.",
        json_schema_extra=ui_field(
            section="starting",
            field_order=1,
            widget="starting-points",
            widget_options={"geometry_types": ["Point", "MultiPoint"]},
        ),
    )

    # =========================================================================
    # Configuration Section
    # =========================================================================

    cost_type: CostType = Field(
        default=CostType.time,
        description="Measure catchment area by travel time or distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
            label_key="measure_type",
            enum_labels=COST_TYPE_LABELS,
            enum_icons=COST_TYPE_ICONS,
            inline_group="cost_config",
            visible_when={
                "routing_mode": {"$in": ["walking", "bicycle", "pedelec", "car"]}
            },
        ),
    )

    # Single travel budget — same name/meaning as the analysis schema and the
    # C++ engine. Default, floor and cap come from the mode x cost_type rules.
    max_cost: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        description="Upper limit for the selected measure type: travel time or travel distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            label_key="limit",
            description_key="limit",
            inline_group="cost_config",
            inline_flex="1 0 0",
            widget_options=budget_widget_options(),
        ),
    )

    speed: float | None = Field(
        default=None,
        description="Travel speed in km/h. None when the routing mode doesn't "
        "use a user-supplied speed (PT/Car).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=3,
            label_key="speed",
            visible_when={
                "routing_mode": {"$in": ["walking", "bicycle", "pedelec"]},
                "cost_type": "time",
            },
            widget_options={
                # Default speed switches with the mode (kicks in on first show).
                "default_by_field": {
                    "field": "routing_mode",
                    "values": {"walking": 5, "bicycle": 15, "pedelec": 23},
                },
                # Per-mode caps using conditional literal entries — first
                # matching `when` clause wins, with its own translation key.
                "max_value_from": {
                    "fields": [
                        {
                            "value": 30,
                            "when": {"routing_mode": "walking"},
                            "message": "walking_speed_limit_message",
                        },
                        {
                            "value": 60,
                            "when": {"routing_mode": "bicycle"},
                            "message": "bicycle_speed_limit_message",
                        },
                        {
                            "value": 60,
                            "when": {"routing_mode": "pedelec"},
                            "message": "pedelec_speed_limit_message",
                        },
                    ],
                    "min": 1,
                    "message": "walking_speed_limit_message",
                },
            },
        ),
    )

    steps: int = Field(
        default=5,
        description="Number of isochrone steps/intervals.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=6,
            label_key="steps",
            visible_when={"catchment_area_type": {"$in": ["polygon", "network"]}},
            widget_options={
                "max_value_from": {
                    "fields": [
                        {"field": "max_cost"},
                    ],
                    "message": "steps_exceeds_limit",
                    "max": 9,
                    "min": 1,
                },
            },
        ),
    )

    step_sizes: list[int] | None = Field(
        default=None,
        description="Step size intervals. Auto-computed from steps and limit, editable.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=7,
            label_key="step_sizes",
            visible_when={"catchment_area_type": {"$in": ["polygon", "network"]}},
            widget="chips",
            widget_options={
                "compute_from": {
                    "steps_field": "steps",
                    "limit_fields": [
                        {"field": "max_cost"},
                    ],
                },
            },
        ),
    )

    # PT time window
    pt_day: Weekday = Field(
        default=Weekday.weekday,
        description="Day type for PT schedule.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=8,
            label_key="weekday",
            enum_labels=WEEKDAY_LABELS,
            # Only for the default network. Its three choices resolve to three
            # fixed anchor dates, which exist in that network's timetable and
            # almost certainly not in an uploaded feed's — so when a bundle is
            # chosen, `pt_date` replaces this rather than sitting beside it.
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"pt_network_bundle_id": {"$exists": False}},
                ]
            },
        ),
    )
    pt_date: str | None = pt_date_field(8)
    pt_start_time: int = Field(
        default=25200,
        description="PT window start (seconds from midnight).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=9,
            label_key="from_time",
            widget="time-picker",
            inline_group="pt_time_window",
            inline_flex="1 0 0",
            visible_when={"routing_mode": "pt"},
        ),
    )
    pt_end_time: int = Field(
        default=32400,
        description="PT window end (seconds from midnight).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=10,
            label_key="to_time",
            widget="time-picker",
            inline_group="pt_time_window",
            inline_flex="1 0 0",
            visible_when={"routing_mode": "pt"},
        ),
    )

    # =========================================================================
    # PT Access & Egress (under Advanced in Configuration)
    # =========================================================================

    access_mode: AccessEgressMode = Field(
        default=AccessEgressMode.walk,
        description="Mode to reach transit stops.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=20,
            label_key="access_mode",
            group_label="groups.access_leg",
            enum_icons=ACCESS_EGRESS_MODE_ICONS,
            enum_labels=ACCESS_EGRESS_MODE_LABELS,
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                ]
            },
        ),
    )

    access_cost_type: CostType = Field(
        default=CostType.time,
        description="Access leg cost type.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=21,
            label_key="measure_type",
            enum_labels=COST_TYPE_LABELS,
            enum_icons=COST_TYPE_ICONS,
            inline_group="access_cost",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                ]
            },
        ),
    )

    # Single leg budget — same name/meaning as the analysis schema and the C++
    # engine. Default, unit, floor and cap follow this leg's own cost type.
    access_max_cost: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        description="Upper limit for this leg's measure type: travel time or travel distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=22,
            label_key="limit",
            description_key="limit",
            inline_group="access_cost",
            inline_flex="1 0 0",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                ]
            },
            widget_options=leg_budget_widget_options(
                "access_cost_type", "access_budget_exceeds_limit"
            ),
        ),
    )

    access_speed: float | None = Field(
        default=None,
        description="Access leg speed in km/h. None for car access (per-edge "
        "OSM maxspeed governs cost).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=23,
            label_key="speed_kmh",
            widget_options={
                "default_by_field": {
                    "field": "access_mode",
                    "values": {"walk": 5, "bicycle": 15, "pedelec": 23},
                },
                "max_value_from": {
                    "fields": [
                        {
                            "value": 30,
                            "when": {"access_mode": "walk"},
                            "message": "walking_speed_limit_message",
                        },
                        {
                            "value": 60,
                            "when": {"access_mode": "bicycle"},
                            "message": "bicycle_speed_limit_message",
                        },
                        {
                            "value": 60,
                            "when": {"access_mode": "pedelec"},
                            "message": "pedelec_speed_limit_message",
                        },
                    ],
                    "min": 1,
                    "message": "walking_speed_limit_message",
                },
            },
            # Hidden for car access (per-edge OSM maxspeed governs cost).
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                    {"access_cost_type": "time"},
                    {"access_mode": {"$in": ["walk", "bicycle", "pedelec"]}},
                ]
            },
        ),
    )

    egress_mode: AccessEgressMode = Field(
        default=AccessEgressMode.walk,
        description="Mode from transit stops to destination.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=24,
            label_key="egress_mode",
            group_label="groups.egress_leg",
            enum_icons=ACCESS_EGRESS_MODE_ICONS,
            enum_labels=ACCESS_EGRESS_MODE_LABELS,
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                ]
            },
        ),
    )

    egress_cost_type: CostType = Field(
        default=CostType.time,
        description="Egress leg cost type.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=25,
            label_key="measure_type",
            enum_labels=COST_TYPE_LABELS,
            enum_icons=COST_TYPE_ICONS,
            inline_group="egress_cost",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                ]
            },
        ),
    )

    # Single leg budget — same name/meaning as the analysis schema and the C++
    # engine. Default, unit, floor and cap follow this leg's own cost type.
    egress_max_cost: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        description="Upper limit for this leg's measure type: travel time or travel distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=26,
            label_key="limit",
            description_key="limit",
            inline_group="egress_cost",
            inline_flex="1 0 0",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                ]
            },
            widget_options=leg_budget_widget_options(
                "egress_cost_type", "egress_budget_exceeds_limit"
            ),
        ),
    )

    egress_speed: float | None = Field(
        default=None,
        description="Egress leg speed in km/h. None for car egress (per-edge "
        "OSM maxspeed governs cost).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=27,
            label_key="speed_kmh",
            widget_options={
                "default_by_field": {
                    "field": "egress_mode",
                    "values": {"walk": 5, "bicycle": 15, "pedelec": 23},
                },
                "max_value_from": {
                    "fields": [
                        {
                            "value": 30,
                            "when": {"egress_mode": "walk"},
                            "message": "walking_speed_limit_message",
                        },
                        {
                            "value": 60,
                            "when": {"egress_mode": "bicycle"},
                            "message": "bicycle_speed_limit_message",
                        },
                        {
                            "value": 60,
                            "when": {"egress_mode": "pedelec"},
                            "message": "pedelec_speed_limit_message",
                        },
                    ],
                    "min": 1,
                    "message": "walking_speed_limit_message",
                },
            },
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"show_advanced": True},
                    {"egress_cost_type": "time"},
                    {"egress_mode": {"$in": ["walk", "bicycle", "pedelec"]}},
                ]
            },
        ),
    )

    # =========================================================================
    # Advanced Options (inline toggle within Configuration)
    # =========================================================================

    show_advanced: bool = Field(
        default=False,
        description="Show advanced configuration options.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=15,
            label_key="advanced_options",
            widget="advanced-toggle",
        ),
    )

    catchment_area_type: CatchmentType = Field(
        default=CatchmentType.polygon,
        description="Output geometry type.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=4,
            label_key="catchment_area_type",
            enum_labels=CATCHMENT_TYPE_LABELS,
        ),
    )

    shape_style: ShapeStyle = Field(
        default=ShapeStyle.combined,
        description="How polygons are shaped when there are multiple starting points.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=16,
            label_key="shape_style",
            enum_labels=SHAPE_STYLE_LABELS,
            visible_when={
                "$and": [
                    {"show_advanced": True},
                    {"catchment_area_type": "polygon"},
                    {"routing_mode": {"$in": ["walking", "bicycle", "pedelec"]}},
                ]
            },
        ),
    )

    steps_style: StepsStyle = Field(
        default=StepsStyle.separate,
        description="How steps are displayed in the output.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=17,
            label_key="steps_style",
            enum_labels=STEPS_STYLE_LABELS,
            visible_when={
                "$and": [
                    {"show_advanced": True},
                    {"catchment_area_type": "polygon"},
                ]
            },
        ),
    )

    point_grid_layer_id: str | None = Field(
        default=None,
        description="Point layer to use as grid for point_grid catchment type.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=5,
            label_key="point_grid_layer",
            widget="layer-selector",
            widget_options={"geometry_types": ["Point", "MultiPoint"]},
            visible_when={"catchment_area_type": "point_grid"},
        ),
    )

    point_grid_layer_filter: dict[str, Any] | None = Field(
        default=None,
        description="CQL2-JSON filter for point grid layer.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=18,
            hidden=True,
        ),
    )

    output_format: OutputFormat = Field(
        default=OutputFormat.parquet,
        description="Output file format.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=19,
            hidden=True,
        ),
    )

    # =========================================================================
    # Validators
    # =========================================================================

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_budget(cls, data: Any) -> Any:
        return resolve_leg_budget_input(resolve_budget_input(data))

    @model_validator(mode="after")
    def _check_budget(self: Self) -> Self:
        validate_cost_type(self.routing_mode, self.cost_type)
        validate_budget(self.routing_mode, self.cost_type, self.max_cost)
        validate_leg_budget(self.access_cost_type, self.access_max_cost, "access")
        validate_leg_budget(self.egress_cost_type, self.egress_max_cost, "egress")
        return self

    @model_validator(mode="after")
    def validate_shape_style(self: Self) -> Self:
        if self.shape_style != ShapeStyle.separated:
            return self
        if self.catchment_area_type != CatchmentType.polygon:
            raise ValueError(
                "shape_style=separated requires catchment_area_type=polygon."
            )
        if self.routing_mode in (
            CatchmentAreaRoutingMode.pt,
            CatchmentAreaRoutingMode.car,
        ):
            raise ValueError(
                "shape_style=separated is only supported for active mobility modes."
            )
        return self


# =========================================================================
# Tool Runner
# =========================================================================


class CatchmentAreaV2ToolRunner(CatchmentAreaToolRunner):
    """Catchment Area V2 tool runner for Windmill — local C++ routing backend."""

    tool_class = CatchmentAreaToolV2
    default_output_name = get_default_layer_name("catchment_area", "en")

    def process(
        self: Self,
        params: CatchmentAreaV2WindmillParams,
        temp_dir: Path,
    ) -> tuple[Path, DatasetMetadata]:
        """Run catchment area V2 analysis."""
        output_path = temp_dir / "output.parquet"

        latitudes, longitudes = self._get_starting_coordinates(
            params.starting_points,
            params.user_id,
        )

        # Validate starting point count
        n_points = len(latitudes)
        if params.routing_mode == CatchmentAreaRoutingMode.pt:
            if n_points > 100:
                raise ValueError(
                    f"Public transport supports a maximum of 100 starting points. "
                    f"Got {n_points}."
                )
        elif n_points > 1000:
            raise ValueError(f"Maximum 1,000 starting points allowed. Got {n_points}.")

        # Build PT time window
        time_window = None
        if params.routing_mode == CatchmentAreaRoutingMode.pt:
            time_window = PTTimeWindow(
                weekday=params.pt_day,
                # Set only for a bundle, whose timetable the weekday
                # anchors do not fall inside; it wins when present.
                on_date=params.pt_date,
                from_time=params.pt_start_time,
                to_time=params.pt_end_time,
            )

        max_cost = float(params.max_cost)

        # Export point grid layer to parquet if needed
        grid_points_path = None
        if (
            params.catchment_area_type == CatchmentType.point_grid
            and params.point_grid_layer_id
        ):
            raw_layer_path = self.export_layer_to_parquet(
                params.point_grid_layer_id,
                params.user_id,
                cql_filter=params.point_grid_layer_filter,
            )
            # Convert to the format expected by C++: id, x_3857, y_3857
            grid_parquet = tempfile.NamedTemporaryFile(
                suffix=".parquet", delete=False
            ).name
            con = duckdb.connect()
            con.execute("INSTALL spatial; LOAD spatial;")
            cols = con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{raw_layer_path}')"
            ).fetchall()
            geom_col = next(
                (
                    c[0]
                    for c in cols
                    if "GEOMETRY" in c[1].upper() or c[0] in ("geom", "geometry")
                ),
                "geometry",
            )
            # Convert WGS84 lon/lat to Web Mercator (EPSG:3857)
            earth_radius_m = 6378137.0
            con.execute(f"""
                COPY (
                    SELECT
                        ROW_NUMBER() OVER () AS id,
                        ST_X("{geom_col}") * PI() / 180.0 * {earth_radius_m} AS x_3857,
                        LN(TAN(PI() / 4.0 + ST_Y("{geom_col}") * PI() / 360.0)) * {earth_radius_m} AS y_3857
                    FROM read_parquet('{raw_layer_path}')
                    WHERE "{geom_col}" IS NOT NULL
                ) TO '{grid_parquet}' (FORMAT PARQUET)
            """)
            con.close()
            grid_points_path = grid_parquet

        # Map routing mode to V2 enum
        routing_mode_map = {
            "walking": RoutingMode.walking,
            "bicycle": RoutingMode.bicycle,
            "pedelec": RoutingMode.pedelec,
            "car": RoutingMode.car,
            "pt": RoutingMode.pt,
        }
        routing_mode_value = (
            params.routing_mode.value
            if hasattr(params.routing_mode, "value")
            else params.routing_mode
        )

        analysis_params = CatchmentAreaV2Params(
            latitude=latitudes,
            longitude=longitudes,
            routing_mode=routing_mode_map[routing_mode_value],
            cost_type=params.cost_type,
            max_cost=max_cost,
            steps=params.steps,
            speed=params.speed,
            cutoffs=params.step_sizes,
            grid_points_path=grid_points_path,
            # PT
            transit_modes=params.pt_modes,
            time_window=time_window,
            max_transfers=params.pt_max_transfers,
            # PT access/egress
            access_mode=params.access_mode,
            egress_mode=params.egress_mode,
            access_cost_type=params.access_cost_type,
            egress_cost_type=params.egress_cost_type,
            access_max_cost=params.access_max_cost,
            egress_max_cost=params.egress_max_cost,
            access_speed=params.access_speed,
            egress_speed=params.egress_speed,
            # Output
            catchment_type=params.catchment_area_type,
            polygon_difference=params.steps_style == StepsStyle.separate,
            shape_style=params.shape_style,
            output_format=params.output_format,
            output_path=str(output_path),
        )

        # A selected PT bundle's timetable overrides the global network.
        if (
            params.routing_mode == CatchmentAreaRoutingMode.pt
            and params.pt_network_bundle_id
        ):
            analysis_params.timetable_path = fetch_pt_timetable(
                self, params.pt_network_bundle_id
            )

        # The street network to route on, in order of what the user meant:
        # the one they picked; else the one the chosen PT bundle is linked to,
        # since that is the network its stops were connected to and the one its
        # access and egress legs belong on; else the default.
        graph = None
        if params.street_network_bundle_id:
            graph = fetch_routing_network(
                self, params.street_network_bundle_id, temp_dir
            )
        elif (
            params.routing_mode == CatchmentAreaRoutingMode.pt
            and params.pt_network_bundle_id
        ):
            graph = fetch_linked_routing_network(
                self, params.pt_network_bundle_id, temp_dir
            )
        if graph:
            analysis_params.edge_path, analysis_params.node_path = graph

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]

            if not self._starting_points_from_layer:
                starting_points_path = temp_dir / "starting_points.parquet"
                self._create_starting_points_parquet(
                    latitudes=latitudes,
                    longitudes=longitudes,
                    output_path=starting_points_path,
                )
                if starting_points_path.exists():
                    self._starting_points_parquet = starting_points_path

            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: CatchmentAreaV2WindmillParams) -> dict:
    """Windmill entry point for catchment area V2 tool."""
    runner = CatchmentAreaV2ToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
