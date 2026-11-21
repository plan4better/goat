# src/goatlib/io/remote_source/wfs.py
from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Tuple, Union

from goatlib.io.ingest import convert_any
from goatlib.io.remote_source.url_guard import assert_public_http_url
from goatlib.io.remote_source.wfs_reader import WFSReader
from goatlib.models.io import DatasetMetadata
from goatlib.utils.layer_address import text_without_keys, without_key

logger = logging.getLogger(__name__)

# Define result type for WFS operations
WfsResult = Union[
    List[Tuple[Path, DatasetMetadata]], Tuple[Path, DatasetMetadata], Tuple[None, None]
]

# Maximum number of features allowed from a single WFS layer
# This prevents accidental imports of massive datasets
WFS_MAX_FEATURES = 500_000


def from_wfs(
    url: str,
    out_dir: str | Path,
    *,
    layer: str | List[str] | None = None,
    target_crs: str | None = None,
    list_layers: bool = False,
) -> WfsResult:
    """
    Read or inspect a WFS service and convert layers to Parquet/GeoParquet.
    """
    # The URL is user input fetched from our network: refuse internal targets
    # before anything touches it.
    assert_public_http_url(url)

    reader = WFSReader()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not reader.can_handle(url):
        raise ValueError(f"URL does not look like a WFS endpoint: {without_key(url)}")

    # Fetch available layers
    layers = _fetch_wfs_layers(reader, url)

    if list_layers:
        _display_available_layers(layers)
        return None, None

    if not layers:
        raise RuntimeError("No layers found in WFS service.")

    # Determine and validate layers to process
    layers_to_process = _validate_and_filter_layers(layer, layers)

    if not layers_to_process:
        logger.warning("No valid layers found to process")
        return []

    # Convert layers
    return _convert_wfs_layers(
        reader=reader,
        url=url,
        layers=layers_to_process,
        out_dir=out_dir,
        target_crs=target_crs,
    )


def _fetch_wfs_layers(reader: WFSReader, url: str) -> List[str]:
    """Fetch available layers from WFS service."""
    try:
        return reader.get_layers(url)
    except RuntimeError as e:
        raise RuntimeError(f"Failed to fetch WFS layers from {without_key(url)}") from e


def _display_available_layers(layers: List[str]) -> None:
    """Display available WFS layers to the user."""
    logger.info("Available WFS layers:")
    for layer_name in layers:
        logger.info("  • %s", layer_name)


def _validate_and_filter_layers(
    requested_layers: str | List[str] | None, available_layers: List[str]
) -> List[str]:
    """Validate requested layers against available layers."""
    if requested_layers is None:
        return available_layers

    if isinstance(requested_layers, str):
        selected_layers = [requested_layers]
    elif isinstance(requested_layers, list):
        selected_layers = requested_layers
    else:
        raise TypeError(
            "The 'layer' argument must be a string, list of strings, or None"
        )

    # Filter out non-existent layers with warnings
    valid_layers = []
    for layer_name in selected_layers:
        if layer_name in available_layers:
            valid_layers.append(layer_name)
        else:
            logger.warning("Layer '%s' not found in WFS service - skipping", layer_name)

    return valid_layers


def _convert_wfs_layers(
    reader: WFSReader,
    url: str,
    layers: List[str],
    out_dir: Path,
    target_crs: str | None,
) -> WfsResult:
    """Convert WFS layers to Parquet/GeoParquet."""
    results: List[Tuple[Path, DatasetMetadata]] = []

    for layer_name in layers:
        try:
            layer_results = _convert_single_wfs_layer(
                reader=reader,
                url=url,
                layer_name=layer_name,
                out_dir=out_dir,
                target_crs=target_crs,
            )
            results.extend(layer_results)

        except Exception as e:
            logger.error(
                "Failed to process WFS layer '%s': %s",
                layer_name,
                text_without_keys(str(e)),
            )
            # Continue with next layer instead of failing completely

    # Return appropriate format based on number of results
    return _format_wfs_results(results, layers)


