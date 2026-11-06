import logging
import shutil
from pathlib import Path

from goatlib.io.converter import IOConverter
from goatlib.io.discover import discover_inputs
from goatlib.io.formats import (
    RASTER_EXTS,
    TABULAR_EXTS,
    VECTOR_EXTS,
    FileFormat,
    refuse_unsupported_format,
)
from goatlib.models.io import (
    ConversionFailure,
    ConversionReport,
    ConvertedDataset,
    DatasetMetadata,
)

logger = logging.getLogger(__name__)


def convert_all(
    src_path: str | list[str],
    dest_dir: str | Path,
    geometry_col: str | None = None,
    target_crs: str | None = None,
    has_header: bool | None = None,
    sheet_name: str | None = None,
) -> ConversionReport:
    """
    Convert every dataset a source contains, reporting the ones that fail.

    Same discovery and conversion as `convert_any`; the difference is what happens when
    one dataset of several cannot be read. Here it is recorded and the rest continue,
    because an archive of twenty layers should not be lost to one bad file — and the
    caller needs to say which one was dropped.
    """
    outputs, failures = _convert(
        src_path=src_path,
        dest_dir=dest_dir,
        geometry_col=geometry_col,
        target_crs=target_crs,
        has_header=has_header,
        sheet_name=sheet_name,
    )
    return ConversionReport(
        outputs=[
            ConvertedDataset(
                source=source,
                name=dataset_name(source),
                path=str(path),
                metadata=meta,
            )
            for source, path, meta in outputs
        ],
        failures=failures,
    )


def convert_any(
    src_path: str | list[str],
    dest_dir: str | Path,
    geometry_col: str | None = None,
    target_crs: str | None = None,
    has_header: bool | None = None,
    sheet_name: str | None = None,
) -> list[tuple[Path, DatasetMetadata]]:
    """
    Convert any supported input to standardized outputs.

    Parameters
    ----------
    src_path : str | list[str]
        Source path(s)
    dest_dir : str | Path
        Destination directory
    geometry_col : str, optional
        Geometry column name
    target_crs : str, optional
        Target CRS for reprojection
    has_header : bool, optional
        Whether the first row contains column headers (CSV/XLSX)
    sheet_name : str, optional
        Worksheet name for XLSX files (None=first sheet)

    Returns
    -------
    list[tuple[Path, DatasetMetadata]]
        List of (output_path, metadata) for all converted datasets
    """
    outputs, failures = _convert(
        src_path=src_path,
        dest_dir=dest_dir,
        geometry_col=geometry_col,
        target_crs=target_crs,
        has_header=has_header,
        sheet_name=sheet_name,
    )
    # Nothing converted at all is a failed conversion; some of many is not.
    if not outputs and failures:
        raise ValueError(failures[0].reason)
    return [(path, meta) for _source, path, meta in outputs]


def _convert(
    src_path: str | list[str],
    dest_dir: str | Path,
    geometry_col: str | None,
    target_crs: str | None,
    has_header: bool | None,
    sheet_name: str | None,
) -> tuple[list[tuple[str, Path, DatasetMetadata]], list[ConversionFailure]]:
    """Discover and convert, collecting what failed rather than stopping at it."""
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    converter = IOConverter()
    sources = src_path if isinstance(src_path, list) else [src_path]

    outputs: list[tuple[str, Path, DatasetMetadata]] = []
    failures: list[ConversionFailure] = []
    for source in sources:
        source_outputs, source_failures = _convert_one_source(
            src_path=source,
            converter=converter,
            dest_dir=dest,
            geometry_col=geometry_col,
            target_crs=target_crs,
            has_header=has_header,
            sheet_name=sheet_name,
        )
        outputs.extend(source_outputs)
        failures.extend(source_failures)
    return outputs, failures


