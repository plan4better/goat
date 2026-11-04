import importlib
import logging
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, List, Self, Tuple, final

import duckdb

from goatlib.analysis.schemas.base import GeometryType
from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.io.utils import Metadata, download_if_remote, get_metadata
from goatlib.models.io import DatasetMetadata
from goatlib.utils.container_memory import JOB_WORK_MEMORY_SHARE, set_memory_share

logger = logging.getLogger(__name__)

# An analysis's budget without a container limit (local runs).
ANALYSIS_MEMORY_DEFAULT = "4GB"
# DuckDB spatial takes a copy of a geometry for every row it tests against it
# (ST_Intersects, ST_Intersection, ST_Difference) and frees the copies only
# after the whole vector of rows; that memory cannot spill. A polygon of a few
# MB tested row by row needs a copy per row, so the overlay tools cut polygons
# into pieces of at most this many vertices and test rows against the pieces.
SUBDIVIDE_MAX_VERTICES = 256
# Rows that touch at most this many pieces union them with a list fold, which
# keeps no state per row; rows that touch more use ST_Union_Agg, whose
# cascaded union stays fast where folding into a growing union does not.
LIST_UNION_MAX_PIECES = 16
# Each round of the quad split halves a piece's bounding box; a piece still
# above the limit after this many rounds is kept as it is.
SUBDIVIDE_MAX_ROUNDS = 32
# A cut line crossing an overlay edge that is not axis-parallel adds a vertex
# computed in floating point, a rounding error off that edge, so the union of
# the pieces a row touches bends the edge by that much. A row with an edge
# along it then gets a sliver from ST_Intersection or ST_Difference where the
# whole overlay gives it nothing, or only a line. A row whose polygonal result
# has a part thinner (twice its area over its perimeter) than this share of
# the row's own extent is recomputed against the whole overlay, as the tools
# did before the pieces. The share is relative to the row, so it means the
# same in degrees and in metres: rounding noise is far thinner than it, real
# parts are far wider, and a real part that thin is only recomputed, which
# gives the same result.
NEAR_EMPTY_WIDTH_RATIO = 1e-6
# A row recomputed against the whole overlay copies it, so such rows are
# recomputed this many per statement, which bounds the copies held at once.
RECOMPUTE_BATCH_ROWS = 16


