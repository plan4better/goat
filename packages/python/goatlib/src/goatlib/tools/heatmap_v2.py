"""Heatmap V2 tool for Windmill — on-the-fly via local C++ routing.

Supports walking, bicycle, pedelec, car, and public-transport modes. PT
uses an arrive-by reverse-RAPTOR pipeline with precomputed per-mode
access/egress lookup tables (resolved from settings). Per-opportunity
max_cost drives the routing budget; the resolver turns layer IDs into
parquet paths.
"""

from __future__ import annotations

import logging
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import ConfigDict, Field, model_validator

from goatlib.analysis.accessibility import HeatmapV2Tool
from goatlib.analysis.pt_time import pt_anchor_unix_minutes
from goatlib.analysis.schemas.catchment_area import WEEKDAY_LABELS
from goatlib.analysis.schemas.catchment_area_v2 import (
    AccessEgressMode,
    CostType,
    PTMode,
    RoutingMode,
    Weekday,
)
from goatlib.analysis.schemas.heatmap import (
    ROUTING_MODE_ICONS,
    ROUTING_MODE_LABELS,
    PotentialExpression,
    PotentialType,
    TwoSFCAType_LABELS,
)
from goatlib.analysis.schemas.heatmap_v2 import (
    N_DESTINATIONS_MAX,
    N_DESTINATIONS_MIN,
    SENSITIVITY_MAX,
    SENSITIVITY_MIN,
    GravityDecay,
    HeatmapType,
    HeatmapV2Params,
    OpportunityV2,
    TwoSFCAType,
)
from goatlib.analysis.schemas.ui import (
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.bundles.artifacts.street_network import fetch_routing_network
from goatlib.models.io import DatasetMetadata
from goatlib.tools._opportunity_handles import (
    NUMBERED_OPPORTUNITY_FILTER_FIELDS,
    NUMBERED_OPPORTUNITY_ID_FIELDS,
    NumberedOpportunityLayersMixin,
)
from goatlib.tools._routing_limits import (
    DEFAULT_MAX_TIME_ACTIVE_MIN,
    budget_widget_options,
    leg_budget_widget_options,
    resolve_budget_input,
    resolve_leg_names,
    validate_budget,
    validate_cost_type,
    validate_leg_budget,
)
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.catchment_area_v2 import (
    ACCESS_EGRESS_MODE_ICONS,
    ACCESS_EGRESS_MODE_LABELS,
    COST_TYPE_ICONS,
    COST_TYPE_LABELS,
    PT_MODE_LABELS,
    SECTION_CONFIGURATION,
)
from goatlib.tools.pt_network import (
    apply_pt_bundle_override,
    pt_date_field,
    pt_network_bundle_field,
)
from goatlib.tools.schemas import (
    ToolInputBase,
    get_default_layer_name,
)
from goatlib.tools.style import get_heatmap_style

logger = logging.getLogger(__name__)


class HeatmapRoutingMode(StrEnum):
    """Routing modes supported by heatmap v2.

    PT uses an arrive-by reverse-RAPTOR pipeline with precomputed per-mode
    access/egress lookup tables (the access/egress mode selects which table is
    loaded; only the walk table is generated so far, others resolve once built).
    """

    walking = "walking"
    bicycle = "bicycle"
    pedelec = "pedelec"
    car = "car"
    pt = "pt"


# Routing-mode icons/labels for the heatmap form. Extends the street-mode
# maps from the heatmap schema with a PT entry (matching catchment v2). The
# base street maps (without PT) are reused directly for the connectivity tile.
HM_ROUTING_MODE_ICONS: dict[str, str] = {**ROUTING_MODE_ICONS, "pt": "bus"}
HM_ROUTING_MODE_LABELS: dict[str, str] = {
    **ROUTING_MODE_LABELS,
    "pt": "routing_modes.pt",
}


# =========================================================================
# UI Sections
# =========================================================================

SECTION_ROUTING_HM = UISection(
    id="routing",
    order=1,
    icon="route",
    label_key="routing",
)

SECTION_OPPORTUNITIES_HM = UISection(
    id="opportunities",
    order=4,
    icon="opportunity",
    label_key="opportunities",
    depends_on={"routing_mode": {"$ne": None}},
)

SECTION_RESULT_HM = UISection(
    id="result",
    order=7,
    icon="save",
    label_key="result_layer_section",
    depends_on={"routing_mode": {"$ne": None}},
)

# 2SFCA / Huff: the demand layer is a second input domain, not a routing
# setting, so it gets its own section between configuration and opportunities.
SECTION_DEMAND_HM = UISection(
    id="demand",
    order=3,
    icon="people",
    depends_on={"routing_mode": {"$ne": None}},
)

# Connectivity only: the reference area is a required input domain, so it gets
# its own section (ordered right after configuration) rather than sharing the
# advanced-clip slot the other heatmaps use.
SECTION_REFERENCE_AREA = UISection(
    id="reference_area",
    order=3,
    icon="layers",
    label_key="reference_area",
    depends_on={"routing_mode": {"$ne": None}},
)

# =========================================================================
# Label Mappings
# =========================================================================

HEATMAP_TYPE_LABELS: dict[str, str] = {
    "gravity": "enums.heatmap_type.gravity",
    "closest_average": "enums.heatmap_type.closest_average",
}

GRAVITY_DECAY_LABELS: dict[str, str] = {
    "gaussian": "enums.gravity_decay.gaussian",
    "exponential": "enums.gravity_decay.exponential",
    "linear": "enums.gravity_decay.linear",
    "power": "enums.gravity_decay.power",
    "cumulative": "enums.gravity_decay.cumulative",
}


# =========================================================================
# Form-layer opportunity schema
#
# Adds a point / polygon geometry filter to the layer selector on top of the
# analysis-layer OpportunityV2; instances stay compatible via inheritance.
# =========================================================================


class OpportunityV2PointBase(OpportunityV2):
    """Shared form-layer base for v2 opportunity cards. Accepts point or
    polygon layers, carries the per-opportunity budget (unit follows the outer
    cost_type), and hides formula-specific extras; the gravity /
    closest-average subclasses re-expose what each needs."""

    input_path: str = Field(
        ...,
        description="Path to opportunity dataset (point or polygon layer).",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=1,
            label_key="input_path",
            widget="layer-selector",
            widget_options={
                "geometry_types": [
                    "Point",
                    "MultiPoint",
                    "Polygon",
                    "MultiPolygon",
                ]
            },
        ),
    )

    layer_project_id: int | None = Field(
        default=None,
        description="Project-layer id of the opportunity layer (auto-populated).",
        json_schema_extra=ui_field(section="opportunities", field_order=1, hidden=True),
    )

    # Single per-opportunity travel budget — same name/meaning as the analysis
    # schema and the C++ engine. Default, floor and cap resolve from the parent
    # routing_mode x cost_type rules.
    max_cost: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        gt=0,
        description="Upper limit for this opportunity, in the selected measure type: travel time or travel distance.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=2,
            label_key="limit",
            description_key="limit",
            visible_when={"input_path": {"$ne": None}},
            widget_options=budget_widget_options(),
        ),
    )

    # Hide all formula-specific extras from the base. The two formula
    # subclasses below re-declare the fields they need as visible.
    sensitivity: float = Field(
        default=300000.0,
        ge=SENSITIVITY_MIN,
        le=SENSITIVITY_MAX,
        json_schema_extra=ui_field(section="opportunities", hidden=True),
    )
    potential_type: PotentialType = Field(
        default=PotentialType.constant,
        json_schema_extra=ui_field(section="opportunities", hidden=True),
    )
    potential_field: str | None = Field(
        None,
        json_schema_extra=ui_field(section="opportunities", hidden=True),
    )
    potential_constant: float | None = Field(
        1.0,
        gt=0.0,
        json_schema_extra=ui_field(section="opportunities", hidden=True),
    )
    potential_expression: PotentialExpression | None = Field(
        None,
        json_schema_extra=ui_field(section="opportunities", hidden=True),
    )
    n_destinations: Literal[1, 2, 3, 4, 5, 6, 7, 8, 9, 10] = Field(
        default=1,
        title="Number of Destinations",
        json_schema_extra=ui_field(section="opportunities", hidden=True),
    )


