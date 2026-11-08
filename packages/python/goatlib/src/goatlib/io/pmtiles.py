"""PMTiles generation from DuckLake tables.

This module provides utilities for generating PMTiles (static vector tiles)
from DuckLake tables. PMTiles enable fast tile serving without dynamic
generation overhead.

The generation pipeline:
    1. Write the layer from a DuckDB query (tile_query), ordered by feature
       id, to a GeoParquet file on local disk, then run manby on it with a
       recipe per geometry type (manby_flags). DuckDB is done before manby
       starts, so the two never need memory at the same time.
    2. For polygon layers: generate a separate anchor PMTiles file with label
       anchor points (--convert-polygons-to-label-points). The tile service
       concatenates MVT bytes from both files at serving time.
    3. Store PMTiles in a separate tiles directory (cache/derived data)
    4. Embed DuckLake snapshot_id and MANBY_MARKER in PMTiles metadata: the
       snapshot for sync tracking, the marker because geoapi filters stored
       tiles only when it finds it.

Usage:
    from goatlib.io.pmtiles import PMTilesGenerator

    generator = PMTilesGenerator(tiles_data_dir="/app/data/tiles")
    pmtiles_path = generator.generate_from_table(
        duckdb_con=con,
        table_name="lake.user_xxx.t_yyy",
        layer_id="yyy",
        snapshot_id=1234,  # DuckLake snapshot for sync tracking
    )
"""

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Self

import duckdb
import manby
from pmtiles.reader import MmapSource
from pmtiles.reader import Reader as PMTilesReader

from goatlib.io.config import parquet_copy_options
from goatlib.utils.container_cpu import container_cpu_count
from goatlib.utils.container_memory import MANBY_MEMORY_SHARE, container_memory_limit
from goatlib.utils.layer import layer_id_to_table_name

logger = logging.getLogger(__name__)

# Recorded in the description of every tileset manby built, next to the
# snapshot id. geoapi filters stored tiles only when it finds it: the point
# tiles built before manby merged nearby points at every zoom, and some had no
# feature ids.
MANBY_MARKER: dict = {"tiler": "manby", "recipe": 1}

# Columns geoapi hides from tiles (its HIDDEN_FIELDS default): the GeoParquet
# bbox and the legacy scalar bbox fields.
_HIDDEN_COLUMNS = frozenset({"bbox", "$minx", "$miny", "$maxx", "$maxy"})

# Column types a tile attribute cannot hold: nested types and arrays
# (`INTEGER[]`, `INTEGER[2]`). Other geometry columns are no attributes either.
_NON_PLAIN_TYPE = re.compile(r"^(STRUCT|MAP|LIST|UNION|GEOMETRY)\b|\]$", re.IGNORECASE)

# A timestamp as tiles built through GDAL's GeoJSON carry it: milliseconds
# only when there are any.
_TIMESTAMP_TEXT = r"regexp_replace(strftime({}, '%Y-%m-%dT%H:%M:%S.%g'), '\.000$', '')"

# Points spread over less than this (degrees, in both axes) are one location
# to manby, whose grid is 360 / 2**32 degrees: -zg cannot guess a max zoom.
ONE_LOCATION_DEGREES = 1e-6
# manby's exit status when -zg finds no two locations to guess a max zoom
# from. Any other failure (a build killed for its memory) fails the build.
MANBY_EXIT_NO_ZOOM_GUESS = 110


def _part_type(geometry_type: str | None) -> int:
    """A layer's kind, as OGC type codes: 1 points, 2 lines, 3 polygons.

    It picks the recipe and the parts kept from geometry collections. Any
    other type gets the polygon recipe.
    """
    geom_upper = geometry_type.upper() if geometry_type else ""
    if "POINT" in geom_upper:
        return 1
    if "LINE" in geom_upper:
        return 2
    return 3


