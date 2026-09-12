"""LayerUpdate Tool - Update layer data while preserving metadata and IDs.

This tool handles updating layer data without changing the layer ID:
1. Imports new data from S3 (file upload) or refreshes from WFS
2. Replaces DuckLake table data (DROP + CREATE)
3. Updates PostgreSQL metadata (extent, size, feature_count, etc.)
4. Preserves: layer ID, folder, name, description, tags, style, project links

Usage:
    from goatlib.tools.layer_update import LayerUpdateParams, main

    # Update from new file upload
    result = main(LayerUpdateParams(
        user_id="...",
        layer_id="...",
        s3_key="uploads/new_data.gpkg",
    ))

    # Refresh WFS layer
    result = main(LayerUpdateParams(
        user_id="...",
        layer_id="...",
        refresh_wfs=True,
    ))
"""

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any, Self

from pydantic import ConfigDict, Field, model_validator

from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    ui_field,
    ui_sections,
)
from goatlib.io.converter import IOConverter
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import SimpleToolRunner
from goatlib.tools.layer_replace import LayerReplaceMixin
from goatlib.tools.schemas import ToolInputBase

logger = logging.getLogger(__name__)


class LayerUpdateParams(ToolInputBase):
    """Parameters for LayerUpdate tool."""

    model_config = ConfigDict(json_schema_extra=ui_sections(SECTION_INPUT))

    layer_id: str = Field(
        ...,
        description="ID of the layer to update",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            widget="layer-selector",
        ),
    )
    s3_key: str | None = Field(
        None,
        description="S3 object key for new data file (for file-based layers)",
        json_schema_extra=ui_field(
            section="input",
            field_order=2,
            mutually_exclusive_group="update_source",
        ),
    )
    refresh_wfs: bool = Field(
        False,
        description="Refresh data from WFS source (for WFS layers)",
        json_schema_extra=ui_field(
            section="input",
            field_order=3,
            mutually_exclusive_group="update_source",
        ),
    )

    @model_validator(mode="after")
    def validate_update_source(self: Self) -> Self:
        """Ensure exactly one update source is specified."""
        if not self.s3_key and not self.refresh_wfs:
            raise ValueError("Either s3_key or refresh_wfs must be specified")
        if self.s3_key and self.refresh_wfs:
            raise ValueError("Cannot specify both s3_key and refresh_wfs")
        return self


class LayerUpdateOutput(ToolInputBase):
    """Output schema for LayerUpdate tool."""

    layer_id: str
    updated: bool = False
    feature_count: int | None = None
    size: int | None = None
    geometry_type: str | None = None
    error: str | None = None


