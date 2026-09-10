"""Layer import tool for Windmill.

Imports geospatial data from S3 or WFS into DuckLake storage.
Supports all formats that goatlib IOConverter handles (GeoPackage, Shapefile, GeoJSON, etc).
"""

import logging
import os
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Any, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.schemas.ui import (
    SECTION_OUTPUT,
    UISection,
    ui_field,
    ui_sections,
)
from goatlib.io.converter import IOConverter
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.schemas import ToolInputBase

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class LayerImportParams(ToolInputBase):
    """Parameters for layer import tool.

    Either s3_key or wfs_url must be provided.
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            UISection(id="source", order=1, icon="upload"),
            UISection(id="wfs_options", order=2, icon="globe"),
            UISection(id="metadata", order=3, icon="tag"),
            SECTION_OUTPUT,
        )
    )

    # Import source (one of these must be provided)
    s3_key: str | None = Field(
        None,
        description="S3 object key for file import",
        json_schema_extra=ui_field(
            section="source",
            field_order=1,
            mutually_exclusive_group="import_source",
        ),
    )
    wfs_url: str | None = Field(
        None,
        description="WFS service URL for external layer import",
        json_schema_extra=ui_field(
            section="source",
            field_order=2,
            mutually_exclusive_group="import_source",
        ),
    )
    wfs_layer_name: str | None = Field(
        None,
        description="Layer name within the WFS service",
        json_schema_extra=ui_field(
            section="wfs_options",
            field_order=1,
            visible_when={"wfs_url": {"$ne": None}},
        ),
    )

    # External layer properties (for WFS/external services)
    data_type: str | None = Field(
        None,
        description="Data type (for WFS layers)",
        json_schema_extra=ui_field(
            section="wfs_options",
            field_order=2,
            visible_when={"wfs_url": {"$ne": None}},
        ),
    )
    other_properties: dict | None = Field(
        None,
        description="Additional properties for WFS layer",
        json_schema_extra=ui_field(
            section="wfs_options",
            field_order=3,
            hidden=True,
        ),
    )

    # Tabular import options (CSV/XLSX)
    has_header: bool | None = Field(
        None,
        description="Whether the first row contains column headers (True=yes, False=no, None=auto-detect)",
        json_schema_extra=ui_field(
            section="source",
            field_order=3,
            hidden=True,
        ),
    )
    sheet_name: str | None = Field(
        None,
        description="Worksheet name for XLSX files (None=first sheet)",
        json_schema_extra=ui_field(
            section="source",
            field_order=4,
            hidden=True,
        ),
    )

    # Layer metadata
    name: str | None = Field(
        None,
        description="Layer name (will use filename if not provided)",
        json_schema_extra=ui_field(section="metadata", field_order=1),
    )
    description: str | None = Field(
        None,
        description="Layer description",
        json_schema_extra=ui_field(section="metadata", field_order=2),
    )
    tags: list[str] | None = Field(
        None,
        description="Tags for categorizing the layer",
        json_schema_extra=ui_field(section="metadata", field_order=3, widget="tags"),
    )


class LayerImportRunner(BaseToolRunner[LayerImportParams]):
    """Layer import tool runner for Windmill.

    Imports files from S3 or WFS services into DuckLake storage.
    Unlike analysis tools, this creates "standard" feature layers (not "tool" layers).
    """

    tool_class = None  # No analysis tool - we handle import directly
    output_geometry_type = None  # Detected from data
    default_output_name = "Imported Layer"

    def __init__(self: Self) -> None:
        """Initialize layer import runner."""
        super().__init__()
        self._s3_client = None
        self._converter = None

    def get_feature_layer_type(self: Self, params: LayerImportParams) -> str:
        """Return 'standard' for imported layers (not 'tool').

        Args:
            params: Import parameters

        Returns:
            "standard" for user-imported data
        """
        return "standard"

    @property
    def converter(self: Self) -> IOConverter:
        """Lazy-load IOConverter."""
        if self._converter is None:
            self._converter = IOConverter()
        return self._converter

    def _get_s3_client(self: Self) -> Any:
        """Get or create S3 client (uses shared helper from ToolSettings)."""
        if self._s3_client is None:
            if self.settings is None:
                raise RuntimeError("Settings not initialized")
            self._s3_client = self.settings.get_s3_client()
        return self._s3_client

    def _import_from_s3(
        self: Self,
        s3_key: str,
        temp_dir: Path,
        output_path: Path,
        has_header: bool | None = None,
        sheet_name: str | None = None,
    ) -> DatasetMetadata:
        """Import file from S3 and convert to GeoParquet.

        Args:
            s3_key: S3 object key
            temp_dir: Temporary directory for downloaded file
            output_path: Path for output parquet file
            has_header: Whether first row contains column headers
            sheet_name: Worksheet name for XLSX files

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

        # Download file directly using boto3 (more reliable than presigned URLs)
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
            has_header=has_header,
            sheet_name=sheet_name,
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

    def process(
        self: Self, params: LayerImportParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        """Import data from S3 or WFS and convert to GeoParquet.

        Args:
            params: Import parameters
            temp_dir: Temporary directory for intermediate files

        Returns:
            Tuple of (output_parquet_path, metadata)

        Raises:
            ValueError: If neither s3_key nor wfs_url provided
        """
        if not params.s3_key and not params.wfs_url:
            raise ValueError("Either s3_key or wfs_url must be provided")

        output_path = temp_dir / "output.parquet"

        if params.wfs_url:
            # Get layer name from wfs_layer_name or other_properties.layers
            layer_name = params.wfs_layer_name
            if not layer_name and params.other_properties:
                layers = params.other_properties.get("layers", [])
                if layers:
                    layer_name = layers[0] if isinstance(layers, list) else layers
                    logger.info("Using layer from other_properties: %s", layer_name)

            metadata = self._import_from_wfs(
                wfs_url=params.wfs_url,
                layer_name=layer_name,
                temp_dir=temp_dir,
                output_path=output_path,
            )
            # Override source info
            metadata.format = "wfs"
        else:
            metadata = self._import_from_s3(
                s3_key=params.s3_key,  # type: ignore
                temp_dir=temp_dir,
                output_path=output_path,
                has_header=params.has_header,
                sheet_name=params.sheet_name,
            )
            # Extract original format from S3 key
            original_ext = os.path.splitext(params.s3_key)[1].lstrip(".")  # type: ignore
            if original_ext:
                metadata.format = original_ext.lower()

        return output_path, metadata

    def run(self: Self, params: LayerImportParams) -> dict:
        """Run layer import with custom output name handling.

        Overrides base to handle output_name from s3_key if not provided.

        Args:
            params: Import parameters

        Returns:
            Dict with layer metadata
        """
        # Set default output name from filename if not provided
        if not params.output_name and not params.name:
            if params.s3_key:
                # Extract filename without extension
                filename = os.path.basename(params.s3_key)
                params.output_name = os.path.splitext(filename)[0]
            elif params.wfs_url:
                params.output_name = params.wfs_layer_name or "WFS Import"

        # Use name field if output_name not set
        if not params.output_name and params.name:
            params.output_name = params.name

        return super().run(params)


def main(params: LayerImportParams) -> dict:
    """Windmill entry point for layer import tool."""
    runner = LayerImportRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
