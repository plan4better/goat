"""Heatmap V2 — local routing backend.

Computes per-cell accessibility scores on-the-fly via the C++ routing
package's `compute_heatmap`. No precomputed OD matrix; no Python-side
origin grid — the C++ reverse-Dijkstra discovers H3 cells reachable
from the opportunity points and writes one (h3_index, score) row per
reached cell.

For each request:
  1. Extract opportunity points + weights from each opportunity layer.
  2. For each opportunity layer, call routing.compute_heatmap once and
     load the resulting (h3_index, score) parquet into a temp table.
  3. FULL OUTER JOIN the per-layer score tables on h3_index, COALESCE
     missing layer scores to 0, sum into `total_accessibility`.
  4. Write GeoParquet (`h3_index`, `<layer>_accessibility`...,
     `total_accessibility`, `geometry`).
"""

from __future__ import annotations

import logging
import tempfile
import time
from pathlib import Path
from typing import Any, Self

from goatlib.analysis.accessibility.base import HeatmapToolBase, sanitize_sql_name
from goatlib.analysis.schemas.catchment_area_v2 import (
    CostType,
    RoutingMode,
)
from goatlib.analysis.schemas.heatmap import PotentialExpression, PotentialType
from goatlib.analysis.schemas.heatmap_v2 import (
    GravityDecay,
    HeatmapType,
    HeatmapV2Params,
    OpportunityV2,
    TwoSFCAType,
)
from goatlib.config.settings import settings
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


# Per-mode H3 resolutions for AOI rasterization (connectivity) and
# reference-area clipping. Mirrors the C++ `output::hex_resolution_for_mode`
# helper so input-side cells and C++-emitted output cells live at the same
# resolution.
DEFAULT_H3_RESOLUTION: dict[RoutingMode, int] = {
    RoutingMode.walking: 10,
    RoutingMode.bicycle: 9,
    RoutingMode.pedelec: 9,
    RoutingMode.car: 8,
    RoutingMode.pt: 9,
}

# PT access/egress lookup tables are precomputed per mode at a fixed H3
# resolution, named `accessegress_{mode}_r{res}` and stored beside the nigiri
# timetable (gtfs.bin). The mode segment is the RoutingMode value verbatim. The
# runtime access/egress max-time params filter rows from these tables and cannot
# exceed the budget a table was built with — that budget belongs in the table's
# metadata, not its name.
_PT_ACCESSEGRESS_RES = 9

# Connectivity rasterizes the reference area to H3 cells; each cell is a per-cell
# routing origin. Rasterization uses the fixed per-mode DEFAULT_H3_RESOLUTION
# (same as every other heatmap type), so the output resolution is deterministic
# and comparable across reference areas — a requirement for an analysis tool.
#
# Hard cap on rasterised AOI cells for connectivity (all modes). Higher than the
# generic opportunity cap because each cell is a per-cell routing origin
# (reverse-RAPTOR for PT, Dijkstra for street) — CPU-bound, not the temp-disk-
# bound sampled-opportunity workload the generic cap guards against.
_CONNECTIVITY_MAX_CELLS = 50_000
# Modes a PT leg can be made in — each has its own precomputed table. PT itself
# is never an access/egress mode.
_PT_ACCESSEGRESS_MODES = frozenset(
    {
        RoutingMode.walking,
        RoutingMode.bicycle,
        RoutingMode.pedelec,
        RoutingMode.car,
    }
)

# Hard cap on total opportunity SEED points across all layers (gravity /
# closest_average / two_sfca). Seeds are the routing sources — a polygon
# opportunity rasterizes to many seeds — so DuckDB temp-disk usage scales with
# the combined seed count, which is what this bounds. Connectivity has its own
# AOI-cell cap.
MAX_SEED_POINTS_TOTAL = 50_000

# Mode default speeds (km/h) used when the user doesn't supply one. The
# UI's "speed" field lives under show_advanced=True so most form
# submissions arrive with speed=None — feeding 0.0 to the C++ routing
# code causes edge costs to be computed via division by zero, which then
# get filtered out by the adjacency build and origins end up reaching
# almost no nodes (scores collapse to zero).
_MODE_SPEED_DEFAULTS: dict[RoutingMode, float] = {
    RoutingMode.walking: 5.0,
    RoutingMode.bicycle: 15.0,
    RoutingMode.pedelec: 23.0,
    # Car uses per-edge OSM maxspeed (C++ ignores cfg.speed_km_h).
    RoutingMode.car: 0.0,
}


