/**
 * A stop on a line (01-editing-operations § 3): 3.2 taken off it, for the
 * trips in scope. The scope is one of three levels, the same for every edit
 * on a line (decided 6 Nov 2026): a variant (one pattern), a direction (its
 * patterns), the whole line; not a trip, which an edit on the map never has
 * picked (9 Nov 2026). The selection sets where it
 * starts; the Apply bar's "Apply to" widens or narrows it, each level with
 * the trips it takes, one that takes none named with why.
 *
 * Taken off: the trips in scope no longer call there; the stop stays, as do
 * the line's paths (the vehicles drive the same streets, 6 Nov 2026), and
 * every other time. The cascade is a stop delete's for those trips
 * (removeStops): patterns without the stop, merged where one runs the same
 * stops, a pattern only some of whose trips are in scope split; refused
 * where a trip would keep fewer than two stops, end untimed, or lose the
 * first stop its frequencies run from.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { STOP_CHAIN_PREFIX } from "@/lib/explorer/edit/ops/chains";
import { type DeleteStopFacts, removeStops, tripFiguresSql } from "@/lib/explorer/edit/ops/deleteStop";
import { metres } from "@/lib/explorer/edit/ops/geo";
import {
  type MoveStopFacts,
  type Router,
  cutAt as cutPath,
  moveStop,
} from "@/lib/explorer/edit/ops/moveStop";
import type { Built, ChangeRows } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, Touch } from "@/lib/explorer/edit/types";
import { modeOf, routeColor } from "@/lib/explorer/modes";

/** How much of a line an edit on it changes, narrowest first. */
export const SCOPE_LEVELS = ["variant", "direction", "line"] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** Where an edit on a line was started, and how far it reaches. */
export interface LineScope {
  route_idx: number;
  level: ScopeLevel;
  /** The variant shown (the Stops tab's line). */
  pattern_idx: number;
  /** Its direction's patterns. */
  direction: number[];
}

