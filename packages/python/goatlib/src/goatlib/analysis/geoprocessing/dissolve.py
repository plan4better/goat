"""Dissolve Tool.

This module provides a tool for dissolving (aggregating) polygon features
based on common attribute values, computing statistics on dissolved groups.
Equivalent to QGIS "Auflösen" or ArcGIS "Dissolve".
"""

import logging
from pathlib import Path
from typing import List, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.geoprocessing import DissolveParams
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class DissolveTool(AnalysisTool):
    """Tool for dissolving polygon features based on attribute values.

    Dissolve merges features that share common attribute values into single
    features, optionally computing statistics on other fields.

    This is equivalent to:
    - QGIS: Vector > Geoprocessing Tools > Dissolve (Auflösen)
    - ArcGIS: Dissolve
    - PostGIS: ST_Union with GROUP BY

    Example:
        tool = DissolveTool()
        results = tool.run(DissolveParams(
            input_path="/data/parcels.parquet",
            dissolve_fields=["land_use"],
            field_statistics=[
                FieldStatistic(operation="sum", field="area"),
                FieldStatistic(operation="count", field=None),
            ],
            output_path="/data/dissolved.parquet",
        ))
    """

    def _run_implementation(
        self: Self, params: DissolveParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Execute dissolve operation.

        Args:
            params: Dissolve parameters

        Returns:
            List containing tuple of (output_path, metadata)
        """
        logger.info(
            "Starting dissolve: input=%s, dissolve_fields=%s",
            params.input_path,
            params.dissolve_fields,
        )

        # Import input dataset
        input_meta, input_table = self.import_input(params.input_path, "input")
        input_geom = input_meta.geometry_column

        if not input_geom:
            raise ValueError("The input layer has no geometry column.")

        # Validate geometry types
        self.validate_geometry_types(
            input_table, input_geom, params.accepted_input_geometry_types, "input"
        )

        # Get CRS from input metadata
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

        # Define output path
        if not params.output_path:
            params.output_path = str(
                Path(params.input_path).parent
                / f"{Path(params.input_path).stem}_dissolved.parquet"
            )
        output_path = Path(params.output_path)

        # Execute dissolve operation
        self._execute_dissolve(params, input_table, input_geom)

        # Export results with optimized parquet
        write_optimized_parquet(
            self.con,
            "dissolve_result",
            output_path,
            geometry_column="geometry",
        )

        logger.info("Dissolve completed. Output: %s", output_path)

        # Determine output geometry type
        # Dissolve typically produces multi-geometry types
        output_geometry_type = input_meta.geometry_type
        if output_geometry_type and not output_geometry_type.startswith("Multi"):
            output_geometry_type = f"Multi{output_geometry_type}"

        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            format="geoparquet",
            crs=params.output_crs or input_crs_str,
            geometry_type=output_geometry_type,
        )

        return [(output_path, metadata)]

    def _execute_dissolve(
        self: Self,
        params: DissolveParams,
        input_table: str,
        input_geom: str,
    ) -> None:
        """Execute the dissolve operation.

        Args:
            params: Dissolve parameters
            input_table: Name of the input table/view
            input_geom: Name of the geometry column
        """
        # Build dissolve fields clause
        if params.dissolve_fields:
            dissolve_cols = ", ".join(
                quote_identifier(f) for f in params.dissolve_fields
            )
            group_by_clause = f"GROUP BY {dissolve_cols}"
            select_dissolve_cols = f"{dissolve_cols},"
        else:
            # Dissolve all features into one
            group_by_clause = ""
            select_dissolve_cols = ""

        # Build statistics columns
        stats_columns = []
        if params.field_statistics:
            for stat in params.field_statistics:
                stat_sql = self.get_statistics_sql(
                    quote_identifier(stat.field) if stat.field else "",
                    stat.operation.value,
                )
                # The result_name, else "count" or "{operation}_{field}"
                col_name = quote_identifier(stat.get_operation_first_column_name())
                stats_columns.append(f"{stat_sql} AS {col_name}")

        stats_select = ", ".join(stats_columns) if stats_columns else ""
        if stats_select:
            stats_select = ", " + stats_select

        # Build the dissolve query
        # Use ST_Union_Agg to merge geometries. Without group fields the
        # aggregate gives one row even for an input without rows; HAVING
        # leaves that row out, so an empty input gives an empty result.
        sql = f"""
            CREATE OR REPLACE TABLE dissolve_result AS
            SELECT
                ST_Union_Agg({quote_identifier(input_geom)}) AS geometry
                {"," + select_dissolve_cols.rstrip(",") if select_dissolve_cols else ""}
                {stats_select}
            FROM {input_table}
            {group_by_clause}
            HAVING COUNT(*) > 0
        """

        self.con.execute(sql)
