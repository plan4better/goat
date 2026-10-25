import logging
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Self

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.base import PTTimeWindow
from goatlib.io.parquet import write_optimized_parquet
from goatlib.io.utils import Metadata

logger = logging.getLogger(__name__)


# =============================================================================
# Transport Mode Mapping (GTFS route_type to mode category)
# =============================================================================

# Based on GTFS extended route types
TRANSPORT_MODE_MAPPING: dict[str, str] = {
    # Bus
    "3": "bus",
    "11": "bus",
    "700": "bus",
    "701": "bus",
    "702": "bus",
    "704": "bus",
    "705": "bus",
    "710": "bus",
    "712": "bus",
    "715": "bus",
    "800": "bus",
    # Tram
    "0": "tram",
    "5": "tram",
    "900": "tram",
    "901": "tram",
    "902": "tram",
    "903": "tram",
    "904": "tram",
    "905": "tram",
    "906": "tram",
    # Metro
    "1": "metro",
    "400": "metro",
    "401": "metro",
    "402": "metro",
    "403": "metro",
    "405": "metro",
    # Rail
    "2": "rail",
    "100": "rail",
    "101": "rail",
    "102": "rail",
    "103": "rail",
    "104": "rail",
    "105": "rail",
    "106": "rail",
    "107": "rail",
    "108": "rail",
    "109": "rail",
    "110": "rail",
    "111": "rail",
    "112": "rail",
    "114": "rail",
    "116": "rail",
    "117": "rail",
    "202": "rail",
    # Other
    "4": "other",
    "6": "other",
    "7": "other",
    "200": "other",
    "201": "other",
    "204": "other",
    "1000": "other",
    "1300": "other",
    "1400": "other",
}


# =============================================================================
# Utility Functions
# =============================================================================


def sanitize_sql_name(name: str, fallback_idx: int = 0) -> str:
    """Sanitize a string to be a valid SQL identifier.

    Normalizes unicode, removes special characters, and ensures valid SQL name.

    Args:
        name: The original name (e.g., layer name with special characters)
        fallback_idx: Index to use if name becomes empty after sanitization

    Returns:
        A valid SQL identifier (lowercase, alphanumeric with underscores)
    """
    # Normalize unicode (converts ö to o, etc.)
    normalized = unicodedata.normalize("NFKD", name)
    safe_name = normalized.encode("ascii", "ignore").decode("ascii")
    # Replace non-alphanumeric with underscore, lowercase
    safe_name = re.sub(r"[^a-zA-Z0-9]", "_", safe_name).lower()
    # Remove consecutive/trailing underscores
    safe_name = re.sub(r"_+", "_", safe_name).strip("_")
    # Ensure not empty
    if not safe_name:
        safe_name = f"opp_{fallback_idx}"
    return safe_name


#: `calendar.txt`'s day columns, in Python's `date.weekday()` order.
_GTFS_WEEKDAY_COLUMNS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)


