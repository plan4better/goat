# src/goatlib/io/discover.py
from __future__ import annotations

import logging
import shutil
import tempfile
import urllib.error
import urllib.request
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from urllib.parse import urlparse

import boto3
import duckdb

from goatlib.io.formats import ALL_EXTS, FileFormat
from goatlib.io.utils import detect_path_type

logger = logging.getLogger(__name__)


# Plain text is a dataset when someone hands over that file themselves, and almost never
# when it turns up inside an archive: a zip of layers carries a `readme.txt` and a
# `license.txt`, and importing those as layers means a failed dataset in every report.
ARCHIVE_SKIP_EXTS = frozenset({FileFormat.TXT.value, FileFormat.DSV.value})

# The first bytes of every SQLite database, so of every GeoPackage.
_SQLITE_HEADER = b"SQLite format 3\x00"


class DiscoveryError(Exception):
    """Custom exception for discovery-related errors."""

    pass


@contextmanager
def temporary_download(url: str, timeout: int = 300) -> Iterator[Path]:
    """
    Context manager for downloading remote files with automatic cleanup.

    Args:
        url: Remote URL to download
        timeout: Request timeout in seconds

    Yields:
        Path to downloaded temporary file
    """
    tmp_dir = Path(tempfile.mkdtemp(prefix="goatlib_remote_"))
    local_path = tmp_dir / Path(urlparse(url).path).name

    try:
        logger.info("Downloading %s → %s", url, local_path)
        path_type = detect_path_type(url)
        if path_type == "http":
            req = urllib.request.Request(url, headers={"User-Agent": "goatlib/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                with open(local_path, "wb") as f:
                    while chunk := response.read(8192):
                        f.write(chunk)

        elif path_type == "s3":
            parts = url.split("/", 3)
            if len(parts) < 4:
                raise DiscoveryError(f"Invalid S3 URL: {url}")

            bucket = parts[2]
            key = parts[3]
            boto3.client("s3").download_file(bucket, key, str(local_path))

        else:
            raise DiscoveryError(f"Unsupported remote scheme: {url}")

        yield local_path

    except Exception as e:
        # Clean up on error
        if local_path.exists():
            local_path.unlink(missing_ok=True)
        raise DiscoveryError(f"Failed to download {url}: {e}") from e

    finally:
        # Always clean up temp directory
        if tmp_dir.exists():
            for item in tmp_dir.iterdir():
                if item.is_file():
                    item.unlink()
            tmp_dir.rmdir()


def _discover_gpkg_layers(gpkg: Path) -> list[str]:
    """
    Discover GeoPackage layers using parameterized queries for safety.

    Args:
        gpkg: Path to GeoPackage file

    Returns:
        List of virtual paths in format 'file::layer'
    """
    # ST_Read_Meta takes no driver list, so GDAL picks a driver by the file's
    # content: only a file with the SQLite header, which every GeoPackage has,
    # is opened for its layers. Anything else stays one path, which the
    # converter then reads with the GeoPackage driver only.
    try:
        with open(gpkg, "rb") as f:
            if f.read(len(_SQLITE_HEADER)) != _SQLITE_HEADER:
                return [str(gpkg)]
    except OSError:
        return [str(gpkg)]

    try:
        # Use context manager for proper resource cleanup
        with duckdb.connect(database=":memory:") as con:
            con.execute("INSTALL spatial; LOAD spatial;")

            # Use parameterized query to prevent SQL injection
            result = con.execute(
                "SELECT * FROM ST_Read_Meta(?)", [str(gpkg)]
            ).fetchone()

            if not result or len(result) < 4:
                return [str(gpkg)]

            layers = result[3]
            if not isinstance(layers, list) or not layers:
                return [str(gpkg)]

            return [f"{gpkg}::{layer['name']}" for layer in layers]

    except Exception as e:
        logger.warning("Failed to introspect GeoPackage layers for %s: %s", gpkg, e)
        return [str(gpkg)]


def _discover_from_dir(directory: Path) -> Iterator[Path]:
    """
    Discover convertible files in a directory recursively.

    Args:
        directory: Directory to scan

    Yields:
        Paths to discovered convertible files
    """
    try:
        for path in directory.rglob("*"):
            # Skip system files and directories
            if path.name.startswith("._") or path.name == ".DS_Store":
                continue
            if not path.is_file():
                continue

            ext = path.suffix.lower()

            if ext == FileFormat.GPKG.value:
                yield from (Path(v) for v in _discover_gpkg_layers(path))
            elif ext == FileFormat.ZIP.value:
                yield from _discover_from_zip(path)
            elif ext in ALL_EXTS:
                yield path

    except PermissionError as e:
        raise DiscoveryError(f"Permission denied accessing {directory}: {e}") from e


@contextmanager
def _extract_zip_safely(zip_path: Path) -> Iterator[Path]:
    """
    Safely extract ZIP contents to temporary directory.

    The archive's own directory structure is preserved. Flattening to basenames loses
    data: an archive holding `wien/stops.geojson` and `graz/stops.geojson` — the shape a
    per-region export takes — would end up with one file, the second silently overwriting
    the first. It also mixed shapefile sidecars between two same-named shapefiles.

    Args:
        zip_path: Path to ZIP file

    Yields:
        Path to temporary extraction directory
    """
    tmp_dir = Path(tempfile.mkdtemp(prefix="goatlib_zip_"))

    try:
        with zipfile.ZipFile(zip_path) as zf:
            # Check for potentially malicious ZIP files
            total_size = sum(zf.getinfo(name).file_size for name in zf.namelist())
            if total_size > 500 * 1024 * 1024:  # 500MB limit
                raise DiscoveryError(f"ZIP file too large: {total_size} bytes")

            root = tmp_dir.resolve()
            for name in zf.namelist():
                if name.endswith("/"):  # Skip directories
                    continue

                relative = Path(name)
                if relative.name.startswith("._") or relative.name == ".DS_Store":
                    continue
                # macOS resource forks, an archive of an archive's metadata.
                if "__MACOSX" in relative.parts:
                    continue

                dest = (tmp_dir / relative).resolve()
                # Keeping the structure means member names are no longer reduced to a
                # basename, so traversal has to be refused explicitly: `../../etc/passwd`
                # used to be defused by accident.
                if not dest.is_relative_to(root):
                    raise DiscoveryError(f"ZIP entry escapes the archive: {name}")

                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(name) as src, open(dest, "wb") as dst:
                    dst.write(src.read())

        yield tmp_dir

    except zipfile.BadZipFile as e:
        raise DiscoveryError(f"Invalid ZIP archive: {zip_path}") from e
    except Exception:
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    finally:
        # This ensures cleanup even if the context manager isn't properly closed
        pass


def _discover_from_zip(
    zip_path: Path, _skipped: list[Path] | None = None
) -> Iterator[Path]:
    """
    Discover convertible files within a ZIP archive.

    Plain-text tables (``ARCHIVE_SKIP_EXTS``) are not imported from inside an
    archive, where a ``.txt`` is far more often a README than a dataset. When
    they are the *only* thing an archive holds, the caller would otherwise get
    an empty result and no explanation, so that case raises ``DiscoveryError``
    naming the skipped files. Nested archives share the outer call's ``_skipped``
    list and never raise themselves: only the top level knows whether the
    archive as a whole yielded anything.

    Args:
        zip_path: Path to ZIP file

    Yields:
        Paths to discovered convertible files
    """
    top_level = _skipped is None
    skipped: list[Path] = [] if _skipped is None else _skipped
    found = False
    with _extract_zip_safely(zip_path) as tmp_dir:
        # Recursively, because the archive's folders are kept: a dataset can sit at any
        # depth, and `sorted` so the order a caller sees does not depend on the
        # filesystem.
        for item_path in sorted(tmp_dir.rglob("*")):
            if not item_path.is_file():
                continue
            if item_path.name.startswith("._") or item_path.name == ".DS_Store":
                continue

            ext = item_path.suffix.lower()

            # Handle nested archives
            if ext == FileFormat.ZIP.value:
                try:
                    for nested in _discover_from_zip(item_path, skipped):
                        found = True
                        yield nested
                except zipfile.BadZipFile:
                    logger.warning("Invalid nested ZIP: %s", item_path)
                continue

            # Handle GeoPackages
            if ext == FileFormat.GPKG.value:
                for layer in _discover_gpkg_layers(item_path):
                    found = True
                    yield Path(layer)
                continue

            # A shapefile needs no grouping now: its sidecars kept the directory they
            # were archived in, which is where GDAL looks for them.
            if ext == FileFormat.SHP.value:
                found = True
                yield item_path
                continue

            # Handle other supported formats
            if ext in ALL_EXTS:
                if ext in ARCHIVE_SKIP_EXTS:
                    skipped.append(item_path.relative_to(tmp_dir))
                    continue
                found = True
                yield item_path

    if top_level and not found and skipped:
        exts = ", ".join(sorted({p.suffix.lower() for p in skipped}))
        names = ", ".join(str(p) for p in skipped[:5])
        more = f" (+{len(skipped) - 5} more)" if len(skipped) > 5 else ""
        raise DiscoveryError(
            f"{zip_path.name} contains no importable dataset: {exts} files are not "
            f"read from inside an archive ({names}{more}). Upload them directly."
        )


def discover_inputs(src_path: str | Path) -> list[str]:
    """
    Discover convertible dataset paths in file, folder, ZIP, or remote URL.

    Args:
        src_path: Source path to discover

    Returns:
        List of discovered dataset paths

    Raises:
        DiscoveryError: If discovery fails
        FileNotFoundError: If source path doesn't exist
    """
    parsed = urlparse(str(src_path))
    is_remote = parsed.scheme in {"http", "https", "s3"}

    try:
        if is_remote:
            return _discover_remote_inputs(str(src_path))
        else:
            return _discover_local_inputs(Path(src_path))

    except Exception as e:
        if isinstance(e, (DiscoveryError, FileNotFoundError)):
            raise
        raise DiscoveryError(f"Discovery failed for {src_path}: {e}") from e


def _discover_remote_inputs(url: str) -> list[str]:
    """Discover inputs from remote sources."""
    path_lower = urlparse(url).path.lower()

    if path_lower.endswith(FileFormat.ZIP.value):
        logger.info("Remote ZIP detected → download & expand: %s", url)
        with temporary_download(url) as local_copy:
            return [str(p) for p in _discover_from_zip(local_copy)]
    else:
        logger.debug("Remote single file detected → pass through: %s", url)
        return [url]


def _discover_local_inputs(path: Path) -> list[str]:
    """Discover inputs from local sources."""
    if not path.exists():
        raise FileNotFoundError(f"Source path not found: {path}")

    if path.is_dir():
        return [str(p) for p in _discover_from_dir(path)]

    ext = path.suffix.lower()

    if ext == FileFormat.ZIP.value:
        return [str(p) for p in _discover_from_zip(path)]
    elif ext == FileFormat.GPKG.value:
        return _discover_gpkg_layers(path)
    else:
        return [str(path)]
