/**
 * A pattern as its line diagram (board 10): its stops in order, how far and
 * how long between them, the minutes from the start, the other routes at
 * each stop, and where a direction's short turns end.
 *
 * Times are the median over the pattern's trips on the Explorer's date (all
 * its trips when none run that day), as offsets from each trip's first
 * departure — frequency trips are their template's times. Distances come
 * from `shape_dist`, in metres through the feed's unit, and otherwise as the
 * crow flies between the stops.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { activeServicesSql } from "@/lib/explorer/derive/calendar";
import type { Direction } from "@/lib/explorer/derive/directions";
import type { TripRange } from "@/lib/explorer/derive/runs";
import { DEFAULT_SETTINGS, type Period } from "@/lib/explorer/settings";

/** Metres per `shape_dist_traveled` unit, by the manifest's unit. */
export const METRES_PER_UNIT: Record<string, number> = { m: 1, km: 1000, ft: 0.3048, mi: 1609.344 };

export interface LineStop {
  stop_idx: number;
  name: string;
  lat: number | null;
  lon: number | null;
  /** Minutes from the first stop; null where no trip gives a time. */
  minutes: number | null;
  /** To the next stop; null on the last. */
  next_m: number | null;
  next_min: number | null;
  /** Other routes calling at the stop or its station, by route_idx. */
  transfers: number[];
  /** Short turns of the direction ending here. */
  short_turns: { destination: string; trips: number }[];
}

export interface StopsLine {
  pattern_idx: number;
  stops: LineStop[];
  length_m: number | null;
  /** End-to-end median minutes over Midday trips, and over the slower peak. */
  offpeak_min: number | null;
  peak_min: number | null;
  /** Whether the times are the date's trips or, none running, all of them. */
  of_date: boolean;
}

/** The routes calling at each of `stopIdxs` or at its station — the
 * transfers there — by route_idx, leaving out `except`. */
export async function routesAt(
  db: SqlRunner,
  stopIdxs: number[],
  except: number | null = null
): Promise<Map<number, number[]>> {
  if (!stopIdxs.length) return new Map();
  const rows = await db.all<{ stop_idx: number; routes: ArrayLike<number> | null }>(`
    WITH calls AS (SELECT route_idx, UNNEST(stops) AS stop_idx FROM patterns),
    placed AS (
      SELECT COALESCE(s.parent_idx, s.stop_idx) AS place, c.route_idx
      FROM calls c JOIN stops s USING (stop_idx)
    ),
    mine AS (
      SELECT stop_idx, COALESCE(parent_idx, stop_idx) AS place FROM stops
      WHERE stop_idx IN (${[...new Set(stopIdxs)].join(",")})
    )
    SELECT m.stop_idx,
           list_sort(list_distinct(list(p.route_idx) FILTER (WHERE p.route_idx <> ${except ?? -1})))
             AS routes
    FROM mine m LEFT JOIN placed p USING (place) GROUP BY m.stop_idx`);
  return new Map(rows.map((r) => [r.stop_idx, r.routes ? Array.from(r.routes) : []]));
}

