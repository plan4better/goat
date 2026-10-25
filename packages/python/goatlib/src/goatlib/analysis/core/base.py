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