class OpportunityV2PointGravity(OpportunityV2PointBase):
    """Gravity opportunity card: re-exposes sensitivity + potential_* fields."""

    sensitivity: float = Field(
        default=300000.0,
        ge=SENSITIVITY_MIN,
        le=SENSITIVITY_MAX,
        description="Sensitivity parameter for gravity decay function "
        "(larger = slower decay / wider reach).",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=10,
            label_key="sensitivity",
            widget="number",
            widget_options={
                "min": SENSITIVITY_MIN,
                "max": SENSITIVITY_MAX,
                "step": 1000,
            },
            # Cumulative (in-budget step) and linear (1 - cost/max_cost) have
            # no sensitivity term, so the field would do nothing under them.
            # Card fields are evaluated against the parent form's values merged
            # with the item's, so `decay` (a tool-level field) is in scope here.
            visible_when={
                "input_path": {"$ne": None},
                "decay": {
                    "$nin": [
                        GravityDecay.cumulative.value,
                        GravityDecay.linear.value,
                    ]
                },
            },
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
            widget_options={
                "source_layer": "input_path",
                "field_types": ["number"],
            },
            visible_when={
                "input_path": {"$ne": None},
                "potential_type": "field",
            },
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
            visible_when={
                "input_path": {"$ne": None},
                "potential_type": "constant",
            },
        ),
    )
    potential_expression: PotentialExpression | None = Field(
        None,
        description="Expression to compute potential for polygon layers.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=7,
            visible_when={
                "input_path": {"$ne": None},
                "potential_type": "expression",
            },
        ),
    )


class OpportunityV2PointClosestAverage(OpportunityV2PointBase):
    """Closest-Average opportunity card: re-exposes n_destinations."""

    n_destinations: int = Field(
        default=1,
        title="Number of Destinations",
        description="Number of closest destinations to average",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=5,
            label_key="n_destinations",
            widget="number",
            # Bounds go through max_value_from, which NumberInput validates and
            # messages on. Deliberately NOT ge/le: those emit schema
            # minimum/maximum, and NumberInput switches to a slider whenever
            # both are set and their range is <= 10000 — a 1..10 field would
            # become a slider. Bare widget_options min/max are read by nothing.
            # Out-of-range payloads are still rejected server-side by the
            # analysis-layer OpportunityV2 (ge=1, le=10) and the C++ closest_k
            # check.
            widget_options={
                "step": 1,
                "max_value_from": {
                    "fields": [
                        {
                            "value": N_DESTINATIONS_MAX,
                            "min": N_DESTINATIONS_MIN,
                            "message": "n_destinations_limit_message",
                        }
                    ],
                    "message": "n_destinations_limit_message",
                },
            },
            visible_when={"input_path": {"$ne": None}},
        ),
    )


