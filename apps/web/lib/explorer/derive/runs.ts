/**
 * A route's runs on a date: every time a vehicle sets off on one of its trips.
 *
 * A timetabled trip runs once. A frequency-based trip (frequencies.txt) is a
 * template: it runs every `headway_s` from `start_s` up to, not including,
 * `end_s`, each run taking as long as the template does. Windows that
 * overlap (a validator error, but feeds have them) run each departure once.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { activeServicesSql } from "@/lib/explorer/derive/calendar";

/** The trip range of a route (`routes.trip_lo`..`trip_hi`). */
export interface TripRange {
  trip_lo: number | null;
  trip_hi: number | null;
}

export interface Run {
  trip_idx: number;
  pattern_idx: number;
  direction_id: number | null;
  headsign: string | null;
  block_idx: number | null;
  service_idx: number;
  /** Departure from the first stop, seconds since the start of the service day. */
  dep_s: number;
  /** Arrival at the last stop. */
  arr_s: number;
  length_m: number;
  /** Where the length is from: 1 the feed's shape_dist_traveled, 2 the
   * shape's geometry, else straight lines between its stops (an estimate). */
  length_src: number | null;
}

/** SQL for the runs of `range` on `date`; `tripsIn`, a query of trip_idx,
 * narrows them to those trips (the trips calling at a stop). */
export function runsSql(range: TripRange, date: string, tripsIn?: string): string {
  const lo = range.trip_lo ?? -1;
  const hi = range.trip_hi ?? -2;
  return `
    WITH t AS (
      SELECT * FROM trips
      WHERE trip_idx BETWEEN ${lo} AND ${hi}
        AND service_idx IN ${activeServicesSql(date)}
        ${tripsIn ? `AND trip_idx IN (${tripsIn})` : ""}
    )
    SELECT trip_idx, pattern_idx, direction_id, headsign, block_idx, service_idx,
           first_dep_s AS dep_s, last_arr_s AS arr_s, length_m, length_src
    FROM t
    WHERE trip_idx NOT IN (SELECT trip_idx FROM frequencies)
      AND first_dep_s IS NOT NULL AND last_arr_s IS NOT NULL
    UNION ALL
    SELECT DISTINCT trip_idx, pattern_idx, direction_id, headsign, block_idx, service_idx, dep_s,
           dep_s + (last_arr_s - first_dep_s) AS arr_s, length_m, length_src
    FROM (
      SELECT t.*, unnest(range(f.start_s, f.end_s, f.headway_s)) AS dep_s
      FROM t JOIN frequencies f USING (trip_idx)
    )
  `;
}

/** Every trip of the bundle: `runsSql` over the whole network. */
export const ALL_TRIPS: TripRange = { trip_lo: 0, trip_hi: 2147483647 };

/** How many runs each route makes on `date`, by route_idx; a route making
 * none is not in it. For ranking the route list: what runs that day, and
 * runs most, first. */
export async function routeDayRuns(db: SqlRunner, date: string): Promise<Map<number, number>> {
  const rows = await db.all<{ route_idx: number; n: number }>(`
    SELECT t.route_idx, CAST(count(*) AS INTEGER) AS n
    FROM (${runsSql(ALL_TRIPS, date)}) r JOIN trips t USING (trip_idx)
    GROUP BY 1`);
  return new Map(rows.map((r) => [r.route_idx, r.n]));
}

export async function routeRuns(db: SqlRunner, range: TripRange, date: string): Promise<Run[]> {
  return db.all<Run>(`SELECT * FROM (${runsSql(range, date)}) ORDER BY dep_s, trip_idx`);
}
