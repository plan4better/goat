"""Analytics service for synchronous statistics operations.

Uses goatlib statistics functions to compute analytics on DuckLake layers.
These are synchronous operations that return immediate results.
"""

import json
import logging
import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

import duckdb
from fastapi import HTTPException
from goatlib.analysis.statistics import (
    AreaOperation,
    ClassBreakMethod,
    HistogramBreakMethod,
    SortOrder,
    StatisticsOperation,
    calculate_aggregation_stats,
    calculate_area_statistics,
    calculate_class_breaks,
    calculate_extent,
    calculate_feature_count,
    calculate_histogram,
    calculate_unique_values,
    search_layer_features,
)
from goatlib.storage import build_cql_filter, load_extensions
from goatlib.utils.layer import (
    catalog_layer_parquet,
    catalog_layer_relation,
    catalog_view_sql,
    format_uuid,
    is_catalog_relation,
    table_path_parts,
)
from goatlib.utils.sql_validation import validate_sql_query

from processes.dependencies import (
    _layer_id_to_table_name,
    get_schema_for_layer,
    normalize_layer_id,
)
from processes.ducklake import (
    ducklake_manager,
    mirror_cursor,
    preview_ducklake_manager,
    search_ducklake_manager,
)
from processes.services.public_search_config import get_public_search_layers

logger = logging.getLogger(__name__)


