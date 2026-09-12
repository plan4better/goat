"""Heatmap V2 schemas — for the local C++ routing backend.

Computes accessibility scores on-the-fly (no precomputed OD matrix) by
running per-origin shortest paths and applying a heatmap formula
(Gravity / ClosestAverage) against opportunity layers.

Mirrors the catchment_area_v2 schemas style; reuses the enums where the
underlying semantics are identical to keep cross-tool consistency.
"""

from enum import StrEnum
from typing import Self

from pydantic import Field, model_validator

from goatlib.analysis.schemas.catchment_area_v2 import (
    CostType,
    RoutingMode,
)
from goatlib.analysis.schemas.heatmap import OpportunityGravity
from goatlib.analysis.schemas.pt_network import PTNetworkOverride

# Validation bounds for the gravity sensitivity (β). V2 exposes this as a free
# numeric field (rather than the v1 fixed dropdown), bounded to the range the
# decay kernel is calibrated for.
SENSITIVITY_MIN = 1_000
SENSITIVITY_MAX = 1_000_000

# Validation bounds for the ClosestAverage k (number of nearest destinations to
# average). V2 exposes this as a free numeric input rather than the v1 fixed
# dropdown, bounded to a sensible range.
N_DESTINATIONS_MIN = 1
N_DESTINATIONS_MAX = 10

# Ceiling for a PT access/egress leg, in minutes. Must match the max_min the
# precomputed lookup tables were built with: the engine only filters rows a
# table already contains, so a higher limit here truncates silently rather than
# erroring. Lives in the analysis layer because that is what the tables feed;
# the tool layer re-exports it as the form's cap via `_routing_limits`.
MAX_LEG_TIME_LOOKUP_MIN = 30


class HeatmapType(StrEnum):
    gravity = "gravity"
    closest_average = "closest_average"
    connectivity = "connectivity"
    two_sfca = "two_sfca"


class GravityDecay(StrEnum):
    gaussian = "gaussian"
    exponential = "exponential"
    linear = "linear"
    power = "power"
    cumulative = "cumulative"


class TwoSFCAType(StrEnum):
    """2SFCA method variant (mirrors v1)."""

    twosfca = "twosfca"
    e2sfca = "e2sfca"
    m2sfca = "m2sfca"


# Analysis-layer opportunity schema. Relaxes the v1 per-opportunity max_cost
# (which is restricted to TravelTimeLimit = Literal[3..30] minutes) to a
# plain positive int so distance-mode budgets (meters, potentially up to
# 100000) pass validation too. Adds n_destinations so each layer can specify
# its own ClosestAverage k (mirrors v1's OpportunityClosestAverage). The unit
# of max_cost (minutes vs meters) is determined by HeatmapV2Params.cost_type
# at the parent level.
class OpportunityV2(OpportunityGravity):
    max_cost: int = Field(
        default=15,
        gt=0,
        le=100000,
        description=(
            "Travel budget for this opportunity layer — minutes when "
            "cost_type=time, meters when cost_type=distance."
        ),
    )
    # Override the v1 Literal dropdown with a free numeric value (validated
    # range). V2-only — leaves the v1 OpportunityGravity schema untouched.
    sensitivity: float = Field(
        default=300000.0,
        ge=SENSITIVITY_MIN,
        le=SENSITIVITY_MAX,
        description="Gravity decay sensitivity (β); larger = slower decay / wider reach.",
    )
    # Free numeric value (validated range), mirroring the sensitivity override
    # above — replaces the v1 Literal dropdown so the tool can expose it as a
    # number input.
    n_destinations: int = Field(
        default=1,
        ge=N_DESTINATIONS_MIN,
        le=N_DESTINATIONS_MAX,
        description="Number of closest destinations to average (closest_average only).",
    )


