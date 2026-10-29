"""Temporary layer writer for workflow preview.

This module provides utilities for writing tool results to temporary storage
instead of DuckLake. This is used for workflow execution where results should
be previewed before being permanently saved.

Temporary Storage Structure:
    /data/temporary/
    └── user_{uuid}/
        └── w_{workflow_uuid}/
            └── n_{node_uuid}/
                ├── t_{temp_uuid}.parquet  # GeoParquet result
                ├── tiles.pmtiles          # Pre-generated tiles for visualization
                └── metadata.json          # Layer info (name, geometry type, bbox, etc.)

The temporary files are served via GeoAPI using query parameters:
    GET /collections/{layer_id}/items?temp=true&workflow_id=xxx&node_id=yyy
    GET /user_{user_id}/{layer_id}/tiles/{z}/{x}/{y}.pbf?temp=true&workflow_id=xxx&node_id=yyy

When the user clicks "Save", the finalize endpoint copies data to DuckLake
and creates the permanent layer record.
"""

import json
import logging
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Self

import duckdb
from pydantic import BaseModel, Field

from goatlib.utils.container_memory import JOB_WORK_MEMORY_SHARE, set_memory_share

logger = logging.getLogger(__name__)

# Default temporary data root
TEMP_DATA_ROOT = Path("/app/data/temporary")


class TempLayerMetadata(BaseModel):
    """Metadata for a temporary layer."""

    layer_name: str = Field(..., description="Display name for the layer")
    geometry_type: str | None = Field(
        None, description="Geometry type (Point, Polygon, etc.)"
    )
    feature_count: int = Field(0, description="Number of features")
    bbox: list[float] | None = Field(
        None, description="Bounding box [minx, miny, maxx, maxy]"
    )
    columns: dict[str, str] = Field(
        default_factory=dict, description="Column names and types"
    )
    created_at: str = Field(..., description="ISO timestamp of creation")
    workflow_id: str = Field(..., description="Workflow UUID")
    node_id: str = Field(..., description="Node ID within workflow")
    process_id: str | None = Field(
        None, description="Process/tool ID that created this layer"
    )
    size_bytes: int = Field(0, description="Size of the parquet file in bytes")
    style: dict[str, Any] | None = Field(
        None, description="The layer's GOAT Style document, with computed values"
    )


@dataclass
class TempLayerResult:
    """Result of writing a temporary layer."""

    user_id: str
    workflow_id: str
    node_id: str
    parquet_path: Path
    pmtiles_path: Path | None
    metadata: TempLayerMetadata

    @property
    def temp_layer_id(self) -> str:
        """Generate a unique identifier for this temp layer."""
        return f"{self.workflow_id}:{self.node_id}"