def _convert_single_wfs_layer(
    reader: WFSReader,
    url: str,
    layer_name: str,
    out_dir: Path,
    target_crs: str | None,
) -> List[Tuple[Path, DatasetMetadata]]:
    """Convert a single WFS layer to Parquet/GeoParquet.

    Uses osgeo/OGR directly to fetch WFS data (avoids DuckDB's bundled GDAL
    which can have recursion issues with WFS driver).
    """
    import tempfile

    tmp_dir = Path(tempfile.mkdtemp(prefix="goatlib_wfs_"))
    geojson_path = tmp_dir / f"{reader._sanitize_filename(layer_name)}.geojson"

    try:
        # Step 1: Use osgeo to fetch WFS data directly to GeoJSON
        logger.info("Fetching WFS layer '%s' via osgeo...", layer_name)
        _fetch_wfs_to_geojson(reader, url, layer_name, geojson_path)

        # Step 2: Convert GeoJSON to Parquet using DuckDB (no WFS driver needed)
        logger.info("Converting GeoJSON to Parquet...")
        return convert_any(
            src_path=str(geojson_path),
            dest_dir=out_dir,
            geometry_col=None,
            target_crs=target_crs,
        )

    finally:
        # Clean up temporary files
        _cleanup_wfs_temp_files(geojson_path, tmp_dir)


def _fetch_wfs_to_geojson(
    reader: WFSReader, url: str, layer_name: str, output_path: Path
) -> None:
    """Fetch WFS layer data using osgeo and save to GeoJSON.

    This bypasses DuckDB's ST_Read which has issues with WFS in some environments.
    """
    from osgeo import gdal, ogr

    # Clean URL and build connection string
    clean_url = reader._clean_wfs_url(url)
    connection_string = f"WFS:{clean_url}"

    logger.info("Opening WFS datasource: WFS:%s", without_key(clean_url))

    # Open WFS datasource
    wfs_ds = ogr.Open(connection_string, 0)
    if wfs_ds is None:
        error_msg = gdal.GetLastErrorMsg()
        raise RuntimeError(
            "Failed to open WFS datasource: "
            f"{text_without_keys(error_msg) or 'Unknown error'}"
        )

    try:
        # Get the layer
        layer = wfs_ds.GetLayerByName(layer_name)
        if layer is None:
            available = [
                wfs_ds.GetLayerByIndex(i).GetName()
                for i in range(wfs_ds.GetLayerCount())
            ]
            raise RuntimeError(
                f"Layer '{layer_name}' not found. Available: {available}"
            )

        feature_count = layer.GetFeatureCount()
        logger.info("WFS layer '%s' has %d features", layer_name, feature_count)

        # Check feature limit
        if feature_count > WFS_MAX_FEATURES:
            raise ValueError(
                f"WFS layer '{layer_name}' has {feature_count:,} features, "
                f"which exceeds the maximum limit of {WFS_MAX_FEATURES:,}. "
                f"Please select a smaller layer or apply a spatial filter."
            )

        # Create GeoJSON output
        geojson_driver = ogr.GetDriverByName("GeoJSON")
        if geojson_driver is None:
            raise RuntimeError("GeoJSON driver not available")

        # Remove output file if it exists
        if output_path.exists():
            output_path.unlink()

        out_ds = geojson_driver.CreateDataSource(str(output_path))
        if out_ds is None:
            raise RuntimeError(f"Failed to create GeoJSON file: {output_path}")

        try:
            # Copy layer to GeoJSON
            out_layer = out_ds.CopyLayer(layer, layer_name)
            if out_layer is None:
                error_msg = gdal.GetLastErrorMsg()
                raise RuntimeError(
                    "Failed to copy layer: "
                    f"{text_without_keys(error_msg) or 'Unknown error'}"
                )

            # Force write
            out_ds.FlushCache()

            logger.info("Saved WFS data to GeoJSON: %s", output_path)

        finally:
            out_ds = None  # Close output

    finally:
        wfs_ds = None  # Close WFS connection


def _cleanup_wfs_temp_files(xml_path: Path | None, tmp_dir: Path | None) -> None:
    """Clean up temporary WFS files and directories."""
    try:
        if xml_path and xml_path.exists():
            xml_path.unlink(missing_ok=True)

        if tmp_dir and tmp_dir.exists():
            # Remove directory if empty
            try:
                tmp_dir.rmdir()
            except OSError:
                # Directory not empty - leave for system cleanup
                logger.debug("Could not remove non-empty temp directory: %s", tmp_dir)
    except Exception as e:
        logger.warning("Failed to clean up WFS temp files: %s", e)


def _format_wfs_results(
    results: List[Tuple[Path, DatasetMetadata]], requested_layers: List[str]
) -> WfsResult:
    """Format results appropriately based on number of layers processed."""
    if len(requested_layers) == 1 and len(results) == 1:
        # Single layer → return single tuple for backward compatibility
        return results[0]
    else:
        return results
