"""Catchment Area V2 — local routing backend.

Computes catchment areas for all transport modes via the C++ routing package
(walking, bicycle, pedelec, car, public transport). No external HTTP services.
"""

import logging
import math
import time
from pathlib import Path
from typing import Any, Self

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.pt_time import pt_anchor_unix_minutes
from goatlib.analysis.schemas.catchment_area_v2 import (
    AccessEgressMode,
    CatchmentAreaV2Params,
    CatchmentType,
    CostType,
    OutputFormat,
    RoutingMode,
    ShapeStyle,
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


class CatchmentAreaToolV2(AnalysisTool):
    """Compute catchment areas via the local C++ routing package.

    All modes (walking, bicycle, pedelec, car, public transport) use the same
    local routing backend. No external HTTP calls.

    Example:
        tool = CatchmentAreaToolV2()
        result = tool.run(CatchmentAreaV2Params(
            latitude=48.137, longitude=11.576,
            routing_mode="walking", cost_type="time", max_cost=15,
            steps=3, output_path="output/catchment.parquet",
        ))
    """

    def __init__(self: Self) -> None:
        super().__init__()
        self._edge_dir = settings.routing.street_network_edges_base_path
        self._node_dir = settings.routing.street_network_nodes_base_path
        self._timetable_path = settings.routing.pt_network_base_path

    @staticmethod
    def _to_web_mercator(lon: float, lat: float) -> tuple[float, float]:
        x = WEB_MERCATOR_RADIUS_M * math.radians(lon)
        y = WEB_MERCATOR_RADIUS_M * math.log(
            math.tan(math.pi / 4.0 + math.radians(lat) / 2.0)
        )
        return x, y

    @staticmethod
    def _pt_departure_unix_minutes(params: CatchmentAreaV2Params) -> int:
        """When the sweep starts, as the engine wants it: unix minutes UTC."""
        window = params.time_window
        if window is None:
            return pt_anchor_unix_minutes()
        return pt_anchor_unix_minutes(window.weekday, window.from_time, window.on_date)

    def _build_request_config(
        self: Self,
        params: CatchmentAreaV2Params,
    ) -> Any:
        routing = self._get_routing_module()

        lat_list = (
            [params.latitude]
            if isinstance(params.latitude, (int, float))
            else list(params.latitude)
        )
        lon_list = (
            [params.longitude]
            if isinstance(params.longitude, (int, float))
            else list(params.longitude)
        )
        if len(lat_list) != len(lon_list):
            raise ValueError("Latitude and longitude must have the same length")

        mode_map = {
            RoutingMode.walking: routing.RoutingMode.Walking,
            RoutingMode.bicycle: routing.RoutingMode.Bicycle,
            RoutingMode.pedelec: routing.RoutingMode.Pedelec,
            RoutingMode.car: routing.RoutingMode.Car,
            RoutingMode.pt: routing.RoutingMode.PublicTransport,
        }
        catchment_map = {
            CatchmentType.polygon: routing.CatchmentType.Polygon,
            CatchmentType.network: routing.CatchmentType.Network,
            CatchmentType.hexagonal_grid: routing.CatchmentType.HexagonalGrid,
            CatchmentType.point_grid: routing.CatchmentType.PointGrid,
        }
        access_mode_map = {
            AccessEgressMode.walk: routing.RoutingMode.Walking,
            AccessEgressMode.bicycle: routing.RoutingMode.Bicycle,
            AccessEgressMode.pedelec: routing.RoutingMode.Pedelec,
            AccessEgressMode.car: routing.RoutingMode.Car,
        }

        cfg = routing.RequestConfig()
        cfg.starting_points = [
            routing.Point3857(*self._to_web_mercator(lon, lat))
            for lat, lon in zip(lat_list, lon_list)
        ]
        cfg.mode = mode_map[params.routing_mode]
        cfg.cost_type = (
            routing.CostType.Distance
            if params.cost_type == CostType.distance
            else routing.CostType.Time
        )
        cfg.max_cost = params.max_cost
        cfg.steps = params.steps
        # C++ uses 0.0 as the "not set" sentinel; for routing modes that don't
        # take a user-supplied speed (PT/Car), params.speed is None.
        cfg.speed_km_h = params.speed if params.speed is not None else 0.0
        # A bundle's graph replaces the global network when supplied.
        cfg.edge_dir = str(params.edge_path or self._edge_dir)
        cfg.node_dir = str(params.node_path or self._node_dir)
        cfg.output_path = params.output_path
        cfg.catchment_type = catchment_map[params.catchment_type]
        cfg.output_format = (
            routing.OutputFormat.GeoJSON
            if params.output_format == OutputFormat.geojson
            else routing.OutputFormat.Parquet
        )
        cfg.polygon_difference = params.polygon_difference
        cfg.shape_style = (
            routing.ShapeStyle.Separated
            if params.shape_style == ShapeStyle.separated
            else routing.ShapeStyle.Combined
        )

        if params.cutoffs:
            cfg.cutoffs = list(params.cutoffs)

        # PT settings
        if params.routing_mode == RoutingMode.pt:
            # A bundle's routing graph overrides the global default network.
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
            # If the user didn't set the per-leg speed (e.g. left advanced
            # collapsed), fall back to a mode-specific default so the C++
            # access/egress validation has a positive speed to work with.
            # Car has no user-facing speed → 0 (C++ ignores user speed for car
            # routing cost; per-edge OSM maxspeed governs).
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

        # PointGrid settings
        if params.grid_points_path:
            cfg.grid_points_path = params.grid_points_path
        if params.grid_snap_distance > 0:
            cfg.grid_snap_distance = params.grid_snap_distance

        return cfg

    def _run_implementation(
        self: Self, params: CatchmentAreaV2Params
    ) -> list[tuple[Path, DatasetMetadata]]:
        routing = self._get_routing_module()
        cfg = self._build_request_config(params)

        path = Path(params.output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        cfg.output_path = str(path)

        t0 = time.perf_counter()
        result = routing.compute_catchment(cfg)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        logger.info("compute_catchment total_ms=%.1f", elapsed_ms)

        if params.output_format == OutputFormat.geojson:
            path.write_text(result, encoding="utf-8")

        metadata = DatasetMetadata(
            path=str(path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Polygon",
            geometry_column="geometry",
        )
        return [(path, metadata)]