class HeatmapV2Tool(HeatmapToolBase):
    """Compute accessibility heatmaps via the local C++ routing package."""

    def __init__(self: Self) -> None:
        super().__init__()
        self._edge_dir = settings.routing.street_network_edges_base_path
        self._node_dir = settings.routing.street_network_nodes_base_path
        # PT: the nigiri timetable and the per-mode access/egress lookup
        # tables live in the same directory (gtfs.bin's parent).
        self._timetable_path = str(settings.routing.pt_network_base_path)
        self._pt_network_dir = str(Path(self._timetable_path).parent)

    def _accessegress_table_path(self: Self, mode: RoutingMode) -> str:
        """Resolve the precomputed access/egress lookup parquet for a mode."""
        if mode not in _PT_ACCESSEGRESS_MODES:
            raise ValueError(f"Unsupported PT access/egress mode: {mode}")
        fname = f"accessegress_{mode.value}_r{_PT_ACCESSEGRESS_RES}.parquet"
        return str(Path(self._pt_network_dir) / fname)

    # --------------------------------------------------------- opportunities

    def _opportunity_label(self: Self, opp: OpportunityV2, idx: int) -> str:
        """SQL-safe column name for one opportunity layer's score —
        matches v1's `sanitize_sql_name`: unicode-normalized, lowercase,
        non-alphanumerics collapsed to single underscores."""
        raw = opp.name or Path(opp.input_path).stem
        return sanitize_sql_name(raw, fallback_idx=idx)

    def _load_opportunity_points(
        self: Self, opp: OpportunityV2, idx: int, res: int
    ) -> list[tuple[list[tuple[float, float]], float, float, float]]:
        """One opportunity per feature: (seeds_xy_3857, weight, rep_x, rep_y).
        Points → each point a seed; polygons → covered H3 cell centroids as
        seeds; one full weight per feature. Input parquet is pre-filtered.
        """
        meta, opp_table = self.import_input(
            opp.input_path, table_name=f"opp_input_{idx}"
        )
        geom_col = meta.geometry_column or "geom"
        geom_type = (meta.geometry_type or "").lower()
        crs = meta.crs
        if crs is None:
            raise ValueError(f"Opportunity layer {opp.input_path} has no CRS")
        source_crs = crs.to_string()
        weight_expr = self._weight_expression(opp, geom_col, source_crs, geom_type)

        def _to_3857(g: str) -> str:
            return (
                f"ST_Transform(ST_Force2D({g}), "
                f"'{source_crs}', 'EPSG:3857', always_xy:=true)"
            )

        if "polygon" in geom_type:
            # Rasterize to H3 cells; project cell centroids to EPSG:3857.
            centroid_3857 = _to_3857(f"ST_Centroid({geom_col})")
            geom_4326 = (
                f"ST_Transform(ST_Force2D({geom_col}), "
                f"'{source_crs}', 'EPSG:4326', always_xy:=true)"
            )
            rows = self.con.execute(f"""
                WITH feats AS (
                    SELECT ROW_NUMBER() OVER () AS fid,
                           ({weight_expr})::DOUBLE AS weight,
                           ST_X({centroid_3857}) AS rx,
                           ST_Y({centroid_3857}) AS ry,
                           {geom_4326} AS geom4326
                    FROM {opp_table} WHERE {geom_col} IS NOT NULL
                ),
                parts AS (
                    SELECT fid, weight, rx, ry,
                           (UNNEST(ST_Dump(geom4326))).geom AS g FROM feats
                ),
                cells AS (
                    SELECT fid, weight, rx, ry,
                           UNNEST(h3_polygon_wkt_to_cells_experimental(
                             ST_AsText(g), {res}, 'CONTAINMENT_OVERLAPPING')) AS cell
                    FROM parts
                ),
                uniq AS (SELECT DISTINCT fid, weight, rx, ry, cell FROM cells),
                cell_pts AS (
                    SELECT fid, weight, rx, ry, h3_cell_to_latlng(cell) AS ll
                    FROM uniq
                )
                SELECT ANY_VALUE(weight) AS weight,
                       ANY_VALUE(rx) AS rx, ANY_VALUE(ry) AS ry,
                       list(ll[2] * 20037508.342789244 / 180.0) AS sx,
                       list(LN(TAN((90.0 + ll[1]) * PI() / 360.0))
                            * 20037508.342789244 / PI()) AS sy
                FROM cell_pts GROUP BY fid
            """).fetchall()
        else:
            rows = self.con.execute(f"""
                WITH feats AS (
                    SELECT ROW_NUMBER() OVER () AS fid,
                           ({weight_expr})::DOUBLE AS weight,
                           {_to_3857(geom_col)} AS geom3857
                    FROM {opp_table} WHERE {geom_col} IS NOT NULL
                ),
                pts AS (
                    SELECT fid, weight, (UNNEST(ST_Dump(geom3857))).geom AS p
                    FROM feats
                )
                SELECT ANY_VALUE(weight) AS weight,
                       AVG(ST_X(p)) AS rx, AVG(ST_Y(p)) AS ry,
                       list(ST_X(p)) AS sx, list(ST_Y(p)) AS sy
                FROM pts GROUP BY fid
            """).fetchall()

        groups: list[tuple[list[tuple[float, float]], float, float, float]] = []
        for weight, rx, ry, sx, sy in rows:
            seeds = [(float(x), float(y)) for x, y in zip(sx, sy)]
            if not seeds:
                continue
            groups.append((seeds, float(weight), float(rx), float(ry)))

        logger.info(
            "Loaded %d opportunities (%d seeds) from %s (weight: %s)",
            len(groups),
            sum(len(g[0]) for g in groups),
            opp.input_path,
            opp.potential_type.value,
        )
        return groups

    @staticmethod
    def _weight_expression(
        opp: OpportunityV2, geom_col: str, source_crs: str, geom_type: str
    ) -> str:
        """SQL expression yielding per-row weight."""
        if opp.potential_type == PotentialType.constant:
            return f"{opp.potential_constant or 1.0}"
        if opp.potential_type == PotentialType.field:
            if not opp.potential_field:
                raise ValueError("potential_field required when potential_type=field")
            return f"COALESCE({opp.potential_field}, 0)"
        if opp.potential_type == PotentialType.expression:
            if "polygon" not in geom_type:
                raise ValueError(
                    "potential_type=expression requires a polygon layer "
                    f"(got geometry_type={geom_type})."
                )
            metric_geom = (
                f"ST_Transform(ST_Force2D({geom_col}), "
                f"'{source_crs}', 'EPSG:3857', always_xy:=true)"
            )
            if opp.potential_expression == PotentialExpression.area:
                return f"ST_Area({metric_geom})"
            if opp.potential_expression == PotentialExpression.perimeter:
                return f"ST_Perimeter({metric_geom})"
            raise ValueError(
                f"Unsupported potential_expression: {opp.potential_expression}"
            )
        raise ValueError(f"Unknown potential_type: {opp.potential_type}")

    # ------------------------------------------------------- C++ heatmap call

    def _build_heatmap_cfg(
        self: Self,
        params: HeatmapV2Params,
        opp_groups: list[tuple[list[tuple[float, float]], float, float, float]],
        sensitivity: float,
        output_path: str,
        max_cost: float | None = None,
        closest_k: int = 1,
        demand_path: str | None = None,
    ) -> Any:
        """Build a routing.HeatmapConfig for one opportunity layer.

        `max_cost` overrides the request-level value so each opportunity
        layer can use its own travel-time budget (matches the matrix-based
        gravity tool's per-layer `max_cost` semantics).
        """
        routing = self._get_routing_module()

        routing_mode_map = {
            RoutingMode.walking: routing.RoutingMode.Walking,
            RoutingMode.bicycle: routing.RoutingMode.Bicycle,
            RoutingMode.pedelec: routing.RoutingMode.Pedelec,
            RoutingMode.car: routing.RoutingMode.Car,
            RoutingMode.pt: routing.RoutingMode.PublicTransport,
        }
        htype_map = {
            HeatmapType.gravity: routing.HeatmapType.Gravity,
            HeatmapType.closest_average: routing.HeatmapType.ClosestAverage,
            HeatmapType.connectivity: routing.HeatmapType.Connectivity,
            HeatmapType.two_sfca: routing.HeatmapType.TwoSFCA,
        }
        decay_map = {
            GravityDecay.gaussian: routing.GravityDecay.Gaussian,
            GravityDecay.exponential: routing.GravityDecay.Exponential,
            GravityDecay.linear: routing.GravityDecay.Linear,
            GravityDecay.power: routing.GravityDecay.Power,
            GravityDecay.cumulative: routing.GravityDecay.Cumulative,
        }

        cfg = routing.HeatmapConfig()
        cfg.mode = routing_mode_map[params.routing_mode]
        cfg.cost_type = (
            routing.CostType.Distance
            if params.cost_type == CostType.distance
            else routing.CostType.Time
        )
        cfg.max_cost = (
            float(max_cost) if max_cost is not None else float(params.max_cost)
        )
        cfg.speed_km_h = (
            params.speed
            if params.speed is not None
            else _MODE_SPEED_DEFAULTS.get(params.routing_mode, 0.0)
        )
        # An uploaded street network bundle's graph overrides the global network.
        cfg.edge_dir = str(params.edge_path or self._edge_dir)
        cfg.node_dir = str(params.node_path or self._node_dir)
        cfg.opportunities = [
            routing.Opportunity(
                [routing.Point3857(sx, sy) for (sx, sy) in seeds],
                w,
                routing.Point3857(rx, ry),
            )
            for (seeds, w, rx, ry) in opp_groups
        ]
        cfg.heatmap_type = htype_map[params.heatmap_type]
        cfg.decay = decay_map[params.decay]
        cfg.sensitivity = sensitivity
        cfg.max_sensitivity = params.max_sensitivity
        cfg.closest_k = closest_k
        cfg.output_path = output_path

        if params.heatmap_type == HeatmapType.two_sfca:
            cfg.two_sfca_type = {
                TwoSFCAType.twosfca: routing.TwoSFCAType.Standard,
                TwoSFCAType.e2sfca: routing.TwoSFCAType.E2SFCA,
                TwoSFCAType.m2sfca: routing.TwoSFCAType.M2SFCA,
            }[params.two_sfca_type]
            if demand_path is not None:
                cfg.demand_path = demand_path

        # PT: arrive-by reverse RAPTOR + precomputed access/egress lookup
        # tables. max_cost here is the total journey budget (minutes). The
        # timetable and per-mode lookup tables are resolved from settings
        # (mirrors how catchment v2 resolves its timetable).
        if params.routing_mode == RoutingMode.pt:
            if params.arrival_time is None:
                raise ValueError("PT heatmap requires an arrival_time.")
            # An uploaded PT bundle replaces the global network: its own
            # timetable and its own linkage tables, or neither (the schema
            # refuses a half override).
            cfg.timetable_path = str(params.timetable_path or self._timetable_path)
            cfg.arrival_time = int(params.arrival_time)
            cfg.max_transfers = params.max_transfers
            cfg.transit_modes = list(params.transit_modes or [])
            cfg.access_mode = routing_mode_map[params.access_mode]
            cfg.egress_mode = routing_mode_map[params.egress_mode]
            cfg.access_max_time = params.access_max_time
            cfg.egress_max_time = params.egress_max_time
            cfg.access_table_path = str(
                params.access_table_path
                or self._accessegress_table_path(params.access_mode)
            )
            cfg.egress_table_path = str(
                params.egress_table_path
                or self._accessegress_table_path(params.egress_mode)
            )
            # Connectivity keys its output at the fixed per-mode resolution the
            # AOI is rasterized to, so C++ output cells align with the AOI cells.
            cfg.connectivity_output_resolution = DEFAULT_H3_RESOLUTION[
                params.routing_mode
            ]

        return cfg

    # ----------------------- connectivity helpers ----------------------------

    def _rasterize_aoi_to_opportunities(
        self: Self,
        reference_area_path: str,
        h3_resolution: int,
    ) -> tuple[list[tuple[float, float, float]], int]:
        """Rasterize reference AOI polygon to H3 cells at a fixed resolution.

        Returns (centroid points in EPSG:3857 with weight=1.0, resolution used).
        """
        # Register the AOI
        aoi_meta, aoi_table = self.import_input(
            reference_area_path, table_name="aoi_input"
        )

        # Convert to H3 cells (parent helper)
        aoi_cells_table = self._process_table_to_h3(
            aoi_table, aoi_meta, h3_resolution, "aoi_h3_cells", h3_column="aoi_cell"
        )

        # Compute centroids (lat, lng) per cell and project to EPSG:3857.
        # h3_cell_to_latlng returns DOUBLE[] where [1]=lat, [2]=lng (1-based DuckDB list indexing).
        rows = self.con.execute(f"""
            WITH centroids AS (
                SELECT aoi_cell,
                       h3_cell_to_latlng(aoi_cell) AS latlng
                FROM {aoi_cells_table}
            )
            SELECT
                latlng[2] * 20037508.342789244 / 180.0 AS x_3857,
                LN(TAN((90.0 + latlng[1]) * PI() / 360.0)) * 20037508.342789244 / PI() AS y_3857
            FROM centroids
        """).fetchall()

        logger.info(
            "Rasterized AOI to %d H3 cells at resolution %d",
            len(rows),
            h3_resolution,
        )
        return [(float(x), float(y), 1.0) for x, y in rows], h3_resolution

    # ----------------------- opportunity-layer resolution -------------------

    def _resolve_opportunity_layers(
        self: Self,
        params: HeatmapV2Params,
    ) -> list[
        tuple[
            str,
            list[tuple[list[tuple[float, float]], float, float, float]],
            float,
            float,
            int,
        ]
    ]:
        """Return per-layer (column_name, opp_groups, sensitivity, max_cost, n_destinations).

        Per-layer max_cost (minutes or meters) and n_destinations both drive
        that layer's compute_heatmap call.
        """
        if params.heatmap_type == HeatmapType.connectivity:
            # Fixed per-mode rasterization resolution (same as every other
            # heatmap type), so the output resolution is deterministic across
            # reference areas.
            opp_points, _ = self._rasterize_aoi_to_opportunities(
                params.reference_area_path,
                DEFAULT_H3_RESOLUTION[params.routing_mode],
            )
            if not opp_points:
                raise ValueError(
                    "The reference area is empty or invalid. "
                    "Check that the layer contains valid polygons."
                )
            if len(opp_points) > _CONNECTIVITY_MAX_CELLS:
                raise ValueError(
                    f"The reference area is too large to analyse: it covers "
                    f"{len(opp_points):,} grid cells, but the maximum is "
                    f"{_CONNECTIVITY_MAX_CELLS:,}. "
                    "Please choose a smaller reference area."
                )
            # Connectivity: each AOI cell is a 1-seed opportunity (weight 1,
            # rep == the cell centroid). closest_k is unused.
            conn_groups = [([(x, y)], w, x, y) for (x, y, w) in opp_points]
            return [("connectivity", conn_groups, 0.0, float(params.max_cost), 1)]

        if not params.opportunities:
            raise ValueError(
                f"{params.heatmap_type.value} requires at least one "
                "opportunity layer."
            )
        layers: list[
            tuple[
                str,
                list[tuple[list[tuple[float, float]], float, float, float]],
                float,
                float,
                int,
            ]
        ] = []
        res = DEFAULT_H3_RESOLUTION[params.routing_mode]
        for idx, opp in enumerate(params.opportunities):
            opp_groups = self._load_opportunity_points(opp, idx, res)
            if not opp_groups:
                logger.warning(
                    "Opportunity layer %s yielded 0 opportunities; skipping",
                    opp.input_path,
                )
                continue
            label = self._opportunity_label(opp, idx)
            # OpportunityV2 declares both fields with validated defaults, so
            # read them directly (no fallback needed).
            sensitivity = opp.sensitivity
            layer_max_cost = float(opp.max_cost)
            n_destinations = opp.n_destinations
            layers.append(
                (label, opp_groups, sensitivity, layer_max_cost, n_destinations)
            )

        total_seeds = sum(
            sum(len(g[0]) for g in groups) for _, groups, _, _, _ in layers
        )
        if total_seeds > MAX_SEED_POINTS_TOTAL:
            raise ValueError(
                f"Too many opportunity seed points across all layers: "
                f"{total_seeds:,}, but the maximum is "
                f"{MAX_SEED_POINTS_TOTAL:,}. "
                "Filter the layers or pick smaller datasets."
            )
        return layers

    # ----------------------------------------------------------- demand (2SFCA)

    def _prepare_demand(
        self: Self,
        demand_path: str,
        demand_field: str,
        h3_resolution: int,
        scratch_dir: Path | None = None,
    ) -> str:
        """Rasterize demand to a (cell, demand) parquet. Value is conserved
        across a feature's parts: polygons spread value/num_cells over covered
        cells; points divide by the feature's point count."""
        meta, table = self.import_input(demand_path, table_name="demand_input")
        geom_col = meta.geometry_column or "geometry"
        geom_type = (meta.geometry_type or "").lower()
        out_dir = scratch_dir if scratch_dir is not None else Path(tempfile.mkdtemp())
        out_path = str(out_dir / "demand_cells.parquet")
        if "polygon" in geom_type:
            sql = f"""
              COPY (
                WITH feats AS (
                  SELECT ROW_NUMBER() OVER () AS rid,
                         "{demand_field}"::DOUBLE AS v,
                         (UNNEST(ST_Dump(ST_Force2D({geom_col})))).geom AS g
                  FROM {table} WHERE {geom_col} IS NOT NULL
                ),
                cells AS (
                  SELECT rid, v,
                    UNNEST(h3_polygon_wkt_to_cells_experimental(
                      ST_AsText(g), {h3_resolution}, 'CONTAINMENT_OVERLAPPING')) AS cell
                  FROM feats
                ),
                uniq AS (SELECT DISTINCT rid, v, cell FROM cells),
                cnt AS (SELECT rid, COUNT(*) AS n FROM uniq GROUP BY rid)
                SELECT u.cell::BIGINT AS cell, SUM(u.v / c.n) AS demand
                FROM uniq u JOIN cnt c USING (rid)
                GROUP BY u.cell
              ) TO '{out_path}' (FORMAT PARQUET)
            """
        else:
            sql = f"""
              COPY (
                SELECT h3_latlng_to_cell(ST_Y(g), ST_X(g), {h3_resolution})::BIGINT AS cell,
                       SUM(v / np) AS demand
                FROM (
                  SELECT "{demand_field}"::DOUBLE AS v,
                         ST_NumGeometries({geom_col}) AS np,
                         (UNNEST(ST_Dump({geom_col}))).geom AS g
                  FROM {table} WHERE {geom_col} IS NOT NULL
                )
                GROUP BY cell
              ) TO '{out_path}' (FORMAT PARQUET)
            """
        self.con.execute(sql)
        return out_path

    # ----------------------------------------------------------- per-layer compute

    def _compute_layer_scores(
        self: Self,
        idx: int,
        total: int,
        col: str,
        opp_groups: list[tuple[list[tuple[float, float]], float, float, float]],
        sensitivity: float,
        layer_max_cost: float,
        n_destinations: int,
        params: HeatmapV2Params,
        scratch_dir: Path,
        demand_path: str | None = None,
    ) -> str:
        """Run compute_heatmap for one opportunity layer; load + round the
        result into a DuckDB temp table; return its name."""
        routing = self._get_routing_module()
        score_path = scratch_dir / f"score_{idx}.parquet"
        cfg = self._build_heatmap_cfg(
            params,
            opp_groups,
            sensitivity=sensitivity,
            output_path=str(score_path),
            max_cost=layer_max_cost,
            closest_k=n_destinations,
            demand_path=demand_path,
        )

        t0 = time.perf_counter()
        routing.compute_heatmap(cfg)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        logger.info(
            "[Heatmap] Layer %d/%d '%s' compute_heatmap "
            "(%d opps, %d seeds, max_cost=%.1f, sensitivity=%.0f): %.0f ms",
            idx + 1,
            total,
            col,
            len(opp_groups),
            sum(len(g[0]) for g in opp_groups),
            layer_max_cost,
            sensitivity,
            elapsed_ms,
        )

        score_table = f"score_{idx}"
        # Round per-layer scores for rendering. 2 decimals suit gravity /
        # closest-average / connectivity, but 2SFCA scores are per-capita
        # supply-to-demand ratios that are routinely < 0.01 — rounding those to
        # 2 dp collapses them to zero, so 2SFCA keeps more precision.
        decimals = 6 if params.heatmap_type == HeatmapType.two_sfca else 2
        self.con.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE {score_table} AS
            SELECT h3_index::UBIGINT AS h3_index,
                   ROUND(score, {decimals}) AS {col}_accessibility
            FROM read_parquet('{score_path}')
            """
        )
        self._log_layer_score_stats(idx, col, score_table)
        return score_table

    def _log_layer_score_stats(
        self: Self, idx: int, col: str, score_table: str
    ) -> None:
        """Surface per-layer score distribution so regressions like
        'almost always zero' are visible in the worker log."""
        stats = self.con.execute(
            f"""
            SELECT
                count(*) AS n_rows,
                count(*) FILTER (WHERE {col}_accessibility > 0) AS n_nonzero,
                coalesce(min({col}_accessibility), 0) AS min_s,
                coalesce(max({col}_accessibility), 0) AS max_s,
                coalesce(avg({col}_accessibility), 0) AS avg_s
            FROM {score_table}
            """
        ).fetchone()
        logger.info(
            "[Heatmap] Layer %d '%s' scores: "
            "rows=%d nonzero=%d min=%.3g max=%.3g avg=%.3g",
            idx + 1,
            col,
            stats[0],
            stats[1],
            stats[2],
            stats[3],
            stats[4],
        )

    # ----------------------------------------------------------- join across layers

    def _join_layer_scores(
        self: Self,
        score_tables: list[tuple[str, str]],
        heatmap_type: HeatmapType,
    ) -> str:
        """FULL OUTER JOIN the per-layer score tables on h3_index into
        total_accessibility. Gravity totals are a sum (cells not reaching every
        layer are dropped); closest-average totals are the mean of reached
        layers' costs. Unreached layers stay NULL. Materialises
        `heatmap_v2_results`."""
        select_cols = ", ".join(
            f"s{idx}.{col}_accessibility AS {col}_accessibility"
            for idx, (col, _) in enumerate(score_tables)
        )
        sum_expr = " + ".join(
            f"s{idx}.{col}_accessibility" for idx, (col, _) in enumerate(score_tables)
        )
        # 2SFCA totals are tiny per-capita ratios; keep more precision so they
        # don't round to zero (2 dp is fine for the other formulas).
        decimals = 6 if heatmap_type == HeatmapType.two_sfca else 2
        if heatmap_type == HeatmapType.closest_average:
            cnt_expr = " + ".join(
                f"(s{idx}.{col}_accessibility IS NOT NULL)::INT"
                for idx, (col, _) in enumerate(score_tables)
            )
            total_select = f"ROUND(({sum_expr}) / NULLIF({cnt_expr}, 0), {decimals}) AS total_accessibility"
            drop_null_total = False
        else:
            total_select = f"ROUND({sum_expr}, {decimals}) AS total_accessibility"
            drop_null_total = True

        from_clause = f"{score_tables[0][1]} s0"
        for i in range(1, len(score_tables)):
            prev_coalesce = (
                "COALESCE(" + ", ".join(f"s{j}.h3_index" for j in range(i)) + ")"
            )
            from_clause += (
                f"\n        FULL OUTER JOIN {score_tables[i][1]} s{i} "
                f"ON s{i}.h3_index = {prev_coalesce}"
            )
        h3_coalesce = (
            "COALESCE("
            + ", ".join(f"s{idx}.h3_index" for idx in range(len(score_tables)))
            + ")"
        )

        inner_select = (
            f"SELECT {h3_coalesce} AS h3_index, {select_cols}, {total_select} "
            f"FROM {from_clause}"
        )
        body = (
            f"SELECT * FROM ({inner_select}) WHERE total_accessibility IS NOT NULL"
            if drop_null_total
            else inner_select
        )
        self.con.execute(f"CREATE OR REPLACE TEMP TABLE heatmap_v2_results AS {body}")
        return "heatmap_v2_results"

    # ----------------------------------------------------------- reference-area clip

    def _maybe_clip_to_reference_area(
        self: Self, results_table: str, params: HeatmapV2Params
    ) -> str:
        """Optional clip: gravity/closest_avg with reference_area_path set.
        Connectivity is a no-op (its AOI is the compute input). Cells outside
        the AOI are dropped; cells inside that weren't reached become NULL."""
        if not params.reference_area_path:
            return results_table
        if params.heatmap_type == HeatmapType.connectivity:
            return results_table
        h3_res = DEFAULT_H3_RESOLUTION[params.routing_mode]
        ref_meta, ref_table = self.import_input(
            params.reference_area_path, table_name="reference_area"
        )
        ref_table_h3 = self._process_table_to_h3(
            ref_table, ref_meta, h3_res, "reference_area_h3", "dest_id"
        )
        return self._project_to_reference_area(results_table, ref_table_h3)

    # ----------------------------------------------------------- main pipeline

    def _run_implementation(
        self: Self, params: HeatmapV2Params
    ) -> list[tuple[Path, DatasetMetadata]]:
        run_t0 = time.perf_counter()
        last_t = run_t0

        def lap() -> float:
            nonlocal last_t
            now = time.perf_counter()
            elapsed_ms = (now - last_t) * 1000.0
            last_t = now
            return elapsed_ms

        layer_specs = self._resolve_opportunity_layers(params)
        if not layer_specs:
            raise ValueError("No opportunity layers produced any points.")
        total_opps = sum(len(opps) for _, opps, _, _, _ in layer_specs)
        total_seeds = sum(
            sum(len(g[0]) for g in opps) for _, opps, _, _, _ in layer_specs
        )
        logger.info(
            "[Heatmap] Load %d opportunity layer(s) (%d opportunities, "
            "%d seeds total): %.0f ms",
            len(layer_specs),
            total_opps,
            total_seeds,
            lap(),
        )

        with tempfile.TemporaryDirectory() as td_str:
            scratch_dir = Path(td_str)
            demand_path: str | None = None
            if params.heatmap_type == HeatmapType.two_sfca:
                demand_path = self._prepare_demand(
                    params.demand_path,
                    params.demand_field,
                    DEFAULT_H3_RESOLUTION[params.routing_mode],
                    scratch_dir,
                )
                logger.info("[Heatmap] 2SFCA demand rasterized: %.0f ms", lap())
            score_tables: list[tuple[str, str]] = []
            for idx, (col, opp_pts, sens, max_cost, n_dest) in enumerate(layer_specs):
                table = self._compute_layer_scores(
                    idx,
                    len(layer_specs),
                    col,
                    opp_pts,
                    sens,
                    max_cost,
                    n_dest,
                    params,
                    scratch_dir,
                    demand_path,
                )
                score_tables.append((col, table))
            last_t = time.perf_counter()  # per-layer prints already accounted for time

            results_table = self._join_layer_scores(score_tables, params.heatmap_type)
            n_cells = self.con.execute(
                f"SELECT count(*) FROM {results_table}"
            ).fetchone()[0]
            logger.info(
                "[Heatmap] Join + total (over %d layer(s)): %.0f ms — %d cells",
                len(score_tables),
                lap(),
                n_cells,
            )

        results_table = self._maybe_clip_to_reference_area(results_table, params)
        if (
            params.reference_area_path
            and params.heatmap_type != HeatmapType.connectivity
        ):
            logger.info("[Heatmap] Reference-area clip: %.0f ms", lap())

        out_path = self._export_h3_results(
            results_table, params.output_path, h3_column="h3_index"
        )
        logger.info("[Heatmap] Export GeoParquet: %.0f ms", lap())
        logger.info(
            "[Heatmap] _run_implementation total: %.0f ms",
            (time.perf_counter() - run_t0) * 1000,
        )

        metadata = DatasetMetadata(
            path=str(out_path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Polygon",
            geometry_column="geometry",
        )
        return [(out_path, metadata)]