class AnalysisTool:
    """
    Base class for analysis tools using DuckDB.
    Connects to a file-backed database by default to allow for disk spilling
    of large intermediate results (like buffers or joins), preventing Out-of-Memory errors.

    The public run() method handles automatic cleanup using a try...finally
    block internally, fulfilling the requirement of simple usage: tool.run(params).

    Example Usage:
    tool = BufferTool()
    tool.run(params)
    """

    def __init__(self: Self, db_path: Path | None = None) -> None:
        self._temp_db_path: Path | None = None
        self._db_path: Path

        if db_path is None:
            # Create a unique, file-backed path in the system's temp directory
            unique_name = f"duckdb_temp_{uuid.uuid4()}.db"
            self._temp_db_path = Path(tempfile.gettempdir()) / unique_name
            self._db_path = self._temp_db_path
        else:
            self._db_path = db_path

        # Connect to the file-backed database path
        self.con = duckdb.connect(database=str(self._db_path))

        self._setup_duckdb_extensions()

    def _setup_duckdb_extensions(self: Self) -> None:
        """Configure DuckDB with necessary extensions and settings."""
        self.con.execute("INSTALL spatial; LOAD spatial;")
        self.con.execute("INSTALL httpfs; LOAD httpfs;")
        set_memory_share(self.con, JOB_WORK_MEMORY_SHARE, ANALYSIS_MEMORY_DEFAULT)

    @staticmethod
    def _get_routing_module() -> Any:
        """Lazy-import the C++ routing pybind module.

        Shared by tools (catchment v2, heatmap v2, …) that dispatch
        compute to the local C++ routing backend.
        """
        try:
            return importlib.import_module("routing")
        except Exception as exc:
            raise RuntimeError(
                "Local routing package is not available. "
                "Install the 'routing' package (packages/cpp/routing)."
            ) from exc

    def cleanup(self: Self) -> None:
        """
        Closes the DuckDB connection and cleans up the temporary database file.
        This is called automatically by the public run() method.
        """
        # 1. Close the connection
        if hasattr(self, "con") and self.con:
            try:
                self.con.close()
            except Exception:
                pass  # Connection may already be closed
            self.con = None

        # 2. Clean up the temporary file if one was automatically created
        if (
            hasattr(self, "_temp_db_path")
            and self._temp_db_path
            and self._temp_db_path.exists()
        ):
            try:
                os.remove(self._temp_db_path)
                logger.debug(f"Cleaned up temporary DuckDB file: {self._temp_db_path}")
            except Exception as e:
                logger.warning(f"Failed to delete temporary DuckDB file: {e}")

            # DuckDB creates .wal journal file
            wal_path = Path(str(self._temp_db_path) + ".wal")
            if wal_path.exists():
                try:
                    os.remove(wal_path)
                except Exception as e:
                    logger.warning(
                        f"Failed to delete DuckDB WAL file '{wal_path}': {e}"
                    )

            # DuckDB also creates .tmp directory for spilling
            tmp_dir = Path(str(self._temp_db_path) + ".tmp")
            if tmp_dir.exists() and tmp_dir.is_dir():
                try:
                    import shutil

                    shutil.rmtree(tmp_dir)
                    logger.debug(f"Cleaned up DuckDB temp directory: {tmp_dir}")
                except Exception as e:
                    logger.warning(f"Failed to delete DuckDB temp directory: {e}")

            self._temp_db_path = None

    def __del__(self: Self) -> None:
        """Destructor to ensure cleanup happens even if run() wasn't called."""
        try:
            self.cleanup()
        except Exception:
            pass  # Ignore errors during garbage collection

    def __enter__(self: Self) -> Self:
        """Context manager entry."""
        return self

    def __exit__(self: Self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Context manager exit - ensures cleanup."""
        self.cleanup()

    def import_input(
        self: Self,
        input_path: str,
        table_name: str = "v_input",
    ) -> Tuple[Metadata, str]:
        """
        Imports any supported vector or tabular dataset into DuckDB directly.
        Automatically adds bbox columns for spatial indexing if geometry exists but bbox doesn't.

        Args:
            input_path: Path to the input dataset
            table_name: Name for the created table/view

        Returns:
        - Metadata about the imported dataset.
        - The name of the table/view created in DuckDB.
        """
        path = Path(download_if_remote(input_path))
        suffix = path.suffix.lower()

        # First create the basic view
        if suffix == ".parquet":
            logger.info("Registering parquet dataset as table: %s", path)
            self.con.execute(
                f"CREATE OR REPLACE VIEW {table_name}_base AS SELECT * FROM read_parquet('{path}')"
            )
            base_view = f"{table_name}_base"
        else:
            logger.info("Reading dataset into DuckDB via ST_Read: %s", path)
            self.con.execute(
                f"CREATE OR REPLACE VIEW {table_name}_base AS SELECT * FROM ST_Read('{path}')"
            )
            base_view = f"{table_name}_base"

        # Get metadata to determine geometry column
        meta = get_metadata(self.con, str(path))
        geom_column = meta.geometry_column

        # Handle bbox column creation if geometry column exists
        # Always recompute bbox from geometry to ensure correctness
        if geom_column:
            # Get all columns except existing bbox (if any) to avoid conflicts
            cols = self.con.execute(f"DESCRIBE {base_view}").fetchall()
            col_names = [c[0] for c in cols if c[0] != "bbox"]
            col_select = ", ".join(quote_identifier(c) for c in col_names)
            geom = quote_identifier(geom_column)

            logger.info("Computing bbox from geometry for %s", path)
            self.con.execute(f"""
                CREATE OR REPLACE VIEW {table_name} AS
                SELECT {col_select},
                    {{
                        'xmin': ST_XMin({geom}),
                        'xmax': ST_XMax({geom}),
                        'ymin': ST_YMin({geom}),
                        'ymax': ST_YMax({geom})
                    }} AS bbox
                FROM {base_view}
            """)
        else:
            # No geometry column, just create final view
            self.con.execute(
                f"CREATE OR REPLACE VIEW {table_name} AS SELECT * FROM {base_view}"
            )

        return meta, table_name

    def validate_geometry_types(
        self: Self,
        view_name: str,
        geom_column: str,
        accepted_types: List[GeometryType],
        layer_name: str = "layer",
    ) -> None:
        """
        Validates that all geometries in the view match one of the accepted types.

        Args:
            view_name: Name of the DuckDB view/table to validate
            geom_column: Name of the geometry column
            accepted_types: List of accepted GeometryType values
            layer_name: Descriptive name for the layer (for error messages)

        Raises:
            ValueError: If geometries don't match accepted types
        """
        if not accepted_types:
            return  # No validation needed if no types specified

        # Get unique geometry types from the dataset
        geom = quote_identifier(geom_column)
        actual_types = self.con.execute(f"""
            SELECT DISTINCT ST_GeometryType({geom}) as geom_type
            FROM {view_name}
            WHERE {geom} IS NOT NULL
            LIMIT 1
        """).fetchall()

        if not actual_types:
            logger.warning(f"No geometries found in {layer_name}")
            return

        # Convert accepted types to uppercase strings for comparison
        accepted_type_names = [t.value.upper() for t in accepted_types]

        # Check each actual type
        invalid_types = []
        for (geom_type,) in actual_types:
            # ST_GeometryType returns format like "POLYGON", "MULTIPOLYGON", etc.
            geom_type_upper = geom_type.upper()
            if geom_type_upper not in accepted_type_names:
                invalid_types.append(geom_type)

        if invalid_types:
            raise ValueError(
                f"Invalid geometry types found in {layer_name}. "
                f"Found: {', '.join(invalid_types)}. "
                f"Accepted: {', '.join(accepted_type_names)}"
            )

        logger.info(
            f"Geometry type validation passed for {layer_name}: "
            f"{', '.join(t[0] for t in actual_types)}"
        )

    def get_allowed_output_geometry_types(
        self: Self,
        view_name: str,
        geom_column: str,
    ) -> str | None:
        """The geometry types an overlay keeps, as a SQL list: the single and
        multi type of the family of the input's first geometry.

        An overlay can leave degenerate pieces of a lower dimension (the line
        where two polygons touch); keeping the input's family drops them.
        None keeps every type, also for an input without geometries, which
        gives no pieces to drop.
        """
        geom = quote_identifier(geom_column)
        row = self.con.execute(f"""
            SELECT ST_GeometryType({geom})
            FROM {view_name}
            WHERE {geom} IS NOT NULL
            LIMIT 1
        """).fetchone()
        input_geom_upper = str(row[0]).upper() if row else ""
        if "POLYGON" in input_geom_upper:  # Matches POLYGON or MULTIPOLYGON
            return "('POLYGON', 'MULTIPOLYGON')"
        if "LINESTRING" in input_geom_upper:  # Matches LINESTRING or MULTILINESTRING
            return "('LINESTRING', 'MULTILINESTRING')"
        if "POINT" in input_geom_upper:  # Matches POINT or MULTIPOINT
            return "('POINT', 'MULTIPOINT')"
        return None

    def subdivide_polygons(
        self: Self,
        table: str,
        geom: str,
        max_vertices: int = SUBDIVIDE_MAX_VERTICES,
        cut_lines: bool = False,
    ) -> bool:
        """Cut, in place, every polygon of `table` with more than
        `max_vertices` vertices into pieces with at most that many.

        The spatial extension has no ST_Subdivide: a polygon is cut into the
        four quadrants of its bounding box, and a piece still too big is cut
        again. Rows above the limit are first split into their parts (a
        multipolygon into polygons), and their other columns are copied to
        every piece. The pieces cover the polygon without overlapping, up to
        the rounding of the vertices the cut lines add. Invalid polygons are
        not cut, and neither are other types, unless `cut_lines`: then lines
        are cut too and every part of a cut is kept, which is what finding the
        pieces a row touches needs, where the parts only stand in for the row.
        A table without a row above the limit is left as it is, and False is
        returned; otherwise True.
        """
        g = quote_identifier(geom)
        over = f"ST_NPoints({g}) > {max_vertices}"
        row = self.con.execute(
            f"SELECT EXISTS (SELECT 1 FROM {table} WHERE {over})"
        ).fetchone()
        if not row or not row[0]:
            return False

        columns = [r[0] for r in self.con.execute(f"DESCRIBE {table}").fetchall()]
        column_list = ", ".join(quote_identifier(c) for c in columns)
        others = "".join(f"{quote_identifier(c)}, " for c in columns if c != geom)
        big_others = "".join(f"b.{quote_identifier(c)}, " for c in columns if c != geom)
        pending = "__subdivide_pending"
        cut_types = "('POLYGON', 'LINESTRING')" if cut_lines else "('POLYGON')"
        polygon_or_line = (
            f"ST_GeometryType({g}) = 'LINESTRING' OR " if cut_lines else ""
        )
        kept_parts = "" if cut_lines else f"ST_GeometryType({g}) = 'POLYGON' AND "

        # The rows above the limit, split into their parts; `__cut` marks the
        # parts to cut. Validity is checked once: a piece cut from a valid
        # polygon is valid.
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE {pending} AS
            SELECT *, {over} AND ({polygon_or_line}(
                ST_GeometryType({g}) = 'POLYGON' AND ST_IsValid({g})
            )) AS __cut
            FROM (
                SELECT {others} UNNEST(ST_Dump({g})).geom AS {g}
                FROM {table} WHERE {over}
            )
        """)
        self.con.execute(f"DELETE FROM {table} WHERE {over}")
        for _ in range(SUBDIVIDE_MAX_ROUNDS):
            self.con.execute(f"""
                INSERT INTO {table} ({column_list})
                SELECT {column_list} FROM {pending} WHERE NOT __cut
            """)
            row = self.con.execute(
                f"SELECT EXISTS (SELECT 1 FROM {pending} WHERE __cut)"
            ).fetchone()
            if not row or not row[0]:
                break
            # The outer edges of the quadrants are the bounding box's own, so
            # only the two cut lines add vertices.
            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE {pending} AS
                WITH big AS (
                    SELECT {others} {g},
                        ST_XMin({g}) AS __x0, ST_YMin({g}) AS __y0,
                        ST_XMax({g}) AS __x1, ST_YMax({g}) AS __y1,
                        ST_XMin({g}) + (ST_XMax({g}) - ST_XMin({g})) / 2 AS __xm,
                        ST_YMin({g}) + (ST_YMax({g}) - ST_YMin({g})) / 2 AS __ym
                    FROM {pending} WHERE __cut
                ), cut AS (
                    SELECT {big_others} ST_Intersection(b.{g}, ST_MakeEnvelope(
                        CASE WHEN q.__right THEN b.__xm ELSE b.__x0 END,
                        CASE WHEN q.__top THEN b.__ym ELSE b.__y0 END,
                        CASE WHEN q.__right THEN b.__x1 ELSE b.__xm END,
                        CASE WHEN q.__top THEN b.__y1 ELSE b.__ym END
                    )) AS {g}
                    FROM big b, (VALUES (false, false), (false, true),
                                        (true, false), (true, true)) q(__right, __top)
                ), parts AS (
                    SELECT {others} UNNEST(ST_Dump({g})).geom AS {g} FROM cut
                )
                SELECT *, {over} AND ST_GeometryType({g}) IN {cut_types} AS __cut
                FROM parts
                WHERE {kept_parts}NOT ST_IsEmpty({g})
            """)
        else:
            # Pieces still above the limit after the last round stay as they are.
            self.con.execute(f"""
                INSERT INTO {table} ({column_list})
                SELECT {column_list} FROM {pending}
            """)
        self.con.execute(f"DROP TABLE {pending}")
        return True

    def create_overlay_pieces(
        self: Self,
        pieces: str,
        source: str,
        geom: str,
        key: str | None = None,
    ) -> bool:
        """Table `pieces` (piece_id, [key,] geom): `source`'s valid
        geometries, cut by `subdivide_polygons`, to test rows against.

        Without a key they are dissolved into one geometry first, the overlay
        a row is clipped by or erased with; when it is cut, it is also kept
        whole in `{pieces}_whole` for `recompute_slivers`. With a key every row
        stays on its own and its pieces keep its key. Returns whether anything
        was cut: without a cut the pieces are the overlay itself, and no row
        needs `recompute_slivers`.
        """
        g = quote_identifier(geom)
        if key is None:
            select = f"SELECT ST_Union_Agg({g}) AS geom"
        else:
            select = f"SELECT {quote_identifier(key)}, {g} AS geom"
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE {pieces} AS
            {select} FROM {source} WHERE ST_IsValid({g})
        """)
        if key is None:
            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE {pieces}_whole AS
                SELECT geom FROM {pieces}
                WHERE ST_NPoints(geom) > {SUBDIVIDE_MAX_VERTICES}
            """)
        cut = self.subdivide_polygons(pieces, "geom")
        # An empty geometry touches nothing (the dissolve of no rows is one),
        # and a spatial join whose only geometry is empty crashes DuckDB.
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE {pieces} AS
            SELECT row_number() OVER () AS piece_id, * FROM {pieces}
            WHERE NOT ST_IsEmpty(geom)
        """)
        return cut

    def create_touched_pieces(
        self: Self,
        pairs: str,
        rows: str,
        row_key: str,
        geom: str,
        pieces: str,
        owner: str | None = None,
    ) -> None:
        """Table `pairs` (row_key, [owner,] piece_id, is_point): the pieces of
        `pieces` that each row of `rows` touches, for `local_union_cte`.

        A row is tested against small pieces only. Rows above the vertex limit
        (polygons, lines, the points of a multipoint) are cut as well for this
        test, since a big row tested against many pieces would be copied once
        per piece; a piece one row reaches through several of its parts is
        listed once. The intersection or difference that follows uses the row
        itself, not its parts.
        """
        g = quote_identifier(geom)
        row_col = quote_identifier(row_key)
        piece_owner = f", p.{quote_identifier(owner)}" if owner else ""
        over = f"ST_NPoints({g}) > {SUBDIVIDE_MAX_VERTICES}"

        # Empty geometries touch nothing; they are left out because a spatial
        # join whose only geometry is empty crashes DuckDB. Whether a row is a
        # POINT is decided on the row: the parts of a cut row (a multipoint
        # above the limit becomes points) are not.
        is_point = f"ST_GeometryType({g}) = 'POINT' AS __is_point"
        join_rows = f"""(
            SELECT {row_col}, {g}, {is_point} FROM {rows} WHERE NOT ST_IsEmpty({g})
        )"""
        distinct = ""
        row = self.con.execute(
            f"SELECT EXISTS (SELECT 1 FROM {rows} WHERE {over})"
        ).fetchone()
        if row and row[0]:
            row_parts = f"{pairs}_row_parts"
            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE {row_parts} AS
                SELECT {row_col}, {g} FROM {rows} WHERE {over}
            """)
            self.subdivide_polygons(row_parts, geom, cut_lines=True)
            join_rows = f"""(
                SELECT {row_col}, {g}, {is_point} FROM {rows}
                WHERE NOT ({over}) AND NOT ST_IsEmpty({g})
                UNION ALL
                SELECT {row_col}, {g}, false AS __is_point FROM {row_parts}
            )"""
            distinct = "DISTINCT"

        # Planned as a SPATIAL_JOIN: an R-tree on the small pieces.
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE {pairs} AS
            SELECT {distinct} r.{row_col}{piece_owner}, p.piece_id,
                r.__is_point AS is_point
            FROM {join_rows} r
            JOIN {pieces} p ON ST_Intersects(r.{g}, p.geom)
        """)
        self.con.execute(f"DROP TABLE IF EXISTS {pairs}_row_parts")

    def local_union_cte(
        self: Self,
        pairs: str,
        pieces: str,
        row_key: str,
        owner: str | None = None,
    ) -> str:
        """Common table expressions, for a WITH clause, ending in
        `local_overlays` (row_key, [owner,] local_overlay): per row in `pairs`
        (and owner), the union of the pieces it touches.

        That union holds only the part of the overlay the row reaches, so the
        one ST_Intersection or ST_Difference that follows copies that part
        instead of the whole overlay. It stays inside the statement that uses
        it rather than in a table, so it is held only once. A POINT row gets
        NULL: it touches a piece, so it lies in the overlay, and needs no
        union. The names are fixed (`__counted`, `__exploded`,
        `local_overlays`), so a WITH clause holds one of them.
        """
        group = quote_identifier(row_key) + (
            f", {quote_identifier(owner)}" if owner else ""
        )
        return f"""
            __counted AS (
                SELECT {group}, piece_id, count(*) OVER (PARTITION BY {group}) AS n
                FROM {pairs} WHERE NOT is_point
            ), __exploded AS (
                SELECT c.*, p.geom
                FROM __counted c JOIN {pieces} p ON p.piece_id = c.piece_id
            ), local_overlays AS (
                SELECT {group},
                    list_reduce(list(geom), lambda a, b: ST_Union(a, b))
                        AS local_overlay
                FROM __exploded WHERE n <= {LIST_UNION_MAX_PIECES} GROUP BY {group}
                UNION ALL
                SELECT {group}, ST_Union_Agg(geom) AS local_overlay
                FROM __exploded WHERE n > {LIST_UNION_MAX_PIECES} GROUP BY {group}
                UNION ALL
                SELECT DISTINCT {group}, NULL AS local_overlay
                FROM {pairs} WHERE is_point
            )"""

    def recompute_slivers(
        self: Self,
        results: str,
        result_geom: str,
        keys: list[str],
        rows: str,
        row_geom: str,
        operation: str,
        whole: str,
        whole_geom: str,
        whole_key: str | None = None,
    ) -> None:
        """Recompute, in `results`, the rows whose polygonal result has a part
        of near-zero width (see `NEAR_EMPTY_WIDTH_RATIO`), against the whole
        overlay instead of the union of its pieces, which gives the result the
        tools gave before the pieces.

        `keys` identify a row of `results`; the first is its row's key in
        `rows`, and `whole_key`, when given, is also the key of its overlay row
        in `whole` (otherwise `whole` holds one geometry). `operation` is that
        earlier SQL, with `{row}` and `{whole}` for the two geometries. Each
        recomputed row copies the whole overlay, so they are recomputed
        `RECOMPUTE_BATCH_ROWS` per statement.
        """
        rg = quote_identifier(result_geom)
        ig = quote_identifier(row_geom)
        wg = quote_identifier(whole_geom)
        row_key = quote_identifier(keys[0])
        key_cols = ", ".join(f"r.{quote_identifier(k)}" for k in keys)
        same_row = " AND ".join(
            f"r.{quote_identifier(k)} = s.{quote_identifier(k)}" for k in keys
        )
        same_whole = (
            f"AND w.{quote_identifier(whole_key)} = s.{quote_identifier(whole_key)}"
            if whole_key
            else ""
        )
        recompute = "__recompute_rows"
        self.con.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE {recompute} AS
            SELECT row_number() OVER () AS __batch_row, {key_cols}
            FROM {results} r
            JOIN {rows} i ON i.{row_key} = r.{row_key}
            WHERE ST_GeometryType(r.{rg}) IN ('POLYGON', 'MULTIPOLYGON')
                AND list_min(list_transform(
                    ST_Dump(r.{rg}),
                    lambda p: 2 * ST_Area(p.geom) / nullif(ST_Perimeter(p.geom), 0)
                )) < ? * greatest(
                    ST_XMax(i.{ig}) - ST_XMin(i.{ig}),
                    ST_YMax(i.{ig}) - ST_YMin(i.{ig})
                )
            """,
            [NEAR_EMPTY_WIDTH_RATIO],
        )
        row = self.con.execute(f"SELECT count(*) FROM {recompute}").fetchone()
        count = int(row[0]) if row else 0
        recomputed = operation.format(row=f"i.{ig}", whole=f"w.{wg}")
        for first in range(1, count + 1, RECOMPUTE_BATCH_ROWS):
            self.con.execute(
                f"""
                UPDATE {results} AS r SET {rg} = {recomputed}
                FROM {recompute} s, {rows} i, {whole} w
                WHERE s.__batch_row BETWEEN ? AND ?
                    AND {same_row}
                    AND i.{row_key} = s.{row_key}
                    {same_whole}
                """,
                [first, first + RECOMPUTE_BATCH_ROWS - 1],
            )
        self.con.execute(f"DROP TABLE {recompute}")

    def get_statistics_sql(
        self: Self,
        field_expr: str,
        operation: str,
    ) -> str:
        """Generate SQL expression for a statistics operation.

        This is a reusable utility for generating SQL aggregate expressions
        used in tools like AggregatePoints, AggregatePolygons, Join, etc.

        Args:
            field_expr: The field expression to aggregate (ignored for 'count')
            operation: The operation name ('count', 'sum', 'mean', 'min', 'max',
                       'standard_deviation', 'stddev')

        Returns:
            SQL expression string

        Raises:
            ValueError: If operation is not supported
        """
        op = operation.lower()
        if op == "count":
            return "COUNT(*)"
        elif op == "sum":
            return f"SUM({field_expr})"
        elif op == "mean" or op == "avg":
            return f"AVG({field_expr})"
        elif op == "min":
            return f"MIN({field_expr})"
        elif op == "max":
            return f"MAX({field_expr})"
        elif op in ("standard_deviation", "stddev"):
            return f"STDDEV({field_expr})"
        else:
            raise ValueError(f"Unsupported statistics operation: {operation}")

    def _run_implementation(
        self: Self, *args: Any, **kwargs: Any
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """
        Abstract method. Subclasses MUST override this with their core analysis logic.
        """
        raise NotImplementedError(
            "Each tool must implement the _run_implementation() method."
        )

    @final
    def run(
        self: Self, *args: Any, **kwargs: Any
    ) -> List[Tuple[Path, DatasetMetadata]]:
        """
        Public execution method. Executes _run_implementation() and guarantees
        connection and resource cleanup via cleanup(), even if an error occurs.
        """
        try:
            # Delegate execution to the subclass's logic
            return self._run_implementation(*args, **kwargs)
        finally:
            # GUARANTEED cleanup runs here
            self.cleanup()
