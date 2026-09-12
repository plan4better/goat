"""Travel Cost Matrix schemas — for the local C++ routing backend.

Computes many-to-many travel costs between origin and destination points.
"""

from enum import StrEnum
from typing import Self

from pydantic import BaseModel, Field, model_validator


class RoutingMode(StrEnum):
    walking = "walking"
    bicycle = "bicycle"
    pedelec = "pedelec"
    car = "car"
    pt = "pt"
    flight_distance = "flight_distance"


class CostType(StrEnum):
    time = "time"
    distance = "distance"


class AccessEgressMode(StrEnum):
    walk = "walk"
    bicycle = "bicycle"
    pedelec = "pedelec"
    car = "car"


class PTMode(StrEnum):
    bus = "bus"
    tram = "tram"
    rail = "rail"
    subway = "subway"
    ferry = "ferry"
    cable_car = "cable_car"
    gondola = "gondola"
    funicular = "funicular"


class Weekday(StrEnum):
    weekday = "weekday"
    saturday = "saturday"
    sunday = "sunday"


class PTTimeWindow(BaseModel):
    weekday: Weekday = Weekday.weekday
    # A real date, for a timetable the weekday anchors do not fall inside — an
    # uploaded bundle's. Wins over `weekday` when set; see
    # `goatlib.analysis.pt_time`.
    on_date: str | None = Field(
        default=None, description="Date to route on (YYYY-MM-DD)"
    )
    from_time: int = Field(..., description="Start time in seconds from midnight")
    to_time: int = Field(..., description="End time in seconds from midnight")


class TravelCostMatrixParams(BaseModel):
    """Parameters for TravelCostMatrixTool (local C++ routing backend).

    Computes travel cost from every origin to every destination.
    Results: a matrix table (origin_id, destination_id, cost) and
    destination points annotated with their minimum cost from any origin.
    """

    # Origin/destination coordinates in WGS84
    origin_latitude: list[float]
    origin_longitude: list[float]
    origin_id: list[str] | None = None
    destination_latitude: list[float]
    destination_longitude: list[float]
    destination_id: list[str] | None = None

    # Routing
    routing_mode: RoutingMode = RoutingMode.walking
    cost_type: CostType = CostType.time
    max_cost: float | None = Field(
        default=None,
        gt=0,
        description="Optional Dijkstra cutoff: minutes (time) or meters "
        "(distance). None means unbounded — every reachable O-D "
        "pair gets a cost. The C++ matrix loader sizes its own "
        "network from the OD bbox, independent of this value.",
    )
    speed: float | None = Field(
        default=None,
        ge=0.0,
        le=60.0,
        description="Travel speed in km/h (time cost type only). None when the "
        "mode doesn't use a user-supplied speed (PT uses "
        "access/egress speeds; Car uses per-edge OSM maxspeed).",
    )

    # PT settings
    transit_modes: list[PTMode] | None = None
    time_window: PTTimeWindow | None = None
    max_transfers: int = Field(default=5, ge=0, le=5)
    access_mode: AccessEgressMode = AccessEgressMode.walk
    egress_mode: AccessEgressMode = AccessEgressMode.walk
    access_cost_type: CostType = CostType.time
    egress_cost_type: CostType = CostType.time
    access_max_cost: float = Field(
        default=15.0,
        ge=0.0,
        description="Access leg budget: minutes (time) or meters (distance). 0 = default.",
    )
    egress_max_cost: float = Field(
        default=15.0,
        ge=0.0,
        description="Egress leg budget: minutes (time) or meters (distance). 0 = default.",
    )
    access_speed: float | None = Field(
        default=None,
        ge=0.0,
        description="Access leg speed in km/h. None for car access.",
    )
    egress_speed: float | None = Field(
        default=None,
        ge=0.0,
        description="Egress leg speed in km/h. None for car egress.",
    )

    # Output
    output_path: str = Field(..., description="Path for the matrix parquet output.")

    # ---- PT network override ------------------------------------------------
    # Point the engine at a PT bundle's timetable instead of the default global
    # network. None uses the default.
    timetable_path: str | None = Field(
        default=None,
        description="Path to a nigiri .bin timetable to use for PT routing",
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
    def validate_coordinates(self: Self) -> Self:
        if len(self.origin_latitude) != len(self.origin_longitude):
            raise ValueError("Origin latitude and longitude must have the same length")
        if len(self.destination_latitude) != len(self.destination_longitude):
            raise ValueError(
                "Destination latitude and longitude must have the same length"
            )
        if not self.origin_latitude:
            raise ValueError("At least one origin is required")
        if not self.destination_latitude:
            raise ValueError("At least one destination is required")
        return self

    @model_validator(mode="after")
    def validate_pt_settings(self: Self) -> Self:
        if self.routing_mode == RoutingMode.pt:
            if not self.transit_modes:
                raise ValueError("transit_modes is required for PT mode")
            if not self.time_window:
                raise ValueError("time_window is required for PT mode")
        return self
