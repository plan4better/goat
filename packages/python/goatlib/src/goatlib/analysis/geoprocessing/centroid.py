import logging
from pathlib import Path
from typing import List, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.geoprocessing import CentroidParams
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class CentroidTool(AnalysisTool):
    """Tool for computing centroid of features.

    This tool computes the centroid of each feature in the input layer.
    """

    def _run_implementation(
        self: Self, params: CentroidParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Perform centroid operation.

        Args:
            params: CentroidParams object with input_path and other options.

        Returns:
            List containing tuple of (output_path, metadata).
        """
        # Import input dataset
        input_meta, input_view = self.import_input(params.input_path, "input_data")

        # Validate geometry columns
        input_geom = input_meta.geometry_column

        if not input_geom:
            raise ValueError("The input layer has no geometry column.")

        # Get CRS from metadata, fallback to output_crs or EPSG:4326
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

        # Validate geometry types
        self.validate_geometry_types(
            input_view, input_geom, params.accepted_input_geometry_types, "input"
        )

        # Define output path
        if not params.output_path:
            params.output_path = str(
                Path(params.input_path).parent
                / f"{Path(params.input_path).stem}_centroid.parquet"
            )
        output_path = Path(params.output_path)

        logger.info("Computing centroids")

        self.con.execute(f"""
            CREATE OR REPLACE VIEW centroid_result AS
            SELECT
                * EXCLUDE ({input_geom}),
                ST_Centroid({input_geom}) AS {input_geom}
            FROM {input_view}
        """)

        # Export view result to file
        write_optimized_parquet(
            self.con,
            "centroid_result",
            output_path,
            geometry_column=input_geom,
        )

        logger.info("Centroid data written to %s", output_path)

        # Create metadata for output
        output_metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Point",
            crs=crs_str,
        )

        return [(output_path, output_metadata)]
