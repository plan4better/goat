/**
 * A stop's timetable for a date (board 13): every departure from the stop —
 * from each of a station's platforms, when it is a station — grouped by
 * route and by direction, short turns marked.
 *
 * A departure is a run of a trip (a frequency-based trip runs many times)
 * leaving the stop: its time there is the trip's own, moved by as much as
 * the run is from the trip's first departure. A trip's last stop is where
 * it arrives, not where it leaves, and is left out — once, so a loop still
 * leaves from where it starts.
 *
 * Feeds may time only some stops (timepoints) and leave the rest blank. A
 * trip calling at such a stop still calls there: it is listed with the
 * window the feed does give — from its departure at the timed stop before
 * to its arrival at the timed stop after — never a time made up between
 * them (planners act on these figures).
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { Direction, DirectionName } from "@/lib/explorer/derive/directions";
import { ALL_TRIPS, runsSql } from "@/lib/explorer/derive/runs";

export interface Departure {
  /** The stop it leaves from: one of a station's platforms, or the stop. */
  stop_idx: number;
  route_idx: number;
  trip_idx: number;
  pattern_idx: number;
  headsign: string | null;
  /** The run's departure from its first stop: with trip_idx, which run. */
  run_dep_s: number;
  /** Its departure from this stop, seconds from the start of the service
   * day; untimed, the departure from the timed stop before it. */
  dep_s: number;
  /** Untimed in the feed: its arrival at the timed stop after it (null
   * when none follows). Null for a timed call. */
  until_s: number | null;
  /** Untimed: whether it is, and the timed stops either side, by name. */
  untimed: boolean;
  from_stop: string | null;
  until_stop: string | null;
}

export interface StopDetail {
  stop_idx: number;
  stop_id: string;
  name: string | null;
  /** The station, where the stop is one of its platforms. */
  station: string | null;
  platform_code: string | null;
  /** GTFS wheelchair_boarding: 1 possible, 2 not, null or 0 unknown. */
  wheelchair: number | null;
  is_station: boolean;
  /** A station's stops (platforms); 0 for a stop. */
  n_stops: number;
  lat: number | null;
  lon: number | null;
  /** Every route calling at the stop (a station: at its stops), on any day. */
  routes: number[];
}

/** The stops a stop's timetable covers: itself, and a station's platforms. */
const covered = (stop_idx: number) =>
  `SELECT stop_idx FROM stops WHERE stop_idx = ${stop_idx} OR parent_idx = ${stop_idx}`;

export async function stopDetail(db: SqlRunner, stop_idx: number): Promise<StopDetail | null> {
  const [[row], [served]] = await Promise.all([
    db.all<Omit<StopDetail, "routes" | "is_station"> & { location_type: number }>(`
      SELECT s.stop_idx, s.stop_id, s.name, p.name AS station, s.platform_code, s.wheelchair,
             s.location_type, s.lat, s.lon,
             CAST((SELECT count(*) FROM stops c
                   WHERE c.parent_idx = s.stop_idx AND COALESCE(c.location_type, 0) = 0) AS INTEGER) AS n_stops
      FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx
      WHERE s.stop_idx = ${stop_idx}`),
    db.all<{ routes: ArrayLike<number> | null }>(`
      SELECT list_sort(list_distinct(list(route_idx))) AS routes
      FROM (SELECT route_idx, UNNEST(stops) AS stop_idx FROM patterns)
      WHERE stop_idx IN (${covered(stop_idx)})`),
  ]);
  if (!row) return null;
  const { location_type, ...rest } = row;
  return {
    ...rest,
    is_station: location_type === 1,
    routes: served?.routes ? Array.from(served.routes) : [],
  };
}

