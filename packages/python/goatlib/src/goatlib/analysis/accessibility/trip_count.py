"""Trip Count Station Tool.

This module calculates the number of public transport departures per station
within a given time window, grouped by transport mode.
"""

import logging
from typing import Any, Self

from goatlib.analysis.accessibility.base import PTToolBase
from goatlib.analysis.schemas.trip_count import TripCountStationParams
from goatlib.io.config import parquet_copy_options

logger = logging.getLogger(__name__)


class TripCountStationTool(PTToolBase):
    """Trip Count Station Tool.

    Calculates the number of public transport departures per station
    within a given time window, including frequency calculation.

    This tool is the foundation for the ÖV-Güteklassen indicator and
    is useful for weak point analyses of local transport plans.

    Output columns:
        - stop_id: Station identifier
        - stop_name: Station name
        - parent_station: Parent station ID (if any)
        - bus: Number of bus departures
        - tram: Number of tram departures
        - metro: Number of metro departures
        - rail: Number of rail departures
        - other: Number of other mode departures
        - total: Total number of departures
        - frequency: Average minutes between departures (time_window / total)
        - geom: Station geometry (Point)

    Example:
        >>> from goatlib.analysis.accessibility import TripCountStationTool
        >>> from goatlib.analysis.schemas.trip_count import TripCountStationParams
        >>> from goatlib.analysis.schemas.base import PTTimeWindow
        >>>
        >>> tool = TripCountStationTool()
        >>> result = tool.run(TripCountStationParams(
        ...     reference_area_path="path/to/area.geojson",
        ...     stops_path="path/to/stops.parquet",
        ...     stop_times_path="path/to/stop_times.parquet",
        ...     time_window=PTTimeWindow(
        ...         weekday="weekday",
        ...         from_time=25200,  # 07:00
        ...         to_time=32400,    # 09:00
        ...     ),
        ...     output_path="path/to/output.parquet",
        ... ))
    """

    def __init__(self: Self) -> None:
        super().__init__()

    def _run_implementation(
        self: Self,
        params: TripCountStationParams,
    ) -> dict[str, Any]:
        """Execute the trip count analysis.

        Args:
            params: Analysis parameters.

        Returns:
            Dictionary with statistics about the analysis:
            - total_stations: Number of stations in the area
            - stations_with_service: Number of stations with PT service
            - total_trips: Total number of trips counted
            - average_frequency_minutes: Average frequency across all stations
        """
        # Step 1: Import reference area
        logger.info("Importing reference area...")
        ref_meta, _ = self.import_input(
            str(params.reference_area_path), "reference_area"
        )
        ref_geom = ref_meta.geometry_column

        # Step 2: Import GTFS data (shared from PTToolBase). A bundle brings the
        # feed as published, so its tables are joined for the chosen date; the
        # shipped feed arrives pre-digested and is read as it is.
        if params.bundle_stops_path and params.service_date:
            logger.info("Importing GTFS stops from bundle...")
            self._import_bundle_gtfs_stops(str(params.bundle_stops_path))

            logger.info(
                "Importing GTFS stop_times from bundle for %s...", params.service_date
            )
            self._import_bundle_gtfs_stop_times(
                str(params.bundle_stop_times_path),
                str(params.bundle_trips_path),
                str(params.bundle_routes_path),
                params.service_date,
                str(params.bundle_calendar_path)
                if params.bundle_calendar_path
                else None,
                str(params.bundle_calendar_dates_path)
                if params.bundle_calendar_dates_path
                else None,
            )
        else:
            logger.info("Importing GTFS stops...")
            self._import_gtfs_stops(str(params.stops_path))

            logger.info("Importing GTFS stop_times...")
            self._import_gtfs_stop_times(str(params.stop_times_path))

        # Step 3: Get stations within reference area (shared from PTToolBase)
        logger.info("Finding stations within reference area...")
        self._get_stations_in_area(ref_geom)

        # Step 4: Count PT services per station (shared from PTToolBase)
        logger.info("Counting public transport services...")
        self._count_pt_services(params.time_window)

        # Step 5: Create mode mapping and aggregate by mode (shared from PTToolBase)
        logger.info("Aggregating trips by transport mode...")
        self._create_mode_mapping_table()
        self._aggregate_trips_by_mode(params.time_window)

        # Step 6: Export results
        logger.info("Exporting results...")
        stats = self._export_results(str(params.output_path))

        logger.info("Trip count analysis completed successfully.")
        return stats

    def _export_results(self: Self, output_path: str) -> dict[str, Any]:
        """Export results and return statistics.

        Args:
            output_path: Path for the output parquet file.

        Returns:
            Dictionary with analysis statistics.
        """
        self.con.execute(f"""
            COPY (
                SELECT
                    stop_id,
                    stop_name,
                    parent_station,
                    CAST(bus AS INTEGER) AS bus,
                    CAST(tram AS INTEGER) AS tram,
                    CAST(metro AS INTEGER) AS metro,
                    CAST(rail AS INTEGER) AS rail,
                    CAST(other AS INTEGER) AS other,
                    CAST(total AS INTEGER) AS total,
                    frequency,
                    geom
                FROM station_mode_counts
                WHERE total > 0
                ORDER BY total DESC
            ) TO '{output_path}' {parquet_copy_options('COMPRESSION ZSTD')}
        """)

        # Collect statistics
        total_stations = self.con.execute(
            "SELECT COUNT(*) FROM stations_in_area"
        ).fetchone()[0]

        stats_result = self.con.execute("""
            SELECT
                COUNT(*) AS stations_with_service,
                COALESCE(SUM(total), 0) AS total_trips,
                AVG(frequency) AS avg_frequency
            FROM station_mode_counts
            WHERE total > 0
        """).fetchone()

        return {
            "total_stations": total_stations,
            "stations_with_service": stats_result[0],
            "total_trips": int(stats_result[1]),
            "average_frequency_minutes": (
                round(stats_result[2], 2) if stats_result[2] else None
            ),
        }