class AnalyticsService:
    """Service for computing analytics on DuckLake layers."""

    SEARCH_TIME_BUDGET_SECONDS = 8.0

    def _get_table_name(self, collection: str) -> str:
        """The relation a collection/layer ID is read from.

        Two shapes, because layers have two homes. An ordinary layer is a
        DuckLake table (`lake.<schema>.t_<id>`). A promoted catalog layer is
        one parquet file in the shared catalog layers directory, read through a
        `catalog_layers."t_<id>"` view — it was never registered in the
        DuckLake catalog, so resolving it there answers `404 Layer not found`.
        The file's existence is the signal, exactly as geoapi's resolver treats
        it.

        Args:
            collection: Layer ID (UUID format)

        Returns:
            'lake.user_xxx.t_layerid' or 'catalog_layers."t_layerid"'
        """
        layer_id = normalize_layer_id(collection)
        if catalog_layer_parquet(layer_id) is not None:
            relation: str = catalog_layer_relation(layer_id)
            return relation
        schema_name = get_schema_for_layer(layer_id)
        table_name = _layer_id_to_table_name(layer_id)
        return f"lake.{schema_name}.{table_name}"

    def _ensure_catalog_view(
        self, con: duckdb.DuckDBPyConnection, table_name: str
    ) -> None:
        """Create the view a catalog relation needs, on this connection.

        A no-op for a DuckLake table. The view is per-connection state and a
        single analytics call opens several connections, so this runs at every
        one rather than once per layer.
        """
        if not is_catalog_relation(table_name):
            return
        _, table = table_path_parts(table_name)
        layer_id = format_uuid(table.removeprefix("t_"))
        path = catalog_layer_parquet(layer_id)
        if path is None:
            raise HTTPException(
                status_code=404,
                detail=f"Layer not found: {layer_id}",
            )
        for statement in catalog_view_sql(layer_id, path):
            con.execute(statement)

    @contextmanager
    def _connection(
        self, table_name: str, manager: Any = None
    ) -> Iterator[duckdb.DuckDBPyConnection]:
        """A connection that can read `table_name`, whichever home it has."""
        with (manager or ducklake_manager).connection() as con:
            self._ensure_catalog_view(con, table_name)
            yield con

    def _get_column_names(self, table_name: str) -> list[str]:
        """Get column names for a table.

        Args:
            table_name: Full table name

        Returns:
            List of column names
        """
        with self._connection(table_name) as con:
            result = con.execute(f"DESCRIBE {table_name}").fetchall()
            return [row[0] for row in result]

    def _detect_geometry_column(self, table_name: str) -> str:
        """Detect the geometry column name for a table.

        Args:
            table_name: Full table name

        Returns:
            Geometry column name (defaults to 'geometry')
        """
        with self._connection(table_name) as con:
            result = con.execute(f"DESCRIBE {table_name}").fetchall()
            for row in result:
                col_name, col_type = row[0], row[1]
                if "GEOMETRY" in col_type.upper():
                    return col_name
        return "geometry"

    def _build_where_clause(
        self,
        filter_expr: str | None,
        table_name: str,
        geometry_column: str = "geometry",
    ) -> tuple[str, list[Any]]:
        """Build SQL WHERE clause from CQL2 filter.

        Args:
            filter_expr: CQL2 filter expression (JSON string) or None
            table_name: Full table name (for getting column names)
            geometry_column: Name of geometry column

        Returns:
            Tuple of (where_clause, params)
        """
        if not filter_expr:
            return "TRUE", []

        try:
            # Parse the filter JSON string
            if isinstance(filter_expr, str):
                filter_dict = json.loads(filter_expr)
            else:
                filter_dict = filter_expr

            # Get column names and detect geometry column from the table
            with self._connection(table_name) as con:
                result = con.execute(f"DESCRIBE {table_name}").fetchall()
                column_names = [row[0] for row in result]
                column_types = {row[0]: row[1] for row in result}

            # Detect geometry column name (could be 'geom', 'geometry', etc.)
            geometry_column = "geometry"  # default
            for col_name, col_type in column_types.items():
                if "geometry" in col_type.lower() or col_name.lower() in (
                    "geom",
                    "geometry",
                ):
                    geometry_column = col_name
                    break

            # Build CQL filter with proper structure
            cql_filter = {"filter": filter_dict, "lang": "cql2-json"}
            query_filters = build_cql_filter(
                cql_filter,
                column_names,
                geometry_column=geometry_column,
            )

            where_clause = query_filters.to_full_where(default="TRUE")
            params = query_filters.params

            logger.debug("CQL filter built: %s with params %s", where_clause, params)
            return where_clause, params

        except json.JSONDecodeError as e:
            logger.warning("Failed to parse filter JSON '%s': %s", filter_expr, e)
            return "TRUE", []
        except Exception as e:
            logger.warning("Failed to build filter '%s': %s", filter_expr, e)
            return "TRUE", []

    def feature_count(
        self,
        collection: str,
        filter_expr: str | None = None,
    ) -> dict[str, Any]:
        """Count features in a collection.

        Args:
            collection: Layer ID
            filter_expr: Optional CQL2 filter

        Returns:
            Dict with 'count' key
        """
        table_name = self._get_table_name(collection)
        geometry_column = self._detect_geometry_column(table_name)
        where_clause, params = self._build_where_clause(
            filter_expr, table_name, geometry_column
        )

        with self._connection(table_name) as con:
            result = calculate_feature_count(
                con,
                table_name,
                where_clause=where_clause,
                params=params if params else None,
            )

        return result.model_dump()

    def unique_values(
        self,
        collection: str,
        attribute: str,
        order: str = "descendent",
        filter_expr: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        """Get unique values for an attribute.

        Args:
            collection: Layer ID
            attribute: Column name
            order: Sort order ('ascendent' or 'descendent')
            filter_expr: Optional CQL2 filter
            limit: Maximum values to return
            offset: Pagination offset

        Returns:
            Dict with attribute, total, and values
        """
        table_name = self._get_table_name(collection)
        geometry_column = self._detect_geometry_column(table_name)
        where_clause, params = self._build_where_clause(
            filter_expr, table_name, geometry_column
        )

        # Map string to enum
        sort_order = SortOrder.descendent
        if order == "ascendent":
            sort_order = SortOrder.ascendent

        with self._connection(table_name) as con:
            result = calculate_unique_values(
                con,
                table_name,
                attribute,
                where_clause=where_clause,
                params=params if params else None,
                order=sort_order,
                limit=limit,
                offset=offset,
            )

        return result.model_dump()

    def mirror_values(
        self,
        area: dict,
        feature_type: str = "points",
        key: str | None = None,
        limit: int = 100,
        source: str = "osm",
        quick: bool = False,
        size_only: bool = False,
    ) -> dict[str, Any]:
        """Attributes, or one attribute's values, in the mirror for an area."""
        from goatlib.tools.data_integration import mirror_values

        with mirror_cursor() as con:
            return mirror_values(
                con,
                area=area,
                feature_type=feature_type,
                key=key,
                limit=limit,
                source_name=source,
                quick=quick,
                size_only=size_only,
            )

    def class_breaks(
        self,
        collection: str,
        attribute: str,
        method: str = "quantile",
        breaks: int = 5,
        filter_expr: str | None = None,
        strip_zeros: bool = False,
    ) -> dict[str, Any]:
        """Calculate class breaks for a numeric attribute.

        Args:
            collection: Layer ID
            attribute: Numeric column name
            method: Classification method
            breaks: Number of breaks
            filter_expr: Optional CQL2 filter
            strip_zeros: Exclude zero values

        Returns:
            Dict with breaks, min, max, mean, std_dev
        """
        table_name = self._get_table_name(collection)
        geometry_column = self._detect_geometry_column(table_name)
        where_clause, params = self._build_where_clause(
            filter_expr, table_name, geometry_column
        )

        # Map string to enum
        break_method = ClassBreakMethod.quantile
        if method in ClassBreakMethod.__members__:
            break_method = ClassBreakMethod(method)

        with self._connection(table_name) as con:
            result = calculate_class_breaks(
                con,
                table_name,
                attribute,
                method=break_method,
                num_breaks=breaks,
                where_clause=where_clause,
                params=params if params else None,
                strip_zeros=strip_zeros,
            )

        return result.model_dump()

    def area_statistics(
        self,
        collection: str,
        operation: str = "sum",
        filter_expr: str | None = None,
    ) -> dict[str, Any]:
        """Calculate area statistics for polygon features.

        Args:
            collection: Layer ID
            operation: Statistical operation (sum, mean, min, max)
            filter_expr: Optional CQL2 filter

        Returns:
            Dict with result, total_area, feature_count, unit
        """
        table_name = self._get_table_name(collection)
        geometry_column = self._detect_geometry_column(table_name)
        where_clause, params = self._build_where_clause(
            filter_expr, table_name, geometry_column
        )

        # Map string to enum
        area_op = AreaOperation.sum
        if operation in AreaOperation.__members__:
            area_op = AreaOperation(operation)

        with self._connection(table_name) as con:
            result = calculate_area_statistics(
                con,
                table_name,
                geometry_column=geometry_column,
                operation=area_op,
                where_clause=where_clause,
                params=params if params else None,
            )

        return result.model_dump()

    def extent(
        self,
        collection: str,
        filter_expr: str | None = None,
    ) -> dict[str, Any]:
        """Calculate bounding box extent for features.

        Args:
            collection: Layer ID
            filter_expr: Optional CQL2 filter

        Returns:
            Dict with bbox [minx, miny, maxx, maxy] and feature_count
        """
        table_name = self._get_table_name(collection)
        geometry_column = self._detect_geometry_column(table_name)
        where_clause, params = self._build_where_clause(
            filter_expr, table_name, geometry_column
        )

        logger.debug(
            "Extent query: table=%s, geom_col=%s, where=%s, params=%s",
            table_name,
            geometry_column,
            where_clause,
            params,
        )

        with self._connection(table_name) as con:
            result = calculate_extent(
                con,
                table_name,
                geometry_column=geometry_column,
                where_clause=where_clause,
                params=params if params else None,
            )
        return result.model_dump()

    def aggregation_stats(
        self,
        collection: str,
        operation: str = "count",
        operation_column: str | None = None,
        group_by_column: str | None = None,
        group_by_secondary_column: str | None = None,
        filter_expr: str | None = None,
        order: str = "descendent",
        limit: int = 100,
    ) -> dict[str, Any]:
        """Calculate aggregation statistics with optional grouping.

        Args:
            collection: Layer ID
            operation: Statistical operation (count, sum, mean, min, max, expression)
            operation_column: Column to perform the operation on. For 'expression', this
                contains the raw SQL expression.
            group_by_column: Optional column to group results by
            group_by_secondary_column: Optional secondary column for two-level grouping
            filter_expr: Optional CQL2 filter
            order: Sort order (ascendent or descendent)
            limit: Maximum number of grouped values to return

        Returns:
            Dict with items, total_items, and total_count
        """
        table_name = self._get_table_name(collection)
        where_clause, params = self._build_where_clause(filter_expr, table_name)

        # Map string to enum
        stats_op = StatisticsOperation.count
        if operation in StatisticsOperation.__members__:
            stats_op = StatisticsOperation(operation)

        # Validate expression if operation is expression
        if stats_op == StatisticsOperation.expression:
            if not operation_column:
                raise ValueError(
                    "operation_column (expression) is required for operation 'expression'"
                )
            # Import validator to validate the expression
            from goatlib.utils.expressions import ExpressionValidator

            column_names = self._get_column_names(table_name)
            validator = ExpressionValidator(column_names=column_names)
            validation = validator.validate(operation_column)
            if not validation.valid:
                error_messages = [e.message for e in validation.errors]
                raise ValueError(f"Invalid expression: {'; '.join(error_messages)}")

        sort_order = SortOrder.descendent
        if order == "ascendent":
            sort_order = SortOrder.ascendent

        with self._connection(table_name) as con:
            result = calculate_aggregation_stats(
                con,
                table_name,
                operation=stats_op,
                operation_column=operation_column,
                group_by_column=group_by_column,
                group_by_secondary_column=group_by_secondary_column,
                where_clause=where_clause,
                params=params if params else None,
                order=sort_order,
                limit=limit,
            )

        return result.model_dump()

    def histogram(
        self,
        collection: str,
        column: str,
        num_bins: int = 10,
        method: str = "equal_interval",
        custom_breaks: list[float] | None = None,
        filter_expr: str | None = None,
        order: str = "ascendent",
    ) -> dict[str, Any]:
        """Calculate histogram for a numeric column.

        Args:
            collection: Layer ID
            column: Numeric column name
            num_bins: Number of histogram bins
            method: Histogram binning method
            custom_breaks: Optional custom internal break points
            filter_expr: Optional CQL2 filter
            order: Sort order of bins (ascendent or descendent)

        Returns:
            Dict with bins, missing_count, and total_rows
        """
        table_name = self._get_table_name(collection)
        where_clause, params = self._build_where_clause(filter_expr, table_name)

        sort_order = SortOrder.ascendent
        if order == "descendent":
            sort_order = SortOrder.descendent

        histogram_method = HistogramBreakMethod.equal_interval
        if method in HistogramBreakMethod.__members__:
            histogram_method = HistogramBreakMethod(method)

        with self._connection(table_name) as con:
            result = calculate_histogram(
                con,
                table_name,
                column=column,
                num_bins=num_bins,
                method=histogram_method,
                custom_breaks=custom_breaks,
                where_clause=where_clause,
                params=params if params else None,
                order=sort_order,
            )

        return result.model_dump()

    def _scan_one_layer(
        self,
        spec: dict[str, Any],
        query: str,
        map_center: list[float] | None,
    ) -> dict[str, Any]:
        """Scan a single layer; returns a LayerSearchGroup dict.

        Uses `search_ducklake_manager` (a connection pool separate from the
        analytics/preview ones) and a single connection for both the geometry
        column detection and the search itself, to avoid two lock acquisitions
        per layer.
        """
        table_name = self._get_table_name(spec["layer_id"])
        with self._connection(table_name, search_ducklake_manager) as con:
            geometry_column = "geometry"
            for row in con.execute(f"DESCRIBE {table_name}").fetchall():
                col_name, col_type = row[0], row[1]
                if "GEOMETRY" in col_type.upper():
                    geometry_column = col_name
                    break
            group = search_layer_features(
                con,
                table_name,
                query=query,
                columns=spec["columns"],
                layer_id=spec["layer_id"],
                label_column=spec.get("label_column"),
                geometry_column=geometry_column,
                map_center=tuple(map_center) if map_center else None,
                limit=spec.get("limit", 5),
            )
        return group.model_dump()

    def layer_search(
        self,
        query: str,
        map_center: list[float] | None = None,
        project_id: str | None = None,
        layers: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Search feature attributes across layers (see LayerSearchProcessInput)."""
        specs: list[dict[str, Any]]
        if layers is not None:
            specs = layers
        else:
            try:
                specs = [dict(s) for s in get_public_search_layers(project_id or "")]
            except ValueError:
                raise  # invalid project_id (bad UUID): loud 400/422
            except Exception as e:
                # Infra failures here (e.g. duckdb.IOException when Postgres is
                # unreachable) can carry the FULL connection URI, including the
                # password, in their message. Never let str(e) reach a caller —
                # this endpoint is unauthenticated.
                logger.error(
                    "get_public_search_layers failed for project %s: %s",
                    project_id,
                    e,
                )
                raise HTTPException(
                    status_code=503,
                    detail={
                        "type": "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/job-execution-failed",
                        "title": "Service unavailable",
                        "status": 503,
                        "detail": "search temporarily unavailable",
                    },
                ) from None

        groups: list[dict[str, Any]] = []
        start = time.monotonic()
        for spec in specs:
            if time.monotonic() - start > self.SEARCH_TIME_BUDGET_SECONDS:
                groups.append(
                    {
                        "layer_id": spec["layer_id"],
                        "results": [],
                        "truncated": False,
                        "timed_out": True,
                        "error": None,
                    }
                )
                continue
            try:
                groups.append(self._scan_one_layer(spec, query, map_center))
            except ValueError:
                raise  # unknown column: loud 400 (author misconfiguration)
            except Exception as e:  # missing table etc. — degrade per-group
                logger.warning("layer-search failed for %s: %s", spec["layer_id"], e)
                groups.append(
                    {
                        "layer_id": spec["layer_id"],
                        "results": [],
                        "truncated": False,
                        "timed_out": False,
                        # Generic on purpose: raw DuckDB messages (e.g. "Did you
                        # mean t_<uuid>") can leak other layer IDs to an
                        # unauthenticated caller.
                        "error": "layer unavailable",
                    }
                )
        return {"groups": groups}

    def validate_sql(
        self,
        sql_query: str,
        table_schemas: dict[str, dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        """Validate a SQL SELECT statement against provided table schemas.

        Args:
            sql_query: The SQL SELECT statement to validate
            table_schemas: Table schemas: {alias: {column_name: duckdb_type}}

        Returns:
            Dict with valid, errors, columns
        """
        # Step 1: Basic SQL security validation; only the given tables
        try:
            validate_sql_query(sql_query, (table_schemas or {}).keys())
        except ValueError as e:
            return {"valid": False, "errors": [str(e)], "columns": {}}

        # Step 2: Schema validation — create mock tables and execute with LIMIT 0
        if not table_schemas:
            return {"valid": True, "errors": [], "columns": {}}

        con = duckdb.connect()
        try:
            load_extensions(con, "spatial")

            for alias, columns in table_schemas.items():
                if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", alias):
                    return {
                        "valid": False,
                        "errors": [f"Invalid table alias: {alias}"],
                        "columns": {},
                    }

                col_defs = []
                if columns:
                    for col_name, col_type in columns.items():
                        # Validate column name to prevent SQL injection
                        if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_ ]*$", col_name):
                            return {
                                "valid": False,
                                "errors": [f"Invalid column name: {col_name}"],
                                "columns": {},
                            }
                        # Validate type string to prevent SQL injection
                        if not re.match(r"^[a-zA-Z0-9_ ()\[\],]+$", col_type):
                            return {
                                "valid": False,
                                "errors": [f"Invalid column type: {col_type}"],
                                "columns": {},
                            }
                        if "GEOMETRY" in col_type.upper():
                            col_defs.append(f'"{col_name}" GEOMETRY')
                        else:
                            col_defs.append(f'"{col_name}" {col_type}')

                if not col_defs:
                    # Schema not yet available — create table with placeholder
                    col_defs = ['"_placeholder" INTEGER']

                create_sql = f'CREATE TABLE "{alias}" ({", ".join(col_defs)})'
                con.execute(create_sql)

            # Execute with LIMIT 0 to validate and get output schema
            limited_sql = f"SELECT * FROM ({sql_query}) _v LIMIT 0"
            con.execute(limited_sql)

            # Get output column types via DESCRIBE
            describe_result = con.execute(
                f"DESCRIBE SELECT * FROM ({sql_query}) _v LIMIT 0"
            )
            output_columns: dict[str, str] = {}
            for row in describe_result.fetchall():
                output_columns[row[0]] = row[1]

            return {"valid": True, "errors": [], "columns": output_columns}

        except duckdb.Error as e:
            return {"valid": False, "errors": [str(e)], "columns": {}}
        except Exception as e:
            logger.warning("SQL validation error: %s", e)
            return {"valid": False, "errors": [str(e)], "columns": {}}
        finally:
            con.close()

    def _find_temp_parquet(self, temp_uuid: str, user_id: UUID | None) -> str | None:
        """Find one of the caller's own temp parquet files by its UUID.

        Searches DATA_DIR/temporary/user_<caller>/ for t_{uuid}.parquet: temp
        layers are per-user workflow results, and another user's are never
        the caller's to read. An anonymous caller has none.

        Args:
            temp_uuid: The temp file UUID (hex, no dashes)
            user_id: The caller

        Returns:
            Path to parquet file as string, or None if not found
        """
        import os
        from pathlib import Path

        if user_id is None:
            return None
        temp_root = (
            Path(os.getenv("DATA_DIR", "/app/data"))
            / "temporary"
            / f"user_{str(user_id).replace('-', '')}"
        )
        if not temp_root.exists():
            return None

        clean_uuid = temp_uuid.replace("-", "")
        if not re.fullmatch(r"[0-9a-fA-F]{32}", clean_uuid):
            return None
        matches = list(temp_root.glob(f"**/t_{clean_uuid}.parquet"))
        if matches:
            return str(matches[0])
        return None

    def _build_where_clause_in_con(
        self,
        con: duckdb.DuckDBPyConnection,
        view_name: str,
        filter_expr: str | None,
    ) -> tuple[str, list[Any]]:
        """Build a SQL WHERE clause from a CQL2 filter using an existing DuckDB connection."""
        if not filter_expr:
            return "TRUE", []

        try:
            filter_dict = (
                json.loads(filter_expr) if isinstance(filter_expr, str) else filter_expr
            )

            result = con.execute(f'DESCRIBE "{view_name}"').fetchall()
            column_names = [row[0] for row in result]
            column_types = {row[0]: row[1] for row in result}

            geometry_column = "geometry"
            for col_name, col_type in column_types.items():
                if "GEOMETRY" in col_type.upper() or col_name.lower() in (
                    "geom",
                    "geometry",
                ):
                    geometry_column = col_name
                    break

            cql_filter_obj = {"filter": filter_dict, "lang": "cql2-json"}
            query_filters = build_cql_filter(
                cql_filter_obj, column_names, geometry_column=geometry_column
            )
            return query_filters.to_full_where(default="TRUE"), query_filters.params
        except Exception as e:
            logger.warning("Failed to build WHERE clause for '%s': %s", view_name, e)
            return "TRUE", []

    def _create_alias_view(
        self,
        con: duckdb.DuckDBPyConnection,
        alias: str,
        source_sql: str,
        filter_expr: str | None,
    ) -> None:
        """Create a named view for a layer alias, with an optional CQL2 filter applied.

        TEMP, so the view belongs to this cursor alone: pooled cursors share
        one database, and a plain `input_1` view could be replaced by another
        request's between this request creating it and reading it.
        """
        if not filter_expr:
            con.execute(f'CREATE OR REPLACE TEMP VIEW "{alias}" AS {source_sql}')
            return

        src_alias = f"_src_{alias}"
        con.execute(f'CREATE OR REPLACE TEMP VIEW "{src_alias}" AS {source_sql}')

        where_clause, params = self._build_where_clause_in_con(
            con, src_alias, filter_expr
        )

        if where_clause == "TRUE":
            con.execute(f'CREATE OR REPLACE TEMP VIEW "{alias}" AS {source_sql}')
        else:
            try:
                filt_table = f"_filt_{alias}"
                con.execute(f'DROP TABLE IF EXISTS "{filt_table}"')
                con.execute(
                    f'CREATE TEMP TABLE "{filt_table}" AS '
                    f'SELECT * FROM "{src_alias}" WHERE {where_clause}',
                    params if params else [],
                )
                con.execute(
                    f'CREATE OR REPLACE TEMP VIEW "{alias}" AS SELECT * FROM "{filt_table}"'
                )
            except Exception as e:
                logger.warning(
                    "Failed to apply filter to alias '%s', using unfiltered: %s",
                    alias,
                    e,
                )
                con.execute(f'CREATE OR REPLACE TEMP VIEW "{alias}" AS {source_sql}')

    def preview_sql(
        self,
        sql_query: str,
        layers: dict[str, str],
        limit: int = 10,
        offset: int = 0,
        filter_expr: str | None = None,
        user_id: UUID | None = None,
    ) -> dict[str, Any]:
        """Preview a SQL query against actual layer data.

        Loads each referenced layer from DuckLake (or temp parquet) as a named
        view in an in-memory DuckDB connection, then executes the query with a LIMIT.

        Layer IDs can be:
        - Regular UUID: resolved from DuckLake
        - "temp:<uuid>": read from temp parquet file in DATA_DIR/temporary/

        Args:
            sql_query: The SQL SELECT statement to preview
            layers: Layer mapping {alias: layer_id}
            limit: Max rows to return
            offset: Number of rows to skip
            filter_expr: Optional CQL2-JSON filter to pre-filter source layer data

        Returns:
            Dict with success, columns, rows, error
        """
        # Validate SQL first: it runs on a connection with DuckLake attached,
        # so it may read only the layers it declares, by their aliases.
        try:
            validate_sql_query(sql_query, (layers or {}).keys())
        except ValueError as e:
            return {"success": False, "columns": [], "rows": [], "error": str(e)}

        if not layers:
            return {
                "success": False,
                "columns": [],
                "rows": [],
                "error": "No layers provided for preview",
            }

        # Separate temp layers from DuckLake layers up front so we know which
        # views to clean up even if an error occurs mid-setup.
        temp_layers: dict[str, str] = {}
        ducklake_layers: dict[str, str] = {}
        for alias, layer_id in layers.items():
            if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", alias):
                return {
                    "success": False,
                    "columns": [],
                    "rows": [],
                    "error": f"Invalid table alias: {alias}",
                }
            if layer_id.startswith("temp:"):
                temp_layers[alias] = layer_id[5:]  # strip "temp:" prefix
            else:
                ducklake_layers[alias] = layer_id

        created_views: list[str] = []
        with preview_ducklake_manager.connection() as con:
            try:
                # Load temp layers from parquet files
                for alias, temp_uuid in temp_layers.items():
                    parquet_path = self._find_temp_parquet(temp_uuid, user_id)
                    if not parquet_path:
                        return {
                            "success": False,
                            "columns": [],
                            "rows": [],
                            "error": f"Temp layer {alias} not found (may have been cleaned up). "
                            f"Re-run the workflow to regenerate.",
                        }
                    try:
                        self._create_alias_view(
                            con,
                            alias,
                            f"SELECT * FROM read_parquet('{parquet_path}')",
                            filter_expr,
                        )
                        created_views.append(alias)
                    except Exception as e:
                        return {
                            "success": False,
                            "columns": [],
                            "rows": [],
                            "error": f"Failed to load temp layer {alias}: {e}",
                        }

                for alias, layer_id in ducklake_layers.items():
                    try:
                        full_table = self._get_table_name(layer_id)
                        self._ensure_catalog_view(con, full_table)
                    except Exception as e:
                        return {
                            "success": False,
                            "columns": [],
                            "rows": [],
                            "error": f"Layer {alias} ({layer_id}): {e}",
                        }

                    try:
                        self._create_alias_view(
                            con,
                            alias,
                            f"SELECT * FROM {full_table}",
                            filter_expr,
                        )
                        created_views.append(alias)
                    except Exception as e:
                        return {
                            "success": False,
                            "columns": [],
                            "rows": [],
                            "error": f"Failed to load layer {alias}: {e}",
                        }

                # Execute the query with limit+1 to detect whether more rows exist
                # without a full COUNT(*) scan (which would hold the shared lock
                # for the entire table scan duration and block other analytics queries).
                fetch_limit = max(int(limit), 1)
                limited_sql = (
                    f"SELECT * FROM ({sql_query}) _preview "
                    f"LIMIT {fetch_limit + 1} OFFSET {max(int(offset), 0)}"
                )
                rows_data = con.execute(limited_sql).fetchall()

                # Derive column names from the result cursor
                description = con.description or []
                columns: list[dict[str, str]] = [
                    {"name": col[0], "type": str(col[1]) if col[1] else "VARCHAR"}
                    for col in description
                ]

                has_more = len(rows_data) > fetch_limit
                rows_data = rows_data[:fetch_limit]

                col_names = [c["name"] for c in columns]
                rows: list[dict[str, Any]] = []
                for row_tuple in rows_data:
                    values: dict[str, Any] = {}
                    for i, val in enumerate(row_tuple):
                        col_name = col_names[i] if i < len(col_names) else f"col_{i}"
                        if hasattr(val, "wkt"):
                            values[col_name] = val.wkt
                        elif val is None:
                            values[col_name] = None
                        else:
                            try:
                                values[col_name] = (
                                    val
                                    if isinstance(val, (str, int, float, bool))
                                    else str(val)
                                )
                            except Exception:
                                values[col_name] = str(val)
                    rows.append({"values": values})

                return {
                    "success": True,
                    "columns": columns,
                    "rows": rows,
                    "total_count": None,
                    "has_more": has_more,
                }

            except duckdb.Error as e:
                return {"success": False, "columns": [], "rows": [], "error": str(e)}
            except Exception as e:
                logger.exception("Error previewing SQL")
                return {"success": False, "columns": [], "rows": [], "error": str(e)}
            finally:
                for alias in created_views:
                    try:
                        con.execute(f'DROP VIEW IF EXISTS "{alias}"')
                    except Exception:
                        pass
                    try:
                        con.execute(f'DROP VIEW IF EXISTS "_src_{alias}"')
                    except Exception:
                        pass
                    try:
                        con.execute(f'DROP TABLE IF EXISTS "_filt_{alias}"')
                    except Exception:
                        pass


# Singleton instance
analytics_service = AnalyticsService()