# =========================================================================
# Windmill Params
# =========================================================================


class HeatmapV2WindmillParams(ToolInputBase):
    """Windmill-facing params for HeatmapV2.

    Mode/cost/PT fields mirror catchment_area_v2's structure exactly. The
    runner's `process()` builds the analysis-level `HeatmapV2Params` from these
    and hands off to `HeatmapV2Tool`.
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_ROUTING_HM,
            SECTION_CONFIGURATION,
            SECTION_OPPORTUNITIES_HM,
            SECTION_RESULT_HM,
        )
    )

    # =========================================================================
    # Result Section
    # =========================================================================

    result_layer_name: str | None = Field(
        default=get_default_layer_name("heatmap_gravity", "en"),
        description="Name for the heatmap result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("heatmap_gravity", "en"),
                "default_de": get_default_layer_name("heatmap_gravity", "de"),
            },
        ),
    )

    # =========================================================================
    # Routing Section
    # =========================================================================

    routing_mode: HeatmapRoutingMode = Field(
        ...,
        description="Transport mode for the heatmap.",
        json_schema_extra=ui_field(
            section="routing",
            field_order=1,
            label_key="routing_mode",
            enum_icons=HM_ROUTING_MODE_ICONS,
            enum_labels=HM_ROUTING_MODE_LABELS,
            # Changing the transport mode restarts the form: it decides which
            # measures, budgets and legs apply, so nothing should carry over.
            widget_options={"resets_form": True},
        ),
    )

    # PT transit-mode filter (only the listed PT classes are used). Mirrors
    # catchment v2's pt_modes. Visible only for PT.
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

    # =========================================================================
    # Configuration Section — heatmap formula + measure unit
    # =========================================================================

    heatmap_type: HeatmapType = Field(
        default=HeatmapType.gravity,
        description="Formula used to score each cell from reachable opportunities.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=0,
            label_key="heatmap_type",
            enum_labels=HEATMAP_TYPE_LABELS,
        ),
    )

    # Cost type (time vs distance) — mirrors catchment_area_v2. Drives which
    # set of per-opportunity budget fields apply.
    cost_type: CostType = Field(
        default=CostType.time,
        description="Measure the heatmap by travel time or travel distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            label_key="measure_type",
            enum_labels=COST_TYPE_LABELS,
            enum_icons=COST_TYPE_ICONS,
            inline_group="cost_config",
            # PT is always time-based (total journey minutes); hide the
            # time/distance selector for PT.
            visible_when={
                "routing_mode": {"$in": ["walking", "bicycle", "pedelec", "car"]}
            },
        ),
    )

    # =========================================================================
    # PT (routing_mode == pt) — arrive-by reverse RAPTOR.
    #
    # Unlike catchment (departure), the PT heatmap is anchored on an ARRIVAL
    # time: every reachable cell's score reflects a journey arriving by this
    # time. Access/egress mode + time budget mirror catchment (see below);
    # the budget is capped at the lookup table's built max (20 min). The
    # per-opportunity max_cost is the total journey budget.
    # =========================================================================

    pt_day: Weekday = Field(
        default=Weekday.weekday,
        description="Day type for PT schedule.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=3,
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
    pt_date: str | None = pt_date_field(3)
    pt_arrival_time: int = Field(
        default=32400,  # 09:00
        ge=0,
        le=86399,
        description="Arrive-by time of day (seconds from midnight).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=4,
            label_key="arrival_time",
            widget="time-picker",
            visible_when={"routing_mode": "pt"},
        ),
    )
    # Access & egress legs — mirrors catchment_area_v2's PT access/egress
    # (mode selector + per-leg budget, grouped, under Advanced). Unlike
    # catchment, the legs are served by precomputed per-mode lookup tables
    # (minutes, mode speed baked in), so there's no speed/distance override
    # and the budget is capped at the table's built max (20 min). The mode
    # selects which lookup table is loaded.
    # Access/egress legs are walk-only for PT heatmaps: only the walk
    # access/egress lookup table is precomputed. The mode selector stays visible
    # for consistency with the other legs/config, but is restricted to the
    # single "walk" option (== AccessEgressMode.walk) via the Literal type.
    access_mode: Literal["walk"] = Field(
        default="walk",
        description="Mode to reach transit stops (walk-only for PT heatmaps).",
        # Literal keeps validation walk-only (emits `const`); the explicit
        # `enum` makes the frontend render it as a (single-option) dropdown,
        # since it derives options from schema `enum`, not `const`.
        json_schema_extra={
            **ui_field(
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
            "enum": [AccessEgressMode.walk.value],
        },
    )
    access_cost_type: Literal["time"] = Field(
        default="time",
        description="Access leg cost type. Time-only: the access/egress "
        "lookup tables are built on travel time.",
        json_schema_extra={
            **ui_field(
                section="configuration",
                field_order=21,
                label_key="measure_type",
                enum_labels=COST_TYPE_LABELS,
                enum_icons=COST_TYPE_ICONS,
                inline_group="access_cost",
                visible_when={
                    "$and": [{"routing_mode": "pt"}, {"show_advanced": True}]
                },
            ),
            "enum": ["time"],
        },
    )

    access_max_cost: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        description="Access leg budget (≤ the lookup table max).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=22,
            label_key="limit",
            description_key="limit",
            inline_group="access_cost",
            inline_flex="1 0 0",
            visible_when={"$and": [{"routing_mode": "pt"}, {"show_advanced": True}]},
            widget_options=leg_budget_widget_options(
                "access_cost_type",
                "pt_access_time_limit_message",
                lookup_table=True,
            ),
        ),
    )
    egress_mode: Literal["walk"] = Field(
        default="walk",
        description="Mode from transit stops to the opportunity "
        "(walk-only for PT heatmaps).",
        # See access_mode: Literal for validation + explicit enum so the
        # frontend renders a (single-option) dropdown.
        json_schema_extra={
            **ui_field(
                section="configuration",
                field_order=23,
                label_key="pt_egress_mode",
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
            "enum": [AccessEgressMode.walk.value],
        },
    )
    egress_cost_type: Literal["time"] = Field(
        default="time",
        description="Egress leg cost type. Time-only: the access/egress "
        "lookup tables are built on travel time.",
        json_schema_extra={
            **ui_field(
                section="configuration",
                field_order=24,
                label_key="measure_type",
                enum_labels=COST_TYPE_LABELS,
                enum_icons=COST_TYPE_ICONS,
                inline_group="egress_cost",
                visible_when={
                    "$and": [{"routing_mode": "pt"}, {"show_advanced": True}]
                },
            ),
            "enum": ["time"],
        },
    )

    egress_max_cost: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        description="Egress leg budget (≤ the lookup table max).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=25,
            label_key="limit",
            description_key="limit",
            inline_group="egress_cost",
            inline_flex="1 0 0",
            visible_when={"$and": [{"routing_mode": "pt"}, {"show_advanced": True}]},
            widget_options=leg_budget_widget_options(
                "egress_cost_type",
                "pt_egress_time_limit_message",
                lookup_table=True,
            ),
        ),
    )
    pt_max_transfers: int = Field(
        default=5,
        # No ge/le — see access_max_cost (avoids the slider; number input).
        description="Maximum number of transit transfers.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=17,
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

    decay: GravityDecay = Field(
        default=GravityDecay.gaussian,
        description="Shape of the distance-decay curve applied to travel cost.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=1,
            label_key="impedance",
            enum_labels=GRAVITY_DECAY_LABELS,
            # 2SFCA overrides this field with its own condition and ordering.
            visible_when={"heatmap_type": HeatmapType.gravity.value},
        ),
    )

    max_sensitivity: float = Field(
        default=1_000_000.0,
        gt=0.0,
        description="Gravity sensitivity normalization anchor.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=14,
            hidden=True,  # Internal normalization constant
        ),
    )

    # Mirrors catchment_area_v2.show_advanced: gates the Speed override
    # (and any other advanced-only field) behind a single toggle.
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

    h3_resolution: int | None = Field(
        default=None,
        ge=5,
        le=12,
        description="H3 resolution for origin tiling. None → per-mode default.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=16,
            label_key="h3_resolution",
            hidden=True,  # Advanced; expose later if needed
        ),
    )

    # Optional reference-area clip — when set, output cells are restricted
    # to those inside the polygon (cells outside dropped; cells inside that
    # weren't reached become NULL). Gated behind show_advanced so it shares
    # the same toggle as speed; connectivity overrides this to required +
    # always-visible.
    reference_area_layer_id: str | None = Field(
        None,
        description="Layer ID for the reference area polygon.",
        json_schema_extra=ui_field(
            section="configuration",
            # Top of the advanced options — right after the show_advanced
            # toggle (15) and before the PT access/egress groups (20-23), so
            # it isn't pulled into the access leg group.
            field_order=16,
            label_key="reference_area_path",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
            visible_when={"show_advanced": True},
            # Advanced-only clip: stays optional when shown so the user can
            # enable Advanced for other fields (e.g. speed) and leave this
            # blank. Connectivity overrides to required.
            optional=True,
        ),
    )
    reference_area_layer_filter: dict[str, Any] | None = Field(
        None,
        description="CQL2-JSON filter to apply to the reference area layer.",
        json_schema_extra=ui_field(
            section="configuration", field_order=16, hidden=True
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
            field_order=21,
            label_key="street_network_bundle_id",
            widget="bundle-selector",
            # A PT run takes its network from pt_network_bundle_id below, so
            # this selector is for street modes.
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

    pt_network_bundle_id: str | None = pt_network_bundle_field(22)

    # =========================================================================
    # Cost / budget / speed
    #
    # v2 mirrors the matrix-based gravity tool: per-opportunity `max_cost`
    # lives on each OpportunityGravity entry under the Opportunities section
    # (in minutes). Mode-default speeds drive routing — surfaced as advanced
    # if the user needs to override.
    # =========================================================================

    speed: float | None = Field(
        default=None,
        description=(
            "Travel speed in km/h. Leave blank to use the mode default "
            "(walking 5, bicycle 15, pedelec 23). Car uses per-road speed "
            "limits and ignores this setting."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=20,
            label_key="speed",
            visible_when={
                "$and": [
                    {"routing_mode": {"$in": ["walking", "bicycle", "pedelec"]}},
                    {"cost_type": "time"},
                    {"show_advanced": True},
                ]
            },
            widget_options={
                "default_by_field": {
                    "field": "routing_mode",
                    "values": {"walking": 5, "bicycle": 15, "pedelec": 23},
                },
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

    # =========================================================================
    # Opportunities list (toolbox UI: repeatable layer entries with per-layer
    # weight + sensitivity controls). Workflow-canvas numbered layer-IDs above
    # take precedence when present (the runner re-packs them into this list).
    # =========================================================================

    opportunities: list[OpportunityV2] | None = Field(
        default=None,
        description="Opportunity layers to score against.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=10,
            repeatable=True,
            min_items=1,
            visible_when={"heatmap_type": {"$in": ["gravity", "closest_average"]}},
        ),
    )

    # =========================================================================
    # Helpers
    # =========================================================================

    def aggregate_max_cost(self: Self) -> float:
        """Maximum per-opportunity budget across all layers — used so the
        loaded network buffer covers every layer's reach. Unit follows
        cost_type: minutes for time, meters for distance."""
        if not self.opportunities:
            return 30.0
        return float(max(o.max_cost for o in self.opportunities))

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_opportunity_budget(cls, data: Any) -> Any:
        """Per-opportunity budgets used to be a time/distance pair; map a
        pre-collapse payload onto max_cost using the form's own cost type."""
        if not isinstance(data, dict) or not isinstance(
            data.get("opportunities"), list
        ):
            return data
        ctx = {
            "routing_mode": data.get("routing_mode"),
            "cost_type": data.get("cost_type"),
        }
        fixed = []
        for o in data["opportunities"]:
            if isinstance(o, dict) and o.get("max_cost") is None:
                merged = resolve_budget_input({**ctx, **o})
                if merged.get("max_cost") is not None:
                    o = {**o, "max_cost": merged["max_cost"]}
            fixed.append(o)
        return {**resolve_leg_names(data), "opportunities": fixed}

    @model_validator(mode="after")
    def _check_opportunity_budgets(self: Self) -> Self:
        validate_cost_type(self.routing_mode, self.cost_type)
        for o in self.opportunities or []:
            validate_budget(self.routing_mode, self.cost_type, o.max_cost)
        return self

    def resolved_opportunities(self: Self) -> list[OpportunityV2]:
        """Project form opportunities to analysis-layer OpportunityV2."""
        if not self.opportunities:
            return []
        return [
            OpportunityV2(**o.model_dump())
            if isinstance(o, OpportunityV2PointBase)
            else o
            for o in self.opportunities
        ]

    @model_validator(mode="after")
    def _fold_numbered_opportunities(self: Self) -> Self:
        """Fold the workflow-canvas numbered handles into `opportunities`.

        A canvas edge can only target a named input, so those nodes deliver bare
        layer IDs on `opportunity_layer_{N}_id`. Folding them into the list here
        leaves one shape for the runner to resolve instead of a second path.
        Per-layer config doesn't exist on this route, so every entry takes the
        form's aggregate budget.
        """
        if self.opportunities:
            return self
        numbered = [
            (getattr(self, id_field, None), getattr(self, filter_field, None))
            for id_field, filter_field in zip(
                NUMBERED_OPPORTUNITY_ID_FIELDS, NUMBERED_OPPORTUNITY_FILTER_FIELDS
            )
        ]
        if not any(layer_id for layer_id, _ in numbered):
            return self
        budget = int(self.aggregate_max_cost())
        self.opportunities = [
            OpportunityV2(
                input_path=layer_id,
                input_layer_filter=layer_filter,
                max_cost=budget,
            )
            for layer_id, layer_filter in numbered
            if layer_id
        ]
        return self