class HeatmapToolBase(AnalysisTool):
    """Base class for heatmap analysis tools."""

    def __init__(self: Self) -> None:
        super().__init__()
        self._setup_heatmap_extensions()
        #: The time-cost columns (`cost`, `traveltime`) the files of the OD
        #: matrix in use hold, as `_detect_od_columns` found them.
        self._od_cost_columns: list[str] = []

    def _setup_heatmap_extensions(self: Self) -> None:
        """Install required extensions and register helper functions."""
        self.con.execute("INSTALL h3 FROM community; LOAD h3;")
        logger.debug("H3 extensions and helper UDFs loaded.")

    def _detect_od_columns(
        self: Self,
        od_matrix_path: str,
    ) -> dict[str, str]:
        """Auto-detect column mapping from OD matrix parquet schema.

        Looks for standard column names and common alternatives:
        - orig_id: origin_id, from_id, source_id, orig
        - dest_id: destination_id, to_id, target_id, dest
        - cost: traveltime, travel_time, time, duration, distance

        Returns:
            Column mapping dict with keys: orig_id, dest_id, cost
        """
        # Normalize path for glob pattern (handle directories)
        path = od_matrix_path.rstrip("/")
        if not path.endswith(".parquet") and "*" not in path:
            path = f"{path}/**/*.parquet"

        # Get schema from parquet file(s)
        try:
            schema_result = self.con.execute(f"""
                SELECT DISTINCT name
                FROM parquet_schema('{path}')
            """).fetchall()
            columns = {row[0].lower() for row in schema_result}
            logger.debug(f"Detected parquet columns: {sorted(columns)}")
        except Exception as e:
            logger.warning(f"Could not read parquet schema: {e}, using defaults")
            return {"orig_id": "orig_id", "dest_id": "dest_id", "cost": "traveltime"}

        # Define candidate names for each required column (in priority order)
        candidates = {
            "orig_id": ["orig_id", "origin_id", "from_id", "source_id", "orig", "o_id"],
            "dest_id": [
                "dest_id",
                "destination_id",
                "to_id",
                "target_id",
                "dest",
                "d_id",
            ],
            "cost": [
                "cost",
                "traveltime",
                "travel_time",
                "time",
                "duration",
                "distance",
            ],
        }
        # Stored travel-time matrices name the time cost `cost` or
        # `traveltime`; the files of one matrix may hold both.
        self._od_cost_columns = [c for c in ("cost", "traveltime") if c in columns]

        mapping = {}
        for target, options in candidates.items():
            for option in options:
                if option in columns:
                    mapping[target] = option
                    logger.debug(f"Auto-detected {target} -> {option}")
                    break
            if target not in mapping:
                raise ValueError(
                    f"Could not auto-detect '{target}' column. "
                    f"Available columns: {sorted(columns)}. "
                    f"Expected one of: {options}"
                )

        logger.info(f"Auto-detected OD matrix columns: {mapping}")
        return mapping

    def _prepare_od_matrix(
        self: Self,
        od_matrix_path: str,
        od_column_map: dict[str, str] | None = None,
        od_matrix_view_name: str = "od_matrix",
    ) -> tuple[str, int]:
        """
        Register OD matrix source as a DuckDB VIEW and detect H3 resolution.
        Supports custom column mapping: keys = ["orig_id", "dest_id", "cost"]
        Returns (view_name, h3_resolution)
        """
        view_name = od_matrix_view_name

        # Normalize path for glob pattern (handle directories)
        path = od_matrix_path.rstrip("/")
        if not path.endswith(".parquet") and "*" not in path:
            path = f"{path}/**/*.parquet"

        # Default mapping that should trigger auto-detection
        default_mapping = {"orig_id": "orig_id", "dest_id": "dest_id", "cost": "cost"}

        # Only auto-detection sets it; an explicit mapping reads one layout.
        self._od_cost_columns = []

        # Auto-detect column mapping if not provided or using defaults
        if od_column_map is None or od_column_map == default_mapping:
            od_column_map = self._detect_od_columns(od_matrix_path)

        mapping = od_column_map

        # Build column selections - only alias if source != target name
        def col_expr(target: str) -> str:
            source = mapping[target]
            if source == target:
                return f'"{source}"'
            return f'"{source}" AS {target}'

        # Files in both time-cost layouts are matched by column name and give
        # the cost from whichever column each has. Matching by name reads every
        # file footer on each bind of the view and turns a missing column into
        # NULLs, so a single layout keeps the plain read, which fails on it.
        if len(self._od_cost_columns) > 1:
            cost_sql = 'COALESCE("cost", "traveltime") AS cost'
            reader = f"read_parquet('{path}', union_by_name = true)"
        else:
            cost_sql = col_expr("cost")
            reader = f"read_parquet('{path}')"

        try:
            self.con.execute(f"""
                CREATE OR REPLACE TEMP VIEW {view_name} AS
                SELECT
                    {col_expr('orig_id')},
                    {col_expr('dest_id')},
                    {cost_sql}
                FROM {reader}
            """)
        except Exception as e:
            raise ValueError(
                f"Failed to register OD matrix from '{od_matrix_path}': {e}"
            )

        # Inspect columns. DESCRIBE reads only this view; unqualified
        # information_schema spans every attached catalog and lazily
        # loads all lake tables.
        result = self.con.execute(f'DESCRIBE "{view_name}"').fetchall()
        actual_columns = {row[0] for row in result}
        required_columns = {"orig_id", "dest_id", "cost"}
        if not required_columns.issubset(actual_columns):
            raise ValueError(
                f"OD matrix must contain columns: {required_columns}. Found: {actual_columns}"
            )

        # Detect H3 resolution
        result = self.con.execute(f"""
            SELECT h3_get_resolution(COALESCE(orig_id, dest_id)) AS res
            FROM {view_name}
            WHERE orig_id IS NOT NULL OR dest_id IS NOT NULL
            LIMIT 1
        """).fetchone()

        if result and result[0] is not None:
            h3_resolution = int(result[0])
            logger.info(
                "Registered OD matrix view '%s' at H3 resolution %d",
                view_name,
                h3_resolution,
            )
            return view_name, h3_resolution

        raise ValueError("Could not detect H3 resolution from OD matrix")

    def _filter_od_matrix(
        self: Self,
        od_table: str,
        *,
        origin_ids: list[int] = None,
        destination_ids: list[int] = None,
        max_cost: float = None,
        min_cost: float = None,
    ) -> str:
        """
        Efficiently filter the OD matrix by various criteria.

        Args:
            od_table: Name of the OD matrix table
            origin_ids: List of origin H3 IDs to filter by
            destination_ids: List of destination H3 IDs to filter by
            max_cost: Maximum cost to include
            min_cost: Minimum cost to include

        Returns:
            Name of the filtered table
        """
        filtered_table = "filtered_matrix"

        if (
            not origin_ids
            and not destination_ids
            and max_cost is None
            and min_cost is None
        ):
            raise ValueError("At least one filtering criterion must be provided.")

        conditions = []

        if origin_ids:
            origin_ids_sql = ", ".join(map(str, origin_ids))
            conditions.append(f"orig_id IN ({origin_ids_sql})")

        if destination_ids:
            dest_ids_sql = ", ".join(map(str, destination_ids))
            conditions.append(f"dest_id IN ({dest_ids_sql})")

        if max_cost is not None:
            conditions.append(f"cost <= {max_cost}")

        if min_cost is not None:
            conditions.append(f"cost >= {min_cost}")

        where_clause = " AND ".join(conditions) if conditions else "1=1"

        query = f"""
            CREATE OR REPLACE TEMP TABLE {filtered_table} AS
            SELECT orig_id, dest_id, cost
            FROM {od_table}
            WHERE {where_clause}
        """

        self.con.execute(query)
        count = self.con.execute(f"SELECT COUNT(*) FROM {filtered_table}").fetchone()[0]

        filter_desc = []
        if origin_ids:
            filter_desc.append(f"{len(origin_ids)} origins")
        if destination_ids:
            filter_desc.append(f"{len(destination_ids)} destinations")
        if max_cost is not None:
            filter_desc.append(f"max_cost={max_cost}")
        if min_cost is not None:
            filter_desc.append(f"min_cost={min_cost}")

        logger.info(
            "Filtered OD matrix created with %d rows (%s)",
            count,
            ", ".join(filter_desc),
        )
        return filtered_table

    def _extract_h3_ids(
        self: Self, table: str, column_name: str = "dest_id"
    ) -> list[int]:
        """Extract unique destination H3 IDs from a table with h3_index."""
        result = self.con.execute(
            f"SELECT DISTINCT {column_name} FROM {table} WHERE {column_name} IS NOT NULL"
        ).fetchall()
        return [row[0] for row in result] if result else []

    def _process_table_to_h3(
        self: Self,
        input_table: str,
        meta: Metadata,
        h3_resolution: int,
        output_table: str,
        h3_column: str = "dest_id",
    ) -> str:
        """Convert Polygon/MultiPolygon geometries to H3 cells (experimental)."""
        geom_type = (meta.geometry_type or "").lower()
        geom_col = meta.geometry_column or "geom"

        if "polygon" not in geom_type:
            raise ValueError(
                f"Unsupported geometry type '{geom_type}'. Only Polygon/MultiPolygon supported."
            )
        if not hasattr(meta, "crs") or meta.crs is None:
            raise ValueError("No CRS information found in input data.")

        transform_to_4326 = geom_col
        if meta.crs.to_epsg() != 4326:
            source_crs = meta.crs.to_string()
            logger.info(f"Transforming geometry from {source_crs} to EPSG:4326")
            transform_to_4326 = f"ST_Transform({geom_col}, '{source_crs}', 'EPSG:4326')"

        query = f"""
            CREATE OR REPLACE TEMP TABLE {output_table} AS
            WITH features AS (
                SELECT {transform_to_4326} AS geom
                FROM {input_table}
                WHERE {geom_col} IS NOT NULL
            ),
            polygons AS (
                SELECT (UNNEST(ST_Dump(ST_Force2D(geom)))).geom AS simple_geom
                FROM features
            ),
            h3_cells_raw AS (
                SELECT
                    UNNEST(h3_polygon_wkt_to_cells_experimental(ST_AsText(simple_geom), {h3_resolution}, 'CONTAINMENT_OVERLAPPING')) AS {h3_column}
                FROM polygons
            )
            SELECT DISTINCT {h3_column} FROM h3_cells_raw
        """
        self.con.execute(query)
        count = self.con.execute(f"SELECT COUNT(*) FROM {output_table}").fetchone()[0]
        logger.info("Produced %d H3 cells from polygon input: %s", count, output_table)
        return output_table

    def _project_to_reference_area(
        self: Self,
        result_table: str,
        reference_table_h3: str,
    ) -> str:
        """Extend result to all H3 cells in the reference area.

        Cells in the reference area that were not reached get NULL values.
        The output is clipped to the reference area (cells outside are dropped).
        If there is no overlap between the result and the reference area,
        the original result_table is returned unchanged.
        """
        projected_table = "result_projected_to_reference"

        overlap_count = self.con.execute(f"""
            SELECT COUNT(*) FROM {result_table} r
            JOIN {reference_table_h3} ref ON r.h3_index = ref.dest_id
        """).fetchone()[0]

        if overlap_count == 0:
            logger.info(
                "Reference area has no overlap with result — skipping projection"
            )
            return result_table

        # Collect value columns (everything except h3_index)
        schema = self.con.execute(f"DESCRIBE {result_table}").fetchall()
        value_cols = [col[0] for col in schema if col[0] != "h3_index"]
        select_cols = ", ".join(f"r.{col}" for col in value_cols)

        query = f"""
            CREATE OR REPLACE TEMP TABLE {projected_table} AS
            SELECT
                ref.dest_id AS h3_index,
                {select_cols}
            FROM {reference_table_h3} ref
            LEFT JOIN {result_table} r ON ref.dest_id = r.h3_index
        """
        self.con.execute(query)

        count = self.con.execute(f"SELECT COUNT(*) FROM {projected_table}").fetchone()[
            0
        ]
        original_count = self.con.execute(
            f"SELECT COUNT(*) FROM {result_table}"
        ).fetchone()[0]
        logger.info(
            "Projected result to reference area: %d H3 cells (original result had %d)",
            count,
            original_count,
        )
        return projected_table

    def _export_h3_results(
        self: Self,
        results_table: str,
        output_path: str,
        h3_column: str = "h3_index",
    ) -> Path:
        """Export results with optimized Parquet V2 format and bbox for row group pruning."""
        output_path_obj = Path(output_path)
        output_path_obj.parent.mkdir(parents=True, exist_ok=True)

        if output_path_obj.suffix.lower() != ".parquet":
            output_path_obj = output_path_obj.with_suffix(".parquet")

        # Build query that generates H3 polygon geometry
        # Use native GEOMETRY type (not WKB) for proper GeoParquet output
        query = f"""
            SELECT
                {h3_column}::BIGINT AS {h3_column},
                * EXCLUDE ({h3_column}),
                ST_GeomFromText(h3_cell_to_boundary_wkt({h3_column})) AS geometry
            FROM {results_table}
        """

        # Use optimized parquet writer with V2 format, bbox, and Hilbert sort
        write_optimized_parquet(
            self.con,
            query,
            output_path_obj,
            geometry_column="geometry",
        )

        logger.info("Results written to: %s", output_path)
        return output_path_obj


