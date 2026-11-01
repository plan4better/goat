"""Aggregate Polygon Tool.

This module provides a tool for aggregating polygon features onto polygons or H3 grids,
computing statistics like count, sum, mean, min, or max of polygon attributes.

The key difference from AggregatePointsTool is support for:
- Polygon source layers instead of points
- Weighted statistics based on intersection area ratio
"""

import logging
from pathlib import Path
from typing import List, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.aggregate import (
    AggregatePolygonParams,
    AggregationAreaType,
)
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class AggregatePolygonTool(AnalysisTool):
    """Tool for aggregating polygon features onto polygons or H3 grids.

    This tool performs spatial aggregation of polygon data, similar to GOAT Core's
    aggregate_polygon functionality. It supports:
    - Aggregation onto polygon layers (spatial join)
    - Aggregation onto H3 hexagonal grids
    - Statistical operations: count, sum, mean, min, max
    - Optional weighting by intersection area ratio
    - Optional grouping by field(s) in the source layer

    Example:
        tool = AggregatePolygonTool()
        results = tool.run(AggregatePolygonParams(
            source_path="/data/landuse.parquet",
            area_type="polygon",
            area_layer_path="/data/districts.parquet",
            column_statistics=ColumnStatistic(operation="sum", field="area_sqm"),
            weighted_by_intersecting_area=True,
            output_path="/data/aggregated.parquet",
        ))
    """

    def __init__(self: Self, db_path: Path | None = None) -> None:
        """Initialize the aggregate polygon tool."""
        super().__init__(db_path=db_path)
        self._setup_h3_extension()

    def _setup_h3_extension(self: Self) -> None:
        """Install H3 extension for hexagonal grid support."""
        self.con.execute("INSTALL h3 FROM community; LOAD h3;")
        logger.debug("H3 extension loaded.")

    def _run_implementation(
        self: Self, params: AggregatePolygonParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Execute polygon aggregation.

        Args:
            params: Aggregation parameters

        Returns:
            List containing tuple of (output_path, metadata)
        """
        logger.info(
            "Starting polygon aggregation: source=%s, area_type=%s, weighted=%s",
            params.source_path,
            params.area_type.value,
            params.weighted_by_intersecting_area,
        )

        # Import source polygon layer
        source_meta, source_view = self.import_input(params.source_path, "source_data")
        source_geom = source_meta.geometry_column

        if not source_geom:
            raise ValueError("The source layer has no geometry column.")

        # Validate source geometry types
        self.validate_geometry_types(
            source_view,
            source_geom,
            params.accepted_source_geometry_types,
            "source",
        )

        # Get CRS from source metadata
        crs = source_meta.crs
        if crs:
            crs_str = crs.to_string()
        else:
            crs_str = params.output_crs or "EPSG:4326"
            logger.warning(
                "Could not detect CRS for %s, using fallback: %s",
                params.source_path,
                crs_str,
            )

        # Define output path
        if not params.output_path:
            params.output_path = str(
                Path(params.source_path).parent
                / f"{Path(params.source_path).stem}_aggregated.parquet"
            )
        output_path = Path(params.output_path)

        # Execute aggregation based on area type
        if params.area_type == AggregationAreaType.polygon:
            self._aggregate_to_polygon(params, source_view, source_geom)
        else:
            self._aggregate_to_h3(params, source_view, source_geom)

        # Export results
        write_optimized_parquet(
            self.con,
            "aggregation_result",
            output_path,
            geometry_column="geometry",
        )

        logger.info("Aggregation completed. Output: %s", output_path)

        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Polygon",
            crs=crs_str,
        )

        return [(output_path, metadata)]

    def _aggregate_to_polygon(
        self: Self,
        params: AggregatePolygonParams,
        source_view: str,
        source_geom: str,
    ) -> None:
        """Aggregate polygons onto polygon layer.

        Args:
            params: Aggregation parameters
            source_view: Name of the source polygons view
            source_geom: Name of the source geometry column
        """
        # Import area layer
        area_meta, area_view = self.import_input(params.area_layer_path, "area_data")
        area_geom = area_meta.geometry_column

        if not area_geom:
            raise ValueError("The area layer has no geometry column.")

        # Validate area geometry types
        self.validate_geometry_types(
            area_view,
            area_geom,
            params.accepted_area_geometry_types,
            "area",
        )

        # Geometry columns are named by the data: quoted identifiers.
        area_g = quote_identifier(area_geom)
        source_g = quote_identifier(source_geom)
        agg_specs = self._build_agg_specs(params, source_geom, area_geom)
        # Result names are user-given: each one, and each name derived
        # from one, goes into SQL as one quoted identifier.
        stat_cols = [
            (quote_identifier(col), quote_identifier(f"{col}_grouped"), sql)
            for col, sql in agg_specs
        ]
        total_select = ", ".join(f"{sql} AS {col}" for col, _, sql in stat_cols)
        coalesced_total_select = ", ".join(
            f"COALESCE(t.{col}, 0) AS {col}" for col, _, _ in stat_cols
        )

        # DESCRIBE reads only this view; unqualified information_schema
        # spans every attached catalog and lazily loads all lake tables.
        area_columns = self.con.execute(f'DESCRIBE "{area_view}"').fetchall()
        area_col_names = [
            row[0] for row in area_columns if row[0] not in (area_geom, "bbox")
        ]
        area_select_with_prefix = ", ".join(
            f"a.{quote_identifier(col)}" for col in area_col_names
        )

        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE area_with_id AS
            SELECT
                ROW_NUMBER() OVER () AS area_id,
                *
            FROM {area_view}
        """)

        if params.group_by_field:
            group_cols = ", ".join(
                f"s.{quote_identifier(col)}" for col in params.group_by_field
            )
            group_col_concat = " || '_' || ".join(
                [
                    f"CAST(s.{quote_identifier(col)} AS VARCHAR)"
                    for col in params.group_by_field
                ]
            )

            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE grouped_stats AS
                SELECT
                    a.area_id,
                    {group_col_concat} AS group_name,
                    {total_select}
                FROM area_with_id a
                JOIN {source_view} s
                ON ST_Intersects(a.{area_g}, s.{source_g})
                GROUP BY a.area_id, {group_cols}
            """)

            grouped_json_select = ", ".join(
                f"JSON_GROUP_OBJECT(group_name, {col}) AS {grouped}"
                for col, grouped, _ in stat_cols
            )
            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE grouped_json AS
                SELECT area_id, {grouped_json_select}
                FROM grouped_stats
                GROUP BY area_id
            """)

            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE total_stats AS
                SELECT a.area_id, {total_select}
                FROM area_with_id a
                JOIN {source_view} s
                ON ST_Intersects(a.{area_g}, s.{source_g})
                GROUP BY a.area_id
            """)

            grouped_proj = ", ".join(
                f"g.{grouped} AS {grouped}" for _, grouped, _ in stat_cols
            )
            select_parts = [f"a.{area_g} AS geometry"]
            if area_select_with_prefix:
                select_parts.append(area_select_with_prefix)
            select_parts.append(coalesced_total_select)
            select_parts.append(grouped_proj)
            self.con.execute(f"""
                CREATE OR REPLACE TABLE aggregation_result AS
                SELECT
                    {", ".join(select_parts)}
                FROM area_with_id a
                LEFT JOIN total_stats t ON a.area_id = t.area_id
                LEFT JOIN grouped_json g ON a.area_id = g.area_id
            """)
        else:
            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE total_stats AS
                SELECT a.area_id, {total_select}
                FROM area_with_id a
                JOIN {source_view} s
                ON ST_Intersects(a.{area_g}, s.{source_g})
                GROUP BY a.area_id
            """)

            select_parts = [f"a.{area_g} AS geometry"]
            if area_select_with_prefix:
                select_parts.append(area_select_with_prefix)
            select_parts.append(coalesced_total_select)
            self.con.execute(f"""
                CREATE OR REPLACE TABLE aggregation_result AS
                SELECT
                    {", ".join(select_parts)}
                FROM area_with_id a
                LEFT JOIN total_stats t ON a.area_id = t.area_id
            """)

        logger.info(
            "Polygon aggregation completed with %d output stat columns", len(agg_specs)
        )

    def _get_weighted_statistics_sql(
        self: Self,
        field: str,
        operation: str,
        source_geom: str,
        area_geom: str,
    ) -> str:
        """Generate SQL for weighted statistics based on intersection area.

        The weight is calculated as:
        intersection_area / source_area

        This ensures that if a source polygon is split across multiple area polygons,
        the values are proportionally distributed.

        Args:
            field: Field name to compute statistics on
            operation: Statistical operation (sum, mean, min, max, count)
            source_geom: Source geometry column name
            area_geom: Area geometry column name

        Returns:
            SQL expression for weighted statistics
        """
        area_g = quote_identifier(area_geom)
        source_g = quote_identifier(source_geom)
        # For count, we can weight by area ratio
        if operation == "count":
            return f"""
                SUM(
                    ST_Area(ST_Intersection(a.{area_g}, s.{source_g})) /
                    NULLIF(ST_Area(s.{source_g}), 0)
                )
            """

        # For sum, multiply by area ratio
        if operation == "sum":
            return f"""
                SUM(
                    {field} *
                    ST_Area(ST_Intersection(a.{area_g}, s.{source_g})) /
                    NULLIF(ST_Area(s.{source_g}), 0)
                )
            """

        # For mean, use weighted average
        if operation in ("mean", "avg"):
            return f"""
                SUM(
                    {field} *
                    ST_Area(ST_Intersection(a.{area_g}, s.{source_g})) /
                    NULLIF(ST_Area(s.{source_g}), 0)
                ) /
                NULLIF(SUM(
                    ST_Area(ST_Intersection(a.{area_g}, s.{source_g})) /
                    NULLIF(ST_Area(s.{source_g}), 0)
                ), 0)
            """

        # For min/max, weighting doesn't make sense - use simple statistics
        return self.get_statistics_sql(field, operation)

    def _aggregate_to_h3(
        self: Self,
        params: AggregatePolygonParams,
        source_view: str,
        source_geom: str,
    ) -> None:
        """Aggregate polygons onto H3 hexagonal grid.

        For polygons, we use the centroid to determine which H3 cell the polygon
        belongs to, similar to how points are handled.

        Args:
            params: Aggregation parameters
            source_view: Name of the source polygons view
            source_geom: Name of the source geometry column
        """
        h3_resolution = params.h3_resolution

        agg_specs = self._build_agg_specs(
            params, source_geom="", area_geom="", source_prefix=""
        )
        # Result names are user-given: each one, and each name derived
        # from one, goes into SQL as one quoted identifier.
        stat_cols = [
            (quote_identifier(col), quote_identifier(f"{col}_grouped"), sql)
            for col, sql in agg_specs
        ]
        total_select = ", ".join(f"{sql} AS {col}" for col, _, sql in stat_cols)
        source_g = quote_identifier(source_geom)
        h3_cell_expr = (
            f"h3_latlng_to_cell("
            f"ST_Y(ST_Centroid({source_g})), "
            f"ST_X(ST_Centroid({source_g})), "
            f"{h3_resolution})"
        )

        if params.group_by_field:
            group_cols = ", ".join(
                quote_identifier(col) for col in params.group_by_field
            )
            group_col_concat = " || '_' || ".join(
                [
                    f"CAST({quote_identifier(col)} AS VARCHAR)"
                    for col in params.group_by_field
                ]
            )

            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE grouped_stats AS
                SELECT
                    {h3_cell_expr} AS h3_index,
                    {group_col_concat} AS group_name,
                    {total_select}
                FROM {source_view}
                GROUP BY {h3_cell_expr}, {group_cols}
            """)

            grouped_json_select = ", ".join(
                f"JSON_GROUP_OBJECT(group_name, {col}) AS {grouped}"
                for col, grouped, _ in stat_cols
            )
            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE grouped_json AS
                SELECT h3_index, {grouped_json_select}
                FROM grouped_stats
                GROUP BY h3_index
            """)

            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE total_stats AS
                SELECT {h3_cell_expr} AS h3_index, {total_select}
                FROM {source_view}
                GROUP BY {h3_cell_expr}
            """)

            total_proj = ", ".join(f"t.{col} AS {col}" for col, _, _ in stat_cols)
            grouped_proj = ", ".join(
                f"g.{grouped} AS {grouped}" for _, grouped, _ in stat_cols
            )
            select_parts = [
                "ST_GeomFromText(h3_cell_to_boundary_wkt(t.h3_index)) AS geometry",
                f"h3_h3_to_string(t.h3_index) AS h3_{h3_resolution}",
                total_proj,
                grouped_proj,
            ]
            self.con.execute(f"""
                CREATE OR REPLACE TABLE aggregation_result AS
                SELECT
                    {", ".join(select_parts)}
                FROM total_stats t
                LEFT JOIN grouped_json g ON t.h3_index = g.h3_index
            """)
        else:
            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE total_stats AS
                SELECT {h3_cell_expr} AS h3_index, {total_select}
                FROM {source_view}
                GROUP BY {h3_cell_expr}
            """)

            total_proj = ", ".join(f"{col} AS {col}" for col, _, _ in stat_cols)
            select_parts = [
                "ST_GeomFromText(h3_cell_to_boundary_wkt(h3_index)) AS geometry",
                f"h3_h3_to_string(h3_index) AS h3_{h3_resolution}",
                total_proj,
            ]
            self.con.execute(f"""
                CREATE OR REPLACE TABLE aggregation_result AS
                SELECT
                    {", ".join(select_parts)}
                FROM total_stats
            """)

        logger.info(
            "H3 aggregation completed at resolution %d with %d output stat columns",
            h3_resolution,
            len(agg_specs),
        )

    def _build_agg_specs(
        self: Self,
        params: AggregatePolygonParams,
        source_geom: str,
        area_geom: str,
        source_prefix: str = "s.",
    ) -> List[Tuple[str, str]]:
        """Return [(result_col, sql_expr), ...] — one per FieldStatistic entry.

        Output columns are named by
        ``FieldStatistic.get_operation_first_column_name``. Pass empty
        ``source_geom``/``area_geom`` to skip area-weighted SQL (used for H3
        mode).
        """
        specs: list[Tuple[str, str]] = []
        weighted = params.weighted_by_intersecting_area and source_geom and area_geom
        for stat in params.column_statistics:
            field = stat.field or ""
            qualified = f"{source_prefix}{quote_identifier(field)}" if field else ""
            if weighted and field:
                sql_expr = self._get_weighted_statistics_sql(
                    qualified,
                    stat.operation.value,
                    source_geom,
                    area_geom,
                )
            else:
                sql_expr = self.get_statistics_sql(qualified, stat.operation.value)
            specs.append((stat.get_operation_first_column_name(), sql_expr))
        return specs