# =========================================================================
# Per-formula entry points
#
# The toolbox surfaces one tool per heatmap formula (Gravity / ClosestAverage).
# Each pre-binds heatmap_type and hides the selector so the formula-specific
# tile renders a focused form.
# =========================================================================


class HeatmapGravityV2WindmillParams(
    NumberedOpportunityLayersMixin, HeatmapV2WindmillParams
):
    """Gravity-based spatial accessibility analysis."""

    heatmap_type: HeatmapType = Field(
        default=HeatmapType.gravity,
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    # Mirrors v1 HeatmapGravityParams: opportunities required, 1-3 layers.
    opportunities: list[OpportunityV2PointGravity] = Field(
        ...,
        title="Opportunity Layers",
        min_length=1,
        max_length=3,
        description="Opportunity layers to score against.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=10,
            repeatable=True,
            min_items=1,
            max_items=3,
        ),
    )
    result_layer_name: str | None = Field(
        default=get_default_layer_name("heatmap_gravity", "en"),
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("heatmap_gravity", "en"),
                "default_de": get_default_layer_name("heatmap_gravity", "de"),
            },
        ),
    )


class HeatmapClosestAverageV2WindmillParams(
    NumberedOpportunityLayersMixin, HeatmapV2WindmillParams
):
    """Average distance/time to N closest destinations."""

    heatmap_type: HeatmapType = Field(
        default=HeatmapType.closest_average,
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    decay: GravityDecay = Field(
        default=GravityDecay.gaussian,
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    # Mirrors v1 HeatmapClosestAverageParams: opportunities required, 1-3 layers.
    opportunities: list[OpportunityV2PointClosestAverage] = Field(
        ...,
        title="Opportunity Layers",
        min_length=1,
        max_length=3,
        description="Opportunity layers to score against.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=10,
            repeatable=True,
            min_items=1,
            max_items=3,
        ),
    )
    result_layer_name: str | None = Field(
        default=get_default_layer_name("heatmap_closest_average", "en"),
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("heatmap_closest_average", "en"),
                "default_de": get_default_layer_name("heatmap_closest_average", "de"),
            },
        ),
    )