# =============================================================================
# Public Transport Tool Base
# =============================================================================


class PTToolBase(AnalysisTool):
    """Base class for Public Transport analysis tools.

    Provides shared functionality for GTFS data import and station
    service counting used by Trip Count Station and ÖV-Güteklassen tools.

    Subclasses should call these methods in their _run_implementation()
    and then add their specific processing logic.
    """

    def __init__(self: Self) -> None:
        super().__init__()
        self._setup_pt_extensions()

    def _setup_pt_extensions(self: Self) -> None:
        """Install required extensions for PT analysis."""
        self.con.execute("INSTALL h3 FROM community; LOAD h3;")
        logger.debug("H3 extension loaded for PT tool.")

    def _import_gtfs_stops(self: Self, stops_path: str) -> None:
        """Import GTFS stops parquet.

        Creates a view 'gtfs_stops' with standardized columns:
        - stop_id, stop_name, stop_lat, stop_lon, location_type,
          parent_station, h3_3, geom

        Args:
            stops_path: Path to GTFS stops parquet file.
        """
        self.con.execute(f"""
            CREATE OR REPLACE VIEW gtfs_stops AS
            SELECT
                stop_id,
                stop_name,
                stop_lat,
                stop_lon,
                location_type,
                parent_station,
                h3_3,
                ST_Point(stop_lon, stop_lat) AS geom
            FROM read_parquet('{stops_path}')
            WHERE location_type IS NULL OR location_type = '0' OR location_type = ''
        """)

    def _import_gtfs_stop_times(self: Self, stop_times_path: str) -> None:
        """Import GTFS stop_times parquet.

        Creates a view 'gtfs_stop_times' with standardized columns:
        - stop_id, route_type, arrival_time, is_weekday, is_saturday,
          is_sunday, h3_3

        Args:
            stop_times_path: Path to GTFS stop_times parquet file.
        """
        self.con.execute(f"""
            CREATE OR REPLACE VIEW gtfs_stop_times AS
            SELECT
                stop_id,
                route_type,
                arrival_time,
                is_weekday,
                is_saturday,
                is_sunday,
                h3_3
            FROM read_parquet('{stop_times_path}')
        """)

    # -- GTFS from an uploaded bundle --------------------------------------
    #
    # The shipped feed arrives pre-digested: `stop_times_optimized` carries the
    # route type, an h3 cell and three booleans for an *average* weekday,
    # Saturday and Sunday. A bundle carries the feed as published, so the same
    # columns are derived here — and for one real date rather than an average,
    # which is what the user picks. Service on a date is what `calendar` says
    # for that weekday within its window, plus or minus what `calendar_dates`
    # says about that date specifically.

    def _import_bundle_gtfs_stops(self: Self, stops_path: str) -> None:
        """`gtfs_stops` from a bundle's stops layer.

        The same view the shipped feed produces, with `h3_3` computed here: the
        published file has no such column, and the join in `_count_pt_services`
        is on it as well as the stop id.
        """
        self.con.execute("INSTALL h3 FROM community; LOAD h3;")
        self.con.execute(f"""
            CREATE OR REPLACE VIEW gtfs_stops AS
            SELECT
                stop_id,
                stop_name,
                CAST(stop_lat AS DOUBLE) AS stop_lat,
                CAST(stop_lon AS DOUBLE) AS stop_lon,
                location_type,
                parent_station,
                h3_latlng_to_cell(CAST(stop_lat AS DOUBLE), CAST(stop_lon AS DOUBLE), 3)
                    AS h3_3,
                ST_Point(CAST(stop_lon AS DOUBLE), CAST(stop_lat AS DOUBLE)) AS geom
            FROM read_parquet('{stops_path}')
            WHERE stop_lat IS NOT NULL
              AND stop_lon IS NOT NULL
              AND (location_type IS NULL OR location_type IN ('0', ''))
        """)

    def _import_bundle_gtfs_stop_times(
        self: Self,
        stop_times_path: str,
        trips_path: str,
        routes_path: str,
        service_date: str,
        calendar_path: str | None = None,
        calendar_dates_path: str | None = None,
    ) -> None:
        """`gtfs_stop_times` for one date, from a bundle's published tables.

        `service_date` is ``YYYY-MM-DD``. The three day booleans survive because
        everything downstream filters on them: exactly one is set, the one the
        date falls on, so a caller that asks for "the Saturday window" of a date
        that is a Saturday gets what it expects and the counting SQL is
        unchanged.

        Either calendar file may be absent — GTFS requires one of them, not both
        — so each contributes only if it is there.
        """
        day = datetime.strptime(service_date, "%Y-%m-%d").date()
        gtfs_date = day.strftime("%Y%m%d")
        weekday_column = _GTFS_WEEKDAY_COLUMNS[day.weekday()]
        is_weekday = day.weekday() < 5
        is_saturday = day.weekday() == 5
        is_sunday = day.weekday() == 6

        # Services running on the date: the regular schedule, minus removals,
        # plus additions. `calendar_dates` is the authority where it speaks.
        regular = (
            f"""
            SELECT service_id FROM read_parquet('{calendar_path}')
            WHERE {weekday_column} IN ('1', 1)
              AND CAST(start_date AS VARCHAR) <= '{gtfs_date}'
              AND CAST(end_date AS VARCHAR) >= '{gtfs_date}'
            """
            if calendar_path
            else "SELECT NULL AS service_id WHERE FALSE"
        )
        added = removed = "SELECT NULL AS service_id WHERE FALSE"
        if calendar_dates_path:
            added = f"""
                SELECT service_id FROM read_parquet('{calendar_dates_path}')
                WHERE CAST(date AS VARCHAR) = '{gtfs_date}'
                  AND CAST(exception_type AS VARCHAR) = '1'
            """
            removed = f"""
                SELECT service_id FROM read_parquet('{calendar_dates_path}')
                WHERE CAST(date AS VARCHAR) = '{gtfs_date}'
                  AND CAST(exception_type AS VARCHAR) = '2'
            """

        self.con.execute(f"""
            CREATE OR REPLACE VIEW gtfs_stop_times AS
            WITH active_services AS (
                (({regular}) EXCEPT ({removed})) UNION ({added})
            )
            SELECT
                st.stop_id,
                r.route_type,
                st.arrival_time,
                {str(is_weekday).lower()} AS is_weekday,
                {str(is_saturday).lower()} AS is_saturday,
                {str(is_sunday).lower()} AS is_sunday,
                s.h3_3
            FROM read_parquet('{stop_times_path}') st
            JOIN read_parquet('{trips_path}') t ON t.trip_id = st.trip_id
            JOIN read_parquet('{routes_path}') r ON r.route_id = t.route_id
            JOIN active_services a ON a.service_id = t.service_id
            JOIN gtfs_stops s ON s.stop_id = st.stop_id
            WHERE st.arrival_time IS NOT NULL
        """)

    def _get_stations_in_area(self: Self, ref_geom_col: str) -> None:
        """Find all stops within the reference area.

        Creates a table 'stations_in_area' with stops intersecting
        the reference area.

        Args:
            ref_geom_col: Name of the geometry column in the reference_area view.

        Requires:
            - 'gtfs_stops' view must exist
            - 'reference_area' view must exist
        """
        self.con.execute(f"""
            CREATE OR REPLACE TABLE stations_in_area AS
            SELECT DISTINCT
                s.stop_id,
                s.stop_name,
                s.parent_station,
                s.h3_3,
                s.geom
            FROM gtfs_stops s, reference_area r
            WHERE ST_Intersects(s.geom, r.{ref_geom_col})
        """)

    def _count_pt_services(self: Self, time_window: PTTimeWindow) -> None:
        """Count public transport services per station in the time window.

        Creates a table 'station_trip_counts' with trip counts per
        station and route_type.

        Args:
            time_window: Time window for counting services.

        Requires:
            - 'stations_in_area' table must exist
            - 'gtfs_stop_times' view must exist
        """
        weekday_col = time_window.weekday_column
        from_time = time_window.from_time_str
        to_time = time_window.to_time_str

        self.con.execute(f"""
            CREATE OR REPLACE TABLE station_trip_counts AS
            SELECT
                s.stop_id,
                s.stop_name,
                s.parent_station,
                s.geom,
                t.route_type,
                COUNT(*) AS trip_count
            FROM stations_in_area s
            JOIN gtfs_stop_times t ON s.stop_id = t.stop_id AND s.h3_3 = t.h3_3
            WHERE t.{weekday_col} = true
              AND t.arrival_time >= '{from_time}'
              AND t.arrival_time <= '{to_time}'
            GROUP BY s.stop_id, s.stop_name, s.parent_station, s.geom, t.route_type
        """)

    def _create_mode_mapping_table(self: Self) -> None:
        """Create a table mapping route_type to transport mode category.

        Creates 'route_type_modes' table with columns:
        - route_type: GTFS route type as string
        - mode: Category (bus, tram, metro, rail, other)
        """
        mode_values = ", ".join(
            f"('{k}', '{v}')" for k, v in TRANSPORT_MODE_MAPPING.items()
        )
        self.con.execute(f"""
            CREATE OR REPLACE TABLE route_type_modes AS
            SELECT * FROM (VALUES {mode_values}) AS t(route_type, mode)
        """)

    def _aggregate_trips_by_mode(self: Self, time_window: PTTimeWindow) -> None:
        """Aggregate trip counts by transport mode per station.

        Creates 'station_mode_counts' table with trip counts per station
        and mode category (bus, tram, metro, rail, other).

        Args:
            time_window: Time window (used for frequency calculation).

        Requires:
            - 'station_trip_counts' table must exist
            - 'route_type_modes' table must exist
        """
        time_window_minutes = time_window.time_window_minutes

        self.con.execute(f"""
            CREATE OR REPLACE TABLE station_mode_counts AS
            SELECT
                stop_id,
                ANY_VALUE(stop_name) AS stop_name,
                ANY_VALUE(parent_station) AS parent_station,
                ANY_VALUE(geom) AS geom,
                COALESCE(SUM(CASE WHEN mode = 'bus' THEN trip_count ELSE 0 END), 0) AS bus,
                COALESCE(SUM(CASE WHEN mode = 'tram' THEN trip_count ELSE 0 END), 0) AS tram,
                COALESCE(SUM(CASE WHEN mode = 'metro' THEN trip_count ELSE 0 END), 0) AS metro,
                COALESCE(SUM(CASE WHEN mode = 'rail' THEN trip_count ELSE 0 END), 0) AS rail,
                COALESCE(SUM(CASE WHEN mode = 'other' THEN trip_count ELSE 0 END), 0) AS other,
                SUM(trip_count) AS total,
                CASE
                    WHEN SUM(trip_count) > 0
                    THEN ROUND({time_window_minutes} / SUM(trip_count), 2)
                    ELSE NULL
                END AS frequency
            FROM station_trip_counts stc
            LEFT JOIN route_type_modes rtm
                ON CAST(stc.route_type AS VARCHAR) = rtm.route_type
            GROUP BY stop_id
        """)