class HeatmapV2Params(PTNetworkOverride):
    """Parameters for HeatmapV2Tool (on-the-fly C++ routing).

    cost_type + max_cost define the budget:
    - time: max_cost is minutes (e.g. 15 = 15-min walking heatmap)
    - distance: max_cost is meters
    """

    # ---- Study area ----------------------------------------------------------
    # H3 resolution for origin tiling; if omitted the tool picks per mode.
    h3_resolution: int | None = Field(
        default=None,
        ge=5,
        le=12,
        description=(
            "H3 resolution for origin tiling. If None, picked per mode "
            "(walking=10, bicycle/pedelec=9, car=8, pt=9)."
        ),
    )

    # ---- Routing -------------------------------------------------------------
    routing_mode: RoutingMode = RoutingMode.walking
    cost_type: CostType = CostType.time
    max_cost: float = Field(
        default=15.0,
        gt=0.0,
        description="Budget: minutes (time) or meters (distance)",
    )
    speed: float | None = Field(
        default=None,
        ge=0.0,
        le=60.0,
        description="Travel speed in km/h. None for PT/Car (mode default).",
    )

    # ---- Public transport (routing_mode == pt) -------------------------------
    # Arrive-by reverse RAPTOR + precomputed per-mode access/egress lookup
    # tables. access/egress modes pick which table is loaded; their max times
    # are capped at the table's built max. Ignored for street modes.
    arrival_time: int | None = Field(
        default=None,
        description="Arrive-by time, unix minutes since epoch (PT only).",
    )
    access_mode: RoutingMode = Field(
        default=RoutingMode.walking,
        description="Access leg mode (home→boarding stop); selects its lookup table.",
    )
    egress_mode: RoutingMode = Field(
        default=RoutingMode.walking,
        description="Egress leg mode (alighting stop→opportunity); selects its lookup table.",
    )
    access_max_time: int = Field(
        default=15,
        ge=1,
        le=MAX_LEG_TIME_LOOKUP_MIN,
        description="Max access-leg minutes (≤ the access table's built max).",
    )
    egress_max_time: int = Field(
        default=15,
        ge=1,
        le=MAX_LEG_TIME_LOOKUP_MIN,
        description="Max egress-leg minutes (≤ the egress table's built max).",
    )
    transit_modes: list[str] | None = Field(
        default=None,
        description="Allowed PT classes (bus, tram, rail, …). None = all.",
    )
    max_transfers: int = Field(default=5, ge=0, le=5, description="Max PT transfers.")

    # ---- Heatmap formula -----------------------------------------------------
    heatmap_type: HeatmapType = HeatmapType.gravity
    decay: GravityDecay = GravityDecay.gaussian
    max_sensitivity: float = Field(
        default=1_000_000.0,
        gt=0.0,
        description="Gravity sensitivity normalization anchor (matches goatlib default).",
    )
    # ---- Opportunities (1-3 layers) ------------------------------------------
    # Required for gravity / closest_average.
    opportunities: list[OpportunityV2] | None = Field(
        default=None,
        max_length=3,
        description="1-3 opportunity layers; per-layer scores plus a total are emitted.",
    )

    # ---- Connectivity --------------------------------------------------------
    reference_area_path: str | None = Field(
        default=None,
        description=(
            "Path to a polygon parquet defining the reference AOI. "
            "Required when heatmap_type == connectivity; ignored otherwise."
        ),
    )

    # ---- 2SFCA ---------------------------------------------------------------
    two_sfca_type: TwoSFCAType = TwoSFCAType.twosfca
    demand_path: str | None = Field(
        default=None,
        description=(
            "Demand layer parquet (points or polygons with a demand value). "
            "Required when heatmap_type == two_sfca."
        ),
    )
    demand_field: str | None = Field(
        default=None,
        description=(
            "Field in the demand layer holding the demand value (e.g. "
            "population). Required when heatmap_type == two_sfca."
        ),
    )

    # ---- Output --------------------------------------------------------------
    output_path: str = Field(
        ...,
        description="Output GeoParquet path: (h3_index, geometry, "
        "<opp_name>_accessibility..., total_accessibility).",
    )

    # ---- Street network override --------------------------------------------
    # Point the engine at an uploaded street network bundle's graph instead of
    # the default global network. None uses the default.
    edge_path: str | None = Field(
        default=None,
        description="Path to an edges parquet to use for street routing",
    )
    node_path: str | None = Field(
        default=None,
        description="Path to a nodes parquet to use for street routing",
    )

    @model_validator(mode="after")
    def validate_network_override(self: Self) -> Self:
        # Half an override is worse than none: the engine would route over one
        # network's edges joined to the other's nodes, which silently yields a
        # near-empty result rather than failing.
        if bool(self.edge_path) != bool(self.node_path):
            raise ValueError(
                "edge_path and node_path must be set together — a routing graph "
                "is only coherent as a pair"
            )
        return self

    @model_validator(mode="after")
    def validate_inputs_by_type(self: Self) -> Self:
        if self.heatmap_type == HeatmapType.connectivity:
            if not self.reference_area_path:
                raise ValueError("connectivity requires reference_area_path.")
        else:
            if not self.opportunities:
                raise ValueError(
                    f"{self.heatmap_type.value} requires at least one "
                    "opportunity layer."
                )
        if self.heatmap_type == HeatmapType.two_sfca:
            if not self.demand_path or not self.demand_field:
                raise ValueError("two_sfca requires demand_path and demand_field.")
        return self
