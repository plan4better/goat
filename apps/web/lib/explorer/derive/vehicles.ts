/**
 * Where the network's vehicles are at a moment of a day, for playback
 * (02-panel-behaviour-spec › Playback): positions interpolated between
 * scheduled stop times, network-wide.
 *
 * A day's runs are worked out once (`prepareDay`) into the database. A window
 * of time is then read as segments (`vehicleWindow`) — a vehicle moving
 * between two stops, or waiting at one — and `positionsAt` places each run's
 * vehicle on its segment at any moment in the window, without the database,
 * so playback can draw many frames from one read.
 *
 * Vehicles move along their trip's shape (the snapshot's simplified
 * `shape_points`, with each stop placed along it in `pattern_shape_stops`),
 * so they follow the lines the map draws; a trip without a shape goes in a
 * straight line from stop to stop.
 *
 * Both are kept as columns of numbers rather than an object per row: a
 * city's window holds tens of thousands of segments, and a frame thousands
 * of vehicles, ten times a second — as objects, that is garbage enough to
 * stall the page while the collector catches up.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { runsSql } from "@/lib/explorer/derive/runs";

/** A shape as playback walks it: each vertex's distance along it (metres)
 * and position. */
export interface ShapeLine {
  d: Float32Array;
  lon: Float32Array;
  lat: Float32Array;
}

/** The segments of a window of time, as columns: segment `k` is one run's
 * movement over [t0, t1] (service-day seconds), from (ax, ay) to (bx, by),
 * or waiting where they are the same — along shape `shape[k]` from `d0` to
 * `d1` where it has one (else -1). A run's segments are contiguous, in time
 * order: run `r` (0…runs-1) has segments `first[r]` up to `first[r + 1]`. */
export interface VehicleWindow {
  date: string;
  from_s: number;
  to_s: number;
  runs: number;
  first: Int32Array;
  run: Int32Array;
  route_idx: Int32Array;
  trip_idx: Int32Array;
  /** When the run left its first stop: with trip_idx, which run it is. */
  run_dep_s: Float64Array;
  t0: Float64Array;
  t1: Float64Array;
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  shape: Int32Array;
  d0: Float64Array;
  d1: Float64Array;
  /** The shapes segments walk, by shape_idx. */
  shapes: Map<number, ShapeLine>;
}

/** Where the running vehicles are at a moment, as columns: vehicle `i` of
 * `n`. Filled in place frame after frame (`positionsAt`); arrays grow, so
 * read only the first `n`. */
export interface VehicleFrame {
  n: number;
  run: Int32Array;
  route_idx: Int32Array;
  trip_idx: Int32Array;
  run_dep_s: Float64Array;
  lon: Float64Array;
  lat: Float64Array;
}

/** One vehicle of a frame, as an object: for what is asked about one. */
export interface Vehicle {
  run: number;
  route_idx: number;
  trip_idx: number;
  run_dep_s: number;
  lon: number;
  lat: number;
}

export function vehicleFrame(capacity = 0): VehicleFrame {
  return {
    n: 0,
    run: new Int32Array(capacity),
    route_idx: new Int32Array(capacity),
    trip_idx: new Int32Array(capacity),
    run_dep_s: new Float64Array(capacity),
    lon: new Float64Array(capacity),
    lat: new Float64Array(capacity),
  };
}

/** Vehicle `i` of `frame`. */
export function vehicleAt(frame: VehicleFrame, i: number): Vehicle {
  return {
    run: frame.run[i],
    route_idx: frame.route_idx[i],
    trip_idx: frame.trip_idx[i],
    run_dep_s: frame.run_dep_s[i],
    lon: frame.lon[i],
    lat: frame.lat[i],
  };
}

/** The day's runs, numbered, in a table playback reads its windows from. */
const DAY_TABLE = "playback_runs";

/** Work out a date's runs once: every trip running that day, every run of a
 * frequency-based one, with the offset from its template's times. */
