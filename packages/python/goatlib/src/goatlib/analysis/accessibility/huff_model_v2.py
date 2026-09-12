"""Huff Model V2 — local routing backend.

Computes Huff market-share probabilities on the v2 stack: the OD cost matrix
is computed live (street via the reverse+sparse travel-cost matrix; PT via
compute_heatmap's OD-cost emission) instead of read from a precomputed matrix.
The model math is identical to v1 (`huff_model.py::_compute_huff_model`).
"""

import logging
import tempfile
from pathlib import Path
from typing import Any, Self

from goatlib.analysis.accessibility.base import HeatmapToolBase
from goatlib.analysis.schemas.catchment_area_v2 import CostType, RoutingMode
from goatlib.analysis.schemas.heatmap import HuffmodelV2Params
from goatlib.config.settings import settings
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)

# Fixed per-mode H3 resolution for rasterization. PT MUST be res-9 (the
# access/egress lookup-table resolution). Mirrors heatmap_v2.DEFAULT_H3_RESOLUTION.
DEFAULT_H3_RESOLUTION: dict[RoutingMode, int] = {
    RoutingMode.walking: 10,
    RoutingMode.bicycle: 9,
    RoutingMode.pedelec: 9,
    RoutingMode.car: 8,
    RoutingMode.pt: 9,
}

_MODE_SPEED_DEFAULTS: dict[RoutingMode, float] = {
    RoutingMode.walking: 5.0,
    RoutingMode.bicycle: 15.0,
    RoutingMode.pedelec: 23.0,
    RoutingMode.car: 0.0,
}

# Cap on total opportunity SEED cells (the routing sources). Mirrors
# heatmap_v2.MAX_SEED_POINTS_TOTAL.
MAX_SEED_POINTS_TOTAL = 50_000

# PT access/egress precomputed lookup tables: accessegress_{mode}_r9.parquet.
_PT_ACCESSEGRESS_RES = 9
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


