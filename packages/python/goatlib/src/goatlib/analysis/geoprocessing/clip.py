import logging
from pathlib import Path
from typing import List, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.geoprocessing import ClipParams
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class ClipTool(AnalysisTool):
    """Tool for clipping features from input layer using overlay layer geometry.

    Each input row is intersected with the dissolved overlay. The overlay is
    cut into small pieces first and each row is tested against those, so a
    large overlay polygon is not copied for every row (see
    AnalysisTool.subdivide_polygons).
    """

    def _run_implementation(
        self: Self, params: ClipParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Clip the input rows to the dissolved overlay.

        Args:
            params: ClipParams object with input_path, overlay_path, and other options.

        Returns:
            List containing tuple of (output_path, metadata).
        """
        # Import input and overlay datasets with automatic bbox handling
        input_meta, input_view = self.import_input(params.input_path, "input_data")
        overlay_meta, overlay_view = self.import_input(
            params.overlay_path, "overlay_data"
        )

        # Validate geometry columns
        input_geom = input_meta.geometry_column
        overlay_geom = overlay_meta.geometry_column

        if not input_geom:
            raise ValueError("The input layer has no geometry column.")

        if not overlay_geom:
            raise ValueError("The overlay layer has no geometry column.")

        # Validate geometry types
        self.validate_geometry_types(
            input_view, input_geom, params.accepted_input_geometry_types, "input"
        )
        self.validate_geometry_types(
            overlay_view,
            overlay_geom,
            params.accepted_overlay_geometry_types,
            "overlay",
        )

        # Get CRS from input metadata, fallback to output_crs or EPSG:4326
        crs = input_meta.crs
        if crs:
            crs_str = crs.to_string()
        else:
            crs_str = params.output_crs or "EPSG:4326"
            logger.warning(
                "Could not detect CRS for %s, using fallback: %s",
                params.input_path,
                crs_str,
            )

        # Define output path
        if not params.output_path:
            params.output_path = str(
                Path(params.input_path).parent
                / f"{Path(params.input_path).stem}_clip.parquet"
            )
        output_path = Path(params.output_path)

        # Keep the input's geometry family (degenerate pieces are dropped)
        allowed_types = self.get_allowed_output_geometry_types(input_view, input_geom)
        logger.info(f"Filtering output to geometry types: {allowed_types or 'all'}")
        g = quote_identifier(input_geom)
        geom_type_filter = (
            f"AND ST_GeometryType({g}) IN {allowed_types}" if allowed_types else ""
        )

        # The overlay, dissolved, in small pieces. Each input row is
        # intersected once with the union of the pieces it touches, which is
        # its share of the dissolved overlay.
        logger.info("Clipping against the pieces of the dissolved overlay")
        cut = self.create_overlay_pieces("overlay_pieces", overlay_view, overlay_geom)
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE input_numbered AS
            SELECT row_number() OVER () AS __overlay_row, * EXCLUDE (bbox)
            FROM {input_view}
            WHERE ST_IsValid({g})
        """)
        self.create_touched_pieces(
            "clip_pairs",
            "input_numbered",
            "__overlay_row",
            input_geom,
            "overlay_pieces",
        )
        # Materialised, so the intersection runs once per row; a point that
        # touches a piece lies in the overlay and is its own intersection.
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE clip_rows AS
            WITH {self.local_union_cte("clip_pairs", "overlay_pieces", "__overlay_row")}
            SELECT
                i.* EXCLUDE ({g}),
                CASE
                    WHEN l.local_overlay IS NULL THEN i.{g}
                    ELSE ST_Intersection(i.{g}, l.local_overlay)
                END AS {g}
            FROM input_numbered i
            JOIN local_overlays l ON l.__overlay_row = i.__overlay_row
        """)
        # A sliver along an edge the cut lines bend is recomputed against the
        # whole dissolved overlay, as before the pieces.
        if cut:
            self.recompute_slivers(
                "clip_rows",
                input_geom,
                ["__overlay_row"],
                "input_numbered",
                input_geom,
                "ST_Intersection({row}, {whole})",
                "overlay_pieces_whole",
                "geom",
            )
        self.con.execute(f"""
            CREATE OR REPLACE VIEW clipped_result AS
            SELECT * EXCLUDE (__overlay_row) FROM clip_rows
            WHERE NOT ST_IsEmpty({g})
                -- Filter out degenerate geometries - keep only same type as input (ArcGIS/QGIS behavior)
                {geom_type_filter}
        """)

        # Export view result to file
        write_optimized_parquet(
            self.con,
            "clipped_result",
            output_path,
            geometry_column=input_geom,
        )

        logger.info("Clipped data written to %s", output_path)

        # Create metadata for output
        output_metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            geometry_column=input_geom,
            crs=crs_str,
            schema="public",
            table_name=output_path.stem,
        )

        return [(output_path, output_metadata)]