export async function stopDepartures(db: SqlRunner, stop_idx: number, date: string): Promise<Departure[]> {
  const rows = await db.all<Omit<Departure, "untimed"> & { untimed: boolean | number }>(`
    WITH calls AS (
      SELECT trip_idx, stop_idx, stop_sequence, COALESCE(departure_s, arrival_s) AS at_s
      FROM stop_times WHERE stop_idx IN (${covered(stop_idx)})
    ),
    last AS (
      SELECT trip_idx, max(stop_sequence) AS last_seq FROM stop_times
      WHERE trip_idx IN (SELECT trip_idx FROM calls) GROUP BY trip_idx
    ),
    -- The timed stops of trips with an untimed call here, and for each such
    -- call, its trip's timed stop before and after it.
    timed AS (
      SELECT trip_idx, stop_sequence, stop_idx,
             COALESCE(departure_s, arrival_s) AS dep_at, COALESCE(arrival_s, departure_s) AS arr_at
      FROM stop_times
      WHERE trip_idx IN (SELECT trip_idx FROM calls WHERE at_s IS NULL)
        AND COALESCE(departure_s, arrival_s) IS NOT NULL
    ),
    bounds AS (
      SELECT c.trip_idx, c.stop_sequence,
             arg_max(b.dep_at, b.stop_sequence) FILTER (WHERE b.stop_sequence < c.stop_sequence) AS from_s,
             arg_max(b.stop_idx, b.stop_sequence) FILTER (WHERE b.stop_sequence < c.stop_sequence) AS from_idx,
             arg_min(b.arr_at, b.stop_sequence) FILTER (WHERE b.stop_sequence > c.stop_sequence) AS until_s,
             arg_min(b.stop_idx, b.stop_sequence) FILTER (WHERE b.stop_sequence > c.stop_sequence) AS until_idx
      FROM calls c JOIN timed b USING (trip_idx)
      WHERE c.at_s IS NULL
      GROUP BY c.trip_idx, c.stop_sequence
    ),
    r AS (${runsSql(ALL_TRIPS, date, "SELECT trip_idx FROM calls")})
    SELECT c.stop_idx, t.route_idx, r.trip_idx, r.pattern_idx, r.headsign, r.dep_s AS run_dep_s,
           COALESCE(c.at_s, b.from_s) + (r.dep_s - t.first_dep_s) AS dep_s,
           CASE WHEN c.at_s IS NULL THEN b.until_s + (r.dep_s - t.first_dep_s) END AS until_s,
           c.at_s IS NULL AS untimed,
           CASE WHEN c.at_s IS NULL THEN COALESCE(fp.name, fs.name) END AS from_stop,
           CASE WHEN c.at_s IS NULL THEN COALESCE(up.name, us.name) END AS until_stop
    FROM r JOIN trips t ON t.trip_idx = r.trip_idx
    JOIN calls c ON c.trip_idx = r.trip_idx
    JOIN last l ON l.trip_idx = r.trip_idx
    LEFT JOIN bounds b ON b.trip_idx = c.trip_idx AND b.stop_sequence = c.stop_sequence
    LEFT JOIN stops fs ON fs.stop_idx = b.from_idx LEFT JOIN stops fp ON fp.stop_idx = fs.parent_idx
    LEFT JOIN stops us ON us.stop_idx = b.until_idx LEFT JOIN stops up ON up.stop_idx = us.parent_idx
    WHERE c.stop_sequence < l.last_seq AND COALESCE(c.at_s, b.from_s) IS NOT NULL
    ORDER BY dep_s, t.route_idx, r.trip_idx`);
  return rows.map((r) => ({ ...r, untimed: !!r.untimed }));
}

export interface TimetableEntry {
  /** The platform it leaves from: a run can call at two of a station's. */
  stop_idx: number;
  dep_s: number;
  trip_idx: number;
  run_dep_s: number;
  pattern_idx: number;
  /** A short turn of its direction: it ends before the direction does. */
  short: boolean;
  /** Not timed in the feed: `dep_s` to `until_s` is the window between the
   * timed stops either side (Departure). */
  untimed: boolean;
  until_s: number | null;
  from_stop: string | null;
  until_stop: string | null;
}

export interface TimetableDirection {
  /** The direction's key, or the headsign where no direction knows the pattern. */
  key: string;
  name: DirectionName;
  departures: TimetableEntry[];
}

/** A route's departures from the stop, by direction in the route's order.
 * Directions come from `routeDirections`; a pattern none of them has (it
 * should not happen) goes under its headsign. */
export function byDirection(departures: Departure[], directions: Direction[]): TimetableDirection[] {
  const of = new Map<number, { direction: Direction; short: boolean }>();
  for (const d of directions)
    for (const p of d.patterns) of.set(p.pattern_idx, { direction: d, short: p.kind === "short_turn" });
  const groups = new Map<string, TimetableDirection>();
  const order = new Map(directions.map((d, i) => [String(d.key), i]));
  for (const dep of departures) {
    const found = of.get(dep.pattern_idx);
    const key = found ? String(found.direction.key) : `headsign:${dep.headsign ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: found?.direction.name ?? { kind: "to", place: dep.headsign ?? "", via: null },
        departures: [],
      };
      groups.set(key, group);
    }
    group.departures.push({
      stop_idx: dep.stop_idx,
      dep_s: dep.dep_s,
      trip_idx: dep.trip_idx,
      run_dep_s: dep.run_dep_s,
      pattern_idx: dep.pattern_idx,
      short: found?.short ?? false,
      untimed: dep.untimed,
      until_s: dep.until_s,
      from_stop: dep.from_stop,
      until_stop: dep.until_stop,
    });
  }
  return [...groups.values()].sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
}

/** Departures by hour of the service day, for the hour × minute grid. */
export function byHour(entries: TimetableEntry[]): { hour: number; entries: TimetableEntry[] }[] {
  const hours = new Map<number, TimetableEntry[]>();
  for (const e of entries) {
    const h = Math.floor(e.dep_s / 3600);
    const list = hours.get(h);
    if (list) list.push(e);
    else hours.set(h, [e]);
  }
  return [...hours.entries()].sort(([a], [b]) => a - b).map(([hour, list]) => ({ hour, entries: list }));
}
