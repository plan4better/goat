import logging
from pathlib import Path
from typing import TYPE_CHECKING, List, Optional, Self, Tuple

if TYPE_CHECKING:
    import duckdb

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.geoprocessing import BufferParams, DistanceType
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata
from goatlib.utils.helper import UNIT_TO_METERS

logger = logging.getLogger(__name__)


class BufferTool(AnalysisTool):
    """
    BufferTool: Buffers geometries by fixed or per-feature distances using DuckDB Spatial.
    """

    def _run_implementation(
        self: Self, params: BufferParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Perform buffer operation on a vector dataset."""

        # --- Import directly into DuckDB
        meta, table_name = self.import_input(params.input_path)
        geom_col = meta.geometry_column
        crs = meta.crs

        if not geom_col:
            raise ValueError("The input layer has no geometry column.")

        # Fallback to output_crs (default EPSG:4326) if CRS not detected
        # This happens when exporting from DuckLake which doesn't preserve GeoParquet metadata
        if crs:
            crs_str = crs.to_string()
        else:
            crs_str = params.output_crs or "EPSG:4326"
            logger.warning(
                "Could not detect CRS for %s, using fallback: %s",
                params.input_path,
                crs_str,
            )

        # --- Define output path
        if not params.output_path:
            params.output_path = str(
                Path(params.input_path).parent
                / f"{Path(params.input_path).stem}_buffer.parquet"
            )
        output_path = Path(params.output_path)
        logger.info(
            "Starting buffer: %s | table='%s' | geometry='%s' | CRS=%s",
            params.input_path,
            table_name,
            geom_col,
            crs_str,
        )

        # --- Execute buffer operation
        self._execute_buffer(params, table_name, geom_col, crs_str, output_path)

        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            format="geoparquet",
            crs=crs_str or params.output_crs,
            geometry_type="Polygon",
        )

        logger.info("Buffer completed successfully → %s", output_path)
        return [(output_path, metadata)]

    def _execute_buffer(
        self: Self,
        params: BufferParams,
        table_name: str,
        geom_col: str,
        input_crs_str: Optional[str],
        output_path: Path,
    ) -> None:
        """Execute the buffer operation in DuckDB.

        Supports:
        - Constant distances (list of distances applied to all features)
        - Field-based distances (per-feature distance from a column)
        - Polygon difference (incremental rings between distance steps)
        - Dissolve (merge overlapping buffers)
        """
        con = self.con
        unit_multiplier = UNIT_TO_METERS[params.units]

        work_view = "v_work"
        con.execute(
            f"""
            CREATE OR REPLACE VIEW {work_view} AS
            SELECT * EXCLUDE ({geom_col}),
                {geom_col} AS geom
            FROM {table_name}
            """
        )

        opts = (
            f"quad_segs => {params.num_triangles}, "
            f"endcap_style => '{params.cap_style}', "
            f"join_style => '{params.join_style}', "
            f"mitre_limit => {params.mitre_limit}"
        )

        # --- Geodesic Buffering Logic (Dynamic UTM)
        # 1. Ensure WGS84 (Force Long/Lat axis order)
        wgs84_proj = "'+proj=longlat +datum=WGS84 +no_defs'"

        if input_crs_str and input_crs_str != "EPSG:4326":
            geom_wgs84 = f"ST_Transform(geom, '{input_crs_str}', {wgs84_proj})"
        else:
            geom_wgs84 = "geom"

        # 2. Dynamic UTM Zone Expression based on Centroid
        utm_zone_expr = f"""
            ('EPSG:' || CAST((
                CASE WHEN ST_Y(ST_Centroid({geom_wgs84})) >= 0 THEN 32600 ELSE 32700 END
                + CAST(FLOOR((ST_X(ST_Centroid({geom_wgs84})) + 180) / 6) + 1 AS INT)
            ) AS VARCHAR))
        """

        # 3. Buffer expression template (distance placeholder)
        buffer_expr_template = f"""
            ST_Transform(
                ST_Buffer(
                    ST_Transform({geom_wgs84}, {wgs84_proj}, {utm_zone_expr}),
                    {{dist_expr}},
                    {opts}
                ),
                {utm_zone_expr},
                {wgs84_proj}
            )
        """

        # --- Handle distance_field vs constant distances
        if params.distance_type == DistanceType.field and params.distance_field:
            # Per-feature buffer using a field value
            dist_expr = f'"{params.distance_field}" * {unit_multiplier}'
            buffer_expr = buffer_expr_template.format(dist_expr=dist_expr)

            con.execute(
                f"""
                CREATE OR REPLACE TEMP TABLE buffers AS
                SELECT * EXCLUDE (geom),
                    "{params.distance_field}" AS buffer_distance,
                    {buffer_expr} AS geometry
                FROM {work_view}
                WHERE "{params.distance_field}" IS NOT NULL
                  AND "{params.distance_field}" > 0
                """
            )
        else:
            # Constant distances - create multiple buffers per feature
            distances_m = [d * unit_multiplier for d in (params.distances or [])]

            buffer_tables = []
            for i, dist in enumerate(sorted(distances_m)):
                tmp = f"buf_{i}"
                buffer_expr = buffer_expr_template.format(dist_expr=str(dist))
                # Store as integer for ordinal styling
                dist_int = int(round(dist))

                con.execute(
                    f"""
                    CREATE OR REPLACE TEMP TABLE {tmp} AS
                    SELECT * EXCLUDE (geom),
                        {dist_int} AS buffer_distance,
                        {buffer_expr} AS geometry
                    FROM {work_view}
                    """
                )
                buffer_tables.append(tmp)

            con.execute(
                "CREATE OR REPLACE TEMP TABLE buffers AS "
                + " UNION ALL ".join(f"SELECT * FROM {t}" for t in buffer_tables)
            )

        # --- Optional polygon union (merge overlapping buffers at same distance)
        # Must happen BEFORE polygon difference
        source = "buffers"
        polygon_union = getattr(params, "polygon_union", False)
        if polygon_union:
            # When merging, group by buffer_distance to preserve the rings
            con.execute(
                f"""
                CREATE OR REPLACE TEMP TABLE dissolved AS
                SELECT buffer_distance,
                    ST_Union_Agg(geometry) AS geometry
                FROM {source}
                GROUP BY buffer_distance
                """
            )
            source = "dissolved"

        # --- Optional polygon difference (incremental rings)
        # Must happen AFTER polygon union to get clean rings
        polygon_difference = getattr(params, "polygon_difference", False)

        if (
            polygon_difference
            and polygon_union  # Difference only makes sense with union
            and params.distance_type == DistanceType.constant
            and params.distances
            and len(params.distances) > 1
        ):
            # Create difference polygons - subtract smaller buffer from larger
            # After union, we have one geometry per buffer_distance
            con.execute(
                f"""
                CREATE OR REPLACE TEMP TABLE diff_buffers AS
                WITH ordered AS (
                    SELECT *,
                        LAG(geometry) OVER (ORDER BY buffer_distance) AS prev_geometry
                    FROM {source}
                ),
                diffed AS (
                    SELECT buffer_distance,
                        CASE
                            WHEN prev_geometry IS NULL THEN geometry
                            ELSE ST_Difference(geometry, prev_geometry)
                        END AS geometry
                    FROM ordered
                )
                SELECT * FROM diffed
                """
            )
            source = "diff_buffers"

        # --- Reproject back to input CRS if needed
        if input_crs_str and input_crs_str != "EPSG:4326":
            con.execute(
                f"""
                CREATE OR REPLACE TEMP TABLE final_buffers AS
                SELECT * EXCLUDE (geometry),
                    ST_Transform(geometry, {wgs84_proj}, '{input_crs_str}') AS geometry
                FROM {source}
                """
            )
            source = "final_buffers"

        write_optimized_parquet(
            con,
            source,
            output_path,
            geometry_column="geometry",
        )

        logger.info("GeoParquet written to %s", output_path)

    def _get_id_columns(
        self: Self, con: "duckdb.DuckDBPyConnection", table_name: str
    ) -> str:
        """Get a list of columns that can be used as feature identifiers.

        Returns a SQL expression for partitioning in window functions.
        Falls back to using all non-geometry columns if no id column exists.
        """
        # DESCRIBE reads only this table; unqualified information_schema
        # spans every attached catalog and lazily loads all lake tables.
        result = con.execute(f'DESCRIBE "{table_name}"').fetchall()

        columns = [
            row[0]
            for row in result
            if row[0] not in ("geometry", "geom", "buffer_distance")
        ]

        # Look for common ID column names
        id_cols = [c for c in columns if c.lower() in ("id", "fid", "gid", "ogc_fid")]
        if id_cols:
            return id_cols[0]

        # Fallback: use all other columns (may not be unique)
        if columns:
            return ", ".join(f'"{c}"' for c in columns[:3])  # Limit to first 3

        # Last resort: just use rowid-like expression
        return "1"  # Will effectively not partition
