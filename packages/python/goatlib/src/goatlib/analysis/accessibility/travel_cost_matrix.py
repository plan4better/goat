"""Travel Cost Matrix — local routing backend.

Computes many-to-many travel costs between origin and destination points
via the C++ routing package. Supports all transport modes including PT.
"""

import importlib
import logging
import math
import time
from pathlib import Path
from typing import Any, Self

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.pt_time import pt_anchor_unix_minutes
from goatlib.analysis.schemas.travel_cost_matrix import (
    AccessEgressMode,
    CostType,
    RoutingMode,
    TravelCostMatrixParams,
)
from goatlib.config.settings import settings
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)

WEB_MERCATOR_RADIUS_M = 6378137.0

# Per-leg speed fallback when the user leaves the advanced speed blank, so the
# C++ access/egress validation always has a positive speed. Car is 0: its cost
# comes from per-edge OSM maxspeed, not a user speed.
_PT_LEG_DEFAULT_SPEED_KMH: dict[AccessEgressMode, float] = {
    AccessEgressMode.walk: 5.0,
    AccessEgressMode.bicycle: 15.0,
    AccessEgressMode.pedelec: 23.0,
    AccessEgressMode.car: 0.0,
}


class TravelCostMatrixTool(AnalysisTool):
    """Compute many-to-many travel costs via the local C++ routing package.

    Supports walking, bicycle, pedelec, car, and public transport.

    Example:
        tool = TravelCostMatrixTool()
        result = tool.run(TravelCostMatrixParams(
            origin_latitude=[48.137], origin_longitude=[11.576],
            destination_latitude=[48.14, 48.15], destination_longitude=[11.58, 11.59],
            routing_mode="walking", cost_type="time", max_cost=30,
            output_path="output/matrix.parquet",
        ))
    """

    def __init__(self: Self) -> None:
        super().__init__()
        self._edge_dir = settings.routing.street_network_edges_base_path
        self._node_dir = settings.routing.street_network_nodes_base_path
        self._timetable_path = settings.routing.pt_network_base_path

    @staticmethod
    def _get_routing_module() -> Any:
        try:
            return importlib.import_module("routing")
        except Exception as exc:
            raise RuntimeError(
                "Local routing package is not available. "
                "Install the 'routing' package (packages/cpp/routing)."
            ) from exc

    @staticmethod
    def _to_web_mercator(lon: float, lat: float) -> tuple[float, float]:
        x = WEB_MERCATOR_RADIUS_M * math.radians(lon)
        y = WEB_MERCATOR_RADIUS_M * math.log(
            math.tan(math.pi / 4.0 + math.radians(lat) / 2.0)
        )
        return x, y

    @staticmethod
    def _pt_departure_unix_minutes(params: TravelCostMatrixParams) -> int:
        """When the sweep starts, as the engine wants it: unix minutes UTC."""
        window = params.time_window
        if window is None:
            return pt_anchor_unix_minutes()
        return pt_anchor_unix_minutes(window.weekday, window.from_time, window.on_date)

    def _build_matrix_config(
        self: Self,
        params: TravelCostMatrixParams,
    ) -> Any:
        routing = self._get_routing_module()

        origins = [
            routing.Point3857(*self._to_web_mercator(lon, lat))
            for lat, lon in zip(params.origin_latitude, params.origin_longitude)
        ]
        destinations = [
            routing.Point3857(*self._to_web_mercator(lon, lat))
            for lat, lon in zip(
                params.destination_latitude, params.destination_longitude
            )
        ]

        mode_map = {
            RoutingMode.walking: routing.RoutingMode.Walking,
            RoutingMode.bicycle: routing.RoutingMode.Bicycle,
            RoutingMode.pedelec: routing.RoutingMode.Pedelec,
            RoutingMode.car: routing.RoutingMode.Car,
            RoutingMode.pt: routing.RoutingMode.PublicTransport,
        }
        access_mode_map = {
            AccessEgressMode.walk: routing.RoutingMode.Walking,
            AccessEgressMode.bicycle: routing.RoutingMode.Bicycle,
            AccessEgressMode.pedelec: routing.RoutingMode.Pedelec,
            AccessEgressMode.car: routing.RoutingMode.Car,
        }

        cfg = routing.MatrixConfig()
        cfg.origins = origins
        cfg.destinations = destinations
        if params.origin_id:
            cfg.origin_ids = [str(i) for i in params.origin_id]
        if params.destination_id:
            cfg.destination_ids = [str(i) for i in params.destination_id]
        cfg.mode = mode_map[params.routing_mode]
        cfg.cost_type = (
            routing.CostType.Distance
            if params.cost_type == CostType.distance
            else routing.CostType.Time
        )
        # max_cost is the Dijkstra cutoff, not a network-loading bound.
        # None means "no user-supplied limit" — pass +inf so the engine
        # computes every reachable O-D pair within the bbox-loaded network.
        cfg.max_cost = params.max_cost if params.max_cost is not None else math.inf
        # C++ uses 0.0 as the "not set" sentinel; for routing modes that don't
        # take a user-supplied speed (PT/Car/flight_distance), params.speed is None.
        cfg.speed_km_h = params.speed if params.speed is not None else 0.0
        # An uploaded street network bundle's graph overrides the global network.
        cfg.edge_dir = str(params.edge_path or self._edge_dir)
        cfg.node_dir = str(params.node_path or self._node_dir)
        cfg.output_path = params.output_path

        if params.routing_mode == RoutingMode.pt:
            # A selected PT bundle's timetable overrides the global network.
            cfg.timetable_path = str(params.timetable_path or self._timetable_path)
            cfg.departure_time = self._pt_departure_unix_minutes(params)
            cfg.max_transfers = params.max_transfers
            cfg.access_mode = access_mode_map[params.access_mode]
            cfg.egress_mode = access_mode_map[params.egress_mode]
            cfg.access_cost_type = (
                routing.CostType.Distance
                if params.access_cost_type == CostType.distance
                else routing.CostType.Time
            )
            cfg.egress_cost_type = (
                routing.CostType.Distance
                if params.egress_cost_type == CostType.distance
                else routing.CostType.Time
            )
            cfg.access_max_cost = params.access_max_cost
            cfg.egress_max_cost = params.egress_max_cost
            # Fall back to mode-specific default when user didn't set the per-leg
            # speed (e.g. advanced collapsed). Car: no user speed → 0.
            cfg.access_speed_km_h = (
                params.access_speed
                if params.access_speed is not None
                else _PT_LEG_DEFAULT_SPEED_KMH.get(params.access_mode, 0.0)
            )
            cfg.egress_speed_km_h = (
                params.egress_speed
                if params.egress_speed is not None
                else _PT_LEG_DEFAULT_SPEED_KMH.get(params.egress_mode, 0.0)
            )

            if params.transit_modes:
                cfg.transit_modes = [m.value for m in params.transit_modes]

            if params.time_window:
                from_sec = params.time_window.from_time
                to_sec = params.time_window.to_time
                window_min = max(0, (to_sec - from_sec) // 60)
                if window_min > 0:
                    cfg.departure_window = window_min

        return cfg

    def _run_implementation(
        self: Self, params: TravelCostMatrixParams
    ) -> list[tuple[Path, DatasetMetadata]]:
        routing = self._get_routing_module()
        cfg = self._build_matrix_config(params)

        path = Path(params.output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        t0 = time.perf_counter()
        routing.compute_travel_cost_matrix(cfg)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        logger.info("compute_travel_cost_matrix total_ms=%.1f", elapsed_ms)

        metadata = DatasetMetadata(
            path=str(path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Point",
            geometry_column="geometry",
        )
        return [(path, metadata)]
