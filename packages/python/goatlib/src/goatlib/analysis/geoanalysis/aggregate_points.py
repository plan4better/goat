"""Aggregate Points Tool.

This module provides a tool for aggregating point features onto polygons or H3 grids,
computing statistics like count, sum, mean, min, or max of point attributes.
"""

import logging
from pathlib import Path
from typing import List, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.aggregate import (
    AggregatePointsParams,
    AggregationAreaType,
)
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class AggregatePointsTool(AnalysisTool):
    """Tool for aggregating point features onto polygons or H3 grids.

    This tool performs spatial aggregation of point data, similar to GOAT Core's
    aggregate_point functionality. It supports:
    - Aggregation onto polygon layers (spatial join)
    - Aggregation onto H3 hexagonal grids
    - Statistical operations: count, sum, mean, min, max
    - Optional grouping by field(s) in the source layer

    Example:
        tool = AggregatePointsTool()
        results = tool.run(AggregatePointsParams(
            source_path="/data/points.parquet",
            area_type="polygon",
            area_layer_path="/data/districts.parquet",
            column_statistics=ColumnStatistic(operation="sum", field="population"),
            output_path="/data/aggregated.parquet",
        ))
    """

    def __init__(self: Self, db_path: Path | None = None) -> None:
        """Initialize the aggregate points tool."""
        super().__init__(db_path=db_path)
        self._setup_h3_extension()

    def _setup_h3_extension(self: Self) -> None:
        """Install H3 extension for hexagonal grid support."""
        self.con.execute("INSTALL h3 FROM community; LOAD h3;")
        logger.debug("H3 extension loaded.")

    def _run_implementation(
        self: Self, params: AggregatePointsParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Execute point aggregation.

        Args:
            params: Aggregation parameters

        Returns:
            List containing tuple of (output_path, metadata)
        """
        logger.info(
            "Starting point aggregation: source=%s, area_type=%s",
            params.source_path,
            params.area_type.value,
        )

        # Import source point layer
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
        params: AggregatePointsParams,
        source_view: str,
        source_geom: str,
    ) -> None:
        """Aggregate points onto polygon layer.

        Args:
            params: Aggregation parameters
            source_view: Name of the source points view
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
        agg_specs = self._build_agg_specs(params, source_prefix="s.")
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

        # A dissolved area is one multipolygon whose bounding box covers every
        # point; its parts have their own, smaller boxes for the spatial join.
        # A point on an edge two parts share matches both, so the pairs are
        # made distinct before anything is aggregated.
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE area_parts AS
            SELECT area_id, UNNEST(ST_Dump({area_g})).geom AS part
            FROM area_with_id
        """)
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE source_numbered AS
            SELECT ROW_NUMBER() OVER () AS __aggregate_point_id, * FROM {source_view}
        """)
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE area_points AS
            SELECT DISTINCT p.area_id, s.__aggregate_point_id
            FROM area_parts p
            JOIN source_numbered s ON ST_Intersects(p.part, s.{source_g})
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
                    ap.area_id,
                    {group_col_concat} AS group_name,
                    {total_select}
                FROM area_points ap
                JOIN source_numbered s
                ON s.__aggregate_point_id = ap.__aggregate_point_id
                GROUP BY ap.area_id, {group_cols}
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
                SELECT ap.area_id, {total_select}
                FROM area_points ap
                JOIN source_numbered s
                ON s.__aggregate_point_id = ap.__aggregate_point_id
                GROUP BY ap.area_id
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
                SELECT ap.area_id, {total_select}
                FROM area_points ap
                JOIN source_numbered s
                ON s.__aggregate_point_id = ap.__aggregate_point_id
                GROUP BY ap.area_id
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

    def _aggregate_to_h3(
        self: Self,
        params: AggregatePointsParams,
        source_view: str,
        source_geom: str,
    ) -> None:
        """Aggregate points onto H3 hexagonal grid.

        Args:
            params: Aggregation parameters
            source_view: Name of the source points view
            source_geom: Name of the source geometry column
        """
        h3_resolution = params.h3_resolution

        agg_specs = self._build_agg_specs(params, source_prefix="")
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
        params: AggregatePointsParams,
        source_prefix: str = "",
    ) -> List[Tuple[str, str]]:
        """Return [(result_col, sql_expr), ...] — one per FieldStatistic entry."""
        specs: list[Tuple[str, str]] = []
        for stat in params.column_statistics:
            source_field = stat.field or ""
            field_expr = (
                f"{source_prefix}{quote_identifier(source_field)}"
                if source_field
                else ""
            )
            sql_expr = self.get_statistics_sql(field_expr, stat.operation.value)
            specs.append((stat.get_result_column_name(), sql_expr))
        return specs