/** A level as the Apply bar offers it: the trips it takes; none, and why. */
export interface ScopeOption {
  level: ScopeLevel;
  trips: number;
  /** Why it takes none: none of its trips call there. */
  none?: "not_here";
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");

/** The trips of `scope` at `level` whose pattern calls at `stop_idx`. */
async function tripsAt(
  db: SqlRunner,
  scope: LineScope,
  level: ScopeLevel,
  stop_idx: number
): Promise<number[]> {
  const patterns =
    level === "variant"
      ? `pattern_idx = ${sqlNumber(scope.pattern_idx)}`
      : level === "direction"
        ? `pattern_idx IN (${list(scope.direction)})`
        : `route_idx = ${sqlNumber(scope.route_idx)}`;
  const where = `t.pattern_idx IN (SELECT pattern_idx FROM patterns WHERE ${patterns})`;
  return (
    await db.all<{ trip_idx: number }>(`
      SELECT t.trip_idx FROM trips t JOIN patterns p USING (pattern_idx)
      WHERE ${where} AND list_contains(p.stops, ${sqlNumber(stop_idx)}) ORDER BY t.trip_idx`)
  ).map((r) => r.trip_idx);
}

/** Every level, with the trips it would take a stop off. */
export async function removeScopeOptions(
  db: SqlRunner,
  scope: LineScope,
  stop_idx: number
): Promise<ScopeOption[]> {
  return Promise.all(
    SCOPE_LEVELS.map(async (level): Promise<ScopeOption> => {
      const trips = (await tripsAt(db, scope, level, stop_idx)).length;
      return trips ? { level, trips } : { level, trips, none: "not_here" };
    })
  );
}

export interface RemoveFromLineFacts extends DeleteStopFacts {
  route_idx: number;
  /** The line as riders know it: its number, else its name. */
  line: string;
  level: ScopeLevel;
}

/** 3.2: `stop_idx` off the trips `scope` takes. */
export async function removeFromLine(
  db: SqlRunner,
  stop_idx: number,
  scope: LineScope,
  shapeDistUnit: string | null
): Promise<Built<RemoveFromLineFacts>> {
  const [stop] = await db.all<{ stop_id: string; place: string; location_type: number }>(`
    SELECT s.stop_id, COALESCE(p.name, s.name, s.stop_id) AS place, COALESCE(s.location_type, 0) AS location_type
    FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx = ${sqlNumber(stop_idx)}`);
  if (!stop) throw new Error(`No stop ${stop_idx}`);
  const [route] = await db.all<{ line: string }>(`
    SELECT COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line FROM routes
    WHERE route_idx = ${sqlNumber(scope.route_idx)}`);
  const facts: RemoveFromLineFacts = {
    stop_id: stop.stop_id,
    name: stop.place,
    location_type: stop.location_type,
    entrances: 0,
    nodes: 0,
    platforms: 0,
    trips: 0,
    routes: [],
    patterns: 0,
    merged: 0,
    headsigns: 0,
    trip_idxs: [],
    route_idx: scope.route_idx,
    line: route?.line ?? "",
    level: scope.level,
  };
  const trips = await tripsAt(db, scope, scope.level, stop_idx);
  if (!trips.length)
    return { ok: false, refused: { code: "goat_scope_empty", severity: "error" }, facts, checks: [] };
  const built = await removeStops(db, [stop_idx], shapeDistUnit, facts, trips);
  return built.ok
    ? { ...built, facts, rows: { ...built.rows, kind: "line_stop_remove" } }
    : { ...built, facts };
}

// 3.1: a stop added to a line --------------------------------------------

/** How near a line's path a stop added to it lies on it: the path stays,
 * the stop placed where the path passes it (6 Nov 2026). */
export const ON_PATH_M = 15;

type LonLat = [number, number];

/** The patterns' condition for calling at `a` then `b` back to back (or, the
 * whole line, either way round: its other direction). */
function adjacent(a: number, b: number, eitherWay: boolean): string {
  const pair = (x: number, y: number) =>
    `list_contains(list_transform(range(1, len(p.stops)), k -> [p.stops[k], p.stops[k + 1]]), [${sqlNumber(x)}, ${sqlNumber(y)}])`;
  return eitherWay ? `(${pair(a, b)} OR ${pair(b, a)})` : pair(a, b);
}

/** The trips of `scope` at `level` that call at `a` then `b` back to back. */
export async function tripsBetween(
  db: SqlRunner,
  scope: LineScope,
  level: ScopeLevel,
  a: number,
  b: number
): Promise<number[]> {
  const where =
    level === "variant"
      ? `t.pattern_idx = ${sqlNumber(scope.pattern_idx)}`
      : level === "direction"
        ? `t.pattern_idx IN (${list(scope.direction)})`
        : `t.route_idx = ${sqlNumber(scope.route_idx)}`;
  return (
    await db.all<{ trip_idx: number }>(`
      SELECT t.trip_idx FROM trips t JOIN patterns p USING (pattern_idx)
      WHERE ${where} AND ${adjacent(a, b, level === "line")} ORDER BY t.trip_idx`)
  ).map((r) => r.trip_idx);
}

/** Every level, with the trips that would call at a stop added between `a`
 * and `b`. */
export async function addScopeOptions(
  db: SqlRunner,
  scope: LineScope,
  a: number,
  b: number
): Promise<ScopeOption[]> {
  return Promise.all(
    SCOPE_LEVELS.map(async (level): Promise<ScopeOption> => {
      const trips = (await tripsBetween(db, scope, level, a, b)).length;
      return trips ? { level, trips } : { level, trips, none: "not_here" };
    })
  );
}

export interface AddToLineFacts {
  stop_id: string;
  name: string;
  route_idx: number;
  line: string;
  level: ScopeLevel;
  trips: number;
  trip_idxs: number[];
  /** Where it lies off the path, in metres (the farthest, over the paths). */
  off_path_m: number;
  /** The paths drawn anew through it, for the map to preview (a move's). */
  paths: MoveStopFacts["paths"];
}

/** Where `x` is nearest the path `pts` between `lo` and `hi` metres along it:
 * the point, how far along, how far off. */
function nearestOn(
  pts: { lon: number; lat: number; d: number }[],
  x: LonLat,
  lo: number,
  hi: number
): { at: LonLat; d: number; off: number } | null {
  const k = Math.cos((x[1] * Math.PI) / 180) * 111_320;
  const xy = (lon: number, lat: number) => [(lon - x[0]) * k, (lat - x[1]) * 110_540];
  let best: { at: LonLat; d: number; off: number } | null = null;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    if (q.d < lo || p.d > hi) continue;
    const [px, py] = xy(p.lon, p.lat);
    const [qx, qy] = xy(q.lon, q.lat);
    const len = (qx - px) ** 2 + (qy - py) ** 2;
    // Within the segment, and within the stretch between the neighbours.
    const span = q.d - p.d;
    const fLo = span > 0 ? Math.max(0, (lo - p.d) / span) : 0;
    const fHi = span > 0 ? Math.min(1, (hi - p.d) / span) : 1;
    const f = Math.max(fLo, Math.min(fHi, len > 0 ? -(px * (qx - px) + py * (qy - py)) / len : 0));
    const d = p.d + f * span;
    const at: LonLat = [p.lon + f * (q.lon - p.lon), p.lat + f * (q.lat - p.lat)];
    const off = metres(at, x);
    if (!best || off < best.off) best = { at, d, off };
  }
  return best;
}