def _convert_one_source(
    src_path: str,
    converter: IOConverter,
    dest_dir: Path,
    geometry_col: str | None,
    target_crs: str | None,
    has_header: bool | None = None,
    sheet_name: str | None = None,
) -> tuple[list[tuple[str, Path, DatasetMetadata]], list[ConversionFailure]]:
    """Convert one source path, which may contain several datasets."""
    logger.info("Discovering input datasets: %s", src_path)

    discovered = discover_inputs(src_path)
    if not discovered:
        raise ValueError(f"No convertible datasets found in {src_path}")

    outputs: list[tuple[str, Path, DatasetMetadata]] = []
    failures: list[ConversionFailure] = []
    total_items = len(discovered)

    # Temp directories discovery created, cleaned up once everything is converted.
    temp_dirs_to_cleanup = set()

    try:
        for i, item in enumerate(discovered):
            logger.info("Converting dataset %d/%d: %s", i + 1, total_items, item)

            item_path = Path(item.split("::")[0])
            if item_path.parent.name.startswith(("goatlib_zip_", "goatlib_remote_")):
                temp_dirs_to_cleanup.add(item_path.parent)

            try:
                output_path, metadata = _convert_single_item(
                    converter=converter,
                    item=item,
                    dest_dir=dest_dir,
                    geometry_col=geometry_col,
                    target_crs=target_crs,
                    has_header=has_header,
                    sheet_name=sheet_name,
                )
            except Exception as e:  # noqa: BLE001 - one bad dataset must not lose the rest
                logger.warning("Failed to convert %s: %s", item, e)
                failures.append(
                    ConversionFailure(
                        source=item, name=dataset_name(item), reason=first_line(e)
                    )
                )
                continue

            outputs.append((item, output_path, metadata))
            logger.info("Successfully converted: %s", output_path)

        logger.info(
            "Conversion completed: %s (%d converted, %d failed)",
            src_path,
            len(outputs),
            len(failures),
        )
        return outputs, failures

    finally:
        for temp_dir in temp_dirs_to_cleanup:
            if temp_dir.exists():
                try:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    logger.debug("Cleaned up temp directory: %s", temp_dir)
                except Exception as e:
                    logger.warning(
                        "Failed to clean up temp directory %s: %s", temp_dir, e
                    )


def first_line(error: Exception) -> str:
    """The first line of an error, which is the part worth reporting.

    A GDAL failure arrives as a paragraph with the failing SQL and a caret pointing into
    it — useful in a log, noise in a list of datasets that could not be read.
    """
    return (
        str(error).strip().splitlines()[0]
        if str(error).strip()
        else error.__class__.__name__
    )


def dataset_name(discovered_path: str) -> str:
    """What a discovered dataset should be called: its layer, else its file's stem."""
    base, _, layer = discovered_path.partition("::")
    return layer or Path(base).stem


def _convert_single_item(
    converter: IOConverter,
    item: str,
    dest_dir: Path,
    geometry_col: str | None,
    target_crs: str | None,
    has_header: bool | None = None,
    sheet_name: str | None = None,
) -> tuple[Path, DatasetMetadata]:
    """
    Convert a single discovered item to the appropriate format.
    """
    base_path = item.split("::")[0]
    refuse_unsupported_format(base_path)
    suffix = Path(base_path).suffix.lower()
    stem = Path(base_path).stem

    # Handle raster files
    if suffix in RASTER_EXTS:
        logger.info("Processing raster file: %s", base_path)
        out = dest_dir / f"{stem}{FileFormat.TIF.value}"
        meta = converter.to_cog(item, out, target_crs=target_crs)
        return out, meta

    # Handle vector/tabular files and ZIP archives
    if (
        suffix in VECTOR_EXTS
        or suffix in TABULAR_EXTS
        or suffix == FileFormat.ZIP.value
    ):
        logger.info("Processing vector/tabular file: %s", base_path)
        suffix_extra = _get_layer_suffix(item)
        out = dest_dir / f"{stem}{suffix_extra}{FileFormat.PARQUET.value}"
        meta = converter.to_parquet(
            item,
            out,
            geometry_col=geometry_col,
            target_crs=target_crs,
            has_header=has_header,
            sheet_name=sheet_name,
        )
        return out, meta

    # Unsupported format
    logger.warning("Skipping unsupported file: %s", item)
    raise ValueError(f"Unsupported file format: {suffix}")


def _get_layer_suffix(item: str) -> str:
    """Extract layer suffix from item path with ::layer syntax."""
    if "::" in item:
        layer_name = item.split("::")[1]
        # Sanitize layer name for filename
        sanitized = layer_name.replace("/", "_").replace("\\", "_")
        return f"_{sanitized}"
    return ""