def publish_tiles(built: Path, final: Path) -> None:
    """Move tiles built on local disk into place, atomically.

    Tiles are built on local disk, with manby's input and spill, rather than
    in the tiles directory, which may be network storage. The finished file
    is copied next to `final` under a pid-tagged temp name (concurrent runs
    for one layer don't share it) and renamed over `final`, so readers never
    see a partial file.
    """
    final.parent.mkdir(parents=True, exist_ok=True)
    temp = final.parent / f".tmp_{os.getpid()}_{final.name}"
    try:
        shutil.copyfile(built, temp)
        os.replace(temp, final)
    finally:
        temp.unlink(missing_ok=True)


@dataclass
class PMTilesConfig:
    """Configuration for PMTiles generation.

    Uses variable-depth tile pyramids (--generate-variable-depth-tile-pyramid)
    which only generates tiles where needed, dramatically reducing generation
    time and file size for simple features.

    Attributes:
        enabled: Whether PMTiles generation is enabled
        min_zoom: Minimum zoom level (default: 0)
        max_zoom: Maximum zoom level for tile generation (default: 14).
            Note: With variable-depth, most tiles will stop earlier if
            sufficient detail is already present.
        layer_name: Name for the MVT layer (default: "default")
        anchor_layer_name: Name for the label anchor MVT layer (default: "default_anchor").
            Only used for polygon layers — contains point features generated by
            --convert-polygons-to-label-points for server-side label placement.
    """

    enabled: bool = True
    min_zoom: int = 0
    max_zoom: int = 14
    layer_name: str = "default"
    anchor_layer_name: str = "default_anchor"


