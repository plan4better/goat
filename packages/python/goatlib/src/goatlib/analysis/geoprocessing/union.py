import logging
from pathlib import Path
from typing import Any, List, Optional, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.geoprocessing import UnionParams
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class UnionTool(AnalysisTool):
    """
    UnionTool: Combines layers with topological splitting at intersections
    (equivalent to QGIS union/vereinigen).
    Creates separate features for overlapping and non-overlapping parts.
    """

    def _run_implementation(
        self: Self, params: UnionParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Perform union operation on vector datasets."""

        # Import input dataset
        input_meta, input_table = self.import_input(params.input_path, "input")

        # Import overlay dataset if provided, otherwise perform self-union
        overlay_meta = None
        overlay_table = None
        if params.overlay_path:
            overlay_meta, overlay_table = self.import_input(
                params.overlay_path, "overlay"
            )

        # Validate geometry columns
        input_geom = input_meta.geometry_column
        if not input_geom:
            raise ValueError("The input layer has no geometry column.")

        overlay_geom = None
        if overlay_meta:
            overlay_geom = overlay_meta.geometry_column
            if not overlay_geom:
                raise ValueError("The overlay layer has no geometry column.")

        # Validate geometry types
        self.validate_geometry_types(
            input_table, input_geom, params.accepted_input_geometry_types, "input"
        )
        if overlay_meta and overlay_table and overlay_geom:
            self.validate_geometry_types(
                overlay_table,
                overlay_geom,
                params.accepted_overlay_geometry_types,
                "overlay",
            )

        # Get CRS from input metadata, fallback to output_crs or EPSG:4326
        input_crs = input_meta.crs
        if input_crs:
            input_crs_str = input_crs.to_string()
        else:
            input_crs_str = params.output_crs or "EPSG:4326"
            logger.warning(
                "Could not detect CRS for %s, using fallback: %s",
                params.input_path,
                input_crs_str,
            )

        overlay_crs_str = None
        if overlay_meta:
            overlay_crs = overlay_meta.crs
            if overlay_crs:
                overlay_crs_str = overlay_crs.to_string()
            else:
                overlay_crs_str = params.output_crs or "EPSG:4326"
                logger.warning(
                    "Could not detect CRS for %s, using fallback: %s",
                    params.overlay_path,
                    overlay_crs_str,
                )

            # Validate CRS compatibility
            if input_crs_str != overlay_crs_str:
                logger.info(
                    "CRS mismatch detected. Input: %s, Overlay: %s",
                    input_crs_str,
                    overlay_crs_str,
                )
                logger.info("Transforming overlay layer to match input CRS")

        # Define output path
        if not params.output_path:
            suffix = "_self_union" if not params.overlay_path else "_union"
            params.output_path = str(
                Path(params.input_path).parent
                / f"{Path(params.input_path).stem}{suffix}.parquet"
            )
        output_path = Path(params.output_path)

        logger.info(
            "Starting union: input='%s' | overlay='%s' | input_geom='%s' | overlay_geom='%s'",
            params.input_path,
            params.overlay_path or "None (self-union)",
            input_geom,
            overlay_geom or "N/A",
        )

        # Execute union operation
        self._execute_union(
            params,
            input_table,
            overlay_table,
            input_meta,
            overlay_meta,
            input_geom,
            overlay_geom,
            input_crs_str,
            overlay_crs_str,
            output_path,
        )

        # Determine output geometry type (same as input)
        output_geometry_type = input_meta.geometry_type

        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            format="geoparquet",
            crs=params.output_crs or input_crs_str,
            geometry_type=output_geometry_type,
        )

        logger.info("Union completed successfully → %s", output_path)
        return [(output_path, metadata)]

    def _execute_union(
        self: Self,
        params: UnionParams,
        input_table: str,
        overlay_table: Optional[str],
        input_meta: Any,
        overlay_meta: Optional[Any],
        input_geom: str,
        overlay_geom: Optional[str],
        input_crs: Optional[str],
        overlay_crs: Optional[str],
        output_path: Path,
    ) -> None:
        """Execute the union operation in DuckDB."""

        if overlay_table is None:
            # Self-union: split overlapping features within the same layer
            self._execute_self_union(
                params, input_table, input_geom, input_crs, output_path
            )
        else:
            # Two-layer union: combine features from both layers
            self._execute_two_layer_union(
                params,
                input_table,
                overlay_table,
                input_meta,
                overlay_meta,
                input_geom,
                overlay_geom,
                input_crs,
                overlay_crs,
                output_path,
            )

    def _execute_self_union(
        self: Self,
        params: UnionParams,
        input_table: str,
        input_geom: str,
        input_crs: Optional[str],
        output_path: Path,
    ) -> None:
        """Execute self-union operation to split overlapping features within the layer."""
        logger.info("Performing self-union (dissolve) operation")

        # Self-union dissolves all geometries into a single unified geometry
        # Then explode it back into individual features using UNNEST(ST_Dump(...))
        self.con.execute(f"""
            CREATE OR REPLACE VIEW unioned AS
            SELECT
                ROW_NUMBER() OVER () AS fid,
                geom_part.geom AS {input_geom}
            FROM (
                SELECT UNNEST(ST_Dump(ST_Union_Agg({input_geom}))) as geom_part
                FROM {input_table}
                WHERE ST_IsValid({input_geom})
            )
        """)

        # Handle output CRS transformation if needed
        output_view = "unioned"
        if params.output_crs and input_crs and params.output_crs != input_crs:
            self.con.execute(f"""
                CREATE OR REPLACE VIEW unioned_transformed AS
                SELECT fid,
                    ST_Transform({input_geom}, '{input_crs}', '{params.output_crs}') AS {input_geom}
                FROM unioned
            """)
            output_view = "unioned_transformed"

        # Export to file
        write_optimized_parquet(
            self.con,
            output_view,
            output_path,
            geometry_column=input_geom,
        )

        logger.info("Self-union data written to %s", output_path)

    def _execute_two_layer_union(
        self: Self,
        params: UnionParams,
        input_table: str,
        overlay_table: str,
        input_meta: Any,
        overlay_meta: Any,
        input_geom: str,
        overlay_geom: str,
        input_crs: Optional[str],
        overlay_crs: Optional[str],
        output_path: Path,
    ) -> None:
        """Execute two-layer union operation using QGIS-style algorithm.

        Splits features from each layer at their overlap with features from the other layer.
        Overlapping areas appear multiple times (once per participating feature from each layer).
        """
        logger.info("Performing QGIS-style two-layer union with bbox spatial filtering")

        # For WGS84 datasets, assume both are in EPSG:4326 (no CRS conversion needed)
        logger.info(
            "Assuming both datasets are in EPSG:4326 (WGS84) - no CRS conversion required"
        )

        # Determine allowed output geometry types to filter degenerate geometries
        allowed_types = self.get_allowed_output_geometry_types(input_table, input_geom)
        logger.info(
            f"Filtering output to geometry types: {allowed_types or 'all types'}"
        )

        ig = quote_identifier(input_geom)
        og = quote_identifier(overlay_geom)
        # Applied to each part's materialised result
        part_filter = f"NOT ST_IsEmpty({ig})" + (
            f" AND ST_GeometryType({ig}) IN {allowed_types}" if allowed_types else ""
        )

        # Attribute columns of each side; either may have none (a dissolve
        # without group fields writes a geometry alone). Each of the three
        # parts below lists the same columns in the same order, NULL where its
        # side is missing, so UNION ALL lines them up.
        input_cols = self._attribute_columns(input_table, input_geom)
        overlay_cols = self._attribute_columns(overlay_table, overlay_geom)
        prefix = params.overlay_fields_prefix or ""
        input_fields = [f'i."{col}"' for col in input_cols]
        null_input_fields = [f'NULL AS "{col}"' for col in input_cols]
        overlay_fields = [f'o."{col}" AS "{prefix}{col}"' for col in overlay_cols]
        null_overlay_fields = [f'NULL AS "{prefix}{col}"' for col in overlay_cols]

        # Every part tests rows against small pieces of the other layer and
        # runs one ST_Intersection or ST_Difference per row with the union of
        # the pieces that row touches (AnalysisTool.local_union_cte). A
        # point that touches a piece lies in that layer: it is its own
        # intersection, and nothing of it is left by a difference.
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE input_numbered AS
            SELECT row_number() OVER () AS __input_row, *
            FROM {input_table} WHERE ST_IsValid({ig})
        """)
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE overlay_numbered AS
            SELECT row_number() OVER () AS __overlay_row, *
            FROM {overlay_table} WHERE ST_IsValid({og})
        """)

        # Part 1: Overlapping features with attributes from BOTH layers. The
        # overlay rows are cut one by one, their pieces keeping their row.
        logger.info("Creating overlapping features with attributes from both layers")
        overlay_rows_cut = self.create_overlay_pieces(
            "overlay_row_pieces", "overlay_numbered", overlay_geom, key="__overlay_row"
        )
        self.create_touched_pieces(
            "overlap_pairs",
            "input_numbered",
            "__input_row",
            input_geom,
            "overlay_row_pieces",
            owner="__overlay_row",
        )
        overlap_union = self.local_union_cte(
            "overlap_pairs", "overlay_row_pieces", "__input_row", owner="__overlay_row"
        )
        overlap_select = _select_list(
            "i.__input_row",
            "o.__overlay_row",
            input_fields,
            overlay_fields,
            f"""CASE
                    WHEN l.local_overlay IS NULL THEN i.{ig}
                    ELSE ST_Intersection(i.{ig}, l.local_overlay)
                END AS {ig}""",
        )
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE overlapping_rows AS
            WITH {overlap_union}
            SELECT
                {overlap_select}
            FROM local_overlays l
            JOIN input_numbered i ON i.__input_row = l.__input_row
            JOIN overlay_numbered o ON o.__overlay_row = l.__overlay_row
        """)
        # A sliver along an edge the cut lines bend is recomputed against the
        # whole overlay row, as before the pieces.
        if overlay_rows_cut:
            self.recompute_slivers(
                "overlapping_rows",
                input_geom,
                ["__input_row", "__overlay_row"],
                "input_numbered",
                input_geom,
                "ST_Intersection({row}, {whole})",
                "overlay_numbered",
                overlay_geom,
                whole_key="__overlay_row",
            )
        self.con.execute(f"""
            CREATE OR REPLACE VIEW overlapping_features AS
            SELECT * EXCLUDE (__input_row, __overlay_row) FROM overlapping_rows
            WHERE {part_filter}
        """)

        # Part 2: Input-only features (subtract the dissolved overlay from
        # each input feature)
        logger.info("Creating input-only features")
        overlay_cut = self.create_overlay_pieces(
            "overlay_pieces", "overlay_numbered", overlay_geom
        )
        self.create_touched_pieces(
            "input_pairs", "input_numbered", "__input_row", input_geom, "overlay_pieces"
        )
        input_union = self.local_union_cte(
            "input_pairs", "overlay_pieces", "__input_row"
        )
        input_only_select = _select_list(
            "i.__input_row",
            input_fields,
            null_overlay_fields,
            f"""CASE
                    WHEN l.__input_row IS NULL THEN i.{ig}
                    WHEN l.local_overlay IS NULL THEN NULL
                    ELSE ST_Difference(i.{ig}, l.local_overlay)
                END AS {ig}""",
        )
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE input_only_rows AS
            WITH {input_union}
            SELECT
                {input_only_select}
            FROM input_numbered i
            LEFT JOIN local_overlays l ON l.__input_row = i.__input_row
        """)
        if overlay_cut:
            self.recompute_slivers(
                "input_only_rows",
                input_geom,
                ["__input_row"],
                "input_numbered",
                input_geom,
                "ST_Difference({row}, {whole})",
                "overlay_pieces_whole",
                "geom",
            )
        self.con.execute(f"""
            CREATE OR REPLACE VIEW input_only AS
            SELECT * EXCLUDE (__input_row) FROM input_only_rows WHERE {part_filter}
        """)

        # Part 3: Overlay-only features (subtract the dissolved input from
        # each overlay feature)
        logger.info("Creating overlay-only features")
        input_cut = self.create_overlay_pieces(
            "input_pieces", "input_numbered", input_geom
        )
        self.create_touched_pieces(
            "overlay_pairs",
            "overlay_numbered",
            "__overlay_row",
            overlay_geom,
            "input_pieces",
        )
        overlay_union = self.local_union_cte(
            "overlay_pairs", "input_pieces", "__overlay_row"
        )
        overlay_only_select = _select_list(
            "o.__overlay_row",
            null_input_fields,
            overlay_fields,
            f"""CASE
                    WHEN l.__overlay_row IS NULL THEN o.{og}
                    WHEN l.local_overlay IS NULL THEN NULL
                    ELSE ST_Difference(o.{og}, l.local_overlay)
                END AS {ig}""",
        )
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE overlay_only_rows AS
            WITH {overlay_union}
            SELECT
                {overlay_only_select}
            FROM overlay_numbered o
            LEFT JOIN local_overlays l ON l.__overlay_row = o.__overlay_row
        """)
        if input_cut:
            self.recompute_slivers(
                "overlay_only_rows",
                input_geom,
                ["__overlay_row"],
                "overlay_numbered",
                overlay_geom,
                "ST_Difference({row}, {whole})",
                "input_pieces_whole",
                "geom",
            )
        self.con.execute(f"""
            CREATE OR REPLACE VIEW overlay_only AS
            SELECT * EXCLUDE (__overlay_row) FROM overlay_only_rows
            WHERE {part_filter}
        """)

        # Combine all parts
        logger.info("Combining all union parts")
        self.con.execute("""
            CREATE OR REPLACE VIEW unioned AS
            SELECT * FROM overlapping_features
            UNION ALL
            SELECT * FROM input_only
            UNION ALL
            SELECT * FROM overlay_only
        """)

        # Handle output CRS transformation if needed
        output_view = "unioned"
        if params.output_crs and input_crs and params.output_crs != input_crs:
            self.con.execute(f"""
                CREATE OR REPLACE VIEW unioned_transformed AS
                SELECT * EXCLUDE ({input_geom}),
                    ST_Transform({input_geom}, '{input_crs}', '{params.output_crs}') AS {input_geom}
                FROM unioned
            """)
            output_view = "unioned_transformed"

        # Export to file
        write_optimized_parquet(
            self.con,
            output_view,
            output_path,
            geometry_column=input_geom,
        )

        logger.info("Two-layer union data written to %s", output_path)

    def _attribute_columns(self: Self, table_name: str, geom_column: str) -> list[str]:
        """Every column of the table but the geometry and the bbox."""
        rows = self.con.execute(f"DESCRIBE {table_name}").fetchall()
        return [row[0] for row in rows if row[0] not in (geom_column, "bbox")]


def _select_list(*parts: list[str] | str) -> str:
    """A select list of the given column expressions, empty lists skipped."""
    columns = [
        column
        for part in parts
        for column in ([part] if isinstance(part, str) else part)
    ]
    return ",\n                ".join(columns)
