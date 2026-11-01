"""ÖV-Güteklassen (Public Transport Quality Classes) Tool.

This module implements the Swiss ARE methodology for calculating
public transport quality classes based on station accessibility
and service frequency.

Reference:
    Bundesamt für Raumentwicklung ARE, 2022.
    ÖV-Güteklassen Berechnungsmethodik ARE (Grundlagenbericht).
"""

import logging
import tempfile
from pathlib import Path
from typing import Any, Self

from goatlib.analysis.accessibility.base import PTToolBase
from goatlib.analysis.schemas.oev_gueteklasse import (
    STATION_CONFIG_DEFAULT,
    CatchmentType,
    OevGueteklasseParams,
    OevGueteklasseStationConfig,
    PTTimeWindow,
)
from goatlib.io.parquet import write_optimized_parquet

logger = logging.getLogger(__name__)


class OevGueteklasseTool(PTToolBase):
    """Public Transport Quality Classes (ÖV-Güteklassen) Tool.

    This tool calculates public transport quality classes based on the
    Swiss ARE methodology. It evaluates the attractiveness of public
    transport services by analyzing station accessibility and service
    frequency.

    Quality classes range from A (very good) to F (very poor).

    Example:
        >>> tool = OevGueteklasseTool()
        >>> result = tool.run(OevGueteklasseParams(
        ...     reference_area_path="path/to/area.geojson",
        ...     stops_path="path/to/stops.parquet",
        ...     stop_times_path="path/to/stop_times.parquet",
        ...     time_window=PTTimeWindow(weekday="weekday", from_time=25200, to_time=32400),
        ...     output_path="path/to/output.parquet",
        ... ))
    """

    # Note: __init__ and H3 extension setup are inherited from PTToolBase

    def _run_implementation(
        self: Self,
        params: OevGueteklasseParams,
    ) -> dict[str, Any]:
        """Execute the ÖV-Güteklassen analysis.

        Args:
            params: Analysis parameters.

        Returns:
            Dictionary with statistics about the analysis:
            - total_stations: Number of stations analyzed
            - stations_with_service: Number of stations with PT service
            - quality_class_counts: Count of polygons per quality class
        """
        config = params.station_config or STATION_CONFIG_DEFAULT

        # Step 1: Import reference area
        logger.info("Importing reference area...")
        ref_meta, ref_view = self.import_input(
            str(params.reference_area_path), "reference_area"
        )
        ref_geom = ref_meta.geometry_column

        # Step 2: Import GTFS data. A bundle brings the feed as published, so
        # its tables are joined for the chosen date; the shipped feed arrives
        # pre-digested and is read as it is.
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

        # Results are keyed by parent station, which gtfs_stops leaves out, so
        # their names and coordinates are read from the stops file on their own.
        stops_path = (
            params.bundle_stops_path
            if params.bundle_stops_path and params.service_date
            else params.stops_path
        )
        self.con.execute(f"""
            CREATE OR REPLACE VIEW gtfs_stations AS
            SELECT
                stop_id,
                stop_name,
                ST_Point(CAST(stop_lon AS DOUBLE), CAST(stop_lat AS DOUBLE)) AS geom
            FROM read_parquet('{stops_path}')
            WHERE location_type = '1'
        """)

        # Step 3: Get stations within reference area
        logger.info("Finding stations within reference area...")
        self._get_stations_in_area(ref_geom)

        # Step 4: Count PT services per station
        logger.info("Counting public transport services...")
        self._count_pt_services(params.time_window)

        # Step 5: Calculate station categories
        logger.info("Calculating station categories...")
        self._calculate_station_categories(config, params.time_window)

        # Step 6: Create catchments, as circles or along the street network
        if params.catchment_type == CatchmentType.network:
            logger.info("Creating street network catchments...")
            self._create_network_catchments(config, params)
        else:
            logger.info("Creating buffer catchments...")
            self._create_buffer_catchments(config)

        # Step 7: Union and difference buffers
        logger.info("Processing buffer overlaps...")
        self._process_buffer_overlaps()

        # Step 8: Export results
        logger.info("Exporting results...")
        stats = self._export_results(
            str(params.output_path), params.stations_output_path
        )

        logger.info("ÖV-Güteklassen analysis completed successfully.")
        return stats

    # Note: _import_gtfs_stops, _import_gtfs_stop_times, _get_stations_in_area,
    # and _count_pt_services are inherited from PTToolBase

    def _calculate_station_categories(
        self: Self,
        config: OevGueteklasseStationConfig,
        time_window: PTTimeWindow,
    ) -> None:
        """Calculate station category based on service frequency and transport type.

        This implements the oev_gueteklasse_station_category logic from core.
        """
        time_window_minutes = time_window.time_window_minutes

        # Create groups mapping table
        groups_values = ", ".join(f"('{k}', '{v}')" for k, v in config.groups.items())
        self.con.execute(f"""
            CREATE OR REPLACE TABLE route_type_groups AS
            SELECT * FROM (VALUES {groups_values}) AS t(route_type, transport_group)
        """)

        # Aggregate trip counts by stop, considering parent stations
        # For parent stations, we aggregate all child stop counts
        # The parent station's own coordinate is its geometry; the centroid of
        # its child stops stands in when the feed lacks the station row
        # Track child_cnt (number of distinct child stops with service) to know
        # if we should divide trips by 2 later (per Swiss ARE methodology)
        self.con.execute("""
            CREATE OR REPLACE TABLE aggregated_trip_counts AS
            WITH parent_child_counts AS (
                -- Count distinct child stops per parent station
                -- Also get centroid geometry
                SELECT
                    parent_station,
                    -- Fallback name for a station missing from the feed.
                    MIN(stop_name) AS stop_name,
                    ST_Centroid(ST_Collect(LIST(DISTINCT geom))) AS geom,
                    COUNT(DISTINCT stop_id) AS child_cnt
                FROM station_trip_counts
                WHERE parent_station IS NOT NULL AND parent_station != ''
                GROUP BY parent_station
            ),
            child_counts AS (
                -- Stops with parent stations: group by parent
                -- Include actual child_cnt from parent_child_counts
                SELECT
                    s.parent_station AS stop_id,
                    s.route_type,
                    SUM(s.trip_count) AS trip_count,
                    p.child_cnt
                FROM station_trip_counts s
                JOIN parent_child_counts p ON s.parent_station = p.parent_station
                WHERE s.parent_station IS NOT NULL AND s.parent_station != ''
                GROUP BY s.parent_station, s.route_type, p.child_cnt

                UNION ALL

                -- Stops without parent stations: use their own counts
                SELECT
                    stop_id,
                    route_type,
                    trip_count,
                    1 AS child_cnt  -- Single stop -> child_cnt = 1
                FROM station_trip_counts
                WHERE parent_station IS NULL OR parent_station = ''
            )
            SELECT
                c.stop_id,
                COALESCE(
                    orig.stop_name, sn.stop_name, pcc.stop_name, c.stop_id
                ) AS stop_name,
                COALESCE(orig.geom, sn.geom, pcc.geom) AS geom,
                c.route_type,
                c.trip_count,
                c.child_cnt
            FROM child_counts c
            LEFT JOIN station_trip_counts orig ON c.stop_id = orig.stop_id
            LEFT JOIN parent_child_counts pcc ON c.stop_id = pcc.parent_station
            LEFT JOIN gtfs_stations sn ON c.stop_id = sn.stop_id
        """)

        # Calculate station category
        # 1. Get the highest priority transport group (A > B > C, so MIN alphabetically)
        # 2. Calculate average frequency based on child_cnt:
        #    - If child_cnt > 1 (parent station): time_window / (total_trips / 2)
        #    - If child_cnt == 1 (single stop): time_window / total_trips
        # 3. Find the time_frequency interval
        # 4. Look up the station category from config.categories
        self.con.execute("""
            CREATE OR REPLACE TABLE station_services AS
            SELECT
                a.stop_id,
                a.stop_name,
                ANY_VALUE(a.geom) AS geom,
                MIN(g.transport_group) AS transport_group,
                SUM(a.trip_count) AS total_trips,
                ANY_VALUE(a.child_cnt) AS child_cnt
            FROM aggregated_trip_counts a
            JOIN route_type_groups g ON CAST(a.route_type AS VARCHAR) = g.route_type
            GROUP BY a.stop_id, a.stop_name
        """)

        # Calculate frequency (minutes between services)
        # Formula depends on whether this is a parent station (multiple child stops)
        # or a single stop:
        # - Parent station (child_cnt > 1): time_window / (total_trips / 2)
        # - Single stop (child_cnt = 1): time_window / total_trips
        self.con.execute(f"""
            CREATE OR REPLACE TABLE station_frequencies AS
            SELECT
                stop_id,
                stop_name,
                geom,
                transport_group,
                total_trips,
                child_cnt,
                CASE
                    WHEN total_trips > 0
                    THEN {time_window_minutes} / (total_trips / (CASE WHEN child_cnt > 1 THEN 2.0 ELSE 1.0 END))
                    ELSE 9999
                END AS frequency_minutes
            FROM station_services
        """)

        # Create time frequency thresholds table
        freq_values = ", ".join(
            f"({i + 1}, {f})" for i, f in enumerate(config.time_frequency)
        )
        self.con.execute(f"""
            CREATE OR REPLACE TABLE time_frequency_thresholds AS
            SELECT * FROM (VALUES {freq_values}) AS t(time_interval, threshold_minutes)
        """)

        # Determine time interval for each station
        self.con.execute("""
            CREATE OR REPLACE TABLE station_time_intervals AS
            SELECT
                f.stop_id,
                f.stop_name,
                f.geom,
                f.transport_group,
                f.total_trips,
                f.frequency_minutes,
                COALESCE(
                    (
                        SELECT MIN(t.time_interval)
                        FROM time_frequency_thresholds t
                        WHERE f.frequency_minutes <= t.threshold_minutes
                    ),
                    999
                ) AS time_interval
            FROM station_frequencies f
        """)

        # Create categories lookup table
        cat_values = []
        for idx, cat_dict in enumerate(config.categories):
            for group, station_cat in cat_dict.items():
                cat_values.append(f"({idx + 1}, '{group}', {station_cat})")
        cat_values_str = ", ".join(cat_values)
        self.con.execute(f"""
            CREATE OR REPLACE TABLE category_lookup AS
            SELECT * FROM (VALUES {cat_values_str}) AS t(time_interval, transport_group, station_category)
        """)

        # Final station categories
        # Calculate h3_3 from geometry for batch processing (parent stations don't have h3_3)
        self.con.execute("""
            CREATE OR REPLACE TABLE station_categories AS
            SELECT
                s.stop_id,
                s.stop_name,
                s.geom,
                s.transport_group,
                s.total_trips,
                s.frequency_minutes,
                s.time_interval,
                COALESCE(c.station_category, 999) AS station_category,
                h3_cell_to_parent(h3_latlng_to_cell(ST_Y(s.geom), ST_X(s.geom), 10), 3)::BIGINT AS h3_3
            FROM station_time_intervals s
            LEFT JOIN category_lookup c
                ON s.time_interval = c.time_interval
                AND s.transport_group = c.transport_group
        """)

    def _create_classification_lookup(
        self: Self,
        config: OevGueteklasseStationConfig,
    ) -> None:
        """Table of (station category, distance) -> quality class."""
        class_values = []
        for station_cat, distances in config.classification.items():
            for distance, pt_class in distances.items():
                class_values.append(f"({station_cat}, {distance}, {pt_class})")
        class_values_str = ", ".join(class_values)
        self.con.execute(f"""
            CREATE OR REPLACE TABLE classification_lookup AS
            SELECT * FROM (VALUES {class_values_str}) AS t(station_category, distance_m, pt_class)
        """)

    def _create_network_catchments(
        self: Self,
        config: OevGueteklasseStationConfig,
        params: OevGueteklasseParams,
    ) -> None:
        """Create catchments by walking the class distances along the street network.

        One routing run covers every station: each class distance is a cutoff,
        and the separated shape style keeps one polygon per station and cutoff,
        so a station's category picks its classes from its own polygons. The
        result fills ``station_buffers`` exactly like the circles do, so the
        overlap processing is shared.
        """
        # Imported here so the buffer method never needs the routing package.
        from goatlib.analysis.accessibility.catchment_area_v2 import (
            CatchmentAreaToolV2,
        )
        from goatlib.analysis.schemas.catchment_area_v2 import (
            CatchmentAreaV2Params,
        )

        self._create_classification_lookup(config)
        self.con.execute("""
            CREATE OR REPLACE TABLE station_buffers (
                stop_id VARCHAR,
                station_category INTEGER,
                distance_m INTEGER,
                pt_class INTEGER,
                h3_3 BIGINT,
                geom GEOMETRY
            )
        """)

        # The routing run tags each polygon with the index of its starting
        # point, so the stations are numbered in the order they are passed.
        self.con.execute("""
            CREATE OR REPLACE TABLE network_origins AS
            SELECT
                (ROW_NUMBER() OVER (ORDER BY stop_id) - 1)::INTEGER AS origin_idx,
                stop_id,
                station_category,
                h3_3,
                ST_X(geom) AS lon,
                ST_Y(geom) AS lat
            FROM station_categories
            WHERE station_category < 999
        """)
        origins = self.con.execute(
            "SELECT lat, lon FROM network_origins ORDER BY origin_idx"
        ).fetchall()
        if not origins:
            logger.info("No classified stations, no network catchments to create.")
            return

        cutoffs = sorted(
            {d for distances in config.classification.values() for d in distances}
        )
        with tempfile.TemporaryDirectory(prefix="oev_network_") as tmp:
            catchment_path = Path(tmp) / "catchments.parquet"
            CatchmentAreaToolV2().run(
                CatchmentAreaV2Params(
                    latitude=[lat for lat, _ in origins],
                    longitude=[lon for _, lon in origins],
                    routing_mode="walking",
                    cost_type="distance",
                    max_cost=cutoffs[-1],
                    cutoffs=cutoffs,
                    shape_style="separated",
                    polygon_difference=False,
                    output_format="parquet",
                    output_path=str(catchment_path),
                    edge_path=params.edge_path,
                    node_path=params.node_path,
                )
            )
            # A station whose category has no class at a distance gets no
            # polygon there, as with the circles.
            self.con.execute(f"""
                INSERT INTO station_buffers
                SELECT
                    o.stop_id,
                    o.station_category,
                    c.distance_m,
                    c.pt_class,
                    o.h3_3,
                    r.geometry AS geom
                FROM read_parquet('{catchment_path}') r
                JOIN network_origins o ON o.origin_idx = r.origin_idx
                JOIN classification_lookup c
                    ON c.station_category = o.station_category
                    AND c.distance_m = r.cost_step
            """)
        self.con.execute("DROP TABLE IF EXISTS network_origins")

    def _create_buffer_catchments(
        self: Self,
        config: OevGueteklasseStationConfig,
    ) -> None:
        """Create buffer catchments around stations based on their category.

        Uses geodesic buffer calculation for accurate distances worldwide.
        The geodesic buffer is approximated by calculating N points at exact
        geodesic distance from the center using spherical forward formula.

        For large datasets, processes in batches by h3_3 partition to avoid OOM.
        """
        self._create_classification_lookup(config)

        # Get count of station-distance combinations and h3_3 partitions
        count_result = self.con.execute("""
            SELECT COUNT(*) FROM station_categories s
            JOIN classification_lookup c ON s.station_category = c.station_category
            WHERE s.station_category < 999
        """).fetchone()
        total_buffers = count_result[0] if count_result else 0

        # Get distinct h3_3 partitions for batch processing
        h3_partitions = self.con.execute("""
            SELECT DISTINCT h3_3 FROM station_categories WHERE station_category < 999 ORDER BY h3_3
        """).fetchall()

        num_points = 32  # Number of points to approximate circle

        # For small datasets, process all at once; for large, batch by h3_3
        if total_buffers < 50000:
            logger.debug(f"Creating {total_buffers} geodesic buffers (single batch)...")
            self._create_geodesic_buffers_batch(num_points, h3_filter=None)
        else:
            logger.info(
                f"Creating {total_buffers} geodesic buffers in {len(h3_partitions)} batches..."
            )
            # Create empty table first
            self.con.execute("""
                CREATE OR REPLACE TABLE station_buffers (
                    stop_id VARCHAR,
                    station_category INTEGER,
                    distance_m INTEGER,
                    pt_class INTEGER,
                    h3_3 BIGINT,
                    geom GEOMETRY
                )
            """)

            for idx, (h3_3,) in enumerate(h3_partitions):
                if (idx + 1) % 10 == 0 or idx == 0:
                    logger.debug(
                        f"Processing batch {idx + 1}/{len(h3_partitions)} (h3_3={h3_3})..."
                    )
                self._create_geodesic_buffers_batch(
                    num_points, h3_filter=h3_3, append=True
                )

    def _create_geodesic_buffers_batch(
        self: Self,
        num_points: int,
        h3_filter: int | None = None,
        append: bool = False,
    ) -> None:
        """Create geodesic buffers for a batch of stations.

        Args:
            num_points: Number of points to approximate the circle
            h3_filter: If set, only process stations in this h3_3 partition
            append: If True, insert into existing table; else create new table
        """
        h3_where = f"AND s.h3_3 = {h3_filter}" if h3_filter is not None else ""

        create_stmt = (
            "INSERT INTO station_buffers"
            if append
            else "CREATE OR REPLACE TABLE station_buffers AS"
        )

        # Create geodesic buffers using spherical forward formula
        # lat2 = asin(sin(lat1)*cos(d/R) + cos(lat1)*sin(d/R)*cos(bearing))
        # lon2 = lon1 + atan2(sin(bearing)*sin(d/R)*cos(lat1), cos(d/R)-sin(lat1)*sin(lat2))
        # R = 6371000 (Earth radius in meters)
        self.con.execute(f"""
            {create_stmt}
            WITH station_distances AS (
                SELECT
                    s.stop_id,
                    s.station_category,
                    s.h3_3,
                    c.distance_m,
                    CAST(c.pt_class AS INTEGER) AS pt_class,
                    ST_X(s.geom) AS lon,
                    ST_Y(s.geom) AS lat
                FROM station_categories s
                JOIN classification_lookup c ON s.station_category = c.station_category
                WHERE s.station_category < 999 {h3_where}
            ),
            bearings AS (
                SELECT unnest(generate_series(0, {num_points})) AS i
            ),
            buffer_points AS (
                SELECT
                    sd.stop_id,
                    sd.station_category,
                    sd.h3_3,
                    sd.distance_m,
                    sd.pt_class,
                    sd.lon,
                    sd.lat,
                    b.i,
                    ((b.i % {num_points}) * 2.0 * PI() / {num_points}) AS bearing,
                    RADIANS(sd.lat) AS lat1_rad,
                    RADIANS(sd.lon) AS lon1_rad,
                    (sd.distance_m / 6371000.0) AS angular_dist
                FROM station_distances sd
                CROSS JOIN bearings b
            ),
            dest_points AS (
                SELECT
                    stop_id,
                    station_category,
                    h3_3,
                    distance_m,
                    pt_class,
                    i,
                    ASIN(
                        SIN(lat1_rad) * COS(angular_dist) +
                        COS(lat1_rad) * SIN(angular_dist) * COS(bearing)
                    ) AS lat2_rad,
                    lat1_rad,
                    lon1_rad,
                    bearing,
                    angular_dist
                FROM buffer_points
            ),
            final_points AS (
                SELECT
                    stop_id,
                    station_category,
                    h3_3,
                    distance_m,
                    pt_class,
                    i,
                    DEGREES(lat2_rad) AS lat2,
                    DEGREES(
                        lon1_rad + ATAN2(
                            SIN(bearing) * SIN(angular_dist) * COS(lat1_rad),
                            COS(angular_dist) - SIN(lat1_rad) * SIN(lat2_rad)
                        )
                    ) AS lon2
                FROM dest_points
            )
            SELECT
                stop_id,
                station_category,
                distance_m,
                pt_class,
                ANY_VALUE(h3_3) AS h3_3,
                ST_MakePolygon(
                    ST_MakeLine(
                        LIST(ST_Point(lon2, lat2) ORDER BY i)
                    )
                ) AS geom
            FROM final_points
            GROUP BY stop_id, station_category, distance_m, pt_class
        """)

    def _process_buffer_overlaps(self: Self) -> None:
        """Process buffer overlaps: subtract higher quality class areas from lower ones.

        Higher quality classes (lower numbers) take precedence over lower ones.

        Strategy: Two-phase approach for efficiency:
        1. First, union all buffers per (pt_class, h3_3) - this unions only touching/nearby
           buffers within each h3 cell, avoiding creating one giant geometry per class
        2. Then, for each class, subtract the union of all better (lower numbered) classes

        The h3_3 partitioning ensures we union only locally touching buffers, while
        the class-level differencing (7 classes max) is efficient.
        """
        logger.info("Processing buffer overlaps (class-level differencing)...")

        # Phase 1: Union buffers per (pt_class, h3_3) partition
        # This unions only touching/nearby buffers within each h3 cell
        logger.info("Phase 1: Unioning buffers per quality class and h3 partition...")
        self.con.execute("""
            CREATE OR REPLACE TABLE buffers_per_h3 AS
            SELECT
                pt_class,
                h3_3,
                ST_Union_Agg(geom) AS geom
            FROM station_buffers
            GROUP BY pt_class, h3_3
        """)

        # Phase 2: Union h3 partitions per class
        # This creates one (potentially multi-part) geometry per class
        logger.info("Phase 2: Aggregating h3 partitions per class...")
        self.con.execute("""
            CREATE OR REPLACE TABLE buffers_per_class AS
            SELECT
                pt_class,
                ST_Union_Agg(geom) AS geom
            FROM buffers_per_h3
            GROUP BY pt_class
        """)

        # Phase 3: For each class, subtract all better classes
        # We iterate through classes worst to best, building up the "better coverage"
        logger.info("Phase 3: Subtracting better quality class areas...")

        # Get all classes ordered from best (1=A) to worst (7=G)
        classes = [
            row[0]
            for row in self.con.execute(
                "SELECT DISTINCT pt_class FROM buffers_per_class ORDER BY pt_class"
            ).fetchall()
        ]

        # Create results table
        self.con.execute("""
            CREATE OR REPLACE TABLE oev_gueteklassen_final (
                pt_class INTEGER,
                pt_class_label VARCHAR,
                geom GEOMETRY
            )
        """)

        # Process each class
        # Best class (lowest number) keeps its full geometry
        # Each subsequent class subtracts all better classes
        better_union = None
        for pt_class in classes:
            label = chr(pt_class + 96).upper()  # 1->A, 2->B, etc.

            if better_union is None:
                # Best class - no subtraction needed
                self.con.execute(f"""
                    INSERT INTO oev_gueteklassen_final
                    SELECT
                        pt_class,
                        '{label}' AS pt_class_label,
                        ST_Multi(geom) AS geom
                    FROM buffers_per_class
                    WHERE pt_class = {pt_class}
                """)
                # Start accumulating better coverage
                self.con.execute(f"""
                    CREATE OR REPLACE TABLE better_coverage AS
                    SELECT geom FROM buffers_per_class WHERE pt_class = {pt_class}
                """)
                better_union = True
            else:
                # Subtract all better classes from this class
                self.con.execute(f"""
                    INSERT INTO oev_gueteklassen_final
                    SELECT
                        c.pt_class,
                        '{label}' AS pt_class_label,
                        ST_Multi(ST_Difference(c.geom, b.geom)) AS geom
                    FROM buffers_per_class c
                    CROSS JOIN better_coverage b
                    WHERE c.pt_class = {pt_class}
                      AND ST_Intersects(c.geom, b.geom)

                    UNION ALL

                    SELECT
                        c.pt_class,
                        '{label}' AS pt_class_label,
                        ST_Multi(c.geom) AS geom
                    FROM buffers_per_class c
                    CROSS JOIN better_coverage b
                    WHERE c.pt_class = {pt_class}
                      AND NOT ST_Intersects(c.geom, b.geom)
                """)

                # Update better coverage to include this class
                self.con.execute(f"""
                    CREATE OR REPLACE TABLE better_coverage AS
                    SELECT ST_Union_Agg(geom) AS geom
                    FROM (
                        SELECT geom FROM better_coverage
                        UNION ALL
                        SELECT geom FROM buffers_per_class WHERE pt_class = {pt_class}
                    )
                """)

        # Clean up temporary tables
        self.con.execute("DROP TABLE IF EXISTS buffers_per_h3")
        self.con.execute("DROP TABLE IF EXISTS buffers_per_class")
        self.con.execute("DROP TABLE IF EXISTS better_coverage")

    def _export_results(
        self: Self,
        output_path: str,
        stations_output_path: str | Path | None,
    ) -> dict[str, Any]:
        """Export results and return statistics."""
        # Export quality classes - explode multipolygons into individual polygons
        output_query = """
            SELECT
                pt_class,
                pt_class_label,
                geom AS geometry
            FROM (
                SELECT
                    pt_class,
                    pt_class_label,
                    UNNEST(ST_Dump(geom)).geom AS geom
                FROM oev_gueteklassen_final
            )
            WHERE ST_Area(geom) > 0.0000001
        """
        write_optimized_parquet(
            self.con,
            output_query,
            output_path,
            geometry_column="geometry",
        )

        # Export stations if path provided
        if stations_output_path:
            stations_query = """
                SELECT
                    stop_id,
                    stop_name,
                    transport_group,
                    CAST(total_trips AS INTEGER) AS total_trips,
                    ROUND(frequency_minutes, 2) AS frequency_minutes,
                    station_category,
                    geom AS geometry
                FROM station_categories
                ORDER BY station_category, stop_name
            """
            write_optimized_parquet(
                self.con,
                stations_query,
                stations_output_path,
                geometry_column="geometry",
            )

        # Collect statistics
        total_stations = self.con.execute(
            "SELECT COUNT(*) FROM stations_in_area"
        ).fetchone()[0]

        stations_with_service = self.con.execute(
            "SELECT COUNT(*) FROM station_categories WHERE station_category < 999"
        ).fetchone()[0]

        quality_class_counts = dict(
            self.con.execute("""
                SELECT pt_class_label, COUNT(*) AS cnt
                FROM oev_gueteklassen_final
                GROUP BY pt_class_label
                ORDER BY pt_class_label
            """).fetchall()
        )

        return {
            "total_stations": total_stations,
            "stations_with_service": stations_with_service,
            "quality_class_counts": quality_class_counts,
        }
