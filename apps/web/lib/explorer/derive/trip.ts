/**
 * One run of a trip (board 7): its stops with their times, the other
 * routes at each, and the runs before and after it in its direction.
 *
 * A run is a trip and the time it leaves its first stop — a timetabled trip
 * runs once, a frequency-based one many times — and its times are the
 * trip's own moved by as much as the run is from the trip's first departure.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { routeDirections } from "@/lib/explorer/derive/directions";
import { routeRuns } from "@/lib/explorer/derive/runs";
import { routesAt } from "@/lib/explorer/derive/stopsLine";

export interface RunRef {
  trip_idx: number;
  run_dep_s: number;
}

export interface TripStop {
  stop_idx: number;
  /** As riders know it: a platform by its station's name. */
  name: string;
  platform_code: string | null;
  lat: number | null;
  lon: number | null;
  arr_s: number | null;
  dep_s: number | null;
  /** Other routes at the stop or its station, by route_idx. */
  transfers: number[];
}

export interface TripDetail extends RunRef {
  route_idx: number;
  pattern_idx: number;
  headsign: string | null;
  /** The direction's destination, as the route's directions name it. */
  destination: string | null;
  stops: TripStop[];
  /** The runs before and after in the same direction on the date. */
  prev: RunRef | null;
  next: RunRef | null;
}

export async function tripDetail(
  db: SqlRunner,
  trip_idx: number,
  run_dep_s: number,
  date: string
): Promise<TripDetail | null> {
  const [trip] = await db.all<{
    route_idx: number;
    pattern_idx: number;
    headsign: string | null;
    first_dep_s: number | null;
    trip_lo: number | null;
    trip_hi: number | null;
  }>(`
    SELECT t.route_idx, t.pattern_idx, t.headsign, t.first_dep_s, r.trip_lo, r.trip_hi
    FROM trips t JOIN routes r USING (route_idx) WHERE t.trip_idx = ${trip_idx}`);
  if (!trip) return null;
  const off = run_dep_s - (trip.first_dep_s ?? run_dep_s);
  const route = { route_idx: trip.route_idx, trip_lo: trip.trip_lo, trip_hi: trip.trip_hi };

  const [rows, { directions }, runs] = await Promise.all([
    db.all<Omit<TripStop, "transfers">>(`
      SELECT st.stop_idx, COALESCE(p.name, s.name, s.stop_id) AS name, s.platform_code, s.lat, s.lon,
             st.arrival_s + ${off} AS arr_s, st.departure_s + ${off} AS dep_s
      FROM stop_times st JOIN stops s USING (stop_idx) LEFT JOIN stops p ON p.stop_idx = s.parent_idx
      WHERE st.trip_idx = ${trip_idx} ORDER BY st.stop_sequence`),
    routeDirections(db, route),
    routeRuns(db, route, date),
  ]);
  const transfers = await routesAt(
    db,
    rows.map((r) => r.stop_idx),
    trip.route_idx
  );

  // The same direction's runs, in order; this run's neighbours among them.
  const direction = directions.find((d) => d.patterns.some((p) => p.pattern_idx === trip.pattern_idx));
  const mine = new Set(direction?.patterns.map((p) => p.pattern_idx) ?? [trip.pattern_idx]);
  const sameWay = runs.filter((r) => mine.has(r.pattern_idx));
  const at = sameWay.findIndex((r) => r.trip_idx === trip_idx && r.dep_s === run_dep_s);
  const ref = (i: number): RunRef | null =>
    at >= 0 && sameWay[i] ? { trip_idx: sameWay[i].trip_idx, run_dep_s: sameWay[i].dep_s } : null;

  return {
    trip_idx,
    run_dep_s,
    route_idx: trip.route_idx,
    pattern_idx: trip.pattern_idx,
    headsign: trip.headsign,
    destination: direction?.patterns.find((p) => p.pattern_idx === trip.pattern_idx)?.destination ?? null,
    stops: rows.map((r) => ({ ...r, transfers: transfers.get(r.stop_idx) ?? [] })),
    prev: ref(at - 1),
    next: ref(at + 1),
  };
}
