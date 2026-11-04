import logging
from pathlib import Path
from typing import Dict, List, Optional, Self, Tuple

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.data_management import MergeParams
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class MergeTool(AnalysisTool):
    """
    MergeTool: Combines multiple datasets into a single output using DuckDB.

    Features:
    - Merges 2+ inputs with compatible data model (all spatial or all tabular)
    - Automatic CRS harmonization for spatial inputs
    - Field mapping by name (same-name fields are merged into one column)
    - Optional source tracking field (layer_source: 0, 1, 2, etc.)
    - Geometry type validation and promotion for spatial inputs
    - Efficient DuckDB-based processing
    """

    def _run_implementation(
        self: Self, params: MergeParams
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """Perform merge operation on multiple datasets."""

        if len(params.input_paths) < 2:
            raise ValueError("At least 2 input layers required for merge operation.")

        # --- Import all inputs and collect metadata
        layer_info = []
        for i, input_layer in enumerate(params.input_paths):
            input_path = input_layer.input_path
            # Use unique table name for each input to avoid conflicts
            unique_table_name = f"v_input_{i}"
            meta, table_name = self.import_input(
                input_path, table_name=unique_table_name
            )
            layer_info.append(
                {
                    "index": i,
                    "path": Path(input_path),
                    "meta": meta,
                    "table": table_name,
                    "geom_col": meta.geometry_column,
                    "crs": meta.crs,
                    "geometry_type": meta.geometry_type,
                }
            )

        has_geometry_flags = [bool(info["geom_col"]) for info in layer_info]
        has_geometry = all(has_geometry_flags)

        # Keep merge behavior predictable: either all layers are spatial or all are tables.
        if any(has_geometry_flags) and not has_geometry:
            raise ValueError(
                "Cannot merge mixed spatial and non-spatial inputs. "
                "Use either all layers with geometry or all tabular inputs."
            )

        # --- Validate geometry compatibility for spatial merges
        if has_geometry and params.validate_geometry_types:
            self._validate_geometry_types(layer_info)

        # --- Determine target CRS for spatial merges
        target_crs: str | None = None
        if has_geometry:
            target_crs = params.output_crs or (
                layer_info[0]["crs"].to_string()
                if layer_info[0]["crs"]
                else "EPSG:4326"
            )
            logger.info("Target CRS for merge: %s", target_crs)

        # --- Determine output path
        if not params.output_path:
            params.output_path = str(
                Path(params.input_paths[0].input_path).parent
                / f"{Path(params.input_paths[0].input_path).stem}_merged.parquet"
            )
        output_path = Path(params.output_path)

        # --- Execute merge
        output_geom_type = self._execute_merge(
            params,
            layer_info,
            target_crs=target_crs,
            output_path=output_path,
            has_geometry=has_geometry,
        )

        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector" if has_geometry else "tabular",
            format="geoparquet" if has_geometry else "parquet",
            crs=target_crs,
            geometry_type=output_geom_type,
        )

        logger.info(
            f"Merge completed: {len(params.input_paths)} layers → {output_path}"
        )
        return [(output_path, metadata)]

    def _validate_geometry_types(self, layer_info: List[Dict]) -> None:
        """
        Validate that all layers have compatible geometry types.

        Compatible types:
        - Point, MultiPoint → Point family
        - LineString, MultiLineString → LineString family
        - Polygon, MultiPolygon → Polygon family

        Raises ValueError if incompatible types found (e.g., Point + Polygon).
        """

        # A layer without geometries (no rows) has no type to compare.
        typed = [info for info in layer_info if info["geometry_type"]]
        if not typed:
            return
        first = typed[0]
        base_type = self._normalize_geometry_type(first["geometry_type"])

        for info in typed[1:]:
            geom_type = self._normalize_geometry_type(info["geometry_type"])
            if geom_type != base_type:
                raise ValueError(
                    f"Incompatible geometry types detected:\n"
                    f"  Layer {first['index']}: "
                    f"{first['geometry_type']} → {base_type} family\n"
                    f"  Layer {info['index']}: "
                    f"{info['geometry_type']} → {geom_type} family\n"
                    f"Set validate_geometry_types=False to allow mixed geometries."
                )

        logger.info(f"✓ All layers have compatible geometry type: {base_type} family")

    def _normalize_geometry_type(self, geom_type: Optional[str]) -> str:
        """
        Normalize geometry type to base family type.

        Examples:
        - Point, MultiPoint → "Point"
        - LineString, MultiLineString → "LineString"
        - Polygon, MultiPolygon → "Polygon"
        """
        if not geom_type:
            return "Unknown"

        geom_lower = geom_type.lower()
        if "point" in geom_lower:
            return "Point"
        elif "line" in geom_lower:
            return "LineString"
        elif "polygon" in geom_lower:
            return "Polygon"
        return geom_type

    def _execute_merge(
        self,
        params: MergeParams,
        layer_info: List[Dict],
        target_crs: str | None,
        output_path: Path,
        has_geometry: bool,
    ) -> str | None:
        """Execute the merge operation in DuckDB."""
        con = self.con

        # --- Step 1: Collect all columns from all layers and track which layer has which
        layer_columns: Dict[int, List[str]] = {}  # layer_idx -> list of columns
        all_columns: List[str] = []  # ordered output columns (excluding geometry)
        all_columns_seen: set[str] = set()

        for info in layer_info:
            layer_idx = info["index"]
            table_name = info["table"]
            geom_col = info["geom_col"]

            # Get column list from this layer (exclude geometry and bbox columns)
            excluded = {"bbox"}
            if has_geometry and geom_col:
                excluded.add(geom_col)

            cols_query = f"PRAGMA table_info({table_name})"
            columns = [
                row[1]
                for row in con.execute(cols_query).fetchall()
                if row[1] not in excluded
            ]

            layer_columns[layer_idx] = columns

            for col in columns:
                if col not in all_columns_seen:
                    all_columns_seen.add(col)
                    all_columns.append(col)

        # --- Step 2: Build output columns (same-name columns are mapped together)
        final_columns: List[str] = list(all_columns)

        if params.add_source_column:
            final_columns.append("layer_source")
        if has_geometry:
            final_columns.append("geometry")

        logger.info(f"Output schema will have {len(final_columns)} columns")

        # --- Step 3: Create normalized SELECT for each layer with aligned columns
        normalized_selects = []

        for info in layer_info:
            layer_idx = info["index"]
            table_name = info["table"]
            geom_col = info["geom_col"]
            source_crs = info["crs"].to_string() if info["crs"] else None
            input_columns = set(layer_columns[layer_idx])

            # Build SELECT parts for this layer
            select_parts = []

            # Add all non-geometry columns (with NULL for missing ones)
            for final_col in final_columns:
                if final_col == "layer_source":
                    continue  # Handle separately
                if final_col == "geometry":
                    continue  # Handle separately

                if final_col in input_columns:
                    select_parts.append(f'"{final_col}" AS "{final_col}"')
                else:
                    select_parts.append(f'NULL AS "{final_col}"')

            # Add layer_source if requested
            if params.add_source_column:
                select_parts.append(f"{layer_idx} AS layer_source")

            # Add geometry with optional transform and promotion
            if has_geometry:
                geom_transform = (
                    f"ST_Transform({geom_col}, '{source_crs}', '{target_crs}')"
                    if source_crs and target_crs and source_crs != target_crs
                    else geom_col
                )
                if params.promote_to_multi:
                    geom_transform = f"ST_Multi({geom_transform})"
                select_parts.append(f"{geom_transform} AS geometry")

            select_query = f"SELECT {', '.join(select_parts)} FROM {table_name}"
            normalized_selects.append(select_query)

        # --- Step 4: Union all normalized selects
        union_query = " UNION ALL ".join(normalized_selects)

        con.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE merged AS
            {union_query}
            """
        )

        merged_count = con.execute("SELECT COUNT(*) FROM merged").fetchone()[0]
        logger.info(f"Merged table has {merged_count} rows")

        # --- Step 5: Export to output
        write_optimized_parquet(
            con,
            "merged",
            output_path,
            geometry_column="geometry",
        )

        # Determine output geometry type
        output_geom_type = None
        if has_geometry:
            output_geom_type = layer_info[0]["geometry_type"]
            if (
                output_geom_type
                and params.promote_to_multi
                and not output_geom_type.startswith("Multi")
            ):
                output_geom_type = f"Multi{output_geom_type}"

        return output_geom_type
