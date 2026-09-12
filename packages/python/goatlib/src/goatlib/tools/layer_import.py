"""Layer import tool for Windmill.

Imports geospatial data from S3 or WFS into DuckLake storage.
Supports all formats that goatlib IOConverter handles (GeoPackage, Shapefile, GeoJSON, etc).

An upload can hold more than one dataset — the layers of a GeoPackage, the files of an
archive, at any depth — and this imports all of them, as one job. One dataset failing does
not lose the others: the job reports which arrived and which were skipped.
"""

import logging
import os
import shutil
import tempfile
import uuid as uuid_module
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
from goatlib.io.formats import RASTER_EXTS
from goatlib.io.ingest import convert_all, first_line
from goatlib.models.io import ConversionReport, DatasetMetadata
from goatlib.tools.base import BaseToolRunner, _get_or_create_event_loop
from goatlib.tools.schemas import ToolInputBase, ToolOutputBase

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

# How many datasets one upload may import. A zip of shapefiles can hold hundreds, and
# every one of them becomes a layer — and, from a map, a layer on that map. Refused after
# discovery, which is the job's first step, so nothing is imported before the refusal.
MAX_DATASETS_PER_IMPORT = 25


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
        """Run layer import, importing every dataset the source contains.

        Args:
            params: Import parameters

        Returns:
            Dict with the first layer's metadata, plus `imported` and `skipped` listing
            every dataset the source held.
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

        # A WFS import is one layer by definition, and a workflow preview writes to temp
        # storage rather than creating layers: both are the base's single-output path.
        if params.wfs_url or getattr(params, "temp_mode", False):
            return super().run(params)

        return self._run_multi(params)

    def _run_multi(self: Self, params: LayerImportParams) -> dict:
        """Import every dataset in an uploaded file, as one job.

        Mirrors `BaseToolRunner.run` — ingest, tiles, records — but per dataset, because
        the base assumes a tool produces exactly one layer and an upload does not.
        """
        if not params.s3_key:
            raise ValueError("s3_key is required")

        loop = _get_or_create_event_loop()
        loop.run_until_complete(self._init_db_service())

        imported: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []
        first_output: dict[str, Any] | None = None

        with tempfile.TemporaryDirectory(prefix="layerimport_") as temp_dir:
            temp_path = Path(temp_dir)
            report = self._convert_upload(params, temp_path)

            if not report.outputs and not report.failures:
                raise ValueError(f"No convertible datasets found in {params.s3_key}")

            # Only one dataset: the name the user typed is that layer's name. Several, and
            # it cannot be — each takes the name of the layer or file it came from.
            #
            # Counted over everything the source held, failures included: a file of five
            # datasets where four could not be read still held five, and naming the
            # survivor after the file would claim it was the whole upload.
            single = len(report.outputs) + len(report.failures) == 1

            for dataset in report.outputs:
                # A raster converts to a COG, not to parquet, and DuckLake ingestion takes
                # parquet — so it cannot go through this path. Reported rather than
                # ingested as if it were a table: an upload holding one is otherwise a
                # corrupt layer instead of a skipped one.
                if Path(dataset.path).suffix.lower() in RASTER_EXTS:
                    skipped.append(
                        {
                            "name": dataset.name,
                            "reason": "Raster datasets cannot be imported here yet",
                        }
                    )
                    continue

                name = (
                    params.output_name or self.default_output_name
                    if single
                    else dataset.name
                )
                try:
                    output = self._import_one(
                        params=params,
                        parquet=Path(dataset.path),
                        metadata=dataset.metadata,
                        name=name,
                        loop=loop,
                    )
                except Exception as e:  # noqa: BLE001 - one layer must not lose the others
                    logger.exception("Importing %s failed", name)
                    skipped.append({"name": name, "reason": first_line(e)})
                    continue

                imported.append(
                    {"layer_id": output["layer_id"], "name": output["name"]}
                )
                if first_output is None:
                    first_output = output

            for failure in report.failures:
                skipped.append({"name": failure.name, "reason": failure.reason})

        loop.run_until_complete(self._close_db_service())

        if first_output is None:
            reasons = "; ".join(f"{s['name']}: {s['reason']}" for s in skipped)
            raise ValueError(f"Nothing could be imported. {reasons}")

        logger.info(
            "Import complete: %d layers created, %d skipped",
            len(imported),
            len(skipped),
        )
        # The first layer's own output, so anything reading a single import still works,
        # with the full account beside it.
        return {**first_output, "imported": imported, "skipped": skipped}

    def _convert_upload(
        self: Self, params: LayerImportParams, temp_dir: Path
    ) -> ConversionReport:
        """Fetch the upload and convert every dataset in it."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")

        client = self._get_s3_client()
        s3_key = params.s3_key or ""
        local_file = temp_dir / Path(s3_key).name
        logger.info(
            "Downloading s3://%s/%s to %s",
            self.settings.s3_bucket_name,
            s3_key,
            local_file,
        )
        self.download_uploaded_object(s3_key, local_file, client=client)

        report = convert_all(
            str(local_file),
            temp_dir / "converted",
            target_crs="EPSG:4326",
            has_header=params.has_header,
            sheet_name=params.sheet_name,
        )

        total = len(report.outputs) + len(report.failures)
        if total > MAX_DATASETS_PER_IMPORT:
            raise ValueError(
                f"This file holds {total} datasets; at most "
                f"{MAX_DATASETS_PER_IMPORT} can be imported at once."
            )
        return report

    def _import_one(
        self: Self,
        params: LayerImportParams,
        parquet: Path,
        metadata: DatasetMetadata,
        name: str,
        loop: Any,
    ) -> dict[str, Any]:
        """Ingest one converted dataset and record it as a layer."""
        layer_id = str(uuid_module.uuid4())
        custom_properties = self.get_layer_properties(
            params, metadata, parquet_path=parquet
        )

        table_info = self._ingest_to_ducklake(
            user_id=params.user_id, layer_id=layer_id, parquet_path=parquet
        )
        if table_info.get("geometry_type"):
            pmtiles_path = self._generate_pmtiles(
                user_id=params.user_id,
                layer_id=layer_id,
                table_name=table_info["table_name"],
                geometry_column=table_info.get("geometry_column", "geometry"),
            )
            if pmtiles_path:
                table_info["pmtiles_path"] = str(pmtiles_path)

        result_info = loop.run_until_complete(
            self._create_db_records(
                output_layer_id=layer_id,
                params=params,
                output_name=name,
                metadata=metadata,
                table_info=table_info,
                custom_properties=custom_properties,
            )
        )

        geometry_type = table_info.get("geometry_type")
        return ToolOutputBase(
            layer_id=layer_id,
            name=name,
            folder_id=result_info["folder_id"],
            user_id=params.user_id,
            project_id=params.project_id,
            layer_project_id=result_info.get("layer_project_id"),
            type="feature" if geometry_type else "table",
            feature_layer_type=self.get_feature_layer_type(params)
            if geometry_type
            else None,
            geometry_type=geometry_type,
            feature_count=table_info.get("feature_count", 0),
            extent=table_info.get("extent"),
            table_name=table_info["table_name"],
        ).model_dump()


def main(params: LayerImportParams) -> dict:
    """Windmill entry point for layer import tool."""
    runner = LayerImportRunner()
    runner.init_from_env()

    try:
        return runner.run(params)
    finally:
        runner.cleanup()