class PMTilesGenerator:
    """Generate PMTiles from DuckLake tables.

    PMTiles are stored separately from source data (cache/derived data):
        /app/data/tiles/
        └── t_{layer_id}.pmtiles

    Source data remains in DuckLake:
        /app/data/ducklake/
        └── <schema>/
            └── t_{layer_id}/
                └── *.parquet
    """

    def __init__(
        self: Self,
        tiles_data_dir: str = "/app/data/tiles",
        config: PMTilesConfig | None = None,
    ) -> None:
        """Initialize PMTiles generator.

        Args:
            tiles_data_dir: Root directory for tiles storage (separate from source data)
            config: PMTiles generation configuration
        """
        self.tiles_data_dir = Path(tiles_data_dir)
        self.config = config or PMTilesConfig()

        # Ensure base tiles directory exists
        try:
            self.tiles_data_dir.mkdir(parents=True, exist_ok=True)
        except FileExistsError:
            # Path exists but may be a symlink to a directory - that's OK
            if not self.tiles_data_dir.is_dir():
                raise RuntimeError(
                    f"tiles_data_dir exists but is not a directory: {self.tiles_data_dir}"
                )

        self._check_dependencies()

    def _check_dependencies(self: Self) -> bool:
        """Check that manby's program is available.

        Returns:
            True if it is

        Raises:
            RuntimeError: If it is not installed
        """
        try:
            manby.binary()
        except FileNotFoundError as e:
            raise RuntimeError(
                "manby is required for PMTiles generation. "
                "Install goatlib's full extra, which includes manby"
            ) from e
        return True

    def get_pmtiles_path(self: Self, layer_id: str) -> Path:
        """Get the path where PMTiles should be stored.

        Flat, keyed only by layer id: the id is globally unique, so no
        directory is needed to disambiguate. Every lookup is a single stat()
        of this path: listing the tiles directory (tens of thousands of
        files) is slow on network storage and has failed outright on NFS
        clients that cached it.

        Args:
            layer_id: Layer UUID (with or without dashes)

        Returns:
            Path to the PMTiles file
        """
        return self.tiles_data_dir / f"{layer_id_to_table_name(layer_id)}.pmtiles"

    def get_anchor_pmtiles_path(self: Self, layer_id: str) -> Path:
        """Get the path for the label anchor PMTiles file (polygon layers only).

        Anchor PMTiles contain point features generated by the tiler's
        --convert-polygons-to-label-points for optimal label placement.
        Stored as a separate file to avoid tile-join merge issues with
        variable-depth tile pyramids.

        Args:
            layer_id: Layer UUID (without dashes)

        Returns:
            Path to the anchor PMTiles file
        """
        main_path = self.get_pmtiles_path(layer_id)
        return main_path.with_name(main_path.stem + "_anchor.pmtiles")

    def pmtiles_exists(self: Self, layer_id: str) -> bool:
        """Check if PMTiles file exists for a layer.

        Args:
            layer_id: Layer UUID

        Returns:
            True if PMTiles file exists
        """
        return self.get_pmtiles_path(layer_id).exists()

    def is_pmtiles_valid(self: Self, pmtiles_path: Path | str) -> bool:
        """Check if a PMTiles file is valid and readable.

        Args:
            pmtiles_path: Path to PMTiles file

        Returns:
            True if the file is a valid PMTiles file
        """
        try:
            with open(pmtiles_path, "rb") as f:
                reader = PMTilesReader(MmapSource(f))
                # Try to read header - this will fail if file is corrupted
                reader.header()
            return True
        except Exception as e:
            # Log the actual error for debugging
            logger.debug(f"PMTiles validation failed for {pmtiles_path}: {e}")
            # Also check magic bytes for more info
            try:
                with open(pmtiles_path, "rb") as f:
                    magic = f.read(7)
                    logger.warning(
                        f"Invalid PMTiles {pmtiles_path}: magic={magic!r}, error={e}"
                    )
            except Exception:
                pass
            return False

    def read_marker(self: Self, pmtiles_path: Path | str) -> dict:
        """Read the description JSON from PMTiles metadata.

        Our builds store {"snapshot_id": 1234, "generated_at": "..."} there,
        and manby builds MANBY_MARKER's keys too.

        Args:
            pmtiles_path: Path to PMTiles file

        Returns:
            The description as a dict, {} if the file has none or is unreadable
        """
        try:
            with open(pmtiles_path, "rb") as f:
                reader = PMTilesReader(MmapSource(f))
                description = reader.metadata().get("description", "")
            if description.startswith("{"):
                data = json.loads(description)
                if isinstance(data, dict):
                    return data
        except Exception as e:
            logger.debug(f"Could not read the description of {pmtiles_path}: {e}")
        return {}

    def get_pmtiles_snapshot_id(self: Self, pmtiles_path: Path | str) -> int | None:
        """Read the DuckLake snapshot_id from PMTiles metadata.

        Args:
            pmtiles_path: Path to PMTiles file

        Returns:
            Snapshot ID if found, None otherwise
        """
        return self.read_marker(pmtiles_path).get("snapshot_id")

    def is_pmtiles_in_sync(
        self: Self, pmtiles_path: Path | str, current_snapshot_id: int
    ) -> bool:
        """Check if PMTiles is in sync with the DuckLake table.

        Checks both embedded PMTiles metadata and sidecar files for
        backwards compatibility.

        Args:
            pmtiles_path: Path to PMTiles file
            current_snapshot_id: Current DuckLake snapshot ID for the table

        Returns:
            True if PMTiles was generated from the current snapshot
        """
        # First check embedded metadata
        stored_snapshot = self.get_pmtiles_snapshot_id(pmtiles_path)
        if stored_snapshot is not None:
            return stored_snapshot == current_snapshot_id

        # Fall back to sidecar file for backwards compatibility
        try:
            meta_path = Path(pmtiles_path).with_suffix(".pmtiles.meta.json")
            if meta_path.exists():
                with open(meta_path) as f:
                    meta = json.load(f)
                    stored_snapshot = meta.get("snapshot_id")
                    return stored_snapshot == current_snapshot_id
        except Exception:
            pass

        # No snapshot info found - not in sync
        return False

    def generate_from_table(
        self: Self,
        duckdb_con: duckdb.DuckDBPyConnection,
        table_name: str,
        layer_id: str,
        geometry_column: str = "geometry",
        exclude_columns: list[str] | None = None,
        snapshot_id: int | None = None,
    ) -> Path | None:
        """Generate PMTiles from a DuckLake table.

        manby tiles the table from a GeoParquet copy of it with the recipe
        of its geometry type (see _build).

        Args:
            duckdb_con: DuckDB connection with DuckLake attached
            table_name: Full table path (e.g., "lake.user_xxx.t_yyy")
            layer_id: Layer UUID
            geometry_column: Name of the geometry column
            exclude_columns: Columns to exclude from tiles (e.g., ["bbox"])
            snapshot_id: DuckLake snapshot ID for sync tracking. If provided,
                will be embedded in PMTiles metadata.

        Returns:
            Path to generated PMTiles file, or None if generation failed
        """
        if not self.config.enabled:
            logger.debug("PMTiles generation is disabled")
            return None

        exclude_columns = exclude_columns or ["bbox"]
        pmtiles_path = self.get_pmtiles_path(layer_id)

        # Ensure tiles directory exists
        pmtiles_path.parent.mkdir(parents=True, exist_ok=True)

        logger.info(f"Generating PMTiles for {table_name} -> {pmtiles_path}")

        # Detect geometry type for the recipe
        geometry_type = self._detect_geometry_type(
            duckdb_con, table_name, geometry_column
        )

        # Check if this is a polygon layer that needs label anchor points
        geom_upper = geometry_type.upper() if geometry_type else ""
        is_polygon = "POLYGON" in geom_upper

        # Anchor PMTiles path (separate file for polygon label points)
        anchor_pmtiles_path = self.get_anchor_pmtiles_path(layer_id)

        try:
            # Everything is built on local disk and only the finished files
            # are published (see publish_tiles). manby picks the output format
            # by extension, so the built files keep the final names.
            with tempfile.TemporaryDirectory(prefix="pmtiles_") as work:
                work_dir = Path(work)
                built_path = work_dir / pmtiles_path.name
                built_anchor_path = work_dir / anchor_pmtiles_path.name

                # Main geometry tiles (all layer types)
                self._build(
                    duckdb_con=duckdb_con,
                    table_name=table_name,
                    layer_id=layer_id,
                    geometry_column=geometry_column,
                    exclude_columns=exclude_columns,
                    geometry_type=geometry_type,
                    snapshot_id=snapshot_id,
                    output_path=built_path,
                )

                # For polygon layers, separate anchor PMTiles
                if is_polygon:
                    logger.info("Generating label anchor point tiles...")
                    self._build(
                        duckdb_con=duckdb_con,
                        table_name=table_name,
                        layer_id=layer_id,
                        geometry_column=geometry_column,
                        exclude_columns=exclude_columns,
                        geometry_type=geometry_type,
                        snapshot_id=snapshot_id,
                        output_path=built_anchor_path,
                        label_anchor=True,
                    )

                publish_tiles(built_path, pmtiles_path)
                if is_polygon and built_anchor_path.exists():
                    publish_tiles(built_anchor_path, anchor_pmtiles_path)

            size_mb = pmtiles_path.stat().st_size / 1024 / 1024
            logger.info(
                f"PMTiles generated successfully: {pmtiles_path} ({size_mb:.1f} MB)"
            )
            if is_polygon and anchor_pmtiles_path.exists():
                anchor_mb = anchor_pmtiles_path.stat().st_size / 1024 / 1024
                logger.info(
                    f"Anchor PMTiles: {anchor_pmtiles_path} ({anchor_mb:.1f} MB)"
                )

            return pmtiles_path

        except Exception as e:
            logger.error(f"PMTiles generation failed: {e}")
            return None

    def generate_anchor_from_table(
        self: Self,
        duckdb_con: duckdb.DuckDBPyConnection,
        table_name: str,
        layer_id: str,
        geometry_column: str = "geometry",
        exclude_columns: list[str] | None = None,
        snapshot_id: int | None = None,
    ) -> Path | None:
        """Generate only anchor PMTiles for a polygon layer.

        Generates label anchor point tiles without regenerating the main
        geometry tiles.

        Args:
            duckdb_con: DuckDB connection with DuckLake attached
            table_name: Full table path (e.g., "lake.user_xxx.t_yyy")
            layer_id: Layer UUID
            geometry_column: Name of the geometry column
            exclude_columns: Columns to exclude from tiles (e.g., ["bbox"])
            snapshot_id: DuckLake snapshot ID for sync tracking

        Returns:
            Path to generated anchor PMTiles file, or None if generation failed
        """
        if not self.config.enabled:
            logger.debug("PMTiles generation is disabled")
            return None

        exclude_columns = exclude_columns or ["bbox"]
        anchor_pmtiles_path = self.get_anchor_pmtiles_path(layer_id)

        logger.info(
            f"Generating anchor PMTiles for {table_name} -> {anchor_pmtiles_path}"
        )

        # Detect geometry type to confirm it's a polygon layer
        geometry_type = self._detect_geometry_type(
            duckdb_con, table_name, geometry_column
        )
        geom_upper = geometry_type.upper() if geometry_type else ""
        if "POLYGON" not in geom_upper:
            logger.warning(
                f"Skipping anchor generation for non-polygon layer: {geometry_type}"
            )
            return None

        try:
            # Built on local disk, then published (see publish_tiles).
            with tempfile.TemporaryDirectory(prefix="pmtiles_") as work:
                built_anchor_path = Path(work) / anchor_pmtiles_path.name

                self._build(
                    duckdb_con=duckdb_con,
                    table_name=table_name,
                    layer_id=layer_id,
                    geometry_column=geometry_column,
                    exclude_columns=exclude_columns,
                    geometry_type=geometry_type,
                    snapshot_id=snapshot_id,
                    output_path=built_anchor_path,
                    label_anchor=True,
                )

                publish_tiles(built_anchor_path, anchor_pmtiles_path)
            anchor_mb = anchor_pmtiles_path.stat().st_size / 1024 / 1024
            logger.info(
                f"Anchor PMTiles generated: {anchor_pmtiles_path} ({anchor_mb:.1f} MB)"
            )
            return anchor_pmtiles_path

        except Exception as e:
            logger.error(f"Anchor PMTiles generation failed: {e}")
            return None

    def _build(
        self: Self,
        duckdb_con: duckdb.DuckDBPyConnection,
        table_name: str,
        layer_id: str,
        geometry_column: str,
        exclude_columns: list[str],
        geometry_type: str | None,
        snapshot_id: int | None,
        output_path: Path,
        label_anchor: bool = False,
    ) -> None:
        """Build one PMTiles file with manby.

        `output_path` lies in the build's work directory on local disk, which
        also holds manby's input and spill; the input is shared by both files
        of a polygon layer and goes with the directory when the build ends.

        Raises:
            manby.ManbyError: If manby fails. Its own messages went to stderr;
                the error has its exit status.
        """
        work_dir = output_path.parent
        distinct_locations = None
        if _part_type(geometry_type) == 1 and not label_anchor:
            distinct_locations = self._distinct_locations(
                duckdb_con, table_name, geometry_column
            )
        flags = self.manby_flags(
            geometry_type, snapshot_id, label_anchor, distinct_locations
        )
        # Shared by both files of a polygon layer
        tile_input = work_dir / "input.parquet"
        if not tile_input.exists():
            query = self.tile_query(
                duckdb_con,
                table_name,
                geometry_column,
                exclude_columns,
                geometry_type=geometry_type,
            )
            self._write_tile_input(duckdb_con, query, tile_input)
        # manby has no time limit: it runs until it finishes or fails
        try:
            self._run_manby(tile_input, output_path, [*flags, "-t", str(work_dir)])
        except manby.ManbyError as e:
            if "-zg" not in flags or e.returncode != MANBY_EXIT_NO_ZOOM_GUESS:
                raise
            # -zg found no two locations it can tell apart: build to the
            # configured max zoom, as for points at one location
            logger.warning(
                f"manby could not guess a max zoom for layer {layer_id}, "
                "building it to the configured one"
            )
            flags = self.manby_flags(geometry_type, snapshot_id, label_anchor, 1)
            self._run_manby(tile_input, output_path, [*flags, "-t", str(work_dir)])

    @staticmethod
    def _write_tile_input(
        duckdb_con: duckdb.DuckDBPyConnection, query: str, path: Path
    ) -> None:
        """Write the features of `query` to a GeoParquet file for manby.

        DuckDB is done (its sort included) before manby starts. Streamed into
        manby instead, both had to fit in the container at once, and manby
        crawled under the small budget that left it.
        """
        started = time.monotonic()
        target = str(path).replace("'", "''")
        # DuckDB keeps the memory of the sort until the connection closes,
        # next to manby's budget, unless its allocator's background threads
        # hand it back. Set as on the DuckLake connections (storage/ducklake.py);
        # it holds for the connection's whole DuckDB instance.
        duckdb_con.execute("SET allocator_flush_threshold='64MB'")
        duckdb_con.execute("SET allocator_background_threads=true")
        try:
            duckdb_con.execute(f"COPY ({query}) TO '{target}' {parquet_copy_options()}")
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        logger.info(
            f"Wrote the tile input ({path.stat().st_size / 1024 / 1024:.1f} MB) "
            f"in {time.monotonic() - started:.1f} s"
        )

    @staticmethod
    def _run_manby(input_path: Path, output_path: Path, flags: list[str]) -> None:
        """Run manby on a GeoParquet file. Its messages go to stderr.

        manby takes one thread per core of the machine unless
        TIPPECANOE_MAX_THREADS says otherwise: on a big node a container with
        two CPUs would run dozens, which costs memory.

        Raises:
            manby.ManbyError: If manby exits with an error
        """
        argv = [
            manby.binary(),
            "-o",
            str(output_path),
            "--force",
            *flags,
            str(input_path),
        ]
        env = {**os.environ, "TIPPECANOE_MAX_THREADS": str(container_cpu_count())}
        returncode = subprocess.run(argv, env=env).returncode
        if returncode != 0:
            raise manby.ManbyError(returncode, argv[1:])

    def manby_flags(
        self: Self,
        geometry_type: str | None,
        snapshot_id: int | None,
        label_anchor: bool,
        distinct_locations: int | None,
    ) -> list[str]:
        """manby's flags for a layer: the recipe of its geometry type.

        The caller adds `-t <temporary directory>`, the input and the output.

        Args:
            geometry_type: Geometry type (e.g., "POINT", "POLYGON")
            snapshot_id: DuckLake snapshot ID to embed in PMTiles metadata
            label_anchor: If True, label anchor points of polygons, in the
                anchor_layer_name layer
            distinct_locations: For point layers, how many distinct locations
                the points have, counted up to 2 (None: not counted; see
                _distinct_locations)

        Returns:
            The flags, without the input and the output
        """
        # Use defaults if config values are None (safety check)
        min_zoom = self.config.min_zoom if self.config.min_zoom is not None else 0
        max_zoom = self.config.max_zoom if self.config.max_zoom is not None else 14
        part_type = _part_type(geometry_type)

        description: dict = {"generated_at": datetime.now(timezone.utc).isoformat()}
        if snapshot_id is not None:
            description = {"snapshot_id": snapshot_id, **description}
        flags = [
            "-l",
            self.config.anchor_layer_name if label_anchor else self.config.layer_name,
            f"-Z{min_zoom}",
            "--generate-variable-depth-tile-pyramid",  # Only generate tiles where needed
            "--use-attribute-for-id=_rowid",  # Promote _rowid to MVT feature ID
            "--exclude=_rowid",  # Ensure _rowid is removed from properties
            "--preserve-input-order",  # The input is ordered by _rowid
            f"--description={json.dumps({**description, **MANBY_MARKER})}",
            "-q",
        ]
        # Without a container limit manby keeps its default: half the memory
        memory_limit = container_memory_limit()
        if memory_limit is not None:
            budget_mb = int(memory_limit * MANBY_MEMORY_SHARE) // (1024 * 1024)
            flags.append(f"--memory-budget={budget_mb}M")

        if label_anchor:
            # Today's anchor recipe: one point per polygon, no clustering.
            # Drop densest labels at low zooms when tiles are too full (e.g.
            # 200k+ polygons); they appear at higher zooms.
            return [
                *flags,
                f"-z{max_zoom}",
                "--full-detail=16",
                "--convert-polygons-to-label-points",
                "-r1",
                "--drop-densest-as-needed",
                "--extend-zooms-if-still-dropping",
            ]
        if part_type == 1:
            # No point_count: nothing reads it from tiles, a layer's own column
            # of that name would be overwritten, and under a filter the summed
            # counts would include points that do not match.
            # -zg guesses the max zoom from the spacing of the points, which
            # takes at least two locations
            if distinct_locations is not None and distinct_locations < 2:
                zooms = [f"-z{max_zoom}", "-r1"]
            else:
                zooms = ["-zg", "-rp"]
            return [
                *flags,
                "--full-detail=12",
                "--extra-detail=16",
                *zooms,
                "-M",
                "2000000",  # 2MB tile size limit (default 500KB)
                "-O",
                "200000",
                "--drop-densest-as-needed",
                "--extend-zooms-if-still-dropping",
                "--low-detail=10",
                "--preserve-point-density-threshold=64",
            ]
        if part_type == 2:
            return [
                *flags,
                f"-z{max_zoom}",
                "--full-detail=16",
                "-M",
                "2000000",
                "-O",
                "200000",
                "--drop-densest-as-needed",
                "--extend-zooms-if-still-dropping",
                "--simplify-only-low-zooms",
                "--low-detail=10",
            ]
        # Polygons. Not --coalesce-densest-as-needed: a coalesced polygon
        # keeps one feature's attributes, so a filter could draw shapes that
        # do not match it.
        return [
            *flags,
            f"-z{max_zoom}",
            "--full-detail=16",
            "-M",
            "2000000",
            "-O",
            "200000",
            "--drop-densest-as-needed",
            "--extend-zooms-if-still-dropping",
            "--simplify-only-low-zooms",
            "--no-simplification-of-shared-nodes",
            "--tiny-polygon-size=1",
            "--low-detail=10",
        ]

    def tile_query(
        self: Self,
        duckdb_con: duckdb.DuckDBPyConnection,
        table_name: str,
        geometry_column: str,
        exclude_columns: list[str],
        id_expression: str = "rowid + 1",
        geometry_type: str | None = None,
    ) -> str:
        """SQL of the features manby tiles from a table.

        `_rowid` becomes the MVT feature id, and the features come in its
        order (--preserve-input-order). Attributes are the plain columns, as
        the tiles built before manby had them: no nested types or arrays, no
        `exclude_columns` and none of the columns geoapi hides. Dates and
        timestamps become the text they were in those tiles. manby skips
        geometry collections: with `geometry_type`, a collection is replaced
        by its parts of the layer's kind. Rows without a geometry, or with an
        empty one (or nothing of that kind), are left out.

        Args:
            duckdb_con: DuckDB connection
            table_name: Full table path
            geometry_column: Name of the geometry column, quotes doubled
            exclude_columns: Columns to exclude from tiles
            id_expression: SQL of the feature id. rowid + 1 by default: MVT
                feature id 0 is treated as "unset" by MapLibre.
            geometry_type: The layer's geometry type (e.g., "POLYGON"); None
                keeps collections as they are

        Returns:
            The query
        """
        geometry = f'"{geometry_column}"'
        skip = {*exclude_columns, *_HIDDEN_COLUMNS, "_rowid", "geometry"}
        # SELECT LIMIT 0 works better with DuckLake than DESCRIBE
        description = duckdb_con.execute(
            f"SELECT * FROM {table_name} LIMIT 0"
        ).description

        columns = []
        for col_info in description:
            name = col_info[0]
            col_type = str(col_info[1]).strip().upper()
            column = '"' + name.replace('"', '""') + '"'
            if name in skip or column == geometry or _NON_PLAIN_TYPE.search(col_type):
                continue
            value = self._tile_value(column, col_type)
            columns.append(column if value == column else f"{value} AS {column}")

        if geometry_type is not None:
            # ST_CollectionExtract turns any other geometry into an empty one
            geometry = (
                f"CASE WHEN ST_GeometryType({geometry}) = 'GEOMETRYCOLLECTION' "
                f"THEN ST_CollectionExtract({geometry}, {_part_type(geometry_type)}) "
                f"ELSE {geometry} END"
            )
        select = [f"{id_expression} AS _rowid", *columns, f"{geometry} AS geometry"]
        return f"""
            SELECT * FROM (
                SELECT {", ".join(select)}
                FROM {table_name}
            )
            WHERE geometry IS NOT NULL AND NOT ST_IsEmpty(geometry)
            ORDER BY _rowid
        """

    @staticmethod
    def _tile_value(column: str, col_type: str) -> str:
        """SQL of a column's value in the tiles.

        Dates and timestamps as text, as the tiles built before manby carried
        them (GDAL's GeoJSON export, on the workers, whose time zone is UTC).
        UUIDs as text too: GeoParquet stores them as bytes, which manby
        leaves out.
        """
        if col_type == "UUID":
            return f"CAST({column} AS VARCHAR)"
        if col_type == "DATE":
            return f"CAST({column} AS VARCHAR)"
        if col_type == "TIMESTAMP WITH TIME ZONE":
            return _TIMESTAMP_TEXT.format(f"timezone('UTC', {column})") + " || 'Z'"
        if col_type.startswith("TIMESTAMP"):
            return _TIMESTAMP_TEXT.format(column)
        return column

    @staticmethod
    def _distinct_locations(
        duckdb_con: duckdb.DuckDBPyConnection,
        table_name: str,
        geometry_column: str,
    ) -> int:
        """How many distinct locations a layer's geometries have, counted up to 2.

        Geometries spread over less than ONE_LOCATION_DEGREES in both axes
        count as one location. min and max stream in constant memory.
        """
        geometry = f'"{geometry_column}"'
        result = duckdb_con.execute(f"""
            SELECT
                count(*),
                max(ST_XMax({geometry})) - min(ST_XMin({geometry})),
                max(ST_YMax({geometry})) - min(ST_YMin({geometry}))
            FROM {table_name}
            WHERE {geometry} IS NOT NULL AND NOT ST_IsEmpty({geometry})
        """).fetchone()
        if not result or not result[0]:
            return 0
        _, width, height = result
        return 2 if max(width, height) >= ONE_LOCATION_DEGREES else 1

    def _detect_geometry_type(
        self: Self,
        duckdb_con: duckdb.DuckDBPyConnection,
        table_name: str,
        geometry_column: str,
    ) -> str | None:
        """Detect the geometry type of a table.

        Args:
            duckdb_con: DuckDB connection
            table_name: Full table path
            geometry_column: Name of the geometry column

        Returns:
            Geometry type string (e.g., "POINT", "POLYGON") or None
        """
        try:
            # Query the geometry type directly from data
            # (avoids DESCRIBE which can fail with some DuckLake configurations).
            # A collection's type only when there is no other: the recipe and
            # the parts kept from collections follow the layer's own type.
            result = duckdb_con.execute(f"""
                SELECT DISTINCT ST_GeometryType("{geometry_column}") AS geometry_type
                FROM {table_name}
                WHERE "{geometry_column}" IS NOT NULL
                ORDER BY geometry_type = 'GEOMETRYCOLLECTION'
                LIMIT 1
            """).fetchone()
            if result:
                geom_type = result[0]
                logger.info(
                    f"Detected geometry type: {geom_type} (column: {geometry_column})"
                )
                return geom_type
        except Exception as e:
            logger.warning(f"Could not detect geometry type: {e}")
        return None

    def delete_pmtiles(self: Self, layer_id: str) -> bool:
        """Delete PMTiles file, anchor file, and metadata for a layer.

        Args:
            layer_id: Layer UUID

        Returns:
            True if file was deleted, False if it didn't exist
        """
        pmtiles_path = self.get_pmtiles_path(layer_id)
        deleted = False

        if pmtiles_path.exists():
            pmtiles_path.unlink()
            logger.info(f"Deleted PMTiles: {pmtiles_path}")
            deleted = True

        # Also delete anchor PMTiles (polygon label points)
        anchor_path = self.get_anchor_pmtiles_path(layer_id)
        if anchor_path.exists():
            anchor_path.unlink()
            logger.info(f"Deleted anchor PMTiles: {anchor_path}")

        # Also delete metadata sidecar file
        meta_path = pmtiles_path.with_suffix(".pmtiles.meta.json")
        if meta_path.exists():
            meta_path.unlink()
            logger.debug(f"Deleted PMTiles metadata: {meta_path}")

        return deleted