/** 3.1: `stop_idx` added between `a` and `b` for the trips `scope` takes:
 * untimed (6 Nov 2026: no time is made up), the trips' other times kept.
 * Within ON_PATH_M of the path it is placed where the path passes it; else
 * the path between `a` and `b` is drawn anew through it, straight or with
 * Snap along the streets, as a stop moved there from that point is (a
 * copy where another pattern runs the stretch without it). */
export async function addToLine(
  db: SqlRunner,
  stop_idx: number,
  a: number,
  b: number,
  scope: LineScope,
  shapeDistUnit: string | null,
  route?: Router
): Promise<Built<AddToLineFacts>> {
  const x = sqlNumber(stop_idx);
  const [stop] = await db.all<{
    stop_id: string;
    place: string;
    lon: number | null;
    lat: number | null;
    location_type: number;
  }>(`
    SELECT s.stop_id, COALESCE(p.name, s.name, s.stop_id) AS place, s.lon, s.lat,
           COALESCE(s.location_type, 0) AS location_type
    FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx = ${x}`);
  if (!stop) throw new Error(`No stop ${stop_idx}`);
  const [line] = await db.all<{ line: string }>(`
    SELECT COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line FROM routes
    WHERE route_idx = ${sqlNumber(scope.route_idx)}`);
  const facts: AddToLineFacts = {
    stop_id: stop.stop_id,
    name: stop.place,
    route_idx: scope.route_idx,
    line: line?.line ?? "",
    level: scope.level,
    trips: 0,
    trip_idxs: [],
    off_path_m: 0,
    paths: [],
  };
  const refuse = (code: string): Built<AddToLineFacts> => ({
    ok: false,
    refused: { code, severity: "error" },
    facts,
    checks: [],
  });
  // Only a stop or platform is called at; and not as its own neighbour.
  if (stop.location_type !== 0 || stop.lon === null || stop.lat === null)
    return refuse("goat_add_not_a_stop");
  if (stop_idx === a || stop_idx === b) return refuse("goat_add_neighbour");
  const to: LonLat = [stop.lon, stop.lat];
  const trips = await tripsBetween(db, scope, scope.level, a, b);
  if (!trips.length) return refuse("goat_scope_empty");
  facts.trips = trips.length;
  facts.trip_idxs = trips;
  const tripList = list(trips);
  const eitherWay = scope.level === "line";

  // Each pattern of those trips, the stop added after every call at `a`
  // followed by `b` (or the other way round); one only some of whose trips
  // are in scope split off, one that then runs as another of the line's
  // merged into it.
  const patterns = await db.all<{ pattern_idx: number; stops: ArrayLike<number>; n: number; going: number }>(`
    SELECT p.pattern_idx, p.stops,
           (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = p.pattern_idx) AS n,
           (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = p.pattern_idx AND t.trip_idx IN (${tripList})) AS going
    FROM patterns p WHERE p.pattern_idx IN (SELECT pattern_idx FROM trips WHERE trip_idx IN (${tripList}))
    ORDER BY p.pattern_idx`);
  const others = await db.all<{ pattern_idx: number; stops: ArrayLike<number> }>(`
    SELECT pattern_idx, stops FROM patterns WHERE route_idx = ${sqlNumber(scope.route_idx)}`);
  const known = new Map(others.map((p) => [Array.from(p.stops).join(","), p.pattern_idx]));
  let [{ nextPattern }] = await db.all<{ nextPattern: number }>(
    `SELECT CAST(COALESCE(max(pattern_idx) + 1, 0) AS INTEGER) AS nextPattern FROM patterns`
  );
  const sql: string[] = [];
  const touched = new Set<number>();
  /** Per pattern: where the stop goes in it (after these positions), and the
   * pattern its trips in scope run as now. */
  const changed: { pattern_idx: number; after: number[]; to: number; split: boolean }[] = [];
  for (const p of patterns) {
    const stops = Array.from(p.stops);
    const after = stops.flatMap((s, i) =>
      i + 1 < stops.length &&
      ((s === a && stops[i + 1] === b) || (eitherWay && s === b && stops[i + 1] === a))
        ? [i]
        : []
    );
    if (!after.length) continue;
    const added = stops.flatMap((s, i) => (after.includes(i) ? [s, stop_idx] : [s]));
    const key = added.join(",");
    let to = known.get(key);
    const split = p.going < p.n;
    if (to === undefined) {
      to = split ? nextPattern++ : p.pattern_idx;
      known.set(key, to);
      if (split)
        sql.push(
          `INSERT INTO patterns SELECT * REPLACE (${sqlNumber(to)} AS pattern_idx, [${list(added)}]::INTEGER[] AS stops,
             ${added.length} AS n_stops) FROM patterns WHERE pattern_idx = ${sqlNumber(p.pattern_idx)}`
        );
      else
        sql.push(
          `UPDATE patterns SET stops = [${list(added)}]::INTEGER[], n_stops = ${added.length}
           WHERE pattern_idx = ${sqlNumber(p.pattern_idx)}`
        );
    }
    changed.push({ pattern_idx: p.pattern_idx, after, to, split });
    touched.add(p.pattern_idx).add(to);
  }

  // Their places on the paths their trips run: the stop where the path
  // passes nearest it between its neighbours; the stops past it one on.
  const shapes = await db.all<{ pattern_idx: number; shape_idx: number }>(`
    SELECT DISTINCT pattern_idx, shape_idx FROM trips
    WHERE trip_idx IN (${tripList}) AND shape_idx IS NOT NULL ORDER BY 1, 2`);
  const off: { pattern: number; from: LonLat }[] = [];
  let chained = false;
  for (const c of changed) {
    for (const { shape_idx } of shapes.filter((s) => s.pattern_idx === c.pattern_idx)) {
      const s = sqlNumber(shape_idx);
      const [meta] = await db.all<{ shape_id: string }>(
        `SELECT shape_id FROM shapes_meta WHERE shape_idx = ${s}`
      );
      if (meta?.shape_id.startsWith(STOP_CHAIN_PREFIX)) chained = true;
      const placed = await db.all<{ i: number; d: number }>(`
        SELECT i, d FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(c.pattern_idx)} AND shape_idx = ${s} ORDER BY i`);
      const pts = await db.all<{ lon: number; lat: number; d: number }>(
        `SELECT lon, lat, d FROM shape_points WHERE shape_idx = ${s} ORDER BY i`
      );
      const at = (i: number) => placed.find((r) => r.i === i)?.d ?? null;
      const rows = c.after.flatMap((i) => {
        const lo = at(i);
        const hi = at(i + 1);
        if (lo === null || hi === null) return [];
        const near = nearestOn(pts, to, Math.min(lo, hi), Math.max(lo, hi));
        if (!near) return [];
        facts.off_path_m = Math.max(facts.off_path_m, near.off);
        if (near.off > ON_PATH_M) off.push({ pattern: c.to, from: near.at });
        return [
          `(${sqlNumber(c.to)}, ${s}, ${i + 1 + c.after.filter((k) => k < i).length}, ${sqlNumber(near.d)})`,
        ];
      });
      // The stops past each place it goes in, one on.
      const kept = placed.map(
        (r) => `(${sqlNumber(c.to)}, ${s}, ${r.i + c.after.filter((k) => k < r.i).length}, ${sqlNumber(r.d)})`
      );
      sql.push(`DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(c.to)} AND shape_idx = ${s}`);
      if (placed.length) sql.push(`INSERT INTO pattern_shape_stops VALUES ${[...kept, ...rows].join(", ")}`);
    }
  }

  // The stop times: one at the stop, untimed and with no distance along the
  // path (neither is made up), after the call at its neighbour; room made
  // where the two are numbered one apart.
  const calls = await db.all<{
    trip_idx: number;
    trip_id: string;
    seq: number;
    next_seq: number;
    dist: number | null;
    next_dist: number | null;
  }>(`
    SELECT trip_idx, trip_id, seq, next_seq, dist, next_dist FROM (
      SELECT st.trip_idx, t.trip_id, st.stop_sequence AS seq, st.shape_dist AS dist, st.stop_idx,
             lead(st.stop_idx) OVER w AS next_stop, lead(st.stop_sequence) OVER w AS next_seq,
             lead(st.shape_dist) OVER w AS next_dist
      FROM stop_times st JOIN trips t USING (trip_idx)
      WHERE st.trip_idx IN (${tripList})
      WINDOW w AS (PARTITION BY st.trip_idx ORDER BY st.stop_sequence)
    )
    WHERE (stop_idx = ${sqlNumber(a)} AND next_stop = ${sqlNumber(b)})
       ${eitherWay ? `OR (stop_idx = ${sqlNumber(b)} AND next_stop = ${sqlNumber(a)})` : ""}
    QUALIFY row_number() OVER (PARTITION BY trip_idx ORDER BY seq) = 1
    ORDER BY trip_idx`);
  const tight = calls.filter((c) => c.next_seq - c.seq < 2);
  if (tight.length) {
    const room = `CASE trip_idx ${tight.map((c) => `WHEN ${c.trip_idx} THEN ${c.seq}`).join(" ")} END`;
    const where = `trip_idx IN (${list(tight.map((c) => c.trip_idx))}) AND stop_sequence > ${room}`;
    sql.push(
      `UPDATE stop_time_extras SET stop_sequence = stop_sequence + 1 WHERE ${where}`,
      `UPDATE stop_times SET stop_sequence = stop_sequence + 1 WHERE ${where}`
    );
  }
  sql.push(
    `INSERT INTO stop_times (trip_idx, stop_sequence, stop_idx, arrival_s, departure_s, shape_dist) VALUES ${calls
      .map((c) => `(${c.trip_idx}, ${c.seq + 1}, ${x}, NULL, NULL, NULL)`)
      .join(", ")}`
  );
  const gtfs: GtfsRowOp[] = calls.flatMap((c): GtfsRowOp[] => [
    ...(c.next_seq - c.seq < 2
      ? [{ role: "stop_times" as const, op: "shift" as const, key: { trip_id: c.trip_id }, after: c.seq }]
      : []),
    {
      role: "stop_times",
      op: "insert",
      key: { trip_id: c.trip_id, stop_sequence: c.seq + 1 },
      values: { stop_id: stop.stop_id },
    },
  ]);
  // The trips onto the pattern they now run as; one left with none goes.
  for (const c of changed)
    if (c.to !== c.pattern_idx) {
      sql.push(
        `UPDATE trips SET pattern_idx = ${sqlNumber(c.to)}
         WHERE pattern_idx = ${sqlNumber(c.pattern_idx)} AND trip_idx IN (${tripList})`
      );
      if (!c.split)
        sql.push(
          `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(c.pattern_idx)}`,
          `DELETE FROM patterns WHERE pattern_idx = ${sqlNumber(c.pattern_idx)}`
        );
    }
  const pats = list([...touched]);
  sql.push(
    `UPDATE patterns SET
       n_trips = (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = patterns.pattern_idx)
     WHERE pattern_idx IN (${pats})`
  );
  const touches: Touch[] = [
    { table: "stop_times", where: `trip_idx IN (${tripList})` },
    { table: "stop_time_extras", where: `trip_idx IN (${tripList})` },
    { table: "trips", where: `trip_idx IN (${tripList})` },
    { table: "patterns", where: `pattern_idx IN (${pats})` },
    { table: "pattern_shape_stops", where: `pattern_idx IN (${pats})` },
  ];
  let rows: ChangeRows = { kind: "line_stop_add", touches, sql, gtfs };

  // Off the path, or a line drawn through its stops: drawn anew through it,
  // as a stop moved there from where the path passes nearest.
  if ((off.length || chained) && db.fork) {
    const fork = await db.fork();
    try {
      await fork.exec("BEGIN TRANSACTION");
      try {
        for (const statement of sql) await fork.exec(statement);
        const only = [
          ...new Set([...off.map((o) => o.pattern), ...(chained ? changed.map((c) => c.to) : [])]),
        ];
        const moved = await moveStop(fork, stop_idx, to, shapeDistUnit, route, {
          from: off[0]?.from ?? [to[0] + 0.0001, to[1]],
          only,
          stopToStop: true,
        });
        if (!moved.ok) return { ...moved, facts } as Built<AddToLineFacts>;
        facts.paths = moved.facts.paths;
        rows = {
          ...rows,
          sql: [...sql, ...moved.rows.sql],
          touches: [...touches, ...moved.rows.touches],
          // Not a move: the stop stays where it is.
          gtfs: [...gtfs, ...moved.rows.gtfs.filter((o) => o.role !== "stops")],
          shapes: moved.rows.shapes,
        };
        return { ok: true, facts, checks: moved.checks, rows };
      } finally {
        await fork.exec("ROLLBACK");
      }
    } finally {
      await fork.close();
    }
  }
  return { ok: true, facts, checks: [], rows };
}