/** Haversine, in metres. */
function crowFlies(a: LineStop, b: LineStop): number | null {
  if (a.lat === null || a.lon === null || b.lat === null || b.lon === null) return null;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

const minutes = (s: number | null) => (s === null ? null : Math.round(s / 60));

export async function stopsLine(
  db: SqlRunner,
  route: TripRange & { route_idx: number },
  direction: Direction,
  pattern_idx: number,
  date: string,
  shapeDistUnit: string | null,
  periods: Period[] = DEFAULT_SETTINGS.periods
): Promise<StopsLine> {
  const range = `trip_idx BETWEEN ${route.trip_lo ?? -1} AND ${route.trip_hi ?? -2}`;
  const onDate = `${range} AND service_idx IN ${activeServicesSql(date)}`;
  const trips = (where: string, pattern: number) =>
    `SELECT trip_idx FROM trips WHERE ${where} AND pattern_idx = ${pattern}`;

  const [pattern] = await db.all<{ stops: ArrayLike<number>; length_m: number | null }>(
    `SELECT stops, length_m FROM patterns WHERE pattern_idx = ${pattern_idx}`
  );
  const chain = pattern ? Array.from(pattern.stops) : [];
  const [{ n }] = await db.all<{ n: number }>(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM (${trips(onDate, pattern_idx)})`
  );
  const of_date = n > 0;
  const tripsSql = trips(of_date ? onDate : range, pattern_idx);

  // Offsets from each trip's first departure, by position along the pattern.
  const timing = `
    WITH st AS (
      SELECT st.trip_idx,
             CAST(row_number() OVER (PARTITION BY st.trip_idx ORDER BY st.stop_sequence) - 1 AS INTEGER) AS i,
             COALESCE(st.arrival_s, st.departure_s) AS arr,
             COALESCE(st.departure_s, st.arrival_s) AS dep,
             st.shape_dist
      FROM stop_times st JOIN (${tripsSql}) USING (trip_idx)
    ),
    t0 AS (SELECT trip_idx, dep AS t0, shape_dist AS d0 FROM st WHERE i = 0)`;
  const [offsets, ends, transfers, info] = await Promise.all([
    db.all<{ i: number; off_s: number | null; dist: number | null }>(`
      ${timing}
      SELECT i, median(arr - t0) AS off_s, median(shape_dist - d0) AS dist
      FROM st JOIN t0 USING (trip_idx) GROUP BY i ORDER BY i`),
    db.all<{ t0: number; run_s: number }>(`
      ${timing}
      SELECT any_value(t0.t0) AS t0, max(st.arr) - any_value(t0.t0) AS run_s
      FROM st JOIN t0 USING (trip_idx) GROUP BY trip_idx`),
    routesAt(db, chain, route.route_idx),
    chain.length
      ? db.all<{
          stop_idx: number;
          name: string | null;
          station: string | null;
          lat: number | null;
          lon: number | null;
        }>(`
          SELECT s.stop_idx, s.name, p.name AS station, s.lat, s.lon
          FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx
          WHERE s.stop_idx IN (${chain.join(",")})`)
      : Promise.resolve([]),
  ]);

  const scale = shapeDistUnit ? (METRES_PER_UNIT[shapeDistUnit] ?? null) : null;
  const byPos = new Map(offsets.map((o) => [o.i, o]));
  const stopInfo = new Map(info.map((s) => [s.stop_idx, s]));

  // The direction's short turns, by the stop their trips end at.
  const endsHere = new Map<number, { destination: string; trips: number }[]>();
  for (const p of direction.patterns) {
    if (p.kind !== "short_turn" || p.pattern_idx === pattern_idx) continue;
    const [last] = await db.all<{ last: number | null }>(
      `SELECT stops[len(stops)] AS last FROM patterns WHERE pattern_idx = ${p.pattern_idx}`
    );
    const [{ k }] = await db.all<{ k: number }>(
      `SELECT CAST(count(*) AS INTEGER) AS k FROM (${trips(of_date ? onDate : range, p.pattern_idx)})`
    );
    if (last?.last === null || last?.last === undefined || !k) continue;
    const list = endsHere.get(last.last) ?? [];
    list.push({ destination: p.destination, trips: k });
    endsHere.set(last.last, list);
  }

  const stops: LineStop[] = chain.map((stop_idx, i) => {
    const s = stopInfo.get(stop_idx);
    const o = byPos.get(i);
    return {
      stop_idx,
      // A platform is known by its station's name.
      name: s?.station ?? s?.name ?? String(stop_idx),
      lat: s?.lat ?? null,
      lon: s?.lon ?? null,
      minutes: minutes(o?.off_s ?? null),
      next_m: null,
      next_min: null,
      transfers: transfers.get(stop_idx) ?? [],
      short_turns: i < chain.length - 1 ? (endsHere.get(stop_idx) ?? []) : [],
    };
  });
  for (let i = 0; i < stops.length - 1; i++) {
    const a = byPos.get(i);
    const b = byPos.get(i + 1);
    const along = scale !== null && a?.dist != null && b?.dist != null ? (b.dist - a.dist) * scale : null;
    stops[i].next_m = along !== null && along > 0 ? along : crowFlies(stops[i], stops[i + 1]);
    const ta = stops[i].minutes;
    const tb = stops[i + 1].minutes;
    stops[i].next_min = ta !== null && tb !== null ? tb - ta : null;
  }

  // End to end: Midday is the off-peak; the slower of the two peaks is "peak".
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const inPeriod = (key: string) => {
    const p = periods.find((q) => q.key === key);
    return p ? ends.filter((e) => e.t0 >= p.start_s && e.t0 < p.end_s).map((e) => e.run_s) : [];
  };
  const am = median(inPeriod("am_peak"));
  const pm = median(inPeriod("pm_peak"));
  const peak = am === null ? pm : pm === null ? am : Math.max(am, pm);

  return {
    pattern_idx,
    stops,
    length_m: pattern?.length_m ?? null,
    offpeak_min: minutes(median(inPeriod("midday"))),
    peak_min: minutes(peak),
    of_date,
  };
}
