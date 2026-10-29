"""Feature service for GeoJSON queries.

This service retrieves features from DuckLake as GeoJSON.
"""

import json
import logging
import re
from datetime import timedelta
from typing import Any, Optional

from goatlib.storage import build_filters, build_order_clause

from geoapi.config import settings
from geoapi.dependencies import LayerInfo
from geoapi.ducklake_pool import ducklake_pool, execute_with_retry

logger = logging.getLogger(__name__)


def sanitize_string(value: Any) -> Any:
    """Sanitize string values to ensure valid UTF-8.

    Some data may contain invalid UTF-8 bytes (e.g., Latin-1 or Windows-1252).
    This function attempts to fix encoding issues.
    """
    if isinstance(value, bytes):
        # Try UTF-8 first, then fallback to latin-1
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.decode("latin-1", errors="replace")
    elif isinstance(value, str):
        # Re-encode and decode to fix any invalid sequences
        try:
            # Encode to bytes and back to ensure valid UTF-8
            return value.encode("utf-8", errors="surrogatepass").decode(
                "utf-8", errors="replace"
            )
        except (UnicodeDecodeError, UnicodeEncodeError):
            return value.encode("latin-1", errors="replace").decode(
                "utf-8", errors="replace"
            )
    return value


def format_interval(value: timedelta) -> str:
    """An interval as ``HH:MM:SS``, hours past 23 kept (a GTFS time such as
    ``25:10:00``), the same text the items path renders in SQL."""
    total = int(value.total_seconds())
    sign = "-" if total < 0 else ""
    total = abs(total)
    return f"{sign}{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"


def sanitize_properties(properties: dict[str, Any]) -> dict[str, Any]:
    """Sanitize all string values in properties dict and remove hidden fields."""
    return {
        k: format_interval(v) if isinstance(v, timedelta) else sanitize_string(v)
        for k, v in properties.items()
        if k not in settings.HIDDEN_FIELDS
    }


# GeoParquet bbox struct columns get suffixed (bbox_1, bbox_2, ...) when the
# source data already had a column named bbox, so HIDDEN_FIELDS' exact-name
# match alone can't catch them. The STRUCT type check keeps genuine user
# columns that merely share the name.
_BBOX_STRUCT_NAME = re.compile(r"^bbox(_\d+)?$")


def _hidden_columns(native_column_types: Optional[dict[str, str]]) -> set[str]:
    """Internal storage columns that must not be shipped as feature properties."""
    if not native_column_types:
        return set()
    hidden = set()
    for name, native_type in native_column_types.items():
        if name in settings.HIDDEN_FIELDS:
            hidden.add(name)
        elif _BBOX_STRUCT_NAME.match(name) and native_type.upper().startswith("STRUCT"):
            hidden.add(name)
    return hidden


def _qi(name: str) -> str:
    """Quote a SQL identifier, doubling any embedded double quote."""
    return '"' + name.replace('"', '""') + '"'


def build_items_select_clause(
    properties: Optional[list[str]],
    geometry_column: Optional[str],
    has_geometry: bool,
    native_column_types: Optional[dict[str, str]],
) -> str:
    """Build the SELECT clause for the items query.

    Hidden storage columns (GeoParquet bbox structs) and the raw geometry
    column are excluded at the SQL level so they are never read from parquet.
    Explicitly requested properties are honored as-is.
    """
    geom_col = geometry_column if has_geometry else None

    if properties:
        props_set = set(properties)
        select_cols = ", ".join(_qi(p) for p in props_set if p != geom_col)
        if geom_col:
            return f'rowid, {select_cols}, ST_AsGeoJSON("{geom_col}") AS geom_json'
        return f"rowid, {select_cols}"

    excluded = _hidden_columns(native_column_types)
    if geom_col:
        excluded.add(geom_col)
    exclude_sql = (
        " EXCLUDE ({})".format(", ".join(f'"{c}"' for c in sorted(excluded)))
        if excluded
        else ""
    )
    if geom_col:
        return f'rowid, *{exclude_sql}, ST_AsGeoJSON("{geom_col}") AS geom_json'
    return f"rowid, *{exclude_sql}"


