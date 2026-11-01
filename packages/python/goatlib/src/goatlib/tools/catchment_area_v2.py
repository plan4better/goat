"""Catchment Area V2 tool for Windmill.

Uses the local C++ routing backend for all modes. Mirrors the v1 tool runner
structure but builds CatchmentAreaV2Params with cost_type/max_cost.
"""

import logging
import math
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
    SECTION_PT_NETWORK,
    SECTION_ROUTING,
    SECTION_STREET_NETWORK,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.bundles.artifacts.gtfs import fetch_pt_timetable
from goatlib.bundles.artifacts.street_network import (
    fetch_linked_routing_network,
    fetch_routing_network,
)
from goatlib.io.config import parquet_copy_options
from goatlib.models.io import DatasetMetadata
from goatlib.tools.catchment_area import CatchmentAreaToolRunner
from goatlib.tools.limits import (
    CATCHMENT_MAX_STARTING_POINTS,
    CATCHMENT_MAX_STARTING_POINTS_PT,
)
from goatlib.tools.pt_network import ensure_pt_date, pt_date_field
from goatlib.tools.schemas import ToolInputBase, get_default_layer_name

logger = logging.getLogger(__name__)


class StepsStyle(StrEnum):
    separate = "separate"
    cumulative = "cumulative"


# The form computes step sizes (`compute_from`) for these output types only.
_STEP_SIZE_TYPES = ("polygon", "network")
_MAX_STEPS = 9


def band_edges_problem(edges: list[int], steps: int, limit: float) -> str | None:
    """Why ``edges`` are not band edges up to ``limit``, or None. Each band ends
    at one edge, so they rise from above zero and end at most at the budget.
    The router takes them in place of ``steps``, so their number may differ."""
    rising = all(later > earlier for earlier, later in zip(edges, edges[1:]))
    if edges and edges[0] > 0 and rising and edges[-1] <= limit:
        return None
    suggestion = step_sizes_from(steps, limit)
    hint = f" For {steps} bands up to {limit:g}: {suggestion}." if suggestion else ""
    return (
        "step_sizes are the band edges: each band ends at one, so they rise and "
        f"end at most at max_cost ({limit:g}); got {edges}.{hint}"
    )


