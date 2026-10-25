import logging
from pathlib import Path
from typing import List, Optional, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.data_management import (
    JoinOperationType,
    JoinParams,
    JoinType,
    MultipleMatchingRecordsType,
    SpatialRelationshipType,
)
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


def _join_column(name: str) -> str:
    """A join-layer column carried into the result as `join_<name>`; both
    names are user data, so each is one quoted identifier."""
    return f"join_data.{quote_identifier(name)} as {quote_identifier(f'join_{name}')}"


class JoinTool(AnalysisTool):
    """
    JoinTool: Performs spatial and attribute-based joins using DuckDB Spatial.
    """

    def _run_implementation(
        self: Self, params: JoinParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Perform join operation on vector datasets."""

        # Import target and join datasets
        target_meta, target_table = self.import_input(params.target_path, "target")
        join_meta, join_table = self.import_input(params.join_path, "join_data")

        # Validate geometry columns for spatial joins
        if params.use_spatial_relationship:
            target_geom = target_meta.geometry_column
            join_geom = join_meta.geometry_column

            if not target_geom or not join_geom:
                raise ValueError(
                    "Spatial join requires geometry columns in both datasets. "
                    f"Target: {target_geom}, Join: {join_geom}"
                )

        # Define output path
        output_path = Path(params.output_path)

        logger.info(
            "Starting join: target='%s' | join='%s' | spatial=%s | attribute=%s",
            params.target_path,
            params.join_path,
            params.use_spatial_relationship,
            params.use_attribute_relationship,
        )

        # Execute join operation
        self._execute_join(
            params, target_table, join_table, target_meta, join_meta, output_path
        )

        # Determine output geometry type
        output_geometry_type = None
        if target_meta.geometry_column:
            output_geometry_type = target_meta.geometry_type

        # Convert CRS to string if needed
        crs_str = target_meta.crs
        if crs_str is not None and not isinstance(crs_str, str):
            crs_str = str(crs_str)

        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            format="geoparquet",
            crs=crs_str,
            geometry_type=output_geometry_type,
        )

        logger.info("Join completed successfully → %s", output_path)
        return [(output_path, metadata)]

    def _execute_join(
        self: Self,
        params: JoinParams,
        target_table: str,
        join_table: str,
        target_meta: any,
        join_meta: any,
        output_path: Path,
    ) -> None:
        """Execute the join operation in DuckDB."""

        # Disjoint is an anti-semi-join: it doesn't fit the JOIN ON shape (which
        # would duplicate target rows once per non-matching join row). Dispatch
        # before building the regular join machinery, and ignore join_type /
        # join_operation / join_fields / statistics — none apply.
        is_disjoint = (
            params.use_spatial_relationship
            and params.spatial_relationship == SpatialRelationshipType.disjoint
        )

        # Build join condition
        join_conditions = []

        # Add spatial conditions
        if params.use_spatial_relationship:
            if is_disjoint:
                # Inside NOT EXISTS we test for the *match*, so use intersects.
                spatial_condition = (
                    f"ST_Intersects("
                    f"target.{quote_identifier(target_meta.geometry_column)}, "
                    f"join_data.{quote_identifier(join_meta.geometry_column)}"
                    f")"
                )
            else:
                spatial_condition = self._build_spatial_condition(
                    params, target_meta.geometry_column, join_meta.geometry_column
                )
            join_conditions.append(spatial_condition)

        # Add attribute conditions
        if params.use_attribute_relationship:
            for attr_rel in params.attribute_relationships:
                attr_condition = (
                    f"target.{quote_identifier(attr_rel.target_field)} = "
                    f"join_data.{quote_identifier(attr_rel.join_field)}"
                )
                join_conditions.append(attr_condition)

        # Combine all conditions with AND
        full_join_condition = " AND ".join(join_conditions)

        if is_disjoint:
            self._execute_disjoint_filter(
                target_table, join_table, full_join_condition, output_path
            )
            return

        # Determine join type (INNER vs LEFT)
        join_type_sql = (
            "LEFT JOIN" if params.join_type == JoinType.left else "INNER JOIN"
        )

        # Handle different join operations
        if params.join_operation == JoinOperationType.one_to_many:
            self._execute_one_to_many_join(
                params,
                target_table,
                join_table,
                full_join_condition,
                join_type_sql,
                output_path,
            )
        else:
            self._execute_one_to_one_join(
                params,
                target_table,
                join_table,
                full_join_condition,
                join_type_sql,
                output_path,
            )

    def _execute_disjoint_filter(
        self: Self,
        target_table: str,
        join_table: str,
        match_condition: str,
        output_path: Path,
    ) -> None:
        """Anti-semi-join: keep target rows that have no matching join row.

        ``match_condition`` is the would-be join predicate (spatial and/or
        attribute). The result has only target columns — by definition, no
        join row matches so there's nothing to add from the join layer.
        """
        target_fields = self._get_table_fields(target_table, "target")
        select_fields = ", ".join(target_fields)

        query = f"""
            SELECT {select_fields}
            FROM {target_table} target
            WHERE NOT EXISTS (
                SELECT 1 FROM {join_table} join_data
                WHERE {match_condition}
            )
        """

        logger.info("Executing disjoint filter (anti-semi-join)")
        write_optimized_parquet(
            self.con,
            query,
            output_path,
            geometry_column="geometry",
        )

    # Distance unit conversion factors to meters
    DISTANCE_UNIT_FACTORS = {
        "meters": 1.0,
        "kilometers": 1000.0,
        "feet": 0.3048,
        "miles": 1609.344,
        "nautical_miles": 1852.0,
        "yards": 0.9144,
    }

    def _build_spatial_condition(
        self: Self, params: JoinParams, target_geom: str, join_geom: str
    ) -> str:
        """Build spatial relationship condition for SQL."""
        target_geom_ref = f"target.{quote_identifier(target_geom)}"
        join_geom_ref = f"join_data.{quote_identifier(join_geom)}"

        if params.spatial_relationship == SpatialRelationshipType.intersects:
            return f"ST_Intersects({target_geom_ref}, {join_geom_ref})"
        elif params.spatial_relationship == SpatialRelationshipType.within_distance:
            # Convert distance to meters
            distance_meters = params.distance * self.DISTANCE_UNIT_FACTORS.get(
                params.distance_units, 1.0
            )
            # Use UTM transformation for accurate distance in meters.
            # This works for all geometry types (Point, LineString, Polygon, Multi*).
            # Dynamic UTM zone based on target feature centroid.
            wgs84_proj = "'+proj=longlat +datum=WGS84 +no_defs'"
            utm_zone_expr = f"""
                ('EPSG:' || CAST((
                    CASE WHEN ST_Y(ST_Centroid({target_geom_ref})) >= 0 THEN 32600 ELSE 32700 END
                    + CAST(FLOOR((ST_X(ST_Centroid({target_geom_ref})) + 180) / 6) + 1 AS INT)
                ) AS VARCHAR))
            """
            return f"""ST_Distance(
                ST_Transform({target_geom_ref}, {wgs84_proj}, {utm_zone_expr}),
                ST_Transform({join_geom_ref}, {wgs84_proj}, {utm_zone_expr})
            ) <= {distance_meters}"""
        elif params.spatial_relationship == SpatialRelationshipType.identical_to:
            return f"ST_Equals({target_geom_ref}, {join_geom_ref})"
        elif params.spatial_relationship == SpatialRelationshipType.completely_contains:
            return f"ST_Contains({target_geom_ref}, {join_geom_ref})"
        elif params.spatial_relationship == SpatialRelationshipType.completely_within:
            return f"ST_Within({target_geom_ref}, {join_geom_ref})"
        elif params.spatial_relationship == SpatialRelationshipType.touches:
            return f"ST_Touches({target_geom_ref}, {join_geom_ref})"
        elif params.spatial_relationship == SpatialRelationshipType.overlaps:
            return f"ST_Overlaps({target_geom_ref}, {join_geom_ref})"
        elif params.spatial_relationship == SpatialRelationshipType.covers:
            return f"ST_Covers({target_geom_ref}, {join_geom_ref})"
        elif params.spatial_relationship == SpatialRelationshipType.covered_by:
            return f"ST_CoveredBy({target_geom_ref}, {join_geom_ref})"
        else:
            raise ValueError(
                f"Unsupported spatial relationship: {params.spatial_relationship}"
            )

    def _execute_one_to_many_join(
        self: Self,
        params: JoinParams,
        target_table: str,
        join_table: str,
        join_condition: str,
        join_type_sql: str,
        output_path: Path,
    ) -> None:
        """Execute one-to-many join (preserves all matching records)."""
        con = self.con

        # Build select clause with prefixed join fields to avoid conflicts
        target_fields = self._get_table_fields(target_table, "target")
        join_cols = self._filter_join_columns(
            self._get_raw_field_names(join_table),
            params.join_fields,
        )
        join_fields = [_join_column(c) for c in join_cols]

        # When all join fields are filtered out, the SELECT must still be valid
        select_fields = ", ".join(target_fields + join_fields)

        query = f"""
            SELECT {select_fields}
            FROM {target_table} target
            {join_type_sql} {join_table} join_data
            ON {join_condition}
        """

        logger.info("Executing one-to-many join")
        write_optimized_parquet(
            con,
            query,
            output_path,
            geometry_column="geometry",
        )

    def _execute_one_to_one_join(
        self: Self,
        params: JoinParams,
        target_table: str,
        join_table: str,
        join_condition: str,
        join_type_sql: str,
        output_path: Path,
    ) -> None:
        """Execute one-to-one join with multiple matching records handling."""

        if params.multiple_matching_records == MultipleMatchingRecordsType.first_record:
            self._execute_first_record_join(
                params,
                target_table,
                join_table,
                join_condition,
                join_type_sql,
                output_path,
            )
        elif (
            params.multiple_matching_records
            == MultipleMatchingRecordsType.calculate_statistics
        ):
            self._execute_statistical_join(
                params,
                target_table,
                join_table,
                join_condition,
                join_type_sql,
                output_path,
            )
        else:  # count_only
            self._execute_count_only_join(
                params,
                target_table,
                join_table,
                join_condition,
                join_type_sql,
                output_path,
            )

    def _execute_first_record_join(
        self: Self,
        params: JoinParams,
        target_table: str,
        join_table: str,
        join_condition: str,
        join_type_sql: str,
        output_path: Path,
    ) -> None:
        """Execute join keeping only first matching record per target feature."""
        con = self.con

        # Determine sort order for selecting first record
        # If sort_configuration is provided, use it; otherwise use row order for deterministic ordering
        if params.sort_configuration:
            order_direction = (
                "DESC"
                if params.sort_configuration.sort_order == "descending"
                else "ASC"
            )
            order_field = (
                f"join_data.{quote_identifier(params.sort_configuration.field)}"
            )
        else:
            # Add a row number column to the join table for deterministic ordering
            # since rowid pseudo-column isn't available in JOINs
            con.execute(f"""
                CREATE OR REPLACE TEMP TABLE {join_table}_with_rn AS
                SELECT *, ROW_NUMBER() OVER () as __join_row_order
                FROM {join_table}
            """)
            join_table = f"{join_table}_with_rn"
            order_field = "join_data.__join_row_order"

        order_clause = (
            f"ORDER BY {order_field} ASC"
            if not params.sort_configuration
            else f"ORDER BY {order_field} {order_direction}"
        )

        target_fields = self._get_table_fields(target_table, "target")
        # Strip internal row-order column from user-visible columns; ORDER BY
        # references it directly via join_data.__join_row_order regardless.
        join_cols_all = [
            c for c in self._get_raw_field_names(join_table) if c != "__join_row_order"
        ]
        join_cols = self._filter_join_columns(join_cols_all, params.join_fields)
        join_fields = [_join_column(c) for c in join_cols]

        all_select_fields = ", ".join(target_fields + join_fields)

        # Create window function to rank matches
        con.execute(f"""
        CREATE OR REPLACE TEMP TABLE ranked_joins AS
        WITH joined_data AS (
            SELECT {all_select_fields},
                   ROW_NUMBER() OVER (
                       PARTITION BY {self._get_target_key_fields(target_table)}
                       {order_clause}
                   ) as rn
            FROM {target_table} target
            {join_type_sql} {join_table} join_data
            ON {join_condition}
        )
        SELECT * EXCLUDE (rn)
        FROM joined_data
        WHERE rn = 1
        """)

        write_optimized_parquet(
            con,
            "ranked_joins",
            output_path,
            geometry_column="geometry",
        )

    def _execute_statistical_join(
        self: Self,
        params: JoinParams,
        target_table: str,
        join_table: str,
        join_condition: str,
        join_type_sql: str,
        output_path: Path,
    ) -> None:
        """Execute join with statistical aggregation of multiple matches."""
        con = self.con

        # Get a column from the join table to use for counting.
        # COUNT(join_col) returns 0 for unmatched LEFT JOIN rows (NULL values),
        # unlike COUNT(*) which returns 1 for the phantom target row.
        join_fields = self._get_raw_field_names(join_table)
        join_count_col = f"join_data.{quote_identifier(join_fields[0])}"

        # Build aggregation expressions
        agg_expressions = []
        has_count = False

        for field_stat in params.field_statistics:
            operation = field_stat.operation
            # A result name is user-given: one quoted identifier.
            result_col = quote_identifier(field_stat.get_result_column_name())
            if operation.value == "count":
                # Count actual join matches using a specific join column
                agg_expressions.append(f"COUNT({join_count_col}) as {result_col}")
                has_count = True
            else:
                field_name = field_stat.field
                field_ref = f"join_data.{quote_identifier(field_name)}"
                agg_expr = self.get_statistics_sql(field_ref, operation.value)
                agg_expressions.append(f"{agg_expr} as {result_col}")

        # Always include a match count if not already specified
        if not has_count:
            agg_expressions.insert(0, f"COUNT({join_count_col}) as match_count")

        agg_clause = ", ".join(agg_expressions)

        target_select = ", ".join(
            f"target.{quote_identifier(f)}"
            for f in self._get_raw_field_names(target_table)
        )

        query = f"""
        CREATE OR REPLACE TEMP TABLE aggregated_joins AS
        SELECT {target_select},
               {agg_clause}
        FROM {target_table} target
        {join_type_sql} {join_table} join_data
        ON {join_condition}
        GROUP BY {target_select}
        """

        con.execute(query)
        write_optimized_parquet(
            con,
            "aggregated_joins",
            output_path,
            geometry_column="geometry",
        )

    def _execute_count_only_join(
        self: Self,
        params: JoinParams,
        target_table: str,
        join_table: str,
        join_condition: str,
        join_type_sql: str,
        output_path: Path,
    ) -> None:
        """Execute join with only count of matches."""
        con = self.con

        # Get custom result column name if specified in field_statistics
        count_col = "match_count"
        if params.field_statistics:
            for field_stat in params.field_statistics:
                if field_stat.operation.value == "count":
                    count_col = field_stat.get_result_column_name()
                    break

        # Use a specific join column for counting.
        join_fields = self._get_raw_field_names(join_table)
        join_count_col = f"join_data.{quote_identifier(join_fields[0])}"

        target_select = ", ".join(
            f"target.{quote_identifier(f)}"
            for f in self._get_raw_field_names(target_table)
        )

        query = f"""
        CREATE OR REPLACE TEMP TABLE count_joins AS
        SELECT {target_select},
               COUNT({join_count_col}) as {quote_identifier(count_col)}
        FROM {target_table} target
        {join_type_sql} {join_table} join_data
        ON {join_condition}
        GROUP BY {target_select}
        """

        con.execute(query)
        write_optimized_parquet(
            con,
            "count_joins",
            output_path,
            geometry_column="geometry",
        )

    def _filter_join_columns(
        self: Self,
        columns: List[str],
        join_fields: Optional[List[str]],
    ) -> List[str]:
        """Filter join columns by user-selected join_fields.

        ``None`` means "not specified" → keep every column (real join).
        ``[]`` is an explicit "keep none" → filter-only / semi-join.
        """
        if join_fields is None:
            return list(columns)
        if not join_fields:
            return []
        keep = set(join_fields)
        return [c for c in columns if c in keep]

    def _get_table_fields(
        self: Self, table_name: str, alias: str, prefix: str = ""
    ) -> List[str]:
        """Get formatted field list for SELECT clause."""
        con = self.con

        # Get column names
        result = con.execute(f"PRAGMA table_info({table_name})").fetchall()
        columns = [row[1] for row in result]  # Column name is at index 1

        formatted_fields = []
        for col in columns:
            ref = f"{alias}.{quote_identifier(col)}"
            if prefix:
                formatted_fields.append(
                    f"{ref} as {quote_identifier(f'{prefix}{col}')}"
                )
            else:
                formatted_fields.append(ref)

        return formatted_fields

    def _get_raw_field_names(self: Self, table_name: str) -> List[str]:
        """Get raw field names for GROUP BY clauses."""
        con = self.con
        result = con.execute(f"PRAGMA table_info({table_name})").fetchall()
        return [row[1] for row in result]  # Column name is at index 1

    def _get_target_key_fields(self: Self, table_name: str) -> str:
        """Get target key fields for partitioning in window functions."""
        # For now, use all fields. In a more sophisticated implementation,
        # we could detect primary key or use geometry column + a subset of fields
        fields = self._get_raw_field_names(table_name)
        return ", ".join(f"target.{quote_identifier(f)}" for f in fields)