class HeatmapConnectivityV2WindmillParams(HeatmapV2WindmillParams):
    """Total area reachable within max travel cost."""

    # Adds a dedicated reference-area section (its required input domain) to
    # the inherited routing → configuration → opportunities → result layout.
    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_ROUTING_HM,
            SECTION_CONFIGURATION,
            SECTION_REFERENCE_AREA,
            SECTION_OPPORTUNITIES_HM,
            SECTION_RESULT_HM,
        )
    )

    # routing_mode is inherited from the base (full mode set incl. PT). PT
    # connectivity runs through the same arrive-by reverse-RAPTOR pipeline as
    # gravity/closest-average; the inherited PT fields (arrival time,
    # access/egress, transfers) surface via their routing_mode == pt guards.

    # Hide the heatmap_type selector and pre-bind to connectivity
    heatmap_type: HeatmapType = Field(
        default=HeatmapType.connectivity,
        description="Heatmap formula (pre-bound to connectivity).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=2,
            hidden=True,
        ),
    )

    # Opportunity layers are not used for connectivity — override as optional
    # with empty default so the base-class validator doesn't demand them.
    opportunities: list[OpportunityV2] | None = Field(
        default=None,
        description="Not used for connectivity (pre-bound formula).",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=10,
            repeatable=True,
            min_items=1,
            hidden=True,
            visible_when={"heatmap_type": {"$in": ["gravity", "closest_average"]}},
        ),
    )

    # Single travel budget — same name/meaning as the analysis schema and the
    # C++ engine. Default, floor and cap come from the mode x cost_type rules.
    max_cost: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        gt=0,
        description="Upper limit for the selected measure type: travel time or travel distance.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=3,
            label_key="limit",
            description_key="limit",
            widget_options=budget_widget_options(),
        ),
    )

    reference_area_layer_id: str = Field(
        ...,
        description="Layer ID for the reference area polygon.",
        json_schema_extra=ui_field(
            section="reference_area",
            field_order=1,
            label_key="reference_area_path",
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
        ),
    )

    result_layer_name: str | None = Field(
        default=get_default_layer_name("heatmap_connectivity", "en"),
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("heatmap_connectivity", "en"),
                "default_de": get_default_layer_name("heatmap_connectivity", "de"),
            },
        ),
    )

    def aggregate_max_cost(self: Self) -> float:
        """Connectivity budget — minutes (time) or meters (distance)."""
        return float(self.max_cost)

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_budget(cls, data: Any) -> Any:
        return resolve_leg_names(resolve_budget_input(data))

    @model_validator(mode="after")
    def _check_budget(self: Self) -> Self:
        validate_budget(self.routing_mode, self.cost_type, self.max_cost)
        validate_leg_budget(
            self.access_cost_type, self.access_max_cost, "access", lookup_table=True
        )
        validate_leg_budget(
            self.egress_cost_type, self.egress_max_cost, "egress", lookup_table=True
        )
        return self


