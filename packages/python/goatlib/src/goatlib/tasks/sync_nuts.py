"""Build the local ``nuts.parquet`` from Eurostat GISCO.

``apps/catalog``'s spatial filter is NUTS-based: ``/stac/nuts`` is a region
typeahead and ``/stac/nuts/{id}/geometry`` returns the boundary the UI draws
and filters with. Both read ``${DATA_DIR}/catalog/nuts.parquet``, and until
this task existed nothing produced that file -- the store fell back to an
empty table, so the endpoints answered ``200 []`` and the spatial filter had
no regions to offer.

**Why not the catalog bucket.** `docs/goat-catalog-design.md` §5 assumed NUTS
would be published alongside the catalog and fetched by the same sync. It is
not, and it should not be: NUTS is public reference data from Eurostat with a
three-year release cycle and no relationship to what the harvester crawls.
Making it a harvester deliverable would couple a GOAT UI feature to another
team's release for data anyone can download. So this is a separate task
against the authoritative source.

Source: the GISCO distribution service, whose files are versioned by
(year, resolution) --
``https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_<res>_<year>_4326.geojson``.
That pair *is* the version marker: a GISCO release is immutable, so there is
nothing to diff and no ETag to track. Re-running with the same pair is a
no-op unless ``force`` is set.

Resolution: 01M is the most detailed (~67 MB of GeoJSON, ~12 MB as parquet)
and is the default, because the geometry is used to *filter* -- a coarse
boundary quietly changes which datasets a region search returns. Coarser
levels (03M, 10M, 20M, 60M) exist for cheap display and are accepted here.

Windmill deployment: registered in `goatlib.tasks.registry` as
`f/goat/tasks/sync_nuts`, worker tag ``"tools"``, with **no schedule** -- a
67 MB download on a cron for data that changes every three years is waste.
Run it on demand when Eurostat publishes a new release.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

import duckdb
from pydantic import BaseModel, Field

from goatlib.io.config import parquet_copy_options

logger = logging.getLogger(__name__)

__all__ = ["NUTS_FILENAME", "REQUIRED_NUTS_COLUMNS", "SyncNutsParams", "main"]

NUTS_FILENAME = "nuts.parquet"
_MARKER_FILENAME = "NUTS_VERSION"

#: What `apps/catalog`'s `store._NUTS_COLUMNS_SQL` and `routers/nuts.py` name.
#: GISCO's own column names (`NUTS_ID`, `NAME_LATN`, `LEVL_CODE`, `CNTR_CODE`)
#: are mapped once, here, so the service never learns them.
REQUIRED_NUTS_COLUMNS: tuple[str, ...] = (
    "nuts_id",
    "nuts_name",
    "level",
    "country",
    "geometry",
)

_GISCO_URL = (
    "https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/"
    "NUTS_RG_{resolution}_{year}_4326.geojson"
)
_RESOLUTIONS = ("01M", "03M", "10M", "20M", "60M")

#: NUTS 2024 has 1,791 regions across levels 0-3. A release that produced far
#: fewer is a truncated download or a changed file layout, not a new release,
#: and must not replace a good file.
_MINIMUM_REGIONS = 1000


class SyncNutsParams(BaseModel):
    """Inputs for the NUTS reference-data sync."""

    year: int = Field(
        default=2024, description="GISCO NUTS release year (2021, 2024, ...)."
    )
    resolution: str = Field(
        default="01M",
        description="GISCO generalisation level: 01M (most detailed) … 60M. "
        "The geometry is used to filter, so prefer 01M.",
    )
    dest_dir: str | None = Field(
        default=None,
        description="Local directory to write into. Empty = ${DATA_DIR}/catalog.",
    )
    force: bool = Field(
        default=False,
        description="Re-download even when the local file is already this release.",
    )
    dry_run: bool = Field(
        default=False, description="Report what would change, download/write nothing."
    )


def _default_dest_dir() -> Path:
    return Path(os.environ.get("DATA_DIR", "/app/data")) / "catalog"


def _download(url: str, target: Path) -> None:
    """Stream the GeoJSON to disk.

    Streamed rather than read into memory: the 01M file is ~67 MB of JSON,
    which is several hundred MB once parsed, and the worker also has to hold
    DuckDB's working set.
    """
    logger.info("downloading %s", url)
    with urllib.request.urlopen(url, timeout=300) as response:  # noqa: S310
        with target.open("wb") as handle:
            shutil.copyfileobj(response, handle, length=1024 * 1024)


def build_nuts(source: Path, out: Path) -> int:
    """Convert a GISCO NUTS GeoJSON into the parquet the service reads."""
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        out.parent.mkdir(parents=True, exist_ok=True)
        con.execute(f"""
            COPY (
                SELECT
                    NUTS_ID          AS nuts_id,
                    NAME_LATN        AS nuts_name,
                    LEVL_CODE::INTEGER AS level,
                    CNTR_CODE        AS country,
                    geom             AS geometry
                FROM ST_Read('{source.as_posix()}')
                ORDER BY level, nuts_id
            ) TO '{out.as_posix()}' {parquet_copy_options()}
        """)
        row = con.execute(
            "SELECT count(*) FROM read_parquet(?)", [out.as_posix()]
        ).fetchone()
        return int(row[0]) if row else 0
    finally:
        con.close()


def _validate(path: Path) -> int:
    """Reject a file the service could not serve, before it replaces a good one."""
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        described = con.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [path.as_posix()]
        ).fetchall()
        present = {row[0] for row in described}
        missing = [name for name in REQUIRED_NUTS_COLUMNS if name not in present]
        if missing:
            raise ValueError(f"built nuts.parquet is missing columns: {missing}")
        row = con.execute(
            "SELECT count(*) FROM read_parquet(?)", [path.as_posix()]
        ).fetchone()
        count = int(row[0]) if row else 0
        if count < _MINIMUM_REGIONS:
            raise ValueError(
                f"built nuts.parquet has {count} regions, expected at least "
                f"{_MINIMUM_REGIONS} — refusing to replace the current file"
            )
        return count
    finally:
        con.close()


def _sync(params: SyncNutsParams) -> dict[str, Any]:
    resolution = params.resolution.upper()
    if resolution not in _RESOLUTIONS:
        raise ValueError(
            f"unknown resolution {params.resolution!r}; expected one of "
            f"{', '.join(_RESOLUTIONS)}"
        )

    version = f"{params.year}-{resolution}"
    dest_dir = Path(params.dest_dir) if params.dest_dir else _default_dest_dir()
    marker_path = dest_dir / _MARKER_FILENAME
    final_path = dest_dir / NUTS_FILENAME

    try:
        local_version = marker_path.read_text().strip()
    except FileNotFoundError:
        local_version = None

    if local_version == version and final_path.exists() and not params.force:
        return {"changed": False, "version": version, "regions": -1}

    if params.dry_run:
        return {"changed": True, "version": version, "regions": -1}

    url = _GISCO_URL.format(resolution=resolution, year=params.year)
    dest_dir.mkdir(parents=True, exist_ok=True)
    tmp_parquet = dest_dir / f"{NUTS_FILENAME}.tmp"
    with tempfile.TemporaryDirectory(dir=dest_dir) as scratch:
        source = Path(scratch) / "nuts.geojson"
        try:
            _download(url, source)
            build_nuts(source, tmp_parquet)
            regions = _validate(tmp_parquet)
        except Exception:
            tmp_parquet.unlink(missing_ok=True)
            raise

    os.replace(tmp_parquet, final_path)
    # Marker last, same rule as the catalog sync: it is what says "the file
    # beside me is this release".
    marker_path.write_text(version)
    return {"changed": True, "version": version, "regions": regions}


def main(params: SyncNutsParams = SyncNutsParams()) -> dict[str, Any]:
    """Entry point for the Windmill task."""
    result = _sync(params)
    logger.info("nuts sync: %s", result)
    return result
