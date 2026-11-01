import logging
from pathlib import Path
from typing import List, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.geoprocessing import OriginDestinationParams
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class OriginDestinationTool(AnalysisTool):
    """Tool for creating origin-destination lines and points."""

    def _run_implementation(
        self: Self, params: OriginDestinationParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Perform origin-destination analysis.

        Args:
            params: OriginDestinationParams object.

        Returns:
            List containing tuples of (output_path, metadata) for lines and points.
        """
        # Import geometry and matrix datasets
        geom_meta, geom_view = self.import_input(params.geometry_path, "geometry_data")
        matrix_meta, matrix_view = self.import_input(params.matrix_path, "matrix_data")

        geom_col = geom_meta.geometry_column
        if not geom_col:
            raise ValueError("The input layer has no geometry column.")

        # Get CRS from metadata, fallback to output_crs or EPSG:4326
        crs = geom_meta.crs
        if crs:
            crs_str = crs.to_string()
        else:
            crs_str = params.output_crs or "EPSG:4326"
            logger.warning(
                "Could not detect CRS for %s, using fallback: %s",
                params.geometry_path,
                crs_str,
            )

        # Define output paths
        if not params.output_path_lines:
            params.output_path_lines = str(
                Path(params.geometry_path).parent
                / f"{Path(params.geometry_path).stem}_od_lines.parquet"
            )

        if not params.output_path_points:
            params.output_path_points = str(
                Path(params.geometry_path).parent
                / f"{Path(params.geometry_path).stem}_od_points.parquet"
            )

        output_path_lines = Path(params.output_path_lines)
        output_path_points = Path(params.output_path_points)

        # Create lines
        # Join matrix with geometry (origin) and geometry (destination)
        # We need centroids for lines

        self.con.execute(f"""
            CREATE OR REPLACE VIEW od_lines_agg AS
            SELECT
                ST_MakeLine(ST_Centroid(ANY_VALUE(origin.{geom_col})), ST_Centroid(ANY_VALUE(dest.{geom_col}))) as geometry,
                matrix.{params.origin_column} as origin,
                matrix.{params.destination_column} as destination,
                SUM(CAST(matrix.{params.weight_column} AS DOUBLE)) as weight
            FROM {matrix_view} matrix
            JOIN {geom_view} origin ON CAST(matrix.{params.origin_column} AS VARCHAR) = CAST(origin.{params.unique_id_column} AS VARCHAR)
            JOIN {geom_view} dest ON CAST(matrix.{params.destination_column} AS VARCHAR) = CAST(dest.{params.unique_id_column} AS VARCHAR)
            GROUP BY matrix.{params.origin_column}, matrix.{params.destination_column}
        """)

        # Export lines
        write_optimized_parquet(
            self.con,
            "od_lines_agg",
            output_path_lines,
            geometry_column="geometry",
        )

        # Create points
        # Group by destination and sum weights
        # Join with geometry to get centroid

        self.con.execute(f"""
            CREATE OR REPLACE VIEW od_points_agg AS
            WITH grouped AS (
                SELECT
                    {params.destination_column} as dest_id,
                    SUM(CAST({params.weight_column} AS DOUBLE)) as weight
                FROM {matrix_view}
                GROUP BY {params.destination_column}
            )
            SELECT
                ST_Centroid(g.{geom_col}) as geometry,
                grouped.weight
            FROM grouped
            JOIN {geom_view} g ON CAST(grouped.dest_id AS VARCHAR) = CAST(g.{params.unique_id_column} AS VARCHAR)
        """)

        # Export points
        write_optimized_parquet(
            self.con,
            "od_points_agg",
            output_path_points,
            geometry_column="geometry",
        )

        return [
            (
                output_path_lines,
                DatasetMetadata(
                    path=str(output_path_lines),
                    source_type="vector",
                    geometry_column="geometry",
                    geometry_type="LineString",
                    crs=crs_str,
                    schema="public",
                    table_name=output_path_lines.stem,
                ),
            ),
            (
                output_path_points,
                DatasetMetadata(
                    path=str(output_path_points),
                    source_type="vector",
                    geometry_column="geometry",
                    geometry_type="Point",
                    crs=crs_str,
                    schema="public",
                    table_name=output_path_points.stem,
                ),
            ),
        ]