# =========================================================================
# Runner
# =========================================================================


# HeatmapRoutingMode (UI layer) → analysis-layer RoutingMode.
# Both enums have identical values for the supported modes; the map exists
# only to make the type conversion explicit.
_ROUTING_MODE_MAP: dict[HeatmapRoutingMode, RoutingMode] = {
    HeatmapRoutingMode.walking: RoutingMode.walking,
    HeatmapRoutingMode.bicycle: RoutingMode.bicycle,
    HeatmapRoutingMode.pedelec: RoutingMode.pedelec,
    HeatmapRoutingMode.car: RoutingMode.car,
    HeatmapRoutingMode.pt: RoutingMode.pt,
}

# PT access/egress mode (catchment-style "walk" naming) → analysis RoutingMode.
# The analysis layer resolves the per-mode lookup table from this.
_ACCESS_EGRESS_MODE_MAP: dict[AccessEgressMode, RoutingMode] = {
    AccessEgressMode.walk: RoutingMode.walking,
    AccessEgressMode.bicycle: RoutingMode.bicycle,
    AccessEgressMode.pedelec: RoutingMode.pedelec,
    AccessEgressMode.car: RoutingMode.car,
}

# Anchor dates per weekday type — must match catchment v2's
# `_pt_departure_unix_minutes` so PT routing resolves against the same
# representative service days.


class Heatmap2SFCAV2WindmillParams(
    NumberedOpportunityLayersMixin, HeatmapV2WindmillParams
):
    """Two-Step Floating Catchment Area accessibility analysis."""

    # The demand layer gets its own section, as in v1: it is a second input
    # domain alongside the supply layers, not a routing setting.
    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_ROUTING_HM,
            SECTION_CONFIGURATION,
            SECTION_DEMAND_HM,
            SECTION_OPPORTUNITIES_HM,
            SECTION_RESULT_HM,
        )
    )

    heatmap_type: HeatmapType = Field(
        default=HeatmapType.two_sfca,
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    two_sfca_type: TwoSFCAType = Field(
        default=TwoSFCAType.twosfca,
        description="2SFCA method variant (standard / E2SFCA / M2SFCA).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=5,
            label_key="two_sfca_type",
            enum_labels=TwoSFCAType_LABELS,
        ),
    )
    # E2SFCA and M2SFCA feed the decay curve into both 2SFCA steps, so they need
    # the selector; standard 2SFCA weights every reached cell equally (W = 1) and
    # ignores it. Ordered after two_sfca_type, which decides whether it applies.
    decay: GravityDecay = Field(
        default=GravityDecay.gaussian,
        description="Shape of the distance-decay curve applied to travel cost.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=6,
            label_key="impedance",
            enum_labels=GRAVITY_DECAY_LABELS,
            visible_when={
                "two_sfca_type": {
                    "$in": [TwoSFCAType.e2sfca.value, TwoSFCAType.m2sfca.value]
                }
            },
        ),
    )
    # Supply layers — capacity is carried by the opportunity potential fields.
    opportunities: list[OpportunityV2PointGravity] = Field(
        ...,
        title="Supply Layers",
        min_length=1,
        max_length=3,
        description="Supply layers; each opportunity's potential is its capacity.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=10,
            repeatable=True,
            min_items=1,
            max_items=3,
        ),
    )
    # Demand layer (population). Rasterized to cells by the analysis layer.
    demand_layer_id: str = Field(
        ...,
        description="Demand layer (e.g. population).",
        json_schema_extra=ui_field(
            section="demand",
            field_order=1,
            label_key="demand_path",
            widget="layer-selector",
        ),
    )
    demand_layer_filter: dict[str, Any] | None = Field(
        default=None,
        json_schema_extra=ui_field(section="demand", field_order=2, hidden=True),
    )
    demand_field: str = Field(
        ...,
        description="Field in the demand layer holding the demand value.",
        json_schema_extra=ui_field(
            section="demand",
            field_order=3,
            label_key="demand_field",
            widget="field-selector",
            widget_options={
                "source_layer": "demand_layer_id",
                "field_types": ["number"],
            },
            visible_when={"demand_layer_id": {"$ne": None}},
        ),
    )
    result_layer_name: str | None = Field(
        default=get_default_layer_name("heatmap_2sfca", "en"),
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("heatmap_2sfca", "en"),
                "default_de": get_default_layer_name("heatmap_2sfca", "de"),
            },
        ),
    )


