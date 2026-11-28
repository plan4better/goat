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


#: How near a call's stop before is to another's stop after for the two to
#: run opposite ways through a stop, in metres: a stop across the street, not
#: the next one along.
OPPOSITE_STOP_M = 150

#: Two calls of a line head against each other when the cosine between their
#: headings (stop before to stop after) is below this: more than 120 degrees
#: apart, so a fork or a turn at the stop stays one way.
OPPOSITE_HEADING_COS = -0.5

#: How evenly two lines run for one to be the other's way back: the rarer
#: has at least this share of the other's calls. A ring's two ways under two
#: numbers run alike; a school trip against a one-way line is not its way back.
MIRRORED_LINE_SHARE = 0.5


def _metres(ax: str, ay: str, bx: str, by: str) -> str:
    """SQL for the distance in metres between two lon/lat points."""
    return (
        f"sqrt(power(({ax} - {bx}) * cos(radians({ay})) * 111320, 2)"
        f" + power(({ay} - {by}) * 111320, 2))"
    )


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
        ...     trips_path="path/to/trips.parquet",
        ...     routes_path="path/to/routes.parquet",
        ...     calendar_dates_path="path/to/calendar_dates.parquet",
        ...     service_date="2026-11-24",
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

        # Step 2: Import the feed's GTFS tables for the date.
        logger.info("Importing GTFS stops...")
        self._import_gtfs_stops(str(params.stops_path))
        logger.info("Importing GTFS stop_times for %s...", params.service_date)
        self._import_gtfs_stop_times(
            str(params.stop_times_path),
            str(params.trips_path),
            str(params.routes_path),
            params.service_date,
            str(params.calendar_path) if params.calendar_path else None,
            str(params.calendar_dates_path) if params.calendar_dates_path else None,
        )

        # Results are keyed by parent station, which gtfs_stops leaves out, so
        # their names and coordinates are read from the stops file on their own.
        self.con.execute(f"""
            CREATE OR REPLACE VIEW gtfs_stations AS
            SELECT
                stop_id,
                stop_name,
                ST_Point(CAST(stop_lon AS DOUBLE), CAST(stop_lat AS DOUBLE)) AS geom
            FROM read_parquet('{params.stops_path}')
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

        # A line's calls at a stop, and whether it serves the stop one way or
        # both. Directions are read from the core of GTFS alone (direction_id
        # is optional, and feeds use it unevenly): from the stops just before
        # and just after each call on its trip (call_order: the stop sequence;
        # calls sharing one are put in order by distance). Two calls
        # of a line at a stop, or at a station's stops, go opposite ways
        # where one ends there and another starts there (service arriving and
        # service leaving), or where one's stop before is another's stop
        # after, or within OPPOSITE_STOP_M of it (a stop across the street),
        # or where the two head against each other (OPPOSITE_HEADING_COS:
        # the stops of the other way lie on another street, at a bus station
        # or in a one-way system). Two lines of a kind that each run one way
        # there, about as often (MIRRORED_LINE_SHARE), and mirror each other,
        # the stop before one being the stop after the other on both sides,
        # are one line both ways: a ring's two ways under two numbers, or a
        # feed with a route per direction.
        # A line's service at a stop is its calls (arriving, departing or
        # passing) over its directions there: every stop of a line running
        # every 10 minutes each way reads 10 minutes, its termini on one
        # platform or several too, a turning loop's, and a one-way loop's
        # stops; short turns keep their way.
        # Worked on numbered ids, and each step on the rows it needs: a
        # country's weekday is 20 million calls, and following every one
        # along its trip with its ids as text took 6 GB. The ids are numbered,
        # not hashed: hash() gives some pairs of ids the same value.
        weekday_col = time_window.weekday_column
        from_time = time_window.from_time_str
        to_time = time_window.to_time_str
        in_window = (
            f"t.{weekday_col} = true AND t.arrival_time >= '{from_time}' "
            f"AND t.arrival_time <= '{to_time}'"
        )
        self.con.execute("""
            CREATE OR REPLACE TABLE stop_places AS
            SELECT stop_id, row_number() OVER (ORDER BY stop_id) AS stop,
                   CAST(stop_lon AS FLOAT) AS x, CAST(stop_lat AS FLOAT) AS y
            FROM gtfs_stops
        """)
        self.con.execute("""
            CREATE OR REPLACE TABLE area_stops AS
            SELECT stop_id, h3_3, stop, group_id,
                   dense_rank() OVER (ORDER BY group_id) AS station
            FROM (
                SELECT s.stop_id, s.h3_3, g.stop,
                       CASE WHEN s.parent_station IS NOT NULL AND s.parent_station != ''
                            THEN s.parent_station ELSE s.stop_id END AS group_id
                FROM stations_in_area s JOIN stop_places g USING (stop_id)
            )
        """)
        # The trips and lines calling in the window at the area's stops
        self.con.execute(f"""
            CREATE OR REPLACE TABLE window_trips AS
            SELECT trip_id, route_id,
                   dense_rank() OVER (ORDER BY trip_id) AS trip,
                   dense_rank() OVER (ORDER BY route_id) AS line
            FROM (
                SELECT DISTINCT t.trip_id, t.route_id
                FROM area_stops s
                JOIN gtfs_stop_times t ON s.stop_id = t.stop_id AND s.h3_3 = t.h3_3
                WHERE {in_window}
            )
        """)
        # Their calls there
        self.con.execute(f"""
            CREATE OR REPLACE TABLE window_calls AS
            SELECT s.station, t.route_type, w.line, w.trip, s.stop, t.call_order AS o
            FROM area_stops s
            JOIN gtfs_stop_times t ON s.stop_id = t.stop_id AND s.h3_3 = t.h3_3
            JOIN window_trips w ON w.trip_id = t.trip_id AND w.route_id = t.route_id
            WHERE {in_window}
        """)
        # And all calls of the trips: the stop order is read from them
        self.con.execute("""
            CREATE OR REPLACE TABLE trip_calls AS
            SELECT w.trip, g.stop, t.call_order AS o
            FROM gtfs_stop_times t
            JOIN (SELECT DISTINCT trip_id, trip FROM window_trips) w USING (trip_id)
            JOIN stop_places g USING (stop_id)
        """)
        # Trips calling at the same stops at the same times from their start
        # pass every stop the same way, so one of them stands for all: a
        # country's 1.2 million weekday trips are 280,000 such patterns.
        # A trip's pattern is a fingerprint of its calls: each call's stop
        # and time from the start as one number, hashed (a number's hash is
        # well mixed, unlike a text's or a pair's), and over the trip the
        # count, the xor and the two halves' sums of those hashes.
        self.con.execute("""
            CREATE OR REPLACE TABLE trip_patterns AS
            SELECT trip, first_o,
                   dense_rank() OVER (ORDER BY calls, mixed, low, high) AS pattern
            FROM (
                SELECT trip, any_value(first_o) AS first_o, count(*) AS calls,
                       bit_xor(h) AS mixed,
                       sum(h & 4294967295) AS low, sum(h >> 32) AS high
                FROM (
                    SELECT c.trip, f.first_o,
                           hash(c.stop * 4294967296 + (c.o - f.first_o)) AS h
                    FROM trip_calls c
                    JOIN (SELECT trip, min(o) AS first_o FROM trip_calls GROUP BY trip) f
                        USING (trip)
                )
                GROUP BY trip
            )
        """)
        self.con.execute("""
            CREATE OR REPLACE TABLE pattern_neighbours AS
            WITH pattern_calls AS (
                SELECT p.pattern, c.stop, c.o - p.first_o AS o, g.x, g.y
                FROM trip_calls c
                JOIN trip_patterns p USING (trip)
                JOIN stop_places g USING (stop)
                WHERE c.trip IN (SELECT min(trip) FROM trip_patterns GROUP BY pattern)
            ),
            -- Stops sharing a call_order go in order of distance from the
            -- trip's stops at the call_order before (the first: back from
            -- those at the call_order after)
            minutes AS (
                SELECT pattern, o,
                       lag(avg(x)) OVER w AS px, lag(avg(y)) OVER w AS py,
                       lead(avg(x)) OVER w AS nx, lead(avg(y)) OVER w AS ny
                FROM pattern_calls
                GROUP BY pattern, o
                WINDOW w AS (PARTITION BY pattern ORDER BY o)
            ),
            ordered AS (
                SELECT pc.pattern, pc.stop, pc.o, pc.x, pc.y,
                       row_number() OVER (
                           PARTITION BY pc.pattern
                           ORDER BY pc.o,
                               CASE WHEN m.px IS NOT NULL
                                    THEN power((pc.x - m.px) * cos(radians(pc.y)), 2)
                                         + power(pc.y - m.py, 2)
                                    ELSE -(power((pc.x - m.nx) * cos(radians(pc.y)), 2)
                                           + power(pc.y - m.ny, 2))
                               END,
                               pc.stop
                       ) AS seq
                FROM pattern_calls pc JOIN minutes m USING (pattern, o)
            )
            SELECT pattern, stop, o, x, y,
                   lag(x) OVER w AS before_x, lag(y) OVER w AS before_y,
                   lead(x) OVER w AS after_x, lead(y) OVER w AS after_y
            FROM ordered
            WINDOW w AS (PARTITION BY pattern ORDER BY seq)
        """)
        self.con.execute("DROP TABLE trip_calls")
        # The ways each line passes each station: its stops before and after
        self.con.execute("""
            CREATE OR REPLACE TABLE line_passes AS
            SELECT DISTINCT c.station, c.route_type, c.line, n.x, n.y,
                   n.before_x, n.before_y, n.after_x, n.after_y
            FROM window_calls c
            JOIN trip_patterns p USING (trip)
            JOIN pattern_neighbours n
              ON n.pattern = p.pattern AND n.stop = c.stop AND n.o = c.o - p.first_o
        """)
        self.con.execute(f"""
            CREATE OR REPLACE TABLE station_line_calls AS
            WITH crossing AS (
                SELECT DISTINCT p.station, p.line
                FROM (SELECT DISTINCT station, line, before_x AS x, before_y AS y
                      FROM line_passes WHERE before_x IS NOT NULL) p
                JOIN (SELECT DISTINCT station, line, after_x AS x, after_y AS y
                      FROM line_passes WHERE after_x IS NOT NULL) q
                    USING (station, line)
                WHERE {_metres("p.x", "p.y", "q.x", "q.y")} <= {OPPOSITE_STOP_M}
            ),
            ending AS (
                SELECT station, line
                FROM line_passes
                GROUP BY station, line
                HAVING bool_or(before_x IS NOT NULL AND after_x IS NULL)
                   AND bool_or(before_x IS NULL AND after_x IS NOT NULL)
            ),
            -- Where a call heads: from the stop before to the stop after, or
            -- into the stop when the trip ends there, out of it when it starts
            headings AS (
                SELECT DISTINCT station, line,
                       (coalesce(after_x, x) - coalesce(before_x, x)) * cos(radians(y)) AS dx,
                       coalesce(after_y, y) - coalesce(before_y, y) AS dy
                FROM line_passes
            ),
            opposed AS (
                SELECT DISTINCT a.station, a.line
                FROM headings a JOIN headings b USING (station, line)
                WHERE a.dx * b.dx + a.dy * b.dy
                      < {OPPOSITE_HEADING_COS} * sqrt(a.dx * a.dx + a.dy * a.dy)
                                               * sqrt(b.dx * b.dx + b.dy * b.dy)
            ),
            line_ways AS (
                SELECT c.station, c.route_type, c.line, c.calls,
                       (x.line IS NOT NULL OR e.line IS NOT NULL
                        OR h.line IS NOT NULL) AS both_ways
                FROM (SELECT station, route_type, line, COUNT(*) AS calls
                      FROM window_calls GROUP BY station, route_type, line) c
                LEFT JOIN crossing x USING (station, line)
                LEFT JOIN ending e USING (station, line)
                LEFT JOIN opposed h USING (station, line)
            ),
            -- Lines running one way through the station, and the pairs of
            -- them that are each other's way back
            one_way AS (
                SELECT DISTINCT b.station, b.route_type, b.line, l.calls,
                       b.before_x, b.before_y, b.after_x, b.after_y
                FROM line_passes b
                JOIN line_ways l USING (station, route_type, line)
                WHERE NOT l.both_ways
                  AND b.before_x IS NOT NULL AND b.after_x IS NOT NULL
            ),
            mirrored AS (
                SELECT DISTINCT p.station, p.route_type, p.line
                FROM one_way p
                JOIN one_way q
                  ON p.station = q.station AND p.route_type = q.route_type
                 AND p.line != q.line
                WHERE least(p.calls, q.calls)
                          >= {MIRRORED_LINE_SHARE} * greatest(p.calls, q.calls)
                  AND {_metres("p.before_x", "p.before_y", "q.after_x", "q.after_y")}
                          <= {OPPOSITE_STOP_M}
                  AND {_metres("p.after_x", "p.after_y", "q.before_x", "q.before_y")}
                          <= {OPPOSITE_STOP_M}
            )
            SELECT g.group_id, l.route_type, r.route_id, l.calls,
                   CASE WHEN l.both_ways OR m.line IS NOT NULL THEN 2 ELSE 1 END
                       AS directions
            FROM line_ways l
            LEFT JOIN mirrored m USING (station, route_type, line)
            JOIN (SELECT DISTINCT station, group_id FROM area_stops) g USING (station)
            JOIN (SELECT DISTINCT line, route_id FROM window_trips) r USING (line)
        """)
        for table in (
            "stop_places",
            "area_stops",
            "window_trips",
            "window_calls",
            "trip_patterns",
            "pattern_neighbours",
            "line_passes",
        ):
            self.con.execute(f"DROP TABLE {table}")

        # Aggregate trip counts by stop, considering parent stations
        # For parent stations, we aggregate all child stop counts
        # The parent station's own coordinate is its geometry; the centroid of
        # its child stops stands in when the feed lacks the station row
        # child_cnt: the distinct child stops with service, said in the output
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
            line_service AS (
                -- Each line's calls at a stop, or at a station's stops
                -- together, and its calls per direction there.
                SELECT
                    group_id AS stop_id,
                    route_type,
                    route_id,
                    calls,
                    calls / directions AS per_direction
                FROM station_line_calls
            ),
            child_counts AS (
                SELECT
                    l.stop_id,
                    l.route_type,
                    SUM(l.calls) AS trip_count,
                    SUM(l.per_direction) AS trips_per_direction,
                    COALESCE(ANY_VALUE(p.child_cnt), 1) AS child_cnt
                FROM line_service l
                LEFT JOIN parent_child_counts p ON l.stop_id = p.parent_station
                GROUP BY l.stop_id, l.route_type
            )
            SELECT
                c.stop_id,
                COALESCE(
                    orig.stop_name, sn.stop_name, pcc.stop_name, c.stop_id
                ) AS stop_name,
                COALESCE(orig.geom, sn.geom, pcc.geom) AS geom,
                c.route_type,
                c.trip_count,
                c.trips_per_direction,
                c.child_cnt
            FROM child_counts c
            LEFT JOIN (
                -- A stop's name and place once, whatever kinds of line serve it
                SELECT stop_id, ANY_VALUE(stop_name) AS stop_name, ANY_VALUE(geom) AS geom
                FROM station_trip_counts
                GROUP BY stop_id
            ) orig ON c.stop_id = orig.stop_id
            LEFT JOIN parent_child_counts pcc ON c.stop_id = pcc.parent_station
            LEFT JOIN gtfs_stations sn ON c.stop_id = sn.stop_id
        """)

        # Calculate station category
        # 1. Get the highest priority transport group (A > B > C, so MIN alphabetically)
        # 2. Calculate average frequency: time_window / trips per direction
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
                SUM(a.trips_per_direction) AS trips_per_direction,
                ANY_VALUE(a.child_cnt) AS child_cnt
            FROM aggregated_trip_counts a
            JOIN route_type_groups g ON CAST(a.route_type AS VARCHAR) = g.route_type
            GROUP BY a.stop_id, a.stop_name
        """)

        # Calculate frequency (minutes between services): the time window over
        # the trips per direction, the same on one platform or several.
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
                    WHEN trips_per_direction > 0
                    THEN {time_window_minutes} / trips_per_direction
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