def _json_value_expr(column: str, native_type: str) -> str:
    """SQL expression rendering a column as its JSON representation.

    JSON columns are cast so they nest as objects instead of double-encoded
    strings. Timestamps are formatted ISO-8601 with 'T' (and normalized to
    UTC + 'Z' for timestamptz) to match the datetime.isoformat() output of
    the Python serialization path; DuckDB's native JSON cast uses a space
    separator and session-local offsets.
    """
    ident = column.replace('"', '""')
    native = (native_type or "").upper()
    if "JSON" in native:
        return f'CAST("{ident}" AS JSON)'
    if native == "INTERVAL":
        # HH:MM:SS with hours past 23 kept, as `format_interval` does for the
        # single-feature path; DuckDB's own text would say "1 day 01:10:00".
        seconds = f'CAST(epoch("{ident}") AS BIGINT)'
        return (
            f'CASE WHEN "{ident}" IS NOT NULL THEN '
            f"printf('%02d:%02d:%02d', {seconds} // 3600, "
            f"({seconds} % 3600) // 60, {seconds} % 60) END"
        )
    if native.startswith("TIMESTAMP"):
        if "WITH TIME ZONE" in native or native.startswith("TIMESTAMPTZ"):
            return (
                f"strftime(\"{ident}\" AT TIME ZONE 'UTC', "
                f"'%Y-%m-%dT%H:%M:%S.%f') || 'Z'"
            )
        return f"strftime(\"{ident}\", '%Y-%m-%dT%H:%M:%S.%f')"
    return f'"{ident}"'


def build_features_json_query(
    table: str,
    prop_columns: list[str],
    geometry_column: Optional[str],
    where_sql: str,
    sortby: Optional[str],
    limit: int,
    offset: int,
    native_column_types: Optional[dict[str, str]],
) -> str:
    """Build a query that returns (features_json, returned_count).

    The GeoJSON Feature objects are assembled inside DuckDB (vectorized
    json_object + string_agg) instead of row-by-row in Python — for large
    collections this halves serialization cost and avoids materializing
    hundreds of thousands of Python objects. features_json is the
    comma-joined array content without the surrounding brackets ('' when
    empty); the caller splices it into the FeatureCollection envelope.
    """
    types = native_column_types or {}

    inner_cols = ["rowid AS _rowid"]
    inner_cols += [f'"{c.replace(chr(34), chr(34) * 2)}"' for c in prop_columns]
    sort_col = sortby.lstrip("+-") if sortby else None
    if sort_col and sort_col not in prop_columns and sort_col != geometry_column:
        inner_cols.append(f'"{sort_col.replace(chr(34), chr(34) * 2)}"')
    if geometry_column:
        geom_ident = geometry_column.replace('"', '""')
        inner_cols.append(f'ST_AsGeoJSON("{geom_ident}") AS _geom_json')

    pairs = ", ".join(
        f"'{c.replace(chr(39), chr(39) * 2)}', {_json_value_expr(c, types.get(c, ''))}"
        for c in prop_columns
    )
    props_expr = f"json_object({pairs})" if pairs else "CAST('{}' AS JSON)"
    geom_expr = "CAST(_geom_json AS JSON)" if geometry_column else "CAST(NULL AS JSON)"

    # string_agg does not preserve input order on its own, so the sort is
    # restated inside the aggregate; _rowid keeps ties (and the unsorted
    # case) deterministic.
    if sort_col:
        direction = "DESC" if sortby and sortby.startswith("-") else "ASC"
        agg_order = f'"{sort_col.replace(chr(34), chr(34) * 2)}" {direction}, _rowid'
    else:
        agg_order = "_rowid"

    feature_expr = (
        "json_object("
        "'type', 'Feature', "
        "'id', CAST(_rowid + 1 AS VARCHAR), "
        f"'geometry', {geom_expr}, "
        f"'properties', {props_expr}"
        ")::VARCHAR"
    )

    order_clause = build_order_clause(sortby)
    return f"""
        SELECT COALESCE(string_agg({feature_expr}, ',' ORDER BY {agg_order}), ''),
               COUNT(*)
        FROM (
            SELECT {", ".join(inner_cols)}
            FROM {table}
            WHERE {where_sql}
            {order_clause}
            LIMIT {limit} OFFSET {offset}
        ) AS _items
    """


def _json_column_names(native_column_types: Optional[dict[str, str]]) -> set[str]:
    if not native_column_types:
        return set()
    return {n for n, t in native_column_types.items() if "JSON" in t.upper()}


def _parse_json_columns(row_dict: dict[str, Any], json_cols: set[str]) -> None:
    for k in json_cols:
        v = row_dict.get(k)
        if isinstance(v, str):
            row_dict[k] = json.loads(v)