class LayerUpdateRunner(LayerReplaceMixin, SimpleToolRunner):
    """Runner for LayerUpdate tool.

    Extends SimpleToolRunner for shared infrastructure (DuckDB, settings, logging).
    Reuses import logic from layer_import for S3 and WFS data loading.
    Reuses in-place replacement helpers from LayerReplaceMixin.
    """

    def __init__(self: Self) -> None:
        """Initialize runner."""
        super().__init__()
        self._converter: IOConverter | None = None

    @property
    def converter(self: Self) -> IOConverter:
        """Lazy-load IOConverter."""
        if self._converter is None:
            self._converter = IOConverter()
        return self._converter

    def _get_s3_client(self: Self) -> Any:
        """Get or create S3 client."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        return self.settings.get_s3_client()

    def _import_from_s3(
        self: Self, s3_key: str, temp_dir: Path, output_path: Path
    ) -> DatasetMetadata:
        """Import file from S3 and convert to GeoParquet.

        Args:
            s3_key: S3 object key
            temp_dir: Temporary directory for downloaded file
            output_path: Path for output parquet file

        Returns:
            Dataset metadata from conversion
        """
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        logger.info(
            "S3 Settings: provider=%s, endpoint=%s, bucket=%s, region=%s",
            self.settings.s3_provider,
            self.settings.s3_endpoint_url,
            self.settings.s3_bucket_name,
            self.settings.s3_region_name,
        )
        logger.info("S3 Key: %s", s3_key)

        # Download file directly using boto3
        client = self._get_s3_client()
        filename = Path(s3_key).name
        local_file = temp_dir / filename

        logger.info(
            "Downloading s3://%s/%s to %s",
            self.settings.s3_bucket_name,
            s3_key,
            local_file,
        )
        self.download_uploaded_object(s3_key, local_file, client=client)

        # Convert to GeoParquet using IOConverter
        metadata = self.converter.to_parquet(
            src_path=str(local_file),
            out_path=str(output_path),
            target_crs="EPSG:4326",
        )

        logger.info(
            "S3 import complete: %d features, format=%s",
            metadata.feature_count or 0,
            metadata.format,
        )
        return metadata

    def _import_from_wfs(
        self: Self,
        wfs_url: str,
        layer_name: str | None,
        temp_dir: Path,
        output_path: Path,
    ) -> DatasetMetadata:
        """Import layer from WFS service.

        Args:
            wfs_url: WFS service URL
            layer_name: Specific layer name (None = first layer)
            temp_dir: Temporary directory for intermediate files
            output_path: Path for output parquet file

        Returns:
            Dataset metadata from WFS import
        """
        logger.info("Importing from WFS: %s (layer=%s)", wfs_url, layer_name)

        # Import lazily to avoid GDAL dependency when not using WFS
        from goatlib.io.remote_source.wfs import from_wfs

        # Use goatlib WFS reader
        results = from_wfs(
            url=wfs_url,
            out_dir=str(temp_dir),
            layer=layer_name,
            target_crs="EPSG:4326",
        )

        if not results or results == (None, None):
            raise ValueError(f"No data retrieved from WFS: {wfs_url}")

        # Get first result (from_wfs can return list or tuple)
        if isinstance(results, list):
            parquet_path, metadata = results[0]
        else:
            parquet_path, metadata = results

        # Move to expected output path
        shutil.move(str(parquet_path), str(output_path))

        logger.info(
            "WFS import complete: %d features",
            metadata.feature_count or 0,
        )
        return metadata

    def run(self: Self, params: LayerUpdateParams) -> dict[str, Any]:
        """Run the layer update.

        1. Verify ownership and get layer info
        2. Import new data from S3 or WFS
        3. Replace DuckLake table
        4. Update PostgreSQL metadata

        Args:
            params: Update parameters

        Returns:
            Dict with update results
        """
        import tempfile

        logger.info(
            "Starting layer update: layer_id=%s, user_id=%s, s3_key=%s, refresh_wfs=%s",
            params.layer_id,
            params.user_id,
            params.s3_key,
            params.refresh_wfs,
        )

        try:
            # Step 1: Get layer info and verify ownership
            layer_info = asyncio.get_event_loop().run_until_complete(
                self._get_layer_full_info(params.layer_id, params.user_id)
            )
            logger.info(
                "Layer info: name=%s, type=%s, data_type=%s",
                layer_info["name"],
                layer_info["type"],
                layer_info.get("data_type"),
            )

            with tempfile.TemporaryDirectory(prefix="layer_update_") as temp_dir:
                temp_path = Path(temp_dir)
                output_parquet = temp_path / "output.parquet"

                # Step 2: Import new data
                if params.refresh_wfs:
                    # Get WFS URL and layer from other_properties
                    other_props = layer_info.get("other_properties", {})
                    wfs_url = other_props.get("url")
                    wfs_layers = other_props.get("layers", [])

                    if not wfs_url:
                        raise ValueError(
                            f"Layer {params.layer_id} is not a WFS layer or missing URL"
                        )

                    # Get first layer name if list
                    wfs_layer_name = (
                        wfs_layers[0]
                        if isinstance(wfs_layers, list) and wfs_layers
                        else wfs_layers
                        if isinstance(wfs_layers, str)
                        else None
                    )

                    self._import_from_wfs(
                        wfs_url=wfs_url,
                        layer_name=wfs_layer_name,
                        temp_dir=temp_path,
                        output_path=output_parquet,
                    )
                else:
                    # Import from S3
                    self._import_from_s3(
                        s3_key=params.s3_key,  # type: ignore
                        temp_dir=temp_path,
                        output_path=output_parquet,
                    )

                # Step 3: Replace DuckLake table
                table_info = self._replace_ducklake_table(
                    layer_id=params.layer_id,
                    owner_id=layer_info["user_id"],
                    parquet_path=output_parquet,
                )
                logger.info(
                    "DuckLake table replaced: %s (%d features)",
                    table_info["table_name"],
                    table_info.get("feature_count", 0),
                )

                # Step 3.5: Regenerate PMTiles (delete old + create new)
                # First delete any existing PMTiles for this layer
                self._delete_old_pmtiles(
                    user_id=layer_info["user_id"],
                    layer_id=params.layer_id,
                )

                # Then generate new PMTiles from updated data
                self._regenerate_pmtiles(
                    user_id=layer_info["user_id"],
                    layer_id=params.layer_id,
                    table_info=table_info,
                )

                # Step 4: Update PostgreSQL metadata
                asyncio.get_event_loop().run_until_complete(
                    self._update_layer_metadata(
                        layer_id=params.layer_id,
                        feature_count=table_info.get("feature_count", 0),
                        extent_wkt=table_info.get("extent_wkt"),
                        size=table_info.get("size", 0),
                        geometry_type=table_info.get("geometry_type"),
                    )
                )

            # Build output
            from goatlib.tools.db import normalize_geometry_type

            output = LayerUpdateOutput(
                user_id=params.user_id,
                layer_id=params.layer_id,
                updated=True,
                feature_count=table_info.get("feature_count"),
                size=table_info.get("size"),
                geometry_type=normalize_geometry_type(table_info.get("geometry_type")),
            )

            logger.info("Layer update completed: %s", params.layer_id)
            return output.model_dump()

        except PermissionError as e:
            logger.error("Permission denied: %s", e)
            return LayerUpdateOutput(
                user_id=params.user_id,
                layer_id=params.layer_id,
                updated=False,
                error=str(e),
            ).model_dump()
        except Exception as e:
            logger.exception("Layer update failed: %s", e)
            return LayerUpdateOutput(
                user_id=params.user_id,
                layer_id=params.layer_id,
                updated=False,
                error=str(e),
            ).model_dump()

    def cleanup(self: Self) -> None:
        """Clean up resources."""
        if self._duckdb_con:
            try:
                self._duckdb_con.close()
            except Exception:
                pass
            self._duckdb_con = None


def main(params: LayerUpdateParams) -> dict[str, Any]:
    """Windmill entry point for layer update tool."""
    runner = LayerUpdateRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