export async function prepareDay(db: SqlRunner, date: string): Promise<void> {
  await db.all(`
    CREATE OR REPLACE TEMP TABLE ${DAY_TABLE} AS
    SELECT CAST(row_number() OVER (ORDER BY r.dep_s, r.trip_idx) AS INTEGER) AS run,
           r.trip_idx, t.route_idx, t.pattern_idx, t.shape_idx, r.dep_s, r.arr_s,
           r.dep_s - t.first_dep_s AS off
    FROM (${runsSql({ trip_lo: 0, trip_hi: 2147483647 }, date)}) r JOIN trips t USING (trip_idx)`);
}

/** The day's first departure and last arrival: the span playback can show. */
export async function serviceSpan(db: SqlRunner): Promise<{ first_s: number; last_s: number } | null> {
  const [row] = await db.all<{ first_s: number | null; last_s: number | null }>(
    `SELECT min(dep_s) AS first_s, max(arr_s) AS last_s FROM ${DAY_TABLE}`
  );
  return row && row.first_s !== null && row.last_s !== null
    ? { first_s: row.first_s, last_s: row.last_s }
    : null;
}

/** How many vehicles are running at `t`. */
export async function runningAt(db: SqlRunner, t: number): Promise<number> {
  const [row] = await db.all<{ n: number }>(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM ${DAY_TABLE} WHERE dep_s <= ${t} AND arr_s >= ${t}`
  );
  return row?.n ?? 0;
}

/** The segments of the prepared day overlapping [from_s, to_s]. */
export async function vehicleWindow(
  db: SqlRunner,
  date: string,
  from_s: number,
  to_s: number
): Promise<VehicleWindow> {
  const [from, to] = [Math.floor(from_s), Math.ceil(to_s)];
  // Columns, NULLs stated: -1 for no shape, no distance or no next stop.
  const c = await db.columns<
    | "run"
    | "route_idx"
    | "trip_idx"
    | "run_dep_s"
    | "shape_idx"
    | "lon"
    | "lat"
    | "nlon"
    | "nlat"
    | "arr"
    | "dep"
    | "next_arr"
    | "d"
    | "next_d"
  >(`
    WITH r AS (SELECT * FROM ${DAY_TABLE} WHERE dep_s <= ${to} AND arr_s >= ${from}),
    st AS (
      -- A stop without a position takes its station's; i is its place in
      -- the trip, which is its place in the trip's pattern.
      SELECT st.trip_idx,
             CAST(row_number() OVER (PARTITION BY st.trip_idx ORDER BY st.stop_sequence) - 1 AS INTEGER) AS i,
             COALESCE(st.arrival_s, st.departure_s) AS arr,
             COALESCE(st.departure_s, st.arrival_s) AS dep,
             COALESCE(s.lon, p.lon) AS lon, COALESCE(s.lat, p.lat) AS lat
      FROM stop_times st JOIN stops s USING (stop_idx) LEFT JOIN stops p ON p.stop_idx = s.parent_idx
      WHERE st.trip_idx IN (SELECT DISTINCT trip_idx FROM r)
    ),
    placed AS (
      SELECT st.*, r.run, r.route_idx, r.shape_idx, r.off, r.dep_s AS run_dep_s, ps.d
      FROM st JOIN r USING (trip_idx)
      LEFT JOIN pattern_shape_stops ps
        ON ps.pattern_idx = r.pattern_idx AND ps.shape_idx = r.shape_idx AND ps.i = st.i
      -- Timed stops only: a feed may time just its timepoints, leaving the
      -- stops between blank (GTFS allows it). The vehicle then runs from one
      -- timepoint to the next along its shape, past the untimed stops,
      -- rather than stopping dead at the first of them. i stays each stop's
      -- place in the trip, so the shape distances still match.
      WHERE st.lon IS NOT NULL AND st.lat IS NOT NULL AND st.arr IS NOT NULL
    ),
    hops AS (
      SELECT *, lead(arr) OVER w AS next_arr, lead(lon) OVER w AS nlon, lead(lat) OVER w AS nlat,
             lead(d) OVER w AS next_d
      FROM placed WINDOW w AS (PARTITION BY run ORDER BY i)
    )
    SELECT run, route_idx, trip_idx, CAST(run_dep_s AS DOUBLE) AS run_dep_s,
           CAST(COALESCE(shape_idx, -1) AS INTEGER) AS shape_idx,
           CAST(lon AS DOUBLE) AS lon, CAST(lat AS DOUBLE) AS lat,
           CAST(COALESCE(nlon, 0) AS DOUBLE) AS nlon, CAST(COALESCE(nlat, 0) AS DOUBLE) AS nlat,
           CAST(arr + off AS DOUBLE) AS arr, CAST(dep + off AS DOUBLE) AS dep,
           CAST(COALESCE(next_arr + off, -1) AS DOUBLE) AS next_arr,
           CAST(COALESCE(d, -1) AS DOUBLE) AS d, CAST(COALESCE(next_d, -1) AS DOUBLE) AS next_d
    FROM hops
    WHERE arr + off <= ${to} AND COALESCE(next_arr, dep) + off >= ${from}
    ORDER BY run, arr`);

  const rows = c.run.length;
  const wanted: number[] = [];
  for (let k = 0; k < rows; k++) if (c.shape_idx[k] >= 0 && c.d[k] >= 0) wanted.push(c.shape_idx[k]);
  const shapes = await shapeLines(db, wanted);

  // At most two segments a row: waiting at the stop, then (unless it is the
  // last) on the way to the next.
  const cap = rows * 2;
  const w: VehicleWindow = {
    date,
    from_s,
    to_s,
    runs: 0,
    first: new Int32Array(rows + 1),
    run: new Int32Array(cap),
    route_idx: new Int32Array(cap),
    trip_idx: new Int32Array(cap),
    run_dep_s: new Float64Array(cap),
    t0: new Float64Array(cap),
    t1: new Float64Array(cap),
    ax: new Float64Array(cap),
    ay: new Float64Array(cap),
    bx: new Float64Array(cap),
    by: new Float64Array(cap),
    shape: new Int32Array(cap),
    d0: new Float64Array(cap),
    d1: new Float64Array(cap),
    shapes,
  };
  let n = 0;
  let lastRun = -1;
  const add = (
    k: number,
    t0: number,
    t1: number,
    bx: number,
    by: number,
    shape: number,
    d0: number,
    d1: number
  ) => {
    if (c.run[k] !== lastRun) {
      w.first[w.runs++] = n;
      lastRun = c.run[k];
    }
    w.run[n] = c.run[k];
    w.route_idx[n] = c.route_idx[k];
    w.trip_idx[n] = c.trip_idx[k];
    w.run_dep_s[n] = c.run_dep_s[k];
    w.t0[n] = t0;
    w.t1[n] = t1;
    w.ax[n] = c.lon[k];
    w.ay[n] = c.lat[k];
    w.bx[n] = bx;
    w.by[n] = by;
    w.shape[n] = shape;
    w.d0[n] = d0;
    w.d1[n] = d1;
    n++;
  };
  for (let k = 0; k < rows; k++) {
    if (c.dep[k] > c.arr[k]) add(k, c.arr[k], c.dep[k], c.lon[k], c.lat[k], -1, 0, 0);
    if (c.next_arr[k] < 0) continue;
    const s = c.shape_idx[k];
    const along = s >= 0 && shapes.has(s) && c.d[k] >= 0 && c.next_d[k] >= 0;
    add(k, c.dep[k], c.next_arr[k], c.nlon[k], c.nlat[k], along ? s : -1, c.d[k], c.next_d[k]);
  }
  w.first[w.runs] = n;
  return w;
}

/** Shapes read once per database: a window needs the shapes of the trips it
 * holds, and the next window mostly the same ones. */
const shapeCache = new WeakMap<SqlRunner, Map<number, ShapeLine>>();

async function shapeLines(db: SqlRunner, wanted: number[]): Promise<Map<number, ShapeLine>> {
  let cache = shapeCache.get(db);
  if (!cache) shapeCache.set(db, (cache = new Map()));
  const missing = [...new Set(wanted)].filter((s) => !cache?.has(s));
  if (missing.length) {
    const rows = await db.all<{ shape_idx: number; d: number; lon: number; lat: number }>(`
      SELECT shape_idx, d, lon, lat FROM shape_points
      WHERE shape_idx IN (${missing.join(",")}) ORDER BY shape_idx, i`);
    let start = 0;
    for (let k = 1; k <= rows.length; k++) {
      if (k < rows.length && rows[k].shape_idx === rows[start].shape_idx) continue;
      const part = rows.slice(start, k);
      cache.set(rows[start].shape_idx, {
        d: Float32Array.from(part, (r) => r.d),
        lon: Float32Array.from(part, (r) => r.lon),
        lat: Float32Array.from(part, (r) => r.lat),
      });
      start = k;
    }
  }
  return cache;
}

/** Forget a database's shapes: playback is stopping for want of memory. */
export function dropShapeCache(db: SqlRunner): void {
  shapeCache.delete(db);
}

/** The vertex of `shape` at or before `d` metres along it (never the last),
 * for the point between it and the next. */
function vertexBefore(shape: ShapeLine, d: number): number {
  const ds = shape.d;
  let lo = 0;
  let hi = ds.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ds[mid] <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The point `d` metres along `shape`, written as vehicle `i` of `out`. */
function placeAlong(shape: ShapeLine, d: number, out: VehicleFrame, i: number): void {
  const { d: ds, lon, lat } = shape;
  const last = ds.length - 1;
  if (d <= ds[0] || last === 0) {
    out.lon[i] = lon[0];
    out.lat[i] = lat[0];
  } else if (d >= ds[last]) {
    out.lon[i] = lon[last];
    out.lat[i] = lat[last];
  } else {
    const lo = vertexBefore(shape, d);
    const span = ds[lo + 1] - ds[lo];
    const f = span > 0 ? (d - ds[lo]) / span : 0;
    out.lon[i] = lon[lo] + (lon[lo + 1] - lon[lo]) * f;
    out.lat[i] = lat[lo] + (lat[lo + 1] - lat[lo]) * f;
  }
}

/** The point `d` metres along `shape`. */
export function alongShape(shape: ShapeLine, d: number): [number, number] {
  const one = vehicleFrame(1);
  placeAlong(shape, d, one, 0);
  return [one.lon[0], one.lat[0]];
}

/** Each running vehicle's position at `t`, which must lie in the window,
 * written into `out` (grown if need be), which is returned. */
export function positionsAt(
  window: VehicleWindow,
  t: number,
  out: VehicleFrame = vehicleFrame()
): VehicleFrame {
  if (out.run.length < window.runs) {
    const grown = vehicleFrame(Math.max(window.runs, out.run.length * 2));
    Object.assign(out, grown);
  }
  const w = window;
  let n = 0;
  for (let r = 0; r < w.runs; r++) {
    // A run's segments are few in a window: a scan is as quick as a search.
    let k = w.first[r];
    const end = w.first[r + 1];
    while (k < end && !(w.t0[k] <= t && t <= w.t1[k])) k++;
    if (k === end) continue;
    const f = w.t1[k] > w.t0[k] ? (t - w.t0[k]) / (w.t1[k] - w.t0[k]) : 0;
    const shape = w.shape[k] >= 0 ? w.shapes.get(w.shape[k]) : undefined;
    if (shape) placeAlong(shape, w.d0[k] + (w.d1[k] - w.d0[k]) * f, out, n);
    else {
      out.lon[n] = w.ax[k] + (w.bx[k] - w.ax[k]) * f;
      out.lat[n] = w.ay[k] + (w.by[k] - w.ay[k]) * f;
    }
    out.run[n] = w.run[k];
    out.route_idx[n] = w.route_idx[k];
    out.trip_idx[n] = w.trip_idx[k];
    out.run_dep_s[n] = w.run_dep_s[k];
    n++;
  }
  out.n = n;
  return out;
}