class FeatureService:
    """Service for querying features."""

    def get_features(
        self,
        layer_info: LayerInfo,
        limit: int = 10,
        offset: int = 0,
        bbox: Optional[list[float]] = None,
        properties: Optional[list[str]] = None,
        cql_filter: Optional[dict] = None,
        column_names: Optional[list[str]] = None,
        sortby: Optional[str] = None,
        ids: Optional[list[str]] = None,
        geometry_column: str = "geometry",
        has_geometry: bool = True,
        native_column_types: Optional[dict[str, str]] = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """Get features from a layer.

        Args:
            layer_info: Layer information
            limit: Maximum features to return
            offset: Number of features to skip
            bbox: Bounding box filter [minx, miny, maxx, maxy]
            properties: List of properties to include
            cql_filter: CQL2 filter
            column_names: Available column names for validation
            sortby: Sort column (prefix with - for descending)
            ids: List of feature IDs to filter
            geometry_column: Name of the geometry column
            has_geometry: Whether the layer has a geometry column

        Returns:
            Tuple of (features, total_count)
        """
        table = layer_info.full_table_name
        geom_col = geometry_column if has_geometry else None

        # Always include rowid as the canonical feature identifier
        select_clause = build_items_select_clause(
            properties=properties,
            geometry_column=geometry_column,
            has_geometry=has_geometry,
            native_column_types=native_column_types,
        )

        # Build WHERE clause using shared query builder
        filters = build_filters(
            bbox=bbox,
            cql_filter=cql_filter,
            ids=ids,
            geometry_column=geom_col or "geometry",
            column_names=column_names,
            has_geometry=has_geometry,
        )
        where_sql = filters.to_full_where()
        params = filters.params

        # Build ORDER BY clause
        order_clause = build_order_clause(sortby)

        # Get total count
        count_query = f"SELECT COUNT(*) FROM {table} WHERE {where_sql}"
        logger.debug("Count query: %s with params: %s", count_query, params)
        try:
            count_result, _ = execute_with_retry(
                ducklake_pool,
                count_query,
                params if params else None,
                fetch_all=False,
            )
            total_count = count_result[0] if count_result else 0
        except Exception as e:
            logger.warning("Count query failed: %s", e)
            total_count = 0

        # Get features
        query = f"""
            SELECT {select_clause}
            FROM {table}
            WHERE {where_sql}
            {order_clause}
            LIMIT {limit} OFFSET {offset}
        """
        logger.debug("Feature query: %s with params: %s", query, params)

        features = []
        try:
            result, description = execute_with_retry(
                ducklake_pool, query, params if params else None, fetch_all=True
            )

            # Get column names from description
            col_names = [desc[0] for desc in description]
            json_cols = _json_column_names(native_column_types)

            for idx, row in enumerate(result):
                row_dict = dict(zip(col_names, row))

                # Extract geometry (only if layer has geometry)
                geometry = None
                if has_geometry and geom_col:
                    geom_json = row_dict.pop("geom_json", None)
                    geometry = json.loads(geom_json) if geom_json else None
                    # Remove raw geometry column if present
                    row_dict.pop(geom_col, None)

                # Use rowid+1 as the canonical feature identifier
                # (+1 because MVT feature ID 0 is "unset" in MapLibre)
                raw_rowid = row_dict.pop("rowid", None)
                effective_id = raw_rowid + 1 if raw_rowid is not None else None

                _parse_json_columns(row_dict, json_cols)

                # Sanitize string values to ensure valid UTF-8
                sanitized_props = sanitize_properties(row_dict)

                features.append(
                    {
                        "type": "Feature",
                        "id": str(effective_id) if effective_id is not None else None,
                        "geometry": geometry,
                        "properties": sanitized_props,
                    }
                )
        except Exception as e:
            logger.error(f"Feature query error: {e}", exc_info=True)
            raise

        return features, total_count

    def get_features_json(
        self,
        layer_info: LayerInfo,
        limit: int = 10,
        offset: int = 0,
        bbox: Optional[list[float]] = None,
        properties: Optional[list[str]] = None,
        cql_filter: Optional[dict[str, Any]] = None,
        column_names: Optional[list[str]] = None,
        sortby: Optional[str] = None,
        ids: Optional[list[str]] = None,
        geometry_column: str = "geometry",
        has_geometry: bool = True,
        native_column_types: Optional[dict[str, str]] = None,
    ) -> tuple[str, int, int]:
        """Get features as a pre-serialized GeoJSON array fragment.

        Same filtering/pagination semantics as get_features, but the Feature
        objects are serialized inside DuckDB (see build_features_json_query).

        Returns:
            Tuple of (features_json, returned_count, total_count) where
            features_json is the comma-joined Feature objects without the
            surrounding array brackets ('' when empty).
        """
        table = layer_info.full_table_name
        geom_col = geometry_column if has_geometry else None

        hidden = _hidden_columns(native_column_types)
        if properties:
            prop_cols = [
                p
                for p in properties
                if p != geom_col and p not in settings.HIDDEN_FIELDS
            ]
        else:
            prop_cols = [
                c
                for c in (column_names or [])
                if c != geom_col and c not in hidden and c not in settings.HIDDEN_FIELDS
            ]

        filters = build_filters(
            bbox=bbox,
            cql_filter=cql_filter,
            ids=ids,
            geometry_column=geom_col or "geometry",
            column_names=column_names,
            has_geometry=has_geometry,
        )
        where_sql = filters.to_full_where()
        params = filters.params

        count_query = f"SELECT COUNT(*) FROM {table} WHERE {where_sql}"
        logger.debug("Count query: %s with params: %s", count_query, params)
        try:
            count_result, _ = execute_with_retry(
                ducklake_pool,
                count_query,
                params if params else None,
                fetch_all=False,
            )
            total_count = count_result[0] if count_result else 0
        except Exception as e:
            logger.warning("Count query failed: %s", e)
            total_count = 0

        query = build_features_json_query(
            table=table,
            prop_columns=prop_cols,
            geometry_column=geom_col,
            where_sql=where_sql,
            sortby=sortby,
            limit=limit,
            offset=offset,
            native_column_types=native_column_types,
        )
        logger.debug("Features JSON query: %s with params: %s", query, params)
        try:
            result, _ = execute_with_retry(
                ducklake_pool, query, params if params else None, fetch_all=False
            )
        except Exception as e:
            logger.error(f"Feature query error: {e}", exc_info=True)
            raise

        if not result:
            return "", 0, total_count
        return result[0], result[1], total_count

    def get_feature_by_id(
        self,
        layer_info: LayerInfo,
        feature_id: str,
        properties: Optional[list[str]] = None,
        geometry_column: str = "geometry",
        has_geometry: bool = True,
        column_names: Optional[list[str]] = None,
        native_column_types: Optional[dict[str, str]] = None,
    ) -> Optional[dict[str, Any]]:
        """Get a single feature by rowid."""
        table = layer_info.full_table_name
        geom_col = geometry_column if has_geometry else None

        # Build SELECT clause — always include rowid
        if properties:
            props_set = set(properties)
            select_cols = ", ".join(_qi(p) for p in props_set if p != geom_col)
            if has_geometry and geom_col:
                select_clause = (
                    f'rowid, {select_cols}, ST_AsGeoJSON("{geom_col}") AS geom_json'
                )
            else:
                select_clause = f"rowid, {select_cols}"
        else:
            if has_geometry and geom_col:
                select_clause = f'rowid, *, ST_AsGeoJSON("{geom_col}") AS geom_json'
            else:
                select_clause = "rowid, *"

        query = f"""
            SELECT {select_clause}
            FROM {table}
            WHERE rowid = ?
            LIMIT 1
        """

        try:
            # Convert public feature ID to internal rowid (feature_id = rowid + 1)
            rowid = int(feature_id) - 1
            result, description = execute_with_retry(
                ducklake_pool, query, [rowid], fetch_all=False
            )

            if not result:
                return None

            col_names = [desc[0] for desc in description]
            row_dict = dict(zip(col_names, result))

            # Extract rowid and convert to public feature ID
            raw_rowid = row_dict.pop("rowid", None)
            fid = raw_rowid + 1 if raw_rowid is not None else None

            # Extract geometry
            geometry = None
            if has_geometry and geom_col:
                geom_json = row_dict.pop("geom_json", None)
                geometry = json.loads(geom_json) if geom_json else None
                row_dict.pop(geom_col, None)

            # Remove system columns from properties
            row_dict.pop("bbox", None)

            _parse_json_columns(row_dict, _json_column_names(native_column_types))

            sanitized_props = sanitize_properties(row_dict)

            return {
                "type": "Feature",
                "id": str(fid) if fid is not None else None,
                "geometry": geometry,
                "properties": sanitized_props,
            }
        except Exception as e:
            logger.error(f"Feature by ID error: {e}", exc_info=True)
            return None

    def get_temp_features(
        self,
        user_id: str,
        layer_uuid: str,
        limit: int = 100,
        offset: int = 0,
        bbox: Optional[list[float]] = None,
        properties: Optional[list[str]] = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """Get features from a temporary layer's parquet file.

        Used for workflow preview - searches for t_{layer_uuid}.parquet under user's temp directory.

        Args:
            user_id: User UUID
            layer_uuid: The layer UUID (filename is t_{layer_uuid}.parquet)
            limit: Maximum features to return
            offset: Number of features to skip
            bbox: Bounding box filter [minx, miny, maxx, maxy]
            properties: List of properties to include

        Returns:
            Tuple of (features, total_count)
        """
        from pathlib import Path

        import duckdb

        user_id_clean = user_id.replace("-", "")
        layer_uuid_clean = layer_uuid.replace("-", "")

        # Temp data is in /data/temporary with structure: user_{uuid}/w_{uuid}/n_{uuid}/t_{layer_uuid}.parquet
        temp_data_root = Path(settings.DUCKLAKE_DATA_DIR).parent / "temporary"
        user_path = temp_data_root / f"user_{user_id_clean}"

        # Search for the parquet file by layer_uuid
        parquet_path = None
        if user_path.exists():
            matches = list(user_path.glob(f"**/t_{layer_uuid_clean}.parquet"))
            if matches:
                parquet_path = matches[0]

        if not parquet_path or not parquet_path.exists():
            logger.warning(
                "Temp parquet not found for layer %s under user %s", layer_uuid, user_id
            )
            return [], 0

        try:
            con = duckdb.connect(":memory:")
            con.execute("SET TimeZone='UTC'")
            con.execute("INSTALL spatial; LOAD spatial;")

            # Detect geometry column
            cols = con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{parquet_path}')"
            ).fetchall()
            geom_col = None
            col_names = []
            json_cols: set[str] = set()
            for col_name, col_type, *_ in cols:
                col_names.append(col_name)
                type_upper = col_type.upper()
                if "GEOMETRY" in type_upper:
                    geom_col = col_name
                elif "JSON" in type_upper:
                    json_cols.add(col_name)

            # Build select clause
            if properties:
                select_cols = [
                    f'"{p}"' for p in properties if p != geom_col and p in col_names
                ]
            else:
                select_cols = [f'"{c}"' for c in col_names if c != geom_col]

            if geom_col:
                select_cols.append(f'ST_AsGeoJSON("{geom_col}") AS geom_json')

            select_clause = ", ".join(select_cols) if select_cols else "*"

            # Build WHERE clause (applies to both count and data queries)
            where_clause = "1=1"
            if bbox and geom_col and len(bbox) == 4:
                where_clause = (
                    f'ST_Intersects("{geom_col}", '
                    f"ST_MakeEnvelope({bbox[0]}, {bbox[1]}, {bbox[2]}, {bbox[3]}))"
                )

            # Get total count with the same filter
            count_result = con.execute(
                f"SELECT COUNT(*) FROM read_parquet('{parquet_path}') WHERE {where_clause}"
            ).fetchone()
            total_count = count_result[0] if count_result else 0

            query = f"""
                SELECT {select_clause}
                FROM read_parquet('{parquet_path}')
                WHERE {where_clause}
                LIMIT {limit} OFFSET {offset}
            """

            cursor = con.execute(query)
            description = cursor.description
            results = cursor.fetchall()

            col_names_result = [desc[0] for desc in description]
            features = []
            for row in results:
                row_dict = dict(zip(col_names_result, row))

                # Extract geometry
                geometry = None
                geom_json = row_dict.pop("geom_json", None)
                if geom_json:
                    geometry = json.loads(geom_json)

                # Generate feature ID from row index
                fid = offset + len(features) + 1

                _parse_json_columns(row_dict, json_cols)

                # Sanitize properties
                sanitized_props = sanitize_properties(row_dict)

                features.append(
                    {
                        "type": "Feature",
                        "id": str(fid),
                        "geometry": geometry,
                        "properties": sanitized_props,
                    }
                )

            con.close()
            return features, total_count

        except Exception as e:
            logger.error(f"Temp features error: {e}", exc_info=True)
            return [], 0


# Singleton instance
feature_service = FeatureService()