class TempLayerWriter:
    """Write GeoDataFrame/parquet results to temporary storage for workflow preview.

    This class handles:
    - Writing GeoParquet files to /data/temporary/
    - Generating PMTiles for fast visualization
    - Creating metadata.json for layer info
    - Cleanup of old temporary files
    """

    def __init__(
        self: Self,
        user_id: str,
        workflow_id: str,
        node_id: str,
        temp_data_root: Path | str = TEMP_DATA_ROOT,
        pmtiles_enabled: bool = True,
        pmtiles_max_zoom: int = 14,
    ) -> None:
        """Initialize temporary layer writer.

        Args:
            user_id: User UUID (without dashes)
            workflow_id: Workflow UUID
            node_id: Node ID within the workflow
            temp_data_root: Root directory for temporary storage
            pmtiles_enabled: Whether to generate PMTiles
            pmtiles_max_zoom: Maximum zoom level for PMTiles
        """
        self.user_id = user_id.replace("-", "")
        self.workflow_id = workflow_id.replace("-", "") if workflow_id else workflow_id
        self.node_id = node_id
        self.temp_data_root = Path(temp_data_root)
        self.pmtiles_enabled = pmtiles_enabled
        self.pmtiles_max_zoom = pmtiles_max_zoom
        # Generate unique temp file ID for this write
        self.temp_file_id = uuid.uuid4().hex

        # Build paths with prefixes: user_{uuid}/w_{uuid}/n_{uuid}/
        self.base_path = (
            self.temp_data_root
            / f"user_{self.user_id}"
            / f"w_{self.workflow_id}"
            / f"n_{self.node_id}"
        )

    @property
    def parquet_path(self) -> Path:
        """Path to the parquet file with unique temp ID."""
        return self.base_path / f"t_{self.temp_file_id}.parquet"

    @property
    def pmtiles_path(self) -> Path:
        """Path to the PMTiles file (named by layer UUID for lookup)."""
        return self.base_path / f"t_{self.temp_file_id}.pmtiles"

    @property
    def metadata_path(self) -> Path:
        """Path to the metadata JSON file."""
        return self.base_path / "metadata.json"

    def write_from_parquet(
        self: Self,
        source_parquet: Path | str,
        layer_name: str,
        process_id: str | None = None,
        duckdb_con: duckdb.DuckDBPyConnection | None = None,
        style: Callable[[str | None], dict[str, Any] | None] | None = None,
    ) -> TempLayerResult:
        """Write a parquet file to temporary storage.

        This is the main entry point for workflow tools. It:
        1. Copies the parquet to temp storage
        2. Generates PMTiles if enabled and has geometry
        3. Creates metadata.json

        Args:
            source_parquet: Path to the source parquet file
            layer_name: Display name for the layer
            process_id: Optional process/tool ID
            duckdb_con: Optional DuckDB connection for reading parquet metadata
            style: Builds the layer's style from its geometry type as read from
                the data

        Returns:
            TempLayerResult with paths and metadata
        """
        source_path = Path(source_parquet)
        if not source_path.exists():
            raise FileNotFoundError(f"Source parquet not found: {source_path}")

        # Create directory
        self.base_path.mkdir(parents=True, exist_ok=True)

        # Copy parquet to temp location
        shutil.copy2(source_path, self.parquet_path)
        logger.info(f"Copied parquet to temp: {self.parquet_path}")

        # Get metadata from parquet
        metadata = self._extract_metadata(
            layer_name=layer_name,
            process_id=process_id,
            duckdb_con=duckdb_con,
        )

        if style is not None:
            metadata.style = style(metadata.geometry_type)

        # Generate PMTiles if enabled and has geometry
        pmtiles_path = None
        if self.pmtiles_enabled and metadata.geometry_type:
            pmtiles_path = self._generate_pmtiles(duckdb_con)

        # Write metadata
        self.metadata_path.write_text(metadata.model_dump_json(indent=2))
        logger.info(f"Wrote metadata to: {self.metadata_path}")

        return TempLayerResult(
            user_id=self.user_id,
            workflow_id=self.workflow_id,
            node_id=self.node_id,
            parquet_path=self.parquet_path,
            pmtiles_path=pmtiles_path,
            metadata=metadata,
        )

    def _extract_metadata(
        self: Self,
        layer_name: str,
        process_id: str | None,
        duckdb_con: duckdb.DuckDBPyConnection | None = None,
    ) -> TempLayerMetadata:
        """Extract metadata from the parquet file.

        Args:
            layer_name: Display name for the layer
            process_id: Optional process/tool ID
            duckdb_con: Optional DuckDB connection

        Returns:
            TempLayerMetadata with extracted info
        """
        # Create a DuckDB connection if not provided
        con = duckdb_con
        if con is None:
            con = duckdb.connect()
            set_memory_share(con, JOB_WORK_MEMORY_SHARE)
            con.execute("INSTALL spatial; LOAD spatial;")

        try:
            # Read parquet metadata
            parquet_path_str = str(self.parquet_path)

            # Get column info
            cols = con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{parquet_path_str}')"
            ).fetchall()
            columns = {row[0]: row[1] for row in cols}

            # Get row count
            count_result = con.execute(
                f"SELECT COUNT(*) FROM read_parquet('{parquet_path_str}')"
            ).fetchone()
            feature_count = count_result[0] if count_result else 0

            # Detect geometry column and type
            geom_col = None
            geometry_type = None
            bbox = None

            for col_name, col_type in columns.items():
                if "GEOMETRY" in col_type.upper():
                    geom_col = col_name
                    break

            if geom_col:
                # Get geometry type
                type_result = con.execute(f"""
                    SELECT DISTINCT ST_GeometryType({geom_col})
                    FROM read_parquet('{parquet_path_str}')
                    WHERE {geom_col} IS NOT NULL
                    LIMIT 1
                """).fetchone()
                if type_result:
                    geometry_type = type_result[0]

                # Get bounding box
                try:
                    extent_result = con.execute(f"""
                        SELECT
                            ST_XMin(ST_Extent_Agg({geom_col})),
                            ST_YMin(ST_Extent_Agg({geom_col})),
                            ST_XMax(ST_Extent_Agg({geom_col})),
                            ST_YMax(ST_Extent_Agg({geom_col}))
                        FROM read_parquet('{parquet_path_str}')
                    """).fetchone()
                    if extent_result and all(v is not None for v in extent_result):
                        bbox = list(extent_result)
                except Exception as e:
                    logger.warning(f"Could not compute bbox: {e}")

            # Get file size
            size_bytes = (
                self.parquet_path.stat().st_size if self.parquet_path.exists() else 0
            )

            return TempLayerMetadata(
                layer_name=layer_name,
                geometry_type=geometry_type,
                feature_count=feature_count,
                bbox=bbox,
                columns=columns,
                created_at=datetime.now(timezone.utc).isoformat(),
                workflow_id=self.workflow_id,
                node_id=self.node_id,
                process_id=process_id,
                size_bytes=size_bytes,
            )

        finally:
            # Close connection if we created it
            if duckdb_con is None and con:
                con.close()

    def _generate_pmtiles(
        self: Self,
        duckdb_con: duckdb.DuckDBPyConnection | None = None,
    ) -> Path | None:
        """Generate PMTiles from the parquet file.

        Uses tippecanoe for tile generation with variable-depth pyramid.

        Args:
            duckdb_con: Optional DuckDB connection

        Returns:
            Path to PMTiles file, or None if generation failed
        """
        # Check if tippecanoe is available
        if not shutil.which("tippecanoe"):
            logger.warning("tippecanoe not found, skipping PMTiles generation")
            return None

        build_dir: Path | None = None
        try:
            # Create a DuckDB connection if not provided
            con = duckdb_con
            if con is None:
                con = duckdb.connect()
                set_memory_share(con, JOB_WORK_MEMORY_SHARE)
                con.execute("INSTALL spatial; LOAD spatial;")

            # Export to GeoJSON (required by tippecanoe)
            with tempfile.NamedTemporaryFile(
                suffix=".geojson", delete=False, mode="w"
            ) as f:
                geojson_path = f.name

            parquet_path_str = str(self.parquet_path)

            # Get columns and filter out unsupported types for GeoJSON export
            cols = con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{parquet_path_str}')"
            ).fetchall()

            geom_col = None
            exportable_cols = []
            # Types that GDAL/OGR can't export to GeoJSON
            unsupported_prefixes = ("STRUCT", "MAP", "UNION")

            for col_name, col_type, *_ in cols:
                col_type_upper = col_type.upper()
                if "GEOMETRY" in col_type_upper:
                    geom_col = col_name
                    exportable_cols.append(col_name)
                elif not any(
                    col_type_upper.startswith(p) for p in unsupported_prefixes
                ):
                    exportable_cols.append(col_name)
                else:
                    logger.debug(
                        f"Excluding column '{col_name}' ({col_type}) from GeoJSON export"
                    )

            if not geom_col:
                logger.warning("No geometry column found, skipping PMTiles generation")
                return None

            # Build column list for export (excluding unsupported types)
            col_list = ", ".join(f'"{c}"' for c in exportable_cols)

            # Export to GeoJSON using DuckDB
            con.execute(f"""
                COPY (
                    SELECT {col_list} FROM read_parquet('{parquet_path_str}')
                ) TO '{geojson_path}'
                WITH (FORMAT GDAL, DRIVER 'GeoJSON')
            """)

            # Run tippecanoe on local disk; only the finished file is published
            # (see publish_tiles). The built file keeps the .pmtiles name,
            # since tippecanoe picks the output format by extension.
            build_dir = Path(tempfile.mkdtemp(prefix="pmtiles_"))
            built_path = build_dir / self.pmtiles_path.name
            cmd = [
                "tippecanoe",
                "-o",
                str(built_path),
                "--force",
                "--generate-variable-depth-tile-pyramid",
                f"--maximum-zoom={self.pmtiles_max_zoom}",
                "--drop-densest-as-needed",
                "--extend-zooms-if-still-dropping",
                "-l",
                "default",
                geojson_path,
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=600,  # 10 minute timeout
            )

            # Cleanup temp geojson
            Path(geojson_path).unlink(missing_ok=True)

            if result.returncode != 0:
                logger.warning(f"tippecanoe failed: {result.stderr}")
                return None

            from goatlib.io.pmtiles import publish_tiles

            publish_tiles(built_path, self.pmtiles_path)
            logger.info(f"Generated PMTiles: {self.pmtiles_path}")
            return self.pmtiles_path

        except subprocess.TimeoutExpired:
            logger.warning("tippecanoe timed out")
            return None
        except Exception as e:
            logger.warning(f"PMTiles generation failed: {e}")
            return None
        finally:
            if build_dir is not None:
                shutil.rmtree(build_dir, ignore_errors=True)
            # Close connection if we created it
            if duckdb_con is None and con:
                con.close()

    @classmethod
    def cleanup_workflow(
        cls,
        user_id: str,
        workflow_id: str,
        temp_data_root: Path | str = TEMP_DATA_ROOT,
    ) -> bool:
        """Delete all temp files for a workflow.

        Args:
            user_id: User UUID
            workflow_id: Workflow UUID
            temp_data_root: Root directory for temporary storage

        Returns:
            True if cleanup succeeded, False if nothing to clean
        """
        user_id_clean = user_id.replace("-", "")
        workflow_id_clean = workflow_id.replace("-", "") if workflow_id else workflow_id

        workflow_path = Path(temp_data_root) / user_id_clean / workflow_id_clean

        if workflow_path.exists():
            shutil.rmtree(workflow_path)
            logger.info(f"Cleaned up temp workflow: {workflow_path}")
            return True

        return False

    @classmethod
    def cleanup_user_old(
        cls,
        user_id: str,
        max_age_hours: int = 24,
        temp_data_root: Path | str = TEMP_DATA_ROOT,
    ) -> int:
        """Delete temp files older than max_age_hours.

        Args:
            user_id: User UUID
            max_age_hours: Maximum age in hours
            temp_data_root: Root directory for temporary storage

        Returns:
            Number of workflows cleaned up
        """
        user_id_clean = user_id.replace("-", "")
        user_path = Path(temp_data_root) / user_id_clean

        if not user_path.exists():
            return 0

        import time

        cutoff = time.time() - (max_age_hours * 3600)
        cleaned = 0

        for workflow_dir in user_path.iterdir():
            if workflow_dir.is_dir() and workflow_dir.stat().st_mtime < cutoff:
                shutil.rmtree(workflow_dir)
                logger.info(f"Cleaned up old temp workflow: {workflow_dir}")
                cleaned += 1

        return cleaned

    @classmethod
    def get_temp_layer_path(
        cls,
        user_id: str,
        workflow_id: str,
        node_id: str,
        temp_data_root: Path | str = TEMP_DATA_ROOT,
    ) -> Path:
        """Get the base path for a temp layer.

        Args:
            user_id: User UUID
            workflow_id: Workflow UUID
            node_id: Node ID

        Returns:
            Path to the temp layer directory
        """
        user_id_clean = user_id.replace("-", "")
        workflow_id_clean = workflow_id.replace("-", "") if workflow_id else workflow_id

        return Path(temp_data_root) / user_id_clean / workflow_id_clean / node_id

    @classmethod
    def temp_layer_exists(
        cls,
        user_id: str,
        workflow_id: str,
        node_id: str,
        temp_data_root: Path | str = TEMP_DATA_ROOT,
    ) -> bool:
        """Check if a temp layer exists.

        Args:
            user_id: User UUID
            workflow_id: Workflow UUID
            node_id: Node ID

        Returns:
            True if the temp layer parquet exists
        """
        base_path = cls.get_temp_layer_path(
            user_id, workflow_id, node_id, temp_data_root
        )
        return (base_path / "data.parquet").exists()

    @classmethod
    def read_temp_metadata(
        cls,
        user_id: str,
        workflow_id: str,
        node_id: str,
        temp_data_root: Path | str = TEMP_DATA_ROOT,
    ) -> TempLayerMetadata | None:
        """Read metadata for a temp layer.

        Args:
            user_id: User UUID
            workflow_id: Workflow UUID
            node_id: Node ID

        Returns:
            TempLayerMetadata or None if not found
        """
        base_path = cls.get_temp_layer_path(
            user_id, workflow_id, node_id, temp_data_root
        )
        metadata_path = base_path / "metadata.json"

        if not metadata_path.exists():
            return None

        try:
            data = json.loads(metadata_path.read_text())
            return TempLayerMetadata(**data)
        except Exception as e:
            logger.warning(f"Failed to read temp metadata: {e}")
            return None