class HeatmapV2ToolRunner(BaseToolRunner[HeatmapV2WindmillParams]):
    """Heatmap V2 tool runner for Windmill — local C++ routing backend."""

    tool_class = HeatmapV2Tool
    output_geometry_type = "polygon"  # H3 cells
    default_output_name = get_default_layer_name("heatmap_gravity", "en")

    @classmethod
    def predict_output_schema(
        cls,
        input_schemas: dict[str, dict[str, str]],
        params: dict[str, Any],
    ) -> dict[str, str]:
        return {
            "h3_index": "VARCHAR",
            "total_accessibility": "DOUBLE",
            "geometry": "GEOMETRY",
        }

    def get_layer_properties(
        self: Self,
        params: HeatmapV2WindmillParams,
        metadata: DatasetMetadata,
        table_info: dict[str, Any] | None = None,
        parquet_path: Path | str | None = None,
    ) -> dict[str, Any] | None:
        color_field = "total_accessibility"
        color_scale_breaks = None
        table_name = table_info["table_name"] if table_info else None
        if table_name or parquet_path:
            color_scale_breaks = self.compute_quantile_breaks(
                table_name=table_name,
                column_name=color_field,
                num_breaks=6,
                strip_zeros=True,
                parquet_path=parquet_path,
            )
        return get_heatmap_style(
            color_field_name=color_field,
            color_scale_breaks=color_scale_breaks,
            color_range_name="Emrld",
        )

    # --------------------------------------------------------- helpers

    def _resolve_opportunities(
        self: Self, params: HeatmapV2WindmillParams
    ) -> list[OpportunityV2]:
        """Resolve opportunity layer IDs → parquet paths.

        `params.opportunities` holds OpportunityV2 instances whose `input_path`
        is a layer UUID, with the per-layer fields (potential_type /
        potential_field / potential_constant / potential_expression /
        sensitivity / input_layer_filter / name) already populated.
        `resolve_layer_paths` swaps the UUID for an exported parquet path,
        applies the CQL filter, and preserves every other field on the model.

        Workflow-canvas nodes supply their layers through the numbered
        `opportunity_layer_{N}_id` handles instead; those are folded into this
        same list by `_fold_numbered_opportunities`, so there is one shape here.
        """
        if not params.opportunities:
            raise ValueError(
                "At least one opportunity layer is required "
                "(via opportunity_layer_{1,2,3}_id or the opportunities list)."
            )
        # Toolbox-form path: collapse OpportunityV2PointBase's per-mode budget
        # fields into the analysis-layer OpportunityV2.max_cost (resolved
        # against the form's outer routing_mode + cost_type), then swap
        # layer UUIDs for parquet paths.
        # Name the result column after the project layer. Set before
        # resolve_layer_paths, which fills the dataset name when name is unset.
        resolved = params.resolved_opportunities()
        named = []
        for opp, card in zip(resolved, params.opportunities):
            if not opp.name:
                proj_name = self.get_project_layer_name_by_id(
                    getattr(card, "layer_project_id", None)
                )
                if proj_name:
                    opp = opp.model_copy(update={"name": proj_name})
            named.append(opp)
        return self.resolve_layer_paths(named, params.user_id, "input_path")

    def _resolve_reference_area(
        self: Self, params: HeatmapV2WindmillParams
    ) -> str | None:
        """Export the reference area layer (if any) to a parquet path.
        Returns None when the user didn't supply one (gravity/closest_avg
        advanced field left blank). Connectivity's subclass marks the
        field as required, so this returns a path for that tool."""
        if not getattr(params, "reference_area_layer_id", None):
            return None
        return str(
            self.export_layer_to_parquet(
                layer_id=params.reference_area_layer_id,
                user_id=params.user_id,
                cql_filter=params.reference_area_layer_filter,
            )
        )

    def _resolve_demand(self: Self, params: HeatmapV2WindmillParams) -> str | None:
        """Export the demand layer (2SFCA only) to a parquet path."""
        if not getattr(params, "demand_layer_id", None):
            return None
        return str(
            self.export_layer_to_parquet(
                layer_id=params.demand_layer_id,
                user_id=params.user_id,
                cql_filter=getattr(params, "demand_layer_filter", None),
            )
        )

    # --------------------------------------------------------- main

    def process(
        self: Self, params: HeatmapV2WindmillParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        output_path = temp_dir / "output.parquet"

        # Connectivity uses the reference area as the input domain; gravity
        # / closest_avg uses it (optional, advanced) to clip the output.
        is_connectivity = params.heatmap_type == HeatmapType.connectivity
        reference_area_path = self._resolve_reference_area(params)
        resolved_opportunities = (
            [] if is_connectivity else self._resolve_opportunities(params)
        )

        # 2SFCA: resolve the demand layer + method variant.
        is_two_sfca = params.heatmap_type == HeatmapType.two_sfca
        demand_path = self._resolve_demand(params) if is_two_sfca else None
        demand_field = getattr(params, "demand_field", None)
        two_sfca_type = getattr(params, "two_sfca_type", TwoSFCAType.twosfca)

        # routing_mode is HeatmapRoutingMode across all heatmap types; normalise
        # via value to be robust to a raw string coming from Windmill.
        mode = HeatmapRoutingMode(
            params.routing_mode.value
            if hasattr(params.routing_mode, "value")
            else params.routing_mode
        )
        is_pt = mode == HeatmapRoutingMode.pt

        analysis_params = HeatmapV2Params(
            # Study area
            h3_resolution=params.h3_resolution,
            # Routing
            routing_mode=_ROUTING_MODE_MAP[mode],
            cost_type=params.cost_type,
            max_cost=params.aggregate_max_cost(),
            speed=params.speed,
            # Formula
            heatmap_type=params.heatmap_type,
            decay=params.decay,
            max_sensitivity=params.max_sensitivity,
            # Opportunities + optional reference-area clip
            opportunities=resolved_opportunities,
            reference_area_path=reference_area_path,
            # 2SFCA supply-vs-demand
            two_sfca_type=two_sfca_type,
            demand_path=demand_path,
            demand_field=demand_field,
            # PT (arrive-by reverse RAPTOR). access/egress modes select the
            # per-mode lookup table (walk/bicycle/pedelec/car); the analysis
            # layer resolves the table path and errors if it isn't built yet.
            arrival_time=(
                pt_anchor_unix_minutes(
                    params.pt_day, params.pt_arrival_time, params.pt_date
                )
                if is_pt
                else None
            ),
            transit_modes=(
                [m.value for m in params.pt_modes]
                if is_pt and params.pt_modes
                else None
            ),
            max_transfers=params.pt_max_transfers,
            access_mode=_ACCESS_EGRESS_MODE_MAP[params.access_mode],
            egress_mode=_ACCESS_EGRESS_MODE_MAP[params.egress_mode],
            # Analysis/C++ HeatmapConfig names these *_max_time (time-only
            # lookup tables); the tool layer uses the shared *_max_cost shape.
            access_max_time=params.access_max_cost,
            egress_max_time=params.egress_max_cost,
            # Output
            output_path=str(output_path),
        )

        # An uploaded street network bundle's graph replaces the global network.
        if params.street_network_bundle_id:
            edge_path, node_path = fetch_routing_network(
                self, params.street_network_bundle_id, temp_dir
            )
            analysis_params.edge_path = edge_path
            analysis_params.node_path = node_path

        # An uploaded PT bundle replaces the global network: its timetable and
        # its stop-to-street linkage, in the analysis layer's mode spelling.
        if params.routing_mode == HeatmapRoutingMode.pt and params.pt_network_bundle_id:
            apply_pt_bundle_override(
                self,
                analysis_params,
                params.pt_network_bundle_id,
                temp_dir,
                access_mode=analysis_params.access_mode.value,
                egress_mode=analysis_params.egress_mode.value,
            )

        tool = self.tool_class()
        try:
            results = tool.run(analysis_params)
            result_path, metadata = results[0]
            return Path(result_path), metadata
        finally:
            tool.cleanup()


class HeatmapGravityV2ToolRunner(HeatmapV2ToolRunner):
    """Per-formula entry point: pre-binds heatmap_type=gravity in the UI."""

    default_output_name = get_default_layer_name("heatmap_gravity", "en")


class HeatmapClosestAverageV2ToolRunner(HeatmapV2ToolRunner):
    """Per-formula entry point: pre-binds heatmap_type=closest_average."""

    default_output_name = get_default_layer_name("heatmap_closest_average", "en")


class HeatmapConnectivityV2ToolRunner(HeatmapV2ToolRunner):
    """Per-formula entry point: pre-binds heatmap_type=connectivity in the UI.
    The base runner handles reference-area export + dispatch."""

    default_output_name = get_default_layer_name("heatmap_connectivity", "en")


class Heatmap2SFCAV2ToolRunner(HeatmapV2ToolRunner):
    """Per-formula entry point: pre-binds heatmap_type=two_sfca in the UI.
    The base runner handles demand + supply export + dispatch."""

    default_output_name = get_default_layer_name("heatmap_2sfca", "en")


def main(params: HeatmapV2WindmillParams) -> dict:
    """Formula-agnostic Windmill entry point — kept for programmatic callers.

    Toolbox tiles use the per-formula shim modules
    (`heatmap_gravity_v2`, `heatmap_closest_average_v2`) so each tile
    pre-binds heatmap_type and hides the selector.
    """
    runner = HeatmapV2ToolRunner()
    runner.init_from_env()
    try:
        return runner.run(params)
    finally:
        runner.cleanup()
