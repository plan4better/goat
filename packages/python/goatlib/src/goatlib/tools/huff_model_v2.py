"""Huff Model V2 tool for Windmill.

Same Huff market-area analysis as v1, but the OD cost matrix is computed live
via the local C++ routing backend (street: reverse+sparse travel-cost matrix;
PT: compute_od_costs emission). Output geometry matches the opportunity
layer, with a probability value per facility.
"""

import logging
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import ConfigDict, Field, model_validator

from goatlib.analysis.accessibility.huff_model_v2 import HuffmodelV2Tool
from goatlib.analysis.pt_time import pt_anchor_unix_minutes
from goatlib.analysis.schemas.catchment_area import WEEKDAY_LABELS
from goatlib.analysis.schemas.catchment_area_v2 import (
    CostType,
    PTMode,
    RoutingMode,
    Weekday,
)
from goatlib.analysis.schemas.heatmap import HuffmodelV2Params
from goatlib.analysis.schemas.ui import (
    ui_field,
    ui_sections,
)
from goatlib.bundles.artifacts.street_network import fetch_routing_network
from goatlib.models.io import DatasetMetadata
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
from goatlib.tools.heatmap_v2 import (
    HM_ROUTING_MODE_ICONS,
    HM_ROUTING_MODE_LABELS,
    SECTION_DEMAND_HM,
    SECTION_OPPORTUNITIES_HM,
    SECTION_RESULT_HM,
    SECTION_ROUTING_HM,
    HeatmapRoutingMode,
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


class HuffModelV2ToolParams(ToolInputBase, HuffmodelV2Params):
    """Windmill-facing params. Paths are resolved from layer IDs in process();
    routing_mode/cost_type + PT arrival fields drive the live OD-matrix
    computation."""

    # Four sections mirroring the v2 heatmap tools (routing → configuration →
    # opportunities → result); configuration/opportunities/result reveal only
    # after a routing_mode is picked (depends_on lives on the section objects).
    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_ROUTING_HM,
            SECTION_CONFIGURATION,
            SECTION_DEMAND_HM,
            SECTION_OPPORTUNITIES_HM,
            SECTION_RESULT_HM,
        )
    )

    # Hidden path fields — resolved from layer IDs / derived in process().
    demand_path: str | None = Field(
        None, json_schema_extra=ui_field(section="demand", hidden=True)
    )  # type: ignore[assignment]
    opportunity_path: str | None = Field(
        None, json_schema_extra=ui_field(section="opportunities", hidden=True)
    )  # type: ignore[assignment]
    reference_area_path: str | None = Field(
        None, json_schema_extra=ui_field(section="configuration", hidden=True)
    )  # type: ignore[assignment]
    output_path: str | None = Field(
        None, json_schema_extra=ui_field(section="result", hidden=True)
    )  # type: ignore[assignment]
    # Derived in process(); hidden so the inherited analysis-layer fields don't
    # render. access/egress_max_time are the analysis names for the leg budgets
    # the form exposes as access/egress_max_cost.
    arrival_time: int | None = Field(
        None, json_schema_extra=ui_field(section="configuration", hidden=True)
    )
    access_max_time: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    egress_max_time: int = Field(
        default=DEFAULT_MAX_TIME_ACTIVE_MIN,
        json_schema_extra=ui_field(section="configuration", hidden=True),
    )
    transit_modes: list[str] | None = Field(
        default=None, json_schema_extra=ui_field(section="configuration", hidden=True)
    )
    max_transfers: int = Field(
        default=5, json_schema_extra=ui_field(section="configuration", hidden=True)
    )
    # Resolved from street_network_bundle_id and pt_network_bundle_id in
    # process(); hidden so the inherited analysis-layer fields don't render as
    # raw paths.
    edge_path: str | None = Field(
        None, json_schema_extra=ui_field(section="configuration", hidden=True)
    )
    node_path: str | None = Field(
        None, json_schema_extra=ui_field(section="configuration", hidden=True)
    )
    timetable_path: str | None = Field(
        None, json_schema_extra=ui_field(section="configuration", hidden=True)
    )
    access_table_path: str | None = Field(
        None, json_schema_extra=ui_field(section="configuration", hidden=True)
    )
    egress_table_path: str | None = Field(
        None, json_schema_extra=ui_field(section="configuration", hidden=True)
    )

    street_network_bundle_id: str | None = Field(
        default=None,
        description=(
            "Choose a custom Street Network bundle to use for routing. "
            "If unset, the default network will be used."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=26,
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

    pt_network_bundle_id: str | None = pt_network_bundle_field(27)

    # ---- Routing section --------------------------------------------------
    # Same enum + icons + labels as the other v2 tools, and required (no
    # default) so the user must pick a mode — no auto-selection.
    routing_mode: HeatmapRoutingMode = Field(
        ...,
        description="Transport mode for the analysis.",
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
    # PT transit-mode filter (mirrors heatmap/catchment v2). Visible only for PT.
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

    # ---- Configuration section (measure + budget + layers + advanced) -----
    # Travel cost type + limit selector — identical to catchment v2: a
    # cost_type toggle beside the single max_cost field, sharing the
    # "cost_config" inline group.
    cost_type: CostType = Field(
        default=CostType.time,
        description="Measure the model by travel time or travel distance.",
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
    # PT day + arrival time (non-advanced, PT only) — mirrors heatmap v2.
    pt_day: Weekday = Field(
        default=Weekday.weekday,
        description="Day type for the PT schedule.",
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
    # ---- Demand section ---------------------------------------------------
    demand_layer_id: str = Field(
        ...,
        description="Layer containing demand data (e.g., population).",
        json_schema_extra=ui_field(
            section="demand",
            field_order=1,
            widget="layer-selector",
            label_key="demand_path",
        ),
    )
    demand_layer_filter: dict[str, Any] | None = Field(
        None,
        json_schema_extra=ui_field(section="demand", field_order=2, hidden=True),
    )
    demand_field: str = Field(
        ...,
        description="Field from the demand layer with the demand value.",
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
    reference_area_layer_id: str = Field(
        ...,
        description="Reference area polygon layer.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=10,
            widget="layer-selector",
            widget_options={"geometry_types": ["Polygon", "MultiPolygon"]},
            label_key="reference_area_path",
        ),
    )
    reference_area_layer_filter: dict[str, Any] | None = Field(
        None,
        json_schema_extra=ui_field(
            section="configuration", field_order=11, hidden=True
        ),
    )
    # Advanced-options toggle (same widget as the v2 heatmaps) + the fields it
    # gates: Huff alpha/beta and the PT access/egress legs.
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
    attractiveness_param: float = Field(
        default=1.0,
        gt=0.0,
        description="Huff attractiveness exponent (alpha).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=16,
            label_key="attractiveness_param",
            visible_when={"show_advanced": True},
        ),
    )
    distance_decay: float = Field(
        default=2.0,
        gt=0.0,
        description="Huff distance-decay exponent (beta).",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=17,
            label_key="distance_decay",
            visible_when={"show_advanced": True},
        ),
    )
    # Mode-tied routing advanced option (street modes) — identical to heatmap v2.
    speed: float | None = Field(
        default=None,
        description=(
            "Travel speed in km/h. Leave blank to use the mode default "
            "(walking 5, bicycle 15, pedelec 23). Car uses per-road speed "
            "limits and ignores this setting."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=19,
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
    pt_max_transfers: int = Field(
        default=5,
        description="Maximum number of transit transfers.",
        json_schema_extra=ui_field(
            section="configuration",
            field_order=18,
            label_key="max_transfers",
            visible_when={"$and": [{"routing_mode": "pt"}, {"show_advanced": True}]},
            widget_options={"max_value_from": {"fields": [], "max": 5, "min": 0}},
        ),
    )
    access_mode: Literal["walk"] = Field(
        default="walk",
        description="Mode to reach transit stops (walk-only for PT).",
        json_schema_extra={
            **ui_field(
                section="configuration",
                field_order=20,
                label_key="access_mode",
                group_label="groups.access_leg",
                enum_icons=ACCESS_EGRESS_MODE_ICONS,
                enum_labels=ACCESS_EGRESS_MODE_LABELS,
                visible_when={
                    "$and": [{"routing_mode": "pt"}, {"show_advanced": True}]
                },
            ),
            "enum": ["walk"],
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
        description="Mode from transit stops to the opportunity (walk-only for PT).",
        json_schema_extra={
            **ui_field(
                section="configuration",
                field_order=23,
                label_key="pt_egress_mode",
                group_label="groups.egress_leg",
                enum_icons=ACCESS_EGRESS_MODE_ICONS,
                enum_labels=ACCESS_EGRESS_MODE_LABELS,
                visible_when={
                    "$and": [{"routing_mode": "pt"}, {"show_advanced": True}]
                },
            ),
            "enum": ["walk"],
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

    # ---- Opportunities section --------------------------------------------
    opportunity_layer_id: str = Field(
        ...,
        description="Layer containing opportunity data.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=1,
            widget="layer-selector",
            label_key="opportunity_path",
        ),
    )
    opportunity_layer_filter: dict[str, Any] | None = Field(
        None,
        json_schema_extra=ui_field(section="opportunities", field_order=2, hidden=True),
    )
    attractivity: str = Field(
        ...,
        description="Field from the opportunity layer with the attractivity value.",
        json_schema_extra=ui_field(
            section="opportunities",
            field_order=3,
            label_key="attractivity",
            widget="field-selector",
            widget_options={
                "source_layer": "opportunity_layer_id",
                "field_types": ["number"],
            },
            visible_when={"opportunity_layer_id": {"$ne": None}},
        ),
    )

    # ---- Result section ---------------------------------------------------
    result_layer_name: str | None = Field(
        default=get_default_layer_name("huff_model", "en"),
        description="Name for the Huff model result layer.",
        json_schema_extra=ui_field(
            section="result",
            field_order=1,
            label_key="result_layer_name",
            widget_options={
                "default_en": get_default_layer_name("huff_model", "en"),
                "default_de": get_default_layer_name("huff_model", "de"),
            },
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_budget(cls, data: Any) -> Any:
        return resolve_leg_names(resolve_budget_input(data))

    @model_validator(mode="after")
    def _check_budget(self: Self) -> Self:
        validate_cost_type(self.routing_mode, self.cost_type)
        validate_budget(self.routing_mode, self.cost_type, self.max_cost)
        validate_leg_budget(
            self.access_cost_type, self.access_max_cost, "access", lookup_table=True
        )
        validate_leg_budget(
            self.egress_cost_type, self.egress_max_cost, "egress", lookup_table=True
        )
        return self


class HuffModelV2ToolRunner(BaseToolRunner[HuffModelV2ToolParams]):
    """Huff Model V2 runner. Output geometry matches the opportunity layer."""

    tool_class = HuffmodelV2Tool
    output_geometry_type = None
    default_output_name = get_default_layer_name("huff_model", "en")

    def get_layer_properties(
        self: Self,
        params: HuffModelV2ToolParams,
        metadata: DatasetMetadata,
        table_info: dict[str, Any] | None = None,
        parquet_path: Path | str | None = None,
    ) -> dict[str, Any] | None:
        color_field = "probability"
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
            color_range_name="Teal",
        )

    def process(
        self: Self, params: HuffModelV2ToolParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        output_path = temp_dir / "output.parquet"

        demand_path = self.export_layer_to_parquet(
            layer_id=params.demand_layer_id,
            user_id=params.user_id,
            cql_filter=params.demand_layer_filter,
        )
        opportunity_path = self.export_layer_to_parquet(
            layer_id=params.opportunity_layer_id,
            user_id=params.user_id,
            cql_filter=params.opportunity_layer_filter,
        )
        reference_area_path = self.export_layer_to_parquet(
            layer_id=params.reference_area_layer_id,
            user_id=params.user_id,
            cql_filter=params.reference_area_layer_filter,
        )

        # UI-layer HeatmapRoutingMode → analysis-layer RoutingMode (same values).
        routing_mode = RoutingMode(params.routing_mode.value)

        arrival_time = None
        if params.routing_mode == HeatmapRoutingMode.pt:
            arrival_time = pt_anchor_unix_minutes(
                params.pt_day, params.pt_arrival_time, params.pt_date
            )

        # PT access/egress are walk-only (walk lookup table); the pt_* UI fields
        # map onto the analysis-layer access/egress/transfer fields.
        transit_modes = [m.value for m in params.pt_modes] if params.pt_modes else None

        analysis_params = HuffmodelV2Params(
            **params.model_dump(
                exclude={
                    "output_path",
                    "arrival_time",
                    "user_id",
                    "folder_id",
                    "project_id",
                    "output_name",
                    "routing_mode",
                    "demand_path",
                    "opportunity_path",
                    "reference_area_path",
                    "demand_layer_id",
                    "demand_layer_filter",
                    "opportunity_layer_id",
                    "opportunity_layer_filter",
                    "reference_area_layer_id",
                    "reference_area_layer_filter",
                    "result_layer_name",
                    "show_advanced",
                    "street_network_bundle_id",
                    "edge_path",
                    "node_path",
                    "pt_network_bundle_id",
                    "timetable_path",
                    "access_table_path",
                    "egress_table_path",
                    "transit_modes",
                    "max_transfers",
                    "pt_modes",
                    "pt_max_transfers",
                    "pt_day",
                    "pt_arrival_time",
                    # access/egress mode + cost_type are walk-only / time-only
                    # UI tokens; the analysis layer takes its own enums and
                    # names the budgets *_max_time (set explicitly below).
                    "access_mode",
                    "egress_mode",
                    "access_cost_type",
                    "egress_cost_type",
                    "access_max_cost",
                    "egress_max_cost",
                    "access_max_time",
                    "egress_max_time",
                }
            ),
            routing_mode=routing_mode,
            demand_path=str(demand_path),
            opportunity_path=str(opportunity_path),
            reference_area_path=str(reference_area_path),
            arrival_time=arrival_time,
            access_mode=RoutingMode.walking,
            egress_mode=RoutingMode.walking,
            access_max_time=params.access_max_cost,
            egress_max_time=params.egress_max_cost,
            max_transfers=params.pt_max_transfers,
            transit_modes=transit_modes,
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
            if metadata.geometry_type:
                self.output_geometry_type = metadata.geometry_type.lower()
            return Path(result_path), metadata
        finally:
            tool.cleanup()


def main(params: HuffModelV2ToolParams) -> dict:
    """Windmill entry point for the Huff Model V2 tool."""
    runner = HuffModelV2ToolRunner()
    runner.init_from_env()
    try:
        return runner.run(params)
    finally:
        runner.cleanup()