// 1.4: a line cut back ------------------------------------------------------

/** Which way a line is cut back at a stop: it ends there, or starts there. */
export type CutEnd = "end" | "start";

export interface CutLineFacts {
  stop_id: string;
  name: string;
  route_idx: number;
  line: string;
  level: ScopeLevel;
  end: CutEnd;
  trips: number;
  trip_idxs: number[];
  /** The most stops a trip no longer calls at. */
  dropped: number;
  /** The paths the trips run, for the map to preview: kept as they are
   * (they stay), the part past the cut drawn faint. */
  paths: MoveStopFacts["paths"];
}

/** 1.4: the trips `scope` takes cut back at `stop_idx`: ending there, every
 * stop after it gone, or starting there, every stop before it. The stops
 * stay, as do the paths (a shape may run on past a trip's ends) and every
 * other time; a trip that was headed for its old end is headed for the new
 * one. Refused where a trip would keep fewer than two stops, its new end has
 * no time, or a frequency-based trip would lose the first stop its runs are
 * timed from. At its first call there, where a trip calls twice. */
export async function cutLine(
  db: SqlRunner,
  stop_idx: number,
  end: CutEnd,
  scope: LineScope,
  shapeDistUnit: string | null
): Promise<Built<CutLineFacts>> {
  const x = sqlNumber(stop_idx);
  const [stop] = await db.all<{ stop_id: string; place: string }>(`
    SELECT s.stop_id, COALESCE(p.name, s.name, s.stop_id) AS place
    FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx = ${x}`);
  if (!stop) throw new Error(`No stop ${stop_idx}`);
  const [line] = await db.all<{ line: string }>(`
    SELECT COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line FROM routes
    WHERE route_idx = ${sqlNumber(scope.route_idx)}`);
  const facts: CutLineFacts = {
    stop_id: stop.stop_id,
    name: stop.place,
    route_idx: scope.route_idx,
    line: line?.line ?? "",
    level: scope.level,
    end,
    trips: 0,
    trip_idxs: [],
    dropped: 0,
    paths: [],
  };
  const refuse = (code: string, count?: number): Built<CutLineFacts> => ({
    ok: false,
    refused: { code, severity: "error", ...(count === undefined ? {} : { params: { count } }) },
    facts,
    checks: [],
  });
  const trips = await tripsAt(db, scope, scope.level, stop_idx);
  if (!trips.length) return refuse("goat_scope_empty");
  facts.trips = trips.length;
  facts.trip_idxs = trips;
  const tripList = list(trips);

  // Each trip's call there, what it keeps, and whether its new end is timed.
  const calls = await db.all<{
    trip_idx: number;
    trip_id: string;
    seq: number;
    kept: number;
    dropped: number;
    arr: number | null;
    dep: number | null;
    frequency: boolean;
    headsign: string | null;
    old_end: string | null;
  }>(`
    WITH c AS (
      SELECT st.trip_idx, st.stop_sequence, st.stop_idx, st.arrival_s, st.departure_s,
             COALESCE(p.name, s.name, s.stop_id) AS place
      FROM stop_times st JOIN stops s USING (stop_idx) LEFT JOIN stops p ON p.stop_idx = s.parent_idx
      WHERE st.trip_idx IN (${tripList})
    ),
    here AS (
      SELECT trip_idx, min(stop_sequence) AS seq FROM c WHERE stop_idx = ${x} GROUP BY trip_idx
    )
    SELECT h.trip_idx, t.trip_id, h.seq,
           CAST(count(*) FILTER (WHERE ${end === "end" ? "c.stop_sequence <= h.seq" : "c.stop_sequence >= h.seq"}) AS INTEGER) AS kept,
           CAST(count(*) FILTER (WHERE ${end === "end" ? "c.stop_sequence > h.seq" : "c.stop_sequence < h.seq"}) AS INTEGER) AS dropped,
           any_value(c.arrival_s) FILTER (WHERE c.stop_sequence = h.seq) AS arr,
           any_value(c.departure_s) FILTER (WHERE c.stop_sequence = h.seq) AS dep,
           h.trip_idx IN (SELECT trip_idx FROM frequencies) AS frequency,
           t.headsign, arg_max(c.place, c.stop_sequence) AS old_end
    FROM here h JOIN c USING (trip_idx) JOIN trips t ON t.trip_idx = h.trip_idx
    GROUP BY h.trip_idx, t.trip_id, h.seq, t.headsign
    ORDER BY h.trip_idx`);
  facts.dropped = Math.max(0, ...calls.map((c) => c.dropped));
  if (!facts.dropped) return refuse("goat_cut_nothing");
  const short = calls.filter((c) => c.kept < 2);
  if (short.length) return refuse("unusable_trip", short.length);
  const untimed = calls.filter((c) => c.dropped > 0 && (end === "end" ? c.arr === null : c.dep === null));
  if (untimed.length) return refuse("missing_trip_edge", untimed.length);
  if (end === "start") {
    const frequency = calls.filter((c) => c.frequency && c.dropped > 0);
    if (frequency.length) return refuse("goat_frequency_start", frequency.length);
  }

  // The trips' patterns, cut at their first call there; one only some of
  // whose trips are in scope split off, one that then runs as another of the
  // line's merged into it.
  const patterns = await db.all<{ pattern_idx: number; stops: ArrayLike<number>; n: number; going: number }>(`
    SELECT p.pattern_idx, p.stops,
           (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = p.pattern_idx) AS n,
           (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = p.pattern_idx AND t.trip_idx IN (${tripList})) AS going
    FROM patterns p WHERE p.pattern_idx IN (SELECT pattern_idx FROM trips WHERE trip_idx IN (${tripList}))
    ORDER BY p.pattern_idx`);
  const others = await db.all<{ pattern_idx: number; stops: ArrayLike<number> }>(`
    SELECT pattern_idx, stops FROM patterns WHERE route_idx = ${sqlNumber(scope.route_idx)}`);
  const known = new Map(others.map((p) => [Array.from(p.stops).join(","), p.pattern_idx]));
  let [{ nextPattern }] = await db.all<{ nextPattern: number }>(
    `SELECT CAST(COALESCE(max(pattern_idx) + 1, 0) AS INTEGER) AS nextPattern FROM patterns`
  );
  const sql: string[] = [];
  const touched = new Set<number>();
  for (const p of patterns) {
    const stops = Array.from(p.stops);
    const at = stops.indexOf(stop_idx);
    if (at < 0) continue;
    const cut = end === "end" ? stops.slice(0, at + 1) : stops.slice(at);
    if (cut.length === stops.length) continue;
    const key = cut.join(",");
    const split = p.going < p.n;
    let to = known.get(key);
    const idx = sqlNumber(p.pattern_idx);
    if (to === undefined) {
      to = split ? nextPattern++ : p.pattern_idx;
      known.set(key, to);
      sql.push(
        split
          ? `INSERT INTO patterns SELECT * REPLACE (${sqlNumber(to)} AS pattern_idx, [${list(cut)}]::INTEGER[] AS stops,
               ${cut.length} AS n_stops) FROM patterns WHERE pattern_idx = ${idx}`
          : `UPDATE patterns SET stops = [${list(cut)}]::INTEGER[], n_stops = ${cut.length} WHERE pattern_idx = ${idx}`
      );
    }
    touched.add(p.pattern_idx).add(to);
    // Its places on the paths its trips in scope run, the cut stops left out.
    const [lo, hi] = end === "end" ? [0, at] : [at, stops.length - 1];
    const t = sqlNumber(to);
    const shapes = `(SELECT shape_idx FROM trips WHERE trip_idx IN (${tripList}) AND pattern_idx = ${idx})`;
    if (to === p.pattern_idx)
      sql.push(
        `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${idx} AND (i < ${lo} OR i > ${hi})`,
        `UPDATE pattern_shape_stops SET i = i - ${lo} WHERE pattern_idx = ${idx}`
      );
    else
      sql.push(
        `INSERT INTO pattern_shape_stops SELECT ${t}, shape_idx, i - ${lo}, d FROM pattern_shape_stops
         WHERE pattern_idx = ${idx} AND i BETWEEN ${lo} AND ${hi} AND shape_idx IN ${shapes}
           AND shape_idx NOT IN (SELECT shape_idx FROM pattern_shape_stops WHERE pattern_idx = ${t})`,
        `UPDATE trips SET pattern_idx = ${t} WHERE pattern_idx = ${idx} AND trip_idx IN (${tripList})`
      );
    if (to !== p.pattern_idx && !split)
      sql.push(
        `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${idx}`,
        `DELETE FROM patterns WHERE pattern_idx = ${idx}`
      );
  }

  // For the map: each path the trips run, faint past the cut.
  const [route] = await db.all<{ color: string | null; route_type: number | null }>(
    `SELECT color, route_type FROM routes WHERE route_idx = ${sqlNumber(scope.route_idx)}`
  );
  const color = routeColor(route?.color ?? null, modeOf(route?.route_type ?? null));
  const places = await db.all<{ shape_idx: number; shape_id: string; d: number }>(`
    SELECT DISTINCT ps.shape_idx, m.shape_id, ps.d FROM pattern_shape_stops ps
    JOIN patterns p USING (pattern_idx) JOIN shapes_meta m USING (shape_idx)
    WHERE ps.pattern_idx IN (SELECT pattern_idx FROM trips WHERE trip_idx IN (${tripList}))
      AND ps.shape_idx IN (SELECT shape_idx FROM trips WHERE trip_idx IN (${tripList}))
      AND p.stops[ps.i + 1] = ${x} AND ps.d IS NOT NULL`);
  for (const pl of places) {
    if (facts.paths.some((q) => q.shape_idx === pl.shape_idx)) continue;
    const pts = await db.all<{ lon: number; lat: number; d: number }>(
      `SELECT lon, lat, d FROM shape_points WHERE shape_idx = ${sqlNumber(pl.shape_idx)} ORDER BY i`
    );
    if (pts.length < 2) continue;
    facts.paths.push({
      shape_idx: pl.shape_idx,
      color,
      coordinates: pts.map((q) => [q.lon, q.lat]),
      drawn: [],
      replaces: pl.shape_id,
      old: cutPath(pts, [end === "end" ? { a: pl.d, b: null } : { a: null, b: pl.d }]),
    });
  }

  // The stop times past the cut, and their extras.
  const cutAt = `CASE trip_idx ${calls.map((c) => `WHEN ${c.trip_idx} THEN ${c.seq}`).join(" ")} END`;
  const gone = `trip_idx IN (${tripList}) AND stop_sequence ${end === "end" ? ">" : "<"} ${cutAt}`;
  const rows = await db.all<{ trip_id: string; stop_sequence: number }>(`
    SELECT DISTINCT t.trip_id, st.trip_idx, st.stop_sequence FROM stop_times st JOIN trips t USING (trip_idx)
    WHERE ${gone.replaceAll("trip_idx", "st.trip_idx").replaceAll("stop_sequence", "st.stop_sequence")}
    ORDER BY st.trip_idx, st.stop_sequence`);
  sql.push(`DELETE FROM stop_time_extras WHERE ${gone}`, `DELETE FROM stop_times WHERE ${gone}`);
  sql.push(tripFiguresSql(tripList, shapeDistUnit));
  // A trip measured along its whole path runs part of it now: from its
  // first stop's place on the path to its last's.
  sql.push(`UPDATE trips SET length_m = (
      SELECT CAST(max(d) - min(d) AS REAL) FROM pattern_shape_stops ps
      WHERE ps.pattern_idx = trips.pattern_idx AND ps.shape_idx = trips.shape_idx)
    WHERE trip_idx IN (${tripList}) AND length_src = 2`);
  const pats = list([...touched]);
  sql.push(
    `UPDATE patterns SET
       n_trips = (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = patterns.pattern_idx),
       length_m = (SELECT CAST(median(t.length_m) AS REAL) FROM trips t WHERE t.pattern_idx = patterns.pattern_idx)
     WHERE pattern_idx IN (${pats})`
  );
  const gtfs: GtfsRowOp[] = rows.map((r) => ({
    role: "stop_times",
    op: "delete",
    key: { trip_id: r.trip_id, stop_sequence: r.stop_sequence },
  }));
  // Headed for its old end: now for the stop it ends at.
  if (end === "end")
    for (const c of calls)
      if (c.dropped > 0 && c.headsign !== null && c.headsign === c.old_end) {
        sql.push(
          `UPDATE trips SET headsign = ${sqlText(stop.place)} WHERE trip_idx = ${sqlNumber(c.trip_idx)}`
        );
        gtfs.push({
          role: "trips",
          op: "update",
          key: { trip_id: c.trip_id },
          values: { trip_headsign: stop.place },
        });
      }
  const touches: Touch[] = [
    { table: "stop_times", where: `trip_idx IN (${tripList})` },
    { table: "stop_time_extras", where: `trip_idx IN (${tripList})` },
    { table: "trips", where: `trip_idx IN (${tripList})` },
    { table: "patterns", where: `pattern_idx IN (${pats})` },
    { table: "pattern_shape_stops", where: `pattern_idx IN (${pats})` },
  ];
  return { ok: true, facts, checks: [], rows: { kind: "line_cut", touches, sql, gtfs } };
}
