/**
 * A route's runs on a date, each with its stop times, for the trip strip
 * (02-panel-behaviour-spec › Playback; boards 6, 12, 16): one line per run
 * from origin to destination, against time and the distance along its
 * direction.
 *
 * Runs come from `routeRuns` (a frequency-based trip runs every headway).
 * Their stop times are read once per template trip, as columns, and each run
 * takes its template's times shifted by when it leaves. A direction's axis is
 * its main pattern: its stops and how far along it each lies
 * (`pattern_shape_stops`, which covers trips without a shape too).
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { type Direction, type StopInfo, routeDirections } from "@/lib/explorer/derive/directions";
import { type Run, type TripRange, routeRuns, runsSql } from "@/lib/explorer/derive/runs";

/** A direction's main pattern as an axis: its stops in order, and metres
 * along it to each. */
export interface DirectionAxis {
  stop_idx: number[];
  d: number[];
  length_m: number;
}

export interface RouteTrips {
  directions: Direction[];
  stops: Map<number, StopInfo>;
  /** Runs by departure. */
  runs: Run[];
  /** Run `r`'s stops are rows `first[r]` up to `first[r + 1]`, in order. */
  first: Int32Array;
  stop_idx: Int32Array;
  /** Times at each stop (service-day seconds); NaN where the feed gives none. */
  arr: Float64Array;
  dep: Float64Array;
  /** By direction key. */
  axes: Map<number, DirectionAxis>;
}

export async function routeTrips(
  db: SqlRunner,
  route: TripRange & { route_idx: number },
  date: string
): Promise<RouteTrips> {
  const lo = route.trip_lo ?? -1;
  const hi = route.trip_hi ?? -2;
  const [{ directions, stops, patterns }, runs, rows] = await Promise.all([
    routeDirections(db, route),
    routeRuns(db, route, date),
    db.columns<"trip_idx" | "stop_idx" | "arr" | "dep" | "first_dep">(`
      SELECT st.trip_idx, st.stop_idx,
             CAST(COALESCE(st.arrival_s, st.departure_s, -1) AS DOUBLE) AS arr,
             CAST(COALESCE(st.departure_s, st.arrival_s, -1) AS DOUBLE) AS dep,
             CAST(t.first_dep_s AS DOUBLE) AS first_dep
      FROM stop_times st JOIN trips t USING (trip_idx)
      WHERE st.trip_idx BETWEEN ${lo} AND ${hi}
        AND st.trip_idx IN (SELECT DISTINCT trip_idx FROM (${runsSql(route, date)}))
      ORDER BY st.trip_idx, st.stop_sequence`),
  ]);

  // Each template trip's rows.
  const span = new Map<number, [number, number]>();
  for (let k = 0; k < rows.trip_idx.length; k++) {
    const t = rows.trip_idx[k];
    const s = span.get(t);
    if (s) s[1] = k + 1;
    else span.set(t, [k, k + 1]);
  }
  let total = 0;
  for (const r of runs) {
    const s = span.get(r.trip_idx);
    if (s) total += s[1] - s[0];
  }
  const out: RouteTrips = {
    directions,
    stops,
    runs,
    first: new Int32Array(runs.length + 1),
    stop_idx: new Int32Array(total),
    arr: new Float64Array(total),
    dep: new Float64Array(total),
    axes: new Map(),
  };
  let n = 0;
  runs.forEach((r, i) => {
    out.first[i] = n;
    const s = span.get(r.trip_idx);
    if (!s) return;
    // A run of a frequency-based trip leaves later than its template.
    const off = r.dep_s - rows.first_dep[s[0]];
    for (let k = s[0]; k < s[1]; k++, n++) {
      out.stop_idx[n] = rows.stop_idx[k];
      out.arr[n] = rows.arr[k] < 0 ? NaN : rows.arr[k] + off;
      out.dep[n] = rows.dep[k] < 0 ? NaN : rows.dep[k] + off;
    }
  });
  out.first[runs.length] = n;

  // Each direction's axis: its main pattern, how far along it each stop is.
  const mains = directions.map((d) => d.key);
  const along = mains.length
    ? await db.all<{ pattern_idx: number; i: number; d: number }>(`
        SELECT pattern_idx, i, min(d) AS d FROM pattern_shape_stops
        WHERE pattern_idx IN (${mains.join(",")}) GROUP BY ALL`)
    : [];
  for (const d of directions) {
    const stopsOf = patterns.find((p) => p.pattern_idx === d.key)?.stops ?? [];
    const known = new Map(along.filter((a) => a.pattern_idx === d.key).map((a) => [a.i, a.d]));
    out.axes.set(d.key, axisOf(stopsOf, known));
  }
  return out;
}

/** An axis from a pattern's stops and the distances known for some of them:
 * a stop without one is placed between its neighbours, and a pattern with
 * none spaces its stops evenly. */
export function axisOf(stop_idx: number[], known: Map<number, number>): DirectionAxis {
  const n = stop_idx.length;
  if (!known.size) {
    const d = stop_idx.map((_, i) => i);
    return { stop_idx, d, length_m: Math.max(n - 1, 1) };
  }
  const d = new Array<number>(n);
  const at = [...known.keys()].filter((i) => i < n).sort((a, b) => a - b);
  for (let i = 0; i < n; i++) {
    if (known.has(i)) {
      d[i] = known.get(i) as number;
      continue;
    }
    const before = at.filter((k) => k < i).pop();
    const after = at.find((k) => k > i);
    if (before === undefined) d[i] = known.get(after as number) as number;
    else if (after === undefined) d[i] = known.get(before) as number;
    else {
      const f = (i - before) / (after - before);
      d[i] =
        (known.get(before) as number) + ((known.get(after) as number) - (known.get(before) as number)) * f;
    }
  }
  return { stop_idx, d, length_m: Math.max(d[n - 1] - d[0], 1) };
}