class HuffmodelV2Tool(HeatmapToolBase):
    """Huff model on the local C++ routing backend."""

    def __init__(self: Self) -> None:
        super().__init__()
        self._edge_dir = settings.routing.street_network_edges_base_path
        self._node_dir = settings.routing.street_network_nodes_base_path
        self._timetable_path = str(settings.routing.pt_network_base_path)
        self._pt_network_dir = str(Path(self._timetable_path).parent)

    def _accessegress_table_path(self: Self, mode: RoutingMode) -> str:
        if mode not in _PT_ACCESSEGRESS_MODES:
            raise ValueError(f"Unsupported PT access/egress mode: {mode}")
        fname = f"accessegress_{mode.value}_r{_PT_ACCESSEGRESS_RES}.parquet"
        return str(Path(self._pt_network_dir) / fname)

    # ------------------------------------------------------------- rasterization

    @staticmethod
    def _cell_centroid_3857_sql(cell_expr: str) -> tuple[str, str]:
        """(cx, cy) EPSG:3857 SQL from an H3 cell expression. h3_cell_to_latlng
        returns [lat, lng] (1-based)."""
        ll = f"h3_cell_to_latlng({cell_expr})"
        cx = f"{ll}[2] * 20037508.342789244 / 180.0"
        cy = f"LN(TAN((90.0 + {ll}[1]) * PI() / 360.0)) * 20037508.342789244 / PI()"
        return cx, cy

    @staticmethod
    def _to_4326_sql(geom_col: str, meta: Any) -> str:
        """SQL expr projecting geom_col to EPSG:4326. always_xy keeps lon/lat
        order — without it ST_Transform emits lat/lon and every cell lands in
        the wrong hemisphere."""
        if meta.crs and meta.crs.to_epsg() != 4326:
            return (
                f"ST_Transform({geom_col}, '{meta.crs.to_string()}', "
                f"'EPSG:4326', always_xy:=true)"
            )
        return geom_col

    def _prepare_opportunity_cells(
        self: Self, opp_path: str, attractivity: str, h3_resolution: int
    ) -> str:
        """opp_cells(dest_cell BIGINT, supply_id INT, attractivity DOUBLE,
        cx DOUBLE, cy DOUBLE). A facility (supply_id) may occupy several cells."""
        meta, tbl = self.import_input(opp_path, table_name="opp_input")
        geom_col = meta.geometry_column or "geom"
        geom_type = (meta.geometry_type or "").lower()
        # Kept for the original-geometry export (v1 parity): supply_id is
        # re-derived from this table via the same ROW_NUMBER() ordering.
        self._opp_import_table = tbl
        self._opp_geom_col = geom_col
        self._opp_geom_type = meta.geometry_type or "Unknown"
        to4326 = self._to_4326_sql(geom_col, meta)

        if "point" in geom_type:
            cell_sql = f"""
              WITH feats AS (
                SELECT ROW_NUMBER() OVER () AS supply_id,
                       {attractivity}::DOUBLE AS attractivity,
                       {to4326} AS geom
                FROM {tbl} WHERE {geom_col} IS NOT NULL),
              exploded AS (
                SELECT supply_id, attractivity,
                       (UNNEST(ST_Dump(geom))).geom AS g FROM feats)
              SELECT h3_latlng_to_cell(ST_Y(g), ST_X(g), {h3_resolution}) AS dest_cell,
                     supply_id, attractivity
              FROM exploded WHERE g IS NOT NULL
            """
        elif "polygon" in geom_type:
            cell_sql = f"""
              WITH feats AS (
                SELECT ROW_NUMBER() OVER () AS supply_id,
                       {attractivity}::DOUBLE AS attractivity,
                       {to4326} AS geom
                FROM {tbl} WHERE {geom_col} IS NOT NULL),
              polys AS (
                SELECT supply_id, attractivity,
                       (UNNEST(ST_Dump(ST_Force2D(geom)))).geom AS g FROM feats),
              cells AS (
                SELECT supply_id, attractivity,
                       UNNEST(h3_polygon_wkt_to_cells_experimental(
                         ST_AsText(g), {h3_resolution}, 'CONTAINMENT_OVERLAPPING')) AS dest_cell
                FROM polys)
              SELECT DISTINCT dest_cell, supply_id, attractivity FROM cells
            """
        else:
            raise ValueError(f"Unsupported opportunity geometry type: '{geom_type}'")

        cx, cy = self._cell_centroid_3857_sql("dest_cell")
        self.con.execute(f"""
          CREATE OR REPLACE TEMP TABLE opp_cells AS
          WITH base AS ({cell_sql})
          SELECT dest_cell, supply_id, attractivity, {cx} AS cx, {cy} AS cy
          FROM base WHERE dest_cell IS NOT NULL
        """)
        return "opp_cells"

    def _prepare_demand_cells(
        self: Self, demand_path: str, demand_field: str, h3_resolution: int
    ) -> str:
        """demand_cells(orig_cell BIGINT, demand DOUBLE, cx DOUBLE, cy DOUBLE).
        Value is conserved across a feature's parts (v1 _process_demand)."""
        meta, tbl = self.import_input(demand_path, table_name="demand_input")
        geom_col = meta.geometry_column or "geom"
        geom_type = (meta.geometry_type or "").lower()
        to4326 = self._to_4326_sql(geom_col, meta)

        if "point" in geom_type:
            cell_sql = f"""
              SELECT h3_latlng_to_cell(ST_Y(g), ST_X(g), {h3_resolution}) AS orig_cell,
                     SUM(v / np) AS demand
              FROM (
                SELECT {demand_field}::DOUBLE AS v,
                       ST_NumGeometries({to4326}) AS np,
                       (UNNEST(ST_Dump({to4326}))).geom AS g
                FROM {tbl} WHERE {geom_col} IS NOT NULL)
              GROUP BY orig_cell
            """
        elif "polygon" in geom_type:
            cell_sql = f"""
              WITH feats AS (
                SELECT ROW_NUMBER() OVER () AS rid,
                       {demand_field}::DOUBLE AS v,
                       (UNNEST(ST_Dump(ST_Force2D({to4326})))).geom AS g
                FROM {tbl} WHERE {geom_col} IS NOT NULL),
              cells AS (
                SELECT rid, v,
                       UNNEST(h3_polygon_wkt_to_cells_experimental(
                         ST_AsText(g), {h3_resolution}, 'CONTAINMENT_OVERLAPPING')) AS orig_cell
                FROM feats),
              uniq AS (SELECT DISTINCT rid, v, orig_cell FROM cells),
              cnt AS (SELECT rid, COUNT(*) AS n FROM uniq GROUP BY rid)
              SELECT u.orig_cell, SUM(u.v / c.n) AS demand
              FROM uniq u JOIN cnt c USING (rid)
              WHERE u.orig_cell IS NOT NULL GROUP BY u.orig_cell
            """
        else:
            raise ValueError(f"Unsupported demand geometry type: '{geom_type}'")

        cx, cy = self._cell_centroid_3857_sql("orig_cell")
        self.con.execute(f"""
          CREATE OR REPLACE TEMP TABLE demand_cells AS
          WITH base AS ({cell_sql})
          SELECT orig_cell, demand, {cx} AS cx, {cy} AS cy
          FROM base WHERE orig_cell IS NOT NULL
        """)
        return "demand_cells"

    # --------------------------------------------------------------- OD matrix

    def _routing_mode_enum(self: Self, mode: RoutingMode) -> Any:
        routing = self._get_routing_module()
        return {
            RoutingMode.walking: routing.RoutingMode.Walking,
            RoutingMode.bicycle: routing.RoutingMode.Bicycle,
            RoutingMode.pedelec: routing.RoutingMode.Pedelec,
            RoutingMode.car: routing.RoutingMode.Car,
            RoutingMode.pt: routing.RoutingMode.PublicTransport,
        }[mode]

    def _compute_od_matrix(
        self: Self, opp_cells: str, demand_cells: str, params: HuffmodelV2Params
    ) -> str:
        """od_matrix(orig_id BIGINT, dest_id BIGINT, cost INT). Street via the
        reverse+sparse matrix; PT via compute_heatmap's OD-cost emission."""
        routing = self._get_routing_module()
        scratch = Path(tempfile.mkdtemp())
        od_path = str(scratch / "od.parquet")

        if params.routing_mode == RoutingMode.pt:
            # emitted columns: (orig_cell, dest_cell, cost)
            self._compute_od_pt(opp_cells, params, od_path, routing)
            orig_col, dest_col, cost_col, where = "orig_cell", "dest_cell", "cost", ""
        else:
            # matrix columns: (origin, destination, travel_cost)
            self._compute_od_street(opp_cells, demand_cells, params, od_path, routing)
            orig_col, dest_col, cost_col, where = (
                "origin",
                "destination",
                "travel_cost",
                "WHERE travel_cost IS NOT NULL",
            )

        self.con.execute(f"""
          CREATE OR REPLACE TEMP TABLE od_matrix AS
          SELECT {orig_col}::BIGINT AS orig_id, {dest_col}::BIGINT AS dest_id,
                 {cost_col}::INTEGER AS cost
          FROM read_parquet('{od_path}') {where}
        """)
        return "od_matrix"

    def _compute_od_street(
        self: Self,
        opp_cells: str,
        demand_cells: str,
        params: HuffmodelV2Params,
        od_path: str,
        routing: Any,
    ) -> None:
        origins = self.con.execute(
            f"SELECT DISTINCT orig_cell, cx, cy FROM {demand_cells}"
        ).fetchall()
        dests = self.con.execute(
            f"SELECT DISTINCT dest_cell, cx, cy FROM {opp_cells}"
        ).fetchall()

        cfg = routing.MatrixConfig()
        cfg.origins = [routing.Point3857(float(cx), float(cy)) for _, cx, cy in origins]
        cfg.destinations = [
            routing.Point3857(float(cx), float(cy)) for _, cx, cy in dests
        ]
        cfg.origin_ids = [str(c) for c, _, _ in origins]
        cfg.destination_ids = [str(c) for c, _, _ in dests]
        cfg.mode = self._routing_mode_enum(params.routing_mode)
        cfg.cost_type = (
            routing.CostType.Distance
            if params.cost_type == CostType.distance
            else routing.CostType.Time
        )
        cfg.max_cost = float(params.max_cost)
        cfg.speed_km_h = (
            params.speed
            if params.speed is not None
            else _MODE_SPEED_DEFAULTS.get(params.routing_mode, 0.0)
        )
        # An uploaded street network bundle's graph overrides the global network.
        cfg.edge_dir = str(params.edge_path or self._edge_dir)
        cfg.node_dir = str(params.node_path or self._node_dir)
        cfg.reverse = True
        cfg.sparse = True
        cfg.output_path = od_path
        routing.compute_travel_cost_matrix(cfg)

    def _compute_od_pt(
        self: Self,
        opp_cells: str,
        params: HuffmodelV2Params,
        od_path: str,
        routing: Any,
    ) -> None:
        if params.arrival_time is None:
            raise ValueError("PT Huff model requires an arrival_time.")
        dests = self.con.execute(
            f"SELECT DISTINCT dest_cell, cx, cy FROM {opp_cells}"
        ).fetchall()

        cfg = routing.HeatmapConfig()
        cfg.opportunities = [
            routing.Opportunity(
                [routing.Point3857(float(cx), float(cy))],
                1.0,
                routing.Point3857(float(cx), float(cy)),
            )
            for _, cx, cy in dests
        ]
        cfg.mode = routing.RoutingMode.PublicTransport
        cfg.cost_type = routing.CostType.Time
        cfg.max_cost = float(params.max_cost)
        # An uploaded street network bundle's graph overrides the global network.
        cfg.edge_dir = str(params.edge_path or self._edge_dir)
        cfg.node_dir = str(params.node_path or self._node_dir)
        # An uploaded PT bundle replaces the global network: its own timetable
        # and its own linkage tables, or neither (the schema refuses a half
        # override).
        cfg.timetable_path = str(params.timetable_path or self._timetable_path)
        cfg.arrival_time = int(params.arrival_time)
        cfg.max_transfers = params.max_transfers
        cfg.transit_modes = list(params.transit_modes or [])
        cfg.access_mode = self._routing_mode_enum(params.access_mode)
        cfg.egress_mode = self._routing_mode_enum(params.egress_mode)
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
        cfg.output_path = od_path
        routing.compute_od_costs(cfg)

    # --------------------------------------------------------- Huff model math

    def _compute_huff_model(
        self: Self,
        od: str,
        opp_cells: str,
        demand_cells: str,
        alpha: float,
        beta: float,
        max_cost: float,
    ) -> str:
        """Per-facility market-share probability. Identical math to v1
        `huff_model.py::_compute_huff_model` (min-cost per origin/supply →
        weighted attractiveness → per-origin normalization → captured demand)."""
        total_demand = (
            self.con.execute(f"SELECT SUM(demand) FROM {demand_cells}").fetchone()[0]
            or 0
        )
        if total_demand == 0:
            raise ValueError("Total demand is zero - cannot compute Huff model")

        self.con.execute(f"""
          CREATE OR REPLACE TEMP TABLE huff_v2_final AS
          WITH origin_supply_min_cost AS (
            -- Floor at 1: a demand cell coinciding with an opportunity cell has
            -- cost 0, and POW(0, -beta) = inf would poison the per-origin sum
            -- with NaN. (v1 shared the 0-cost quirk; flooring keeps it finite.)
            SELECT m.orig_id, o.supply_id, o.attractivity,
                   GREATEST(MIN(m.cost), 1) AS min_cost
            FROM {od} m JOIN {opp_cells} o ON m.dest_id = o.dest_cell
            WHERE m.cost <= {max_cost}
            GROUP BY m.orig_id, o.supply_id, o.attractivity),
          origin_supply_weights AS (
            SELECT orig_id, supply_id, attractivity,
              POW(attractivity, {alpha}) * POW(min_cost, -{beta}) AS weighted_attr,
              SUM(POW(attractivity, {alpha}) * POW(min_cost, -{beta}))
                OVER (PARTITION BY orig_id) AS total_weighted_attr
            FROM origin_supply_min_cost),
          probabilities_with_demand AS (
            SELECT osw.supply_id, osw.attractivity,
              (osw.weighted_attr / osw.total_weighted_attr) * d.demand AS captured_demand
            FROM origin_supply_weights osw
            JOIN {demand_cells} d ON osw.orig_id = d.orig_cell
            WHERE osw.weighted_attr > 0 AND osw.total_weighted_attr > 0)
          SELECT supply_id,
                 SUM(captured_demand) / {total_demand} * 100 AS probability,
                 MAX(attractivity) AS attractivity
          FROM probabilities_with_demand GROUP BY supply_id
        """)
        return "huff_v2_final"

    def _export_original_geom(self: Self, results_table: str, output_path: str) -> Path:
        """Attach per-facility probability to the original opportunity geometry
        (v1 output contract). supply_id is re-derived from the same import table
        with the same ROW_NUMBER() ordering used during rasterization."""
        out = Path(output_path)
        if out.suffix.lower() != ".parquet":
            out = out.with_suffix(".parquet")
        out.parent.mkdir(parents=True, exist_ok=True)
        geom_col = self._opp_geom_col
        query = f"""
          SELECT o.* EXCLUDE (supply_id, {geom_col}),
                 r.probability AS probability,
                 o.{geom_col} AS geometry
          FROM (
            SELECT ROW_NUMBER() OVER () AS supply_id, *
            FROM {self._opp_import_table} WHERE {geom_col} IS NOT NULL
          ) o
          INNER JOIN {results_table} r ON o.supply_id = r.supply_id
        """
        write_optimized_parquet(self.con, query, out, geometry_column="geometry")
        return out

    # ----------------------------------------------------- reference-area clip

    def _clip_cells_to_reference(
        self: Self, params: HuffmodelV2Params, h3_resolution: int
    ) -> None:
        """Filter opp_cells/demand_cells to the reference-area H3 cells (v1
        restricts both to the study area)."""
        if not params.reference_area_path:
            return
        meta, ref_tbl = self.import_input(
            params.reference_area_path, table_name="reference_area"
        )
        geom_col = meta.geometry_column or "geom"
        to4326 = self._to_4326_sql(geom_col, meta)
        # Rasterize locally with the same always_xy transform as opp/demand so
        # the cell IDs match (the shared _process_table_to_h3 omits always_xy).
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE reference_area_h3 AS
            WITH feats AS (
                SELECT (UNNEST(ST_Dump(ST_Force2D({to4326})))).geom AS g
                FROM {ref_tbl} WHERE {geom_col} IS NOT NULL),
            cells AS (
                SELECT UNNEST(h3_polygon_wkt_to_cells_experimental(
                    ST_AsText(g), {h3_resolution}, 'CONTAINMENT_OVERLAPPING')) AS ref_cell
                FROM feats)
            SELECT DISTINCT ref_cell FROM cells
        """)
        self.con.execute(
            "DELETE FROM opp_cells WHERE dest_cell NOT IN "
            "(SELECT ref_cell FROM reference_area_h3)"
        )
        self.con.execute(
            "DELETE FROM demand_cells WHERE orig_cell NOT IN "
            "(SELECT ref_cell FROM reference_area_h3)"
        )

    # ----------------------------------------------------------- main pipeline

    def _run_implementation(
        self: Self, params: HuffmodelV2Params
    ) -> list[tuple[Path, DatasetMetadata]]:
        h3_resolution = DEFAULT_H3_RESOLUTION[params.routing_mode]

        opp_cells = self._prepare_opportunity_cells(
            params.opportunity_path, params.attractivity, h3_resolution
        )
        demand_cells = self._prepare_demand_cells(
            params.demand_path, params.demand_field, h3_resolution
        )
        logger.info(
            "[Huff] mode=%s res=%d opp_cells=%d demand_cells=%d (pre-clip)",
            params.routing_mode.value,
            h3_resolution,
            self.con.execute(f"SELECT count(*) FROM {opp_cells}").fetchone()[0],
            self.con.execute(f"SELECT count(*) FROM {demand_cells}").fetchone()[0],
        )
        self._clip_cells_to_reference(params, h3_resolution)
        if params.reference_area_path:
            logger.info(
                "[Huff] after reference-area clip: opp_cells=%d demand_cells=%d",
                self.con.execute(f"SELECT count(*) FROM {opp_cells}").fetchone()[0],
                self.con.execute(f"SELECT count(*) FROM {demand_cells}").fetchone()[0],
            )

        n_seeds = self.con.execute(
            f"SELECT count(DISTINCT dest_cell) FROM {opp_cells}"
        ).fetchone()[0]
        if n_seeds == 0:
            raise ValueError(
                "No opportunity cells within the study area. Check the "
                "opportunity and reference-area layers."
            )
        if n_seeds > MAX_SEED_POINTS_TOTAL:
            raise ValueError(
                f"Too many opportunity seed cells: {n_seeds:,}, but the maximum "
                f"is {MAX_SEED_POINTS_TOTAL:,}. Filter the layer or pick a "
                "smaller dataset."
            )

        od = self._compute_od_matrix(opp_cells, demand_cells, params)
        logger.info(
            "[Huff] OD matrix rows=%d (max_cost=%s, cost_type=%s)",
            self.con.execute(f"SELECT count(*) FROM {od}").fetchone()[0],
            params.max_cost,
            params.cost_type.value,
        )
        results = self._compute_huff_model(
            od,
            opp_cells,
            demand_cells,
            params.attractiveness_param,
            params.distance_decay,
            float(params.max_cost),
        )
        n_facilities = self.con.execute(f"SELECT count(*) FROM {results}").fetchone()[0]
        out_path = self._export_original_geom(results, params.output_path)
        n_out = self.con.execute(
            f"SELECT count(*) FROM read_parquet('{out_path}')"
        ).fetchone()[0]
        logger.info(
            "[Huff] facilities scored=%d, exported rows=%d → %s",
            n_facilities,
            n_out,
            out_path,
        )

        metadata = DatasetMetadata(
            path=str(out_path),
            source_type="vector",
            format="geoparquet",
            geometry_type=self._opp_geom_type,
            geometry_column="geometry",
        )
        return [(out_path, metadata)]