def step_sizes_from(steps: int, limit: float) -> list[int] | None:
    """The step sizes the form's chips compute from `steps` and the budget: the
    budget split into equal steps, each rounded to a whole number with halves
    rounded up, as the form's Math.round does. None where the form computes
    none: no steps, more than nine, no budget, or more steps than budget units.
    The engine's own split of `steps` keeps the fractions, so a run without
    these sizes would draw its rings at other costs than the form shows."""
    if steps <= 0 or steps > _MAX_STEPS or limit <= 0 or steps > limit:
        return None
    interval = limit / steps
    return [math.floor(interval * (i + 1) + 0.5) for i in range(steps)]


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
    speed_default_by_field,
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
    order=3,
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
            SECTION_STREET_NETWORK,
            SECTION_PT_NETWORK,
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
            "The public transport network used for routing: the default "
            "network, or a public transport bundle added to this project."
        ),
        json_schema_extra=ui_field(
            section="pt_network",
            field_order=18,
            label_key="pt_network_bundle_id",
            widget="bundle-selector",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"_project_has_pt_network_bundle": True},
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
            "The street network used for routing: the default network, or a "
            "street network bundle added to this project."
        ),
        json_schema_extra=ui_field(
            section="street_network",
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
                    {"_project_has_street_network_bundle": True},
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

    reference_field: str | None = Field(
        default=None,
        description=(
            "Column identifying each starting point, written to the result as "
            "`origin` so a catchment can be traced back to the point it was "
            "computed from. Defaults to the layer's id."
        ),
        json_schema_extra=ui_field(
            section="starting",
            field_order=2,
            label_key="reference_field",
            widget="field-selector",
            # Only separated shapes have anything to reference: combined merges
            # every origin into one geometry. Points placed on the map carry no
            # attributes, so there is nothing to choose between there either.
            visible_when={
                "$and": [
                    {"shape_style": "separated"},
                    {"starting_points.layer_id": {"$ne": None}},
                ]
            },
            widget_options={"source_layer": "starting_points.layer_id"},
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
            # Share the row rather than claiming the width of whichever option
            # is selected: both start from a zero basis, so the number beside
            # this keeps its space whether the label reads "Time (min)" or
            # "Entfernung (m)". Twice the growth of the number, which needs far
            # less room than a labelled option does.
            inline_flex="2 1 0",
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
                "default_by_field": speed_default_by_field("routing_mode"),
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
        description=(
            "The band edges, in rising order up to max_cost: each band ends at one, "
            "e.g. [5, 10, 15] for three bands of 5 minutes up to 15. Left out, they "
            "are computed from steps and max_cost."
        ),
        examples=[[5, 10, 15]],
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
                    {"_pt_network_bundle_id_is_custom": False},
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
                "default_by_field": speed_default_by_field("access_mode", leg=True),
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
                "default_by_field": speed_default_by_field("egress_mode", leg=True),
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
        description=(
            "The shape of the result: polygons around the reached area, the reached "
            "street network, a hexagon grid, or the points of a point layer. A hexagon "
            "counts as reached when any reached part of the network lies in it, so the "
            "grid's area is an upper estimate."
        ),
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
        description=(
            "Separate gives each step as a ring (only the area between the previous "
            "step and this one); cumulative gives each step the whole area reached up "
            "to it."
        ),
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
    def _apply_form_rules(self: Self) -> Self:
        """What the form does before a run, for a run built without it: it
        computes the step sizes from `steps` and the budget, and it does not
        run a point grid without its layer. Step sizes given are band edges and
        must rise up to the budget (``band_edges_problem``)."""
        if (
            self.catchment_area_type == CatchmentType.point_grid
            and not self.point_grid_layer_id
        ):
            raise ValueError(
                "point_grid_layer_id is required when catchment_area_type is "
                "'point_grid'."
            )
        if self.step_sizes is None and self.catchment_area_type in _STEP_SIZE_TYPES:
            self.step_sizes = step_sizes_from(self.steps, self.max_cost)
        if self.step_sizes is not None and self.catchment_area_type in _STEP_SIZE_TYPES:
            problem = band_edges_problem(self.step_sizes, self.steps, self.max_cost)
            if problem is not None:
                raise ValueError(problem)
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

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        """The columns the engine writes for the kind of catchment
        (``_write_empty_result`` writes the same), after ``_resolve_origins``:
        - id, cost_step and geometry for every kind;
        - cost, each point's own travel cost, for a point grid;
        - origin for separated shapes: the reference field's value of the
          starting point a catchment comes from, in the field's type on the
          starting points layer, or the point's number from 1 without a field.
        """
        columns = {"id": "INTEGER"}
        if params.get("catchment_area_type") == CatchmentType.point_grid:
            columns["cost"] = "DOUBLE"
        columns["cost_step"] = "INTEGER"
        if params.get("shape_style") == ShapeStyle.separated:
            reference = params.get("reference_field")
            starting_points = input_schemas.get("starting_points") or {}
            columns["origin"] = (
                starting_points.get(reference, "VARCHAR") if reference else "INTEGER"
            )
        columns["geometry"] = "GEOMETRY"
        return columns

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
            reference_field=params.reference_field,
        )
        if not latitudes:
            # The starting points' filter matched nothing: the run goes on
            # with an empty result of the usual columns.
            return self._write_empty_result(params, temp_dir)

        # Validate starting point count
        n_points = len(latitudes)
        if params.routing_mode == CatchmentAreaRoutingMode.pt:
            if n_points > CATCHMENT_MAX_STARTING_POINTS_PT:
                raise ValueError(
                    f"Public transport supports a maximum of "
                    f"{CATCHMENT_MAX_STARTING_POINTS_PT} starting points. Got {n_points}."
                )
        elif n_points > CATCHMENT_MAX_STARTING_POINTS:
            raise ValueError(
                f"Maximum {CATCHMENT_MAX_STARTING_POINTS:,} starting points allowed. "
                f"Got {n_points}."
            )

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
                ) TO '{grid_parquet}' {parquet_copy_options()}
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
            ensure_pt_date(params.pt_network_bundle_id, params.pt_date)
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

            result_path = self._resolve_origins(
                Path(result_path),
                params.shape_style,
                temp_dir,
            )

            return Path(result_path), metadata
        finally:
            tool.cleanup()

    def _write_empty_result(
        self: Self, params: CatchmentAreaV2WindmillParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """A result without rows in the columns the engine writes for this
        kind, passed through ``_resolve_origins`` like a real one. The engine
        refuses zero starting points, so it is not asked."""
        kind = params.catchment_area_type
        geometry = "ST_Point(0, 0)::GEOMETRY('OGC:CRS84') AS geometry"
        if kind == CatchmentType.point_grid:
            columns = (
                "0::INTEGER AS id, 0.0::DOUBLE AS cost, 0::INTEGER AS cost_step, "
                f"{geometry}"
            )
        elif (
            kind == CatchmentType.polygon
            and params.routing_mode != CatchmentAreaRoutingMode.car
        ):
            columns = (
                "0::INTEGER AS id, 0::INTEGER AS cost_step, "
                f"0::INTEGER AS origin_idx, {geometry}"
            )
        else:
            columns = f"0::INTEGER AS id, 0::INTEGER AS cost_step, {geometry}"
        engine_file = temp_dir / "output.parquet"
        con = duckdb.connect()
        try:
            con.execute("INSTALL spatial; LOAD spatial;")
            con.execute(
                f"COPY (SELECT {columns} WHERE false) TO '{engine_file}' "
                f"{parquet_copy_options()}"
            )
        finally:
            con.close()
        path = self._resolve_origins(engine_file, params.shape_style, temp_dir)
        return Path(path), DatasetMetadata(
            path=str(path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Polygon",
        )

    def _resolve_origins(
        self: Self,
        result_path: Path,
        shape_style: ShapeStyle,
        temp_dir: Path,
    ) -> Path:
        """Turn the engine's origin index into an `origin` column.

        The engine addresses starting points by position, which means nothing
        to a reader of the result. This maps each position back to the value
        the user chose to identify it by — or to the point's own 1-based number
        when the points came from map clicks and there is no attribute to use,
        which is what the generated starting-points layer numbers them.

        Only separated shapes get the id: a combined run answers "how far from
        any of these points", so no band belongs to one of them. The engine
        emits its index either way, though, so a combined run still comes
        through here — to drop it, rather than leave an internal index in a
        result nobody asked to change.
        """
        columns = {
            row[0]
            for row in self.duckdb_con.execute(
                f"DESCRIBE SELECT * FROM '{result_path}'"
            ).fetchall()
        }
        # An engine built before the column existed, or an output kind that
        # never carried it (network, point grid). Nothing to do either way.
        if "origin_idx" not in columns:
            if shape_style == ShapeStyle.separated:
                logger.warning(
                    "Routing engine produced no origin_idx; "
                    "result will carry no origin."
                )
            return result_path

        if shape_style != ShapeStyle.separated:
            stripped = temp_dir / "output_without_idx.parquet"
            self.duckdb_con.execute(
                f"COPY (SELECT * EXCLUDE (origin_idx) "
                f"FROM '{result_path}') TO '{stripped}' {parquet_copy_options()}"
            )
            return stripped

        references = self._starting_point_references
        rewritten = temp_dir / "output_with_ids.parquet"

        if references:
            # Positional join: the engine's index is the position in the list
            # the coordinates were read from, and the references came out of
            # that same query in that same order.
            mapping = ", ".join(
                f"({i}, {self._sql_literal(value)})"
                for i, value in enumerate(references)
            )
            query = f"""
                SELECT r.* EXCLUDE (origin_idx),
                       m.ref AS origin
                FROM '{result_path}' r
                LEFT JOIN (VALUES {mapping}) m(idx, ref)
                  ON m.idx = r.origin_idx
            """
        elif self._starting_point_reference_type:
            # A reference field on a layer that gave no point: nothing to
            # map, and the column keeps the field's type.
            query = f"""
                SELECT * EXCLUDE (origin_idx),
                       CAST(NULL AS {self._starting_point_reference_type}) AS origin
                FROM '{result_path}'
            """
        else:
            query = f"""
                SELECT * EXCLUDE (origin_idx),
                       origin_idx + 1 AS origin
                FROM '{result_path}'
            """

        self.duckdb_con.execute(
            f"COPY ({query}) TO '{rewritten}' {parquet_copy_options()}"
        )
        return rewritten

    @staticmethod
    def _sql_literal(value: Any) -> str:
        """A reference value as a DuckDB literal.

        The values are layer data, not parameters, and they go into a VALUES
        list that cannot take placeholders — so strings are escaped here rather
        than interpolated raw.
        """
        if value is None:
            return "NULL"
        if isinstance(value, bool):
            return "TRUE" if value else "FALSE"
        if isinstance(value, (int, float)):
            return str(value)
        escaped = str(value).replace("'", "''")
        return f"'{escaped}'"


def main(params: CatchmentAreaV2WindmillParams) -> dict:
    """Windmill entry point for catchment area V2 tool."""
    runner = CatchmentAreaV2ToolRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
