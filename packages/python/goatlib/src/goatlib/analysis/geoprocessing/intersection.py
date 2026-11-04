import logging
from pathlib import Path
from typing import List, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.geoprocessing import IntersectionParams
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class IntersectionTool(AnalysisTool):
    """Tool for computing intersection of features from input and overlay layers.

    This tool implements the standard intersection operation using DuckDB views with bbox optimization.
    Unlike clip, this keeps attributes from BOTH input and overlay layers. Automatically handles bbox
    columns for spatial indexing - creates them if needed or uses existing ones. Follows GeoParquet
    spatial indexing specification.
    """

    def _run_implementation(
        self: Self, params: IntersectionParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Perform intersection operation using views with bbox spatial optimization.

        Args:
            params: IntersectionParams object with input_path, overlay_path, and other options.

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
                / f"{Path(params.input_path).stem}_intersection.parquet"
            )
        output_path = Path(params.output_path)

        # Perform intersection operation using views with bbox optimization
        logger.info("Performing view-based intersection with bbox spatial filtering")

        # Keep the input's geometry family (degenerate pieces are dropped)
        allowed_types = self.get_allowed_output_geometry_types(input_view, input_geom)
        logger.info(f"Filtering output to geometry types: {allowed_types or 'all'}")

        # Get all columns from both datasets to merge attributes
        input_cols = self.con.execute(f"DESCRIBE {input_view}").fetchall()
        overlay_cols = self.con.execute(f"DESCRIBE {overlay_view}").fetchall()

        # Attribute columns of each side: every column but the geometry and the
        # bbox, or the listed ones. Either side may have none (a dissolve
        # without group fields writes a geometry alone), and so may a field
        # list once the geometry is taken out of it, so the select list joins
        # only the parts that are there. Names are quoted for special characters.
        input_names = params.input_fields or [col[0] for col in input_cols]
        input_fields = [
            f'i."{col}"' for col in input_names if col not in (input_geom, "bbox")
        ]
        # Overlay fields carry a prefix to avoid conflicts with the input's.
        overlay_prefix = params.overlay_fields_prefix or "intersection_"
        overlay_names = params.overlay_fields or [col[0] for col in overlay_cols]
        overlay_fields = [
            f'o."{col}" AS "{overlay_prefix}{col}"'
            for col in overlay_names
            if col not in (overlay_geom, "bbox")
        ]
        select_list = ",\n                ".join(
            [
                *input_fields,
                *overlay_fields,
                f"ST_Intersection(i.{input_geom}, o.{overlay_geom}) AS {input_geom}",
            ]
        )

        # Build geometry type filter clause
        geom_type_filter = (
            f"AND ST_GeometryType(ST_Intersection(i.{input_geom}, o.{overlay_geom})) IN {allowed_types}"
            if allowed_types
            else ""
        )

        # Compute intersection with attribute merging
        self.con.execute(f"""
            CREATE OR REPLACE VIEW intersection_result AS
            SELECT
                {select_list}
            FROM {input_view} i
            INNER JOIN {overlay_view} o
                ON ST_Intersects(i.{input_geom}, o.{overlay_geom})
                -- Bbox-based spatial filter for performance (GeoParquet spatial indexing)
                AND i.bbox.xmin <= o.bbox.xmax
                AND i.bbox.xmax >= o.bbox.xmin
                AND i.bbox.ymin <= o.bbox.ymax
                AND i.bbox.ymax >= o.bbox.ymin
            WHERE ST_IsValid(i.{input_geom})
                AND ST_IsValid(o.{overlay_geom})
                AND NOT ST_IsEmpty(ST_Intersection(i.{input_geom}, o.{overlay_geom}))
                -- Filter out degenerate geometries - keep only same type as input
                {geom_type_filter}
        """)

        # Export view result to file
        write_optimized_parquet(
            self.con,
            "intersection_result",
            output_path,
            geometry_column=input_geom,
        )

        logger.info("Intersection data written to %s", output_path)

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
