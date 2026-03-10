import logging
import uuid
from pathlib import Path
from typing import Self

from goatlib.analysis.accessibility.base import HeatmapToolBase, sanitize_sql_name
from goatlib.analysis.schemas.heatmap import (
    Heatmap2SFCAParams,
    Opportunity2SFCA,
    ImpedanceFunction,
    TwoSFCAType,
    PotentialType
)
from goatlib.io.utils import Metadata
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class Heatmap2SFCATool(HeatmapToolBase):
    """
    Computes 2-step floating catchment area (2SFCA) heatmap.
    """

    def _run_implementation(
        self: Self, params: Heatmap2SFCAParams
    ) -> list[tuple[Path, DatasetMetadata]]:
        logger.info("Starting Heatmap 2SFCA Analysis")
        # Register OD matrix and detect H3 resolution
        od_table, h3_resolution = self._prepare_od_matrix(
            params.od_matrix_path, params.od_column_map
        )
        logger.info(
            "OD matrix ready: table=%s, h3_resolution=%s", od_table, h3_resolution
        )

        # Process and standardize opportunities using detected resolution
        standardized_tables = self._process_opportunities(
            params.opportunities, h3_resolution
        )
        # Combine all standardized tables using pivot
        unified_table = self._combine_opportunities(standardized_tables)
        logger.info("Unified opportunity table created: %s", unified_table)

        # Process demand layer
        demand_table = self._process_demand(
            params.demand_path, params.demand_field, h3_resolution
        )
        logger.info("Demand table created: %s", demand_table)

        # Extract unique H3 IDs from opportunities and demand
        opportunity_ids = self._extract_h3_ids(unified_table, column_name="dest_id")
        demand_ids = self._extract_h3_ids(demand_table, column_name="orig_id")
        if not opportunity_ids:
            raise ValueError("No opportunity IDs found in opportunity data")
        if not demand_ids:
            raise ValueError("No demand IDs found in demand data")

        logger.info("Found %d unique opportunity IDs", len(opportunity_ids))
        logger.info("Found %d unique demand IDs", len(demand_ids))

        # Step 1: Compute capacity ratios per opportunity
        filtered_matrix = self._filter_od_matrix(
            od_table, destination_ids=opportunity_ids
        )
        logger.info("Filtered OD matrix for Step 1")
        capacity_ratios_table, safe_names = self._compute_capacity_ratios(
            filtered_matrix,
            unified_table,
            standardized_tables,
            demand_table,
            params.two_sfca_type,
            params.impedance,
        )
        logger.info("Capacity ratios table created: %s", capacity_ratios_table)

        result_table = self._compute_cumulative_accessibility(
            filtered_matrix,
            capacity_ratios_table,
            safe_names,
            params.two_sfca_type,
            params.impedance,
        )
        logger.info("2SFCA result table created: %s", result_table)

        # Export results
        output_path = Path(params.output_path)
        logger.info("Heatmap 2SFCA analysis completed successfully")

        result_path = self._export_h3_results(result_table, output_path)

        # Return as list of (path, metadata) tuples for consistency with other tools
        metadata = DatasetMetadata(
            path=str(result_path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Polygon",
            geometry_column="geometry",
        )
        return [(result_path, metadata)]

    def _process_opportunities(
        self: Self, opportunities: list[Opportunity2SFCA], h3_resolution: int
    ) -> list[tuple[str, str]]:
        """
        Imports and standardizes all opportunity datasets.
        Returns a list of (standardized_table_name, opportunity_name)
        """
        opportunity_tables = []

        for idx, opp in enumerate(opportunities):
            # Use simple table name (internal), keep display name separate
            table_name = f"opp_{idx}"
            display_name = opp.name or Path(opp.input_path).stem

            try:
                # Import into DuckDB and get metadata
                meta, table_name = self.import_input(
                    opp.input_path, table_name=table_name
                )
                logger.info(
                    "Imported '%s' (geometry=%s)", opp.input_path, meta.geometry_type
                )

                # Standardize into canonical schema - these are DESTINATIONS
                std_table = self._prepare_opportunity_table(
                    table_name, meta, opp, h3_resolution
                )
                opportunity_tables.append((std_table, display_name))
                logger.info("Prepared standardized table: %s", std_table)

            except Exception as e:
                logger.error(
                    "Failed to import opportunity dataset '%s': %s", opp.input_path, e
                )
                raise

        return opportunity_tables

    def _prepare_opportunity_table(
        self: Self,
        table_name: str,
        meta: Metadata,
        opp: Opportunity2SFCA,
        h3_resolution: int,
    ) -> str:
        """
        Converts an imported opportunity dataset into canonical schema.
        Schema: dest_id, max_cost, capacity, sensitivity
        """
        geom_col = meta.geometry_column or "geom"
        geom_type = (meta.geometry_type or "").lower()
        output_table = f"{table_name}_std"

        transform_to_4326 = geom_col
        try:
            if meta.crs and meta.crs.to_epsg() != 4326:
                source_crs = meta.crs.to_string()
                transform_to_4326 = (
                    f"ST_Transform({geom_col}, '{source_crs}', 'EPSG:4326')"
                )
        except Exception:
            pass
        
        capacity_sql = self._get_capacity_sql(opp, transform_to_4326, geom_type)

        if "point" in geom_type:
            query = f"""
            CREATE OR REPLACE TEMP TABLE {output_table} AS
            WITH features AS (
                SELECT
                    {capacity_sql}::DOUBLE AS capacity,
                    {transform_to_4326} AS geom
                FROM {table_name}
                WHERE {geom_col} IS NOT NULL
            ),
            exploded AS (
                SELECT
                    capacity,
                    (UNNEST(ST_Dump(geom))).geom AS simple_geom
                FROM features
            )
            SELECT
                h3_latlng_to_cell(ST_Y(simple_geom), ST_X(simple_geom), {h3_resolution}) AS dest_id,
                {opp.max_cost}::DOUBLE AS max_cost,
                {opp.sensitivity}::DOUBLE AS sensitivity,
                SUM(capacity) AS capacity
            FROM exploded
            WHERE simple_geom IS NOT NULL
            GROUP BY dest_id
            """
        elif "polygon" in geom_type or "multipolygon" in geom_type:
            query = f"""
            CREATE OR REPLACE TEMP TABLE {output_table} AS
            WITH features AS (
                SELECT
                     {capacity_sql}::DOUBLE AS capacity,
                    {transform_to_4326} AS geom
                FROM {table_name}
                WHERE {geom_col} IS NOT NULL
            ),
            polygons AS (
                SELECT
                    ROW_NUMBER() OVER () AS row_id,
                    capacity,
                    (UNNEST(ST_Dump(ST_Force2D(geom))).geom) AS simple_geom
                FROM features
            ),
            h3_cells_raw AS (
                SELECT
                    row_id,
                    capacity,
                    UNNEST(h3_polygon_wkt_to_cells_experimental(ST_AsText(simple_geom), {h3_resolution}, 'CONTAINMENT_OVERLAPPING')) AS dest_id
                FROM polygons
            ),
            h3_cells_unique AS (
                SELECT DISTINCT row_id, capacity, dest_id
                FROM h3_cells_raw
            ),
            h3_counts AS (
                SELECT
                    row_id,
                    COUNT(*) AS num_cells,
                    capacity
                FROM h3_cells_unique
                GROUP BY row_id, capacity
            )
            SELECT
                u.dest_id,
                SUM(u.capacity / hc.num_cells) AS capacity,
                {opp.max_cost}::DOUBLE AS max_cost,
                {opp.sensitivity}::DOUBLE AS sensitivity
            FROM h3_cells_unique u
            JOIN h3_counts hc ON u.row_id = hc.row_id
            GROUP BY u.dest_id
            """
        else:
            raise ValueError(f"Unsupported geometry type: '{geom_type}'")

        self.con.execute(query)
        return output_table

    def _get_capacity_sql(
        self: Self, opp: Opportunity2SFCA, wgs84_geom_sql: str, geom_type: str
    ) -> str:
        """
        Determines the SQL expression for capacity.
        Priority:
        1. capacity_expression
        2. capacity_constant
        3. capacity_field
        4. defaults to 1.0

        Special rule:
        - 'area' and 'perimeter' expressions are only valid for Polygon/MultiPolygon geometries.
        """
        geom_type_lower = (geom_type or "").lower()

        # --- Handle capacity_expression first ---
        if opp.capacity_expression:
            expr = opp.capacity_expression.lower().strip()

            if expr in ("$area", "area"):
                if "polygon" not in geom_type_lower:
                    raise ValueError(
                        f"Invalid capacity_expression='{expr}' for geometry type '{geom_type}'. "
                        "Area is only valid for Polygon or MultiPolygon geometries."
                    )
                return f"ST_Area_Spheroid({wgs84_geom_sql})"

            if expr in ("$perimeter", "perimeter"):
                if "polygon" not in geom_type_lower:
                    raise ValueError(
                        f"Invalid capacity_expression='{expr}' for geometry type '{geom_type}'. "
                        "Perimeter is only valid for Polygon or MultiPolygon geometries."
                    )
                return f"ST_Perimeter_Spheroid({wgs84_geom_sql})"

            # Custom user expression (use as-is)
            return expr

        # --- Constant capacity ---
        if opp.capacity_type == PotentialType.constant:
            return str(float(opp.capacity_constant))

        # --- Field-based capacity ---
        if opp.capacity_field:
            return f'"{opp.capacity_field}"'

        # --- Default constant ---
        return "1.0"


    def _combine_opportunities(
        self: Self, standardized_tables: list[tuple[str, str]]
    ) -> str:
        """
        Combine standardized opportunity tables using PIVOT.
        Creates columns: {opportunity_name}_max_cost, {opportunity_name}_capacity
        """
        if not standardized_tables:
            raise ValueError("No standardized opportunity tables to combine")

        union_parts: list[str] = []
        for idx, (std_table, name) in enumerate(standardized_tables):
            safe_name = sanitize_sql_name(name, idx)
            union_parts.append(f"""
                SELECT
                    dest_id,
                    '{safe_name}' as opportunity_type,
                    max_cost,
                    sensitivity,
                    capacity
                FROM {std_table}
                WHERE dest_id IS NOT NULL
            """)

        union_query = "\nUNION ALL\n".join(union_parts)

        unified_table = f"opportunity_capacity_unified_{uuid.uuid4().hex[:8]}"

        # Use PIVOT to create columns for each opportunity type
        query = f"""
            CREATE OR REPLACE TEMP TABLE {unified_table} AS
            PIVOT (
                {union_query}
            )
            ON opportunity_type
            USING
                FIRST(max_cost) AS max_cost,
                FIRST(capacity) AS capacity,
                FIRST(sensitivity) AS sens
        """

        self.con.execute(query)
        logger.info(
            "Unified opportunity table '%s' created with %d layers",
            unified_table,
            len(standardized_tables),
        )

        return unified_table

    def _process_demand(
        self: Self, demand_path: str, demand_field: str, h3_resolution: int
    ) -> str:
        """
        Imports and standardizes the demand dataset.
        Returns the standardized demand table name with schema: dest_id, demand_value
        """
        try:
            table_name = "demand_input"
            meta, table_name = self.import_input(demand_path, table_name=table_name)
            geom_col = meta.geometry_column or "geom"
            geom_type = (meta.geometry_type or "").lower()
            output_table = f"{table_name}_std"

            transform_to_4326 = geom_col
            if meta.crs and meta.crs.to_epsg() != 4326:
                source_crs = meta.crs.to_string()
                transform_to_4326 = (
                    f"ST_Transform({geom_col}, '{source_crs}', 'EPSG:4326')"
                )
        except Exception:
            pass

        
        if "point" in geom_type:
            query = f"""
            CREATE OR REPLACE TEMP TABLE {output_table} AS
            WITH features AS (
                SELECT
                    {demand_field}::DOUBLE AS demand_value,
                    {transform_to_4326} AS geom
                FROM {table_name}
                WHERE {geom_col} IS NOT NULL
            ),
            exploded AS (
                SELECT
                    demand_value,
                    (UNNEST(ST_Dump(geom))).geom AS simple_geom
                FROM features
            )
            SELECT
                h3_latlng_to_cell(ST_Y(simple_geom), ST_X(simple_geom), {h3_resolution}) AS orig_id,
                SUM(demand_value) AS demand_value
            FROM exploded
            WHERE simple_geom IS NOT NULL
            GROUP BY orig_id
            """
        elif "polygon" in geom_type or "multipolygon" in geom_type:
            # Optimized: Use ROW_NUMBER and pre-computed cell counts to avoid correlated subquery
            query = f"""
            CREATE OR REPLACE TEMP TABLE {output_table} AS
            WITH features AS (
                SELECT
                    ROW_NUMBER() OVER () AS row_id,
                    {demand_field}::DOUBLE AS demand_value,
                    {transform_to_4326} AS geom
                FROM {table_name}
                WHERE {geom_col} IS NOT NULL
            ),
            polygons AS (
                SELECT
                    row_id,
                    demand_value,
                    (UNNEST(ST_Dump(ST_Force2D(geom)))).geom AS simple_geom
                FROM features
            ),
            h3_cells_raw AS (
                SELECT
                    row_id,
                    demand_value,
                    UNNEST(h3_polygon_wkt_to_cells_experimental(ST_AsText(simple_geom), {h3_resolution}, 'CONTAINMENT_OVERLAPPING')) AS orig_id
                FROM polygons
                WHERE simple_geom IS NOT NULL
            ),
            h3_cells_unique AS (
                SELECT DISTINCT row_id, demand_value, orig_id
                FROM h3_cells_raw
            ),
            h3_counts AS (
                SELECT
                    row_id,
                    COUNT(*) AS num_cells,
                    demand_value
                FROM h3_cells_unique
                GROUP BY row_id, demand_value
            )
            SELECT
                u.orig_id,
                SUM(u.demand_value / hc.num_cells) AS demand_value
            FROM h3_cells_unique u
            JOIN h3_counts hc ON u.row_id = hc.row_id
            WHERE u.orig_id IS NOT NULL
            GROUP BY u.orig_id
            """
        else:
            raise ValueError(f"Unsupported geometry type: '{geom_type}'")

        self.con.execute(query)
        return output_table

    def _compute_capacity_ratios(
        self: Self,
        filtered_matrix: str,
        unified_table: str,
        standardized_tables: list[tuple[str, str]],
        demand_table: str,
        two_sfca_type: TwoSFCAType,
        impedance: ImpedanceFunction | None = None,
        max_sensitivity: float = 1000000,
    ) -> tuple[str, list[str]]:
        """
        Compute capacity ratios for 2SFCA step 1.
        For each opportunity location, calculate:
        ratio = capacity / sum(demand within max_cost)

        If impedance_func is provided (E2SFCA), weights demand by distance decay.
        Otherwise (standard 2SFCA), uses binary in/out of catchment.

        Returns: (capacity_ratios_table, list of safe_names)
        """
        capacity_ratios_table = "capacity_ratios"
        if not standardized_tables:
            raise ValueError("No standardized opportunity tables provided.")

        safe_names = []
        for idx, (_, opp_name) in enumerate(standardized_tables):
            safe_names.append(sanitize_sql_name(opp_name, idx))

        # Build demand sum columns - gravity-style with direct aggregation
        demand_sum_cols = []
        for safe_name in safe_names:
            if (
                two_sfca_type == TwoSFCAType.e2sfca
                or two_sfca_type == TwoSFCAType.m2sfca
            ):
                # E2SFCA/M2SFCA: weight demand by impedance function
                weight = self._impedance_sql(impedance, max_sensitivity, safe_name)
                demand_sum_cols.append(f"""
                    SUM(d.demand_value * {weight}) AS {safe_name}_demand""")
            else:
                # Standard 2SFCA: binary catchment
                demand_sum_cols.append(f"""
                    SUM(d.demand_value) AS {safe_name}_demand""")

        # Build ratio calculations
        ratio_calculations = []
        for safe_name in safe_names:
            ratio_calculations.append(f"""
                o.{safe_name}_capacity / NULLIF(demand_sums.{safe_name}_demand, 0) AS {safe_name}_ratio""")

        # Build WHERE clause for max_cost filtering (gravity-style)
        max_cost_filters = " OR ".join(
            [f"m.cost <= o.{sn}_max_cost" for sn in safe_names]
        )

        query = f"""
            CREATE OR REPLACE TEMP TABLE {capacity_ratios_table} AS
            WITH demand_sums AS (
                SELECT o.dest_id, {','.join(demand_sum_cols)}
                FROM {unified_table} o
                LEFT JOIN {filtered_matrix} m ON m.dest_id = o.dest_id 
                LEFT JOIN {demand_table} d ON m.orig_id = d.orig_id
                WHERE ({max_cost_filters})
                GROUP BY o.dest_id
            )
            SELECT
                o.dest_id,
                {','.join([f"o.{sn}_max_cost" for sn in safe_names])},
                {','.join([f"o.{sn}_sens" for sn in safe_names])},
                {','.join(ratio_calculations)}
            FROM {unified_table} o
            JOIN demand_sums ON o.dest_id = demand_sums.dest_id
        """

        self.con.execute(query)
        logger.info(
            "Computed capacity ratios for %d opportunity types", len(safe_names)
        )
        return capacity_ratios_table, safe_names

    def _impedance_sql(
        self: Self, which: ImpedanceFunction, max_sens: float, opportunity_name: str
    ) -> str:
        """
        Returns the correct SQL formula for the impedance function.
        Updated to use pivoted column names.
        """
        # Reference the pivoted column names
        max_cost_col = f"o.{opportunity_name}_max_cost"
        sens_col = f"o.{opportunity_name}_sens"

        if which == ImpedanceFunction.gaussian:
            return f"""
                    EXP(
                        ((((m.cost / {max_cost_col}) * (m.cost / {max_cost_col})) * -1)
                        / ({sens_col} / {max_sens}))
                    ) 
            """
        elif which == ImpedanceFunction.linear:
            return f"(1 - (m.cost / {max_cost_col}))"
        elif which == ImpedanceFunction.exponential:
            return f"""
                    EXP(
                        ((({sens_col} / {max_sens}) * -1) * (m.cost / {max_cost_col}))
                    )
            """
        elif which == ImpedanceFunction.power:
            return f"""
                    POW(
                        (m.cost / {max_cost_col}),
                        (({sens_col} / {max_sens}) * -1)
                    ) 
            """
        else:
            raise ValueError(f"Unknown impedance function: {which}")
    
    def _compute_cumulative_accessibility(
        self: Self,
        filtered_matrix: str,
        capacity_ratios_table: str,
        safe_names: list[str],
        two_sfca_type: TwoSFCAType,
        impedance: ImpedanceFunction | None = None,
        max_sensitivity: float = 1000000,
    ) -> str:
        """
        Compute cumulative accessibility for 2SFCA step 2.
        For each h3 cell, sum the capacity ratios of all opportunities
        within their respective max cost thresholds.

        If E2SFCA/M2SFCA, weights ratios by distance decay. Otherwise (standard 2SFCA), uses binary in/out of catchment.

        Returns the final 2SFCA result table.
        """
        result_table = "twosfca_final"

        # Build individual opportunity accessibility columns - gravity-style pattern
        accessibility_calculations = []
        sum_expressions = []

        for safe_name in safe_names:
            ratio_col = f"o.{safe_name}_ratio"

            if two_sfca_type == TwoSFCAType.e2sfca:
                # E2SFCA: weight ratio by impedance function
                weight = self._impedance_sql(impedance, max_sensitivity, safe_name)
                accessibility_calculations.append(f"""
                    SUM({ratio_col} * {weight}) AS {safe_name}_accessibility""")
            elif two_sfca_type == TwoSFCAType.m2sfca:
                # M2SFCA: weight ratio by impedance function squared
                weight = self._impedance_sql(impedance, max_sensitivity, safe_name)
                accessibility_calculations.append(f"""
                    SUM({ratio_col} * {weight} * {weight}) AS {safe_name}_accessibility""")
            else:
                # Standard 2SFCA: binary catchment
                accessibility_calculations.append(f"""
                    SUM({ratio_col}) AS {safe_name}_accessibility""")

            sum_expressions.append(f"{safe_name}_accessibility")

        # Build WHERE clause for max_cost filtering (gravity-style)
        max_cost_filters = " OR ".join(
            [f"m.cost <= o.{sn}_max_cost" for sn in safe_names]
        )

        # Total accessibility as sum of all individual accessibilities
        total_accessibility_sql = f"({' + '.join(sum_expressions)}) AS total_accessibility"

        query = f"""
            CREATE OR REPLACE TEMP TABLE {result_table} AS
            SELECT
                m.orig_id AS h3_index,
                {','.join(accessibility_calculations)},
                {total_accessibility_sql}
            FROM {filtered_matrix} m
            JOIN {capacity_ratios_table} o ON m.dest_id = o.dest_id
            WHERE ({max_cost_filters})
              AND ({' OR '.join([f'o.{sn}_ratio IS NOT NULL' for sn in safe_names])})
            GROUP BY m.orig_id
            HAVING total_accessibility IS NOT NULL
        """

        self.con.execute(query)

        schema = self.con.execute(f"DESCRIBE {result_table}").fetchall()
        logger.info("Final 2SFCA result schema: %s", [col[0] for col in schema])

        return result_table