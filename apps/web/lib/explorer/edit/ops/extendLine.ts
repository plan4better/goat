/**
 * 1.3 Extend a line (01-editing-operations § 1): stops added beyond one end
 * of the line, for the trips the scope takes that end (or start) there.
 * `adds` runs outward from the terminus: at the start, the last one is the
 * new first stop.
 *
 * Times (decided 8 Nov 2026): a trip's ends must be timed, so the new end
 * stop is timed from the line's own average speed in that direction (its
 * trips' lengths over their running times, from the feed), as far along the
 * new path as it lies from the old terminus, to the minute; the stops in
 * between stay untimed, as a stop added to a line does (no time is made up
 * where the feed's own speed does not give it). The old terminus keeps its
 * time. A trip headed for the old terminus is headed for the new one.
 *
 * The path runs on from the old terminus through the new stops: straight,
 * or with Snap along the streets for a line on them. A path other trips run
 * too (outside the scope, or on past the terminus) is not changed for them:
 * the trips extended get their own copy (`<id>_goat<n>`).
 *
 * Refused where no trip of the scope ends there, the line has no speed to
 * time from, a new first stop would be before midnight, or (at the start) a
 * trip is frequency-based: its runs are timed from its first stop.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { METRES_PER_UNIT } from "@/lib/explorer/derive/stopsLine";
import { STOP_CHAIN_PREFIX, chainId, chainShapeSql, chainStopsSql } from "@/lib/explorer/edit/ops/chains";
import { gtfsTime } from "@/lib/explorer/edit/ops/deleteLine";
import { metres } from "@/lib/explorer/edit/ops/geo";
import type { LineScope, ScopeLevel, ScopeOption } from "@/lib/explorer/edit/ops/lineStops";
import { SCOPE_LEVELS } from "@/lib/explorer/edit/ops/lineStops";
import {
  type MoveStopFacts,
  ROAD_MODES,
  type Router,
  along,
  cutAt,
  forkId,
  lengthsSql,
  plausible,
  splice,
} from "@/lib/explorer/edit/ops/moveStop";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, ShapeStretch, Touch } from "@/lib/explorer/edit/types";
import { modeOf, routeColor } from "@/lib/explorer/modes";

type LonLat = [number, number];
export type LineEnd = "end" | "start";

export interface ExtendLineFacts {
  route_idx: number;
  line: string;
  level: ScopeLevel;
  /** The old terminus, and the new one. */
  from_name: string;
  to_name: string;
  trips: number;
  trip_idxs: number[];
  /** The line's average speed in that direction, km/h, the new end timed from. */
  speed_kmh: number;
  /** How far the new end lies beyond the old, along the new path (the path
   * most trips run), and how long it takes at that speed, in seconds. */
  metres: number;
  seconds: number;
  forked: number;
  paths: MoveStopFacts["paths"];
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");
const round = (x: number) => Math.round(x * 10) / 10;

/** The trips of `scope` at `level` whose pattern ends (or starts) at `stop_idx`. */
async function tripsAtEnd(
  db: SqlRunner,
  scope: LineScope,
  level: ScopeLevel,
  stop_idx: number,
  end: LineEnd
): Promise<number[]> {
  const where =
    level === "variant"
      ? `t.pattern_idx = ${sqlNumber(scope.pattern_idx)}`
      : level === "direction"
        ? `t.pattern_idx IN (${list(scope.direction)})`
        : `t.route_idx = ${sqlNumber(scope.route_idx)}`;
  const at = end === "end" ? "p.stops[len(p.stops)]" : "p.stops[1]";
  return (
    await db.all<{ trip_idx: number }>(`
      SELECT t.trip_idx FROM trips t JOIN patterns p USING (pattern_idx)
      WHERE ${where} AND ${at} = ${sqlNumber(stop_idx)} ORDER BY t.trip_idx`)
  ).map((r) => r.trip_idx);
}

/** Every level, with the trips a line extended from `stop_idx` would take. */
export async function extendScopeOptions(
  db: SqlRunner,
  scope: LineScope,
  stop_idx: number,
  end: LineEnd
): Promise<ScopeOption[]> {
  return Promise.all(
    SCOPE_LEVELS.map(async (level): Promise<ScopeOption> => {
      const trips = (await tripsAtEnd(db, scope, level, stop_idx, end)).length;
      return trips ? { level, trips } : { level, trips, none: "not_here" };
    })
  );
}

/** Where along `line` each of `points` lies (the nearest vertex on from the
 * one before), in metres from its start. */
export function placesOn(line: LonLat[], points: LonLat[]): number[] {
  const at = [0];
  for (let k = 1; k < line.length; k++) at.push(at[k - 1] + metres(line[k - 1], line[k]));
  let from = 0;
  return points.map((p) => {
    let best = from;
    for (let k = from; k < line.length; k++) if (metres(line[k], p) < metres(line[best], p)) best = k;
    from = best;
    return at[best];
  });
}

export async function extendLine(
  db: SqlRunner,
  terminus: number,
  end: LineEnd,
  adds: number[],
  scope: LineScope,
  shapeDistUnit: string | null,
  route?: Router
): Promise<Built<ExtendLineFacts>> {
  const stopRows = await db.all<{
    stop_idx: number;
    stop_id: string;
    place: string;
    lon: number | null;
    lat: number | null;
    location_type: number;
  }>(`
    SELECT s.stop_idx, s.stop_id, COALESCE(p.name, s.name, s.stop_id) AS place, s.lon, s.lat,
           COALESCE(s.location_type, 0) AS location_type
    FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx
    WHERE s.stop_idx IN (${list([terminus, ...adds])})`);
  const stopOf = new Map(stopRows.map((s) => [s.stop_idx, s]));
  const [line] = await db.all<{ line: string; route_type: number | null; color: string | null }>(`
    SELECT COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line, route_type, color FROM routes
    WHERE route_idx = ${sqlNumber(scope.route_idx)}`);
  const last = adds.length ? stopOf.get(adds[adds.length - 1]) : undefined;
  const facts: ExtendLineFacts = {
    route_idx: scope.route_idx,
    line: line?.line ?? "",
    level: scope.level,
    from_name: stopOf.get(terminus)?.place ?? "",
    to_name: last?.place ?? "",
    trips: 0,
    trip_idxs: [],
    speed_kmh: 0,
    metres: 0,
    seconds: 0,
    forked: 0,
    paths: [],
  };
  const refuse = (code: string, params?: Check["params"]): Built<ExtendLineFacts> => ({
    ok: false,
    refused: { code, severity: "error", ...(params ? { params } : {}) },
    facts,
    checks: [],
  });
  const trips = await tripsAtEnd(db, scope, scope.level, terminus, end);
  if (!trips.length) return refuse("goat_scope_empty");
  facts.trips = trips.length;
  facts.trip_idxs = trips;

  // The line's speed in that direction: its trips' lengths over their times.
  const [speed] = await db.all<{ v: number | null }>(`
    SELECT sum(length_m) / sum(last_arr_s - first_dep_s) AS v FROM trips
    WHERE pattern_idx IN (${list(scope.direction)}) AND length_m > 0
      AND last_arr_s > first_dep_s`);
  const v = speed?.v ?? null;
  if (!v || !(v > 0)) return refuse("goat_extend_no_speed");
  facts.speed_kmh = Math.round(v * 3.6);
  const checks: Check[] = [];
  if (!adds.length)
    return { ok: true, facts, checks, rows: { kind: "line_extend", touches: [], sql: [], gtfs: [] } };

  // Only stops or platforms, placed, each another than the one before it.
  for (const [k, a] of adds.entries()) {
    const s = stopOf.get(a);
    if (!s || s.location_type !== 0 || s.lon === null || s.lat === null) return refuse("goat_add_not_a_stop");
    if (a === (k ? adds[k - 1] : terminus)) return refuse("goat_add_neighbour");
  }
  const tripList = list(trips);
  if (end === "start") {
    const [freq] = await db.all(`SELECT 1 FROM frequencies WHERE trip_idx IN (${tripList}) LIMIT 1`);
    if (freq) return refuse("goat_frequency_start", { count: 1 });
  }
  const at = (s: number): LonLat => {
    const r = stopOf.get(s);
    return [r?.lon as number, r?.lat as number];
  };
  const term = stopOf.get(terminus);
  const termAt: LonLat | null = term && term.lon !== null && term.lat !== null ? [term.lon, term.lat] : null;

  // The trips' patterns, each with the stops added at that end; one only
  // some of whose trips go on split off, one that then runs as another of
  // the line's merged into it.
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
  const k = adds.length;
  // In the trips' order: at the start, the farthest first.
  const added = end === "end" ? adds : [...adds].reverse();
  const sql: string[] = [];
  const touched = new Set<number>();
  const moved = new Map<number, number>();
  const stopsOf = new Map<number, number[]>();
  for (const p of patterns) {
    const stops = Array.from(p.stops);
    const next = end === "end" ? [...stops, ...added] : [...added, ...stops];
    stopsOf.set(p.pattern_idx, next);
    const key = next.join(",");
    let to = known.get(key);
    const split = p.going < p.n;
    if (to === undefined) {
      to = split ? nextPattern++ : p.pattern_idx;
      known.set(key, to);
      if (split)
        sql.push(
          `INSERT INTO patterns SELECT * REPLACE (${sqlNumber(to)} AS pattern_idx, [${list(next)}]::INTEGER[] AS stops,
             ${next.length} AS n_stops) FROM patterns WHERE pattern_idx = ${sqlNumber(p.pattern_idx)}`
        );
      else
        sql.push(
          `UPDATE patterns SET stops = [${list(next)}]::INTEGER[], n_stops = ${next.length}
           WHERE pattern_idx = ${sqlNumber(p.pattern_idx)}`
        );
    }
    moved.set(p.pattern_idx, to);
    touched.add(p.pattern_idx).add(to);
  }

  // The paths: each runs on from the terminus through the new stops.
  const color = routeColor(line?.color ?? null, modeOf(line?.route_type ?? null));
  const routed = !!route && ROAD_MODES.has(modeOf(line?.route_type ?? null));
  const roads = new Map<string, Promise<LonLat[] | null>>();
  const road = (waypoints: LonLat[]): Promise<LonLat[] | null> => {
    const key = waypoints.map((p) => p.map(round).join(",")).join(";");
    let found = roads.get(key);
    if (!found) {
      found = (route as Router)(waypoints)
        .then((r) => (r && r.line.length > 1 && plausible(waypoints, r.line) ? r.line : null))
        .catch(() => null);
      roads.set(key, found);
    }
    return found;
  };
  let unrouted = false;
  const perUnit = shapeDistUnit ? METRES_PER_UNIT[shapeDistUnit] : undefined;
  let [{ next }] = await db.all<{ next: number }>(
    "SELECT CAST(COALESCE(max(shape_idx) + 1, 0) AS INTEGER) AS next FROM shapes_meta"
  );
  const issued = new Set<string>();
  const gtfs: GtfsRowOp[] = [];
  const touchedShapes = new Set<number>();
  const taken = new Set(trips);
  const tripRows = await db.all<{
    trip_idx: number;
    trip_id: string;
    pattern_idx: number;
    shape_idx: number | null;
    headsign: string | null;
  }>(`SELECT trip_idx, trip_id, pattern_idx, shape_idx, headsign FROM trips WHERE trip_idx IN (${tripList})`);
  /** Per trip: how far along its new path each added stop lies past the
   * terminus (end), or before it (start), in metres. */
  const reach = new Map<number, number[]>();
  let most = -1;
  const shapeIdxs = [...new Set(tripRows.flatMap((t) => (t.shape_idx === null ? [] : [t.shape_idx])))];
  const shapes = await db.all<{ shape_idx: number; shape_id: string }>(`
    SELECT shape_idx, shape_id FROM shapes_meta WHERE shape_idx IN (${list(shapeIdxs)})`);
  const chained = shapes.filter((x) => x.shape_id.startsWith(STOP_CHAIN_PREFIX));
  for (const shape of shapes) {
    const s = shape.shape_idx;
    const sIdx = sqlNumber(s);
    // A path through the stops: drawn again through the new ones below.
    if (chained.includes(shape)) continue;
    const pts = await db.all<{ lon: number; lat: number; d: number }>(
      `SELECT lon, lat, d FROM shape_points WHERE shape_idx = ${sIdx} ORDER BY i`
    );
    if (pts.length < 2) continue;
    const length = pts[pts.length - 1].d;
    const placed = await db.all<{ pattern_idx: number; i: number; d: number | null }>(`
      SELECT pattern_idx, i, d FROM pattern_shape_stops WHERE shape_idx = ${sIdx}`);
    const mine = tripRows.filter((t) => t.shape_idx === s);
    // The terminus on the path, per pattern: its last (first) place.
    const termOf = (p: number): number | null => {
      const rows = placed.filter((r) => r.pattern_idx === p && r.d !== null).sort((x, y) => x.i - y.i);
      const r = end === "end" ? rows[rows.length - 1] : rows[0];
      return r ? (r.d as number) : null;
    };
    const groups = new Map<string, { d: number; patterns: number[] }>();
    for (const p of [...new Set(mine.map((t) => t.pattern_idx))]) {
      const d = termOf(p);
      if (d === null) continue;
      const key = String(round(d));
      const g = groups.get(key);
      if (g) g.patterns.push(p);
      else groups.set(key, { d, patterns: [p] });
    }
    const onShape = await db.all<{ trip_idx: number; trip_id: string; pattern_idx: number }>(
      `SELECT trip_idx, trip_id, pattern_idx FROM trips WHERE shape_idx = ${sIdx} ORDER BY trip_idx`
    );
    // In place only where every trip on it goes on and it ends (starts) there.
    const alone = onShape.every((t) => taken.has(t.trip_idx)) && groups.size === 1;
    for (const g of groups.values()) {
      const inPlace = alone && (end === "end" ? length - g.d < 1 : g.d < 1);
      const from = along(pts, g.d);
      // The way the trips run: from the terminus out, or in to it (one-way
      // streets the router keeps to).
      const wps = end === "end" ? [from, ...adds.map(at)] : [...adds.map(at)].reverse().concat([from]);
      let way: LonLat[] = wps;
      if (routed) {
        const r = await road(wps);
        if (r) way = r;
        else unrouted = true;
      }
      const pl = placesOn(way, wps);
      // How far each added stop lies from the terminus, along the way.
      const dists = adds.map((_, j) => (end === "end" ? pl[j + 1] - pl[0] : pl[k] - pl[k - 1 - j]));
      const stretch =
        end === "end"
          ? { a: g.d, b: null, via: { points: way.slice(1), stop: 0 } }
          : { a: null, b: g.d, via: { points: way.slice(0, -1), stop: 0 } };
      const sp = splice(pts, [stretch], from);
      const going = mine.filter((t) => g.patterns.includes(t.pattern_idx));
      let target = s;
      let targetId = shape.shape_id;
      if (!inPlace) {
        target = next++;
        facts.forked++;
        targetId = await forkId(db, shape.shape_id, issued);
        sql.push(
          `INSERT INTO shapes_meta VALUES (${sqlNumber(target)}, ${sqlText(targetId)}, NULL)`,
          `INSERT INTO shape_route VALUES (${sqlNumber(target)}, ${sqlNumber(scope.route_idx)})`,
          `UPDATE trips SET shape_idx = ${sqlNumber(target)} WHERE trip_idx IN (${list(going.map((t) => t.trip_idx))})`
        );
        for (const t of going)
          gtfs.push({
            role: "trips",
            op: "update",
            key: { trip_id: t.trip_id },
            values: { shape_id: targetId },
          });
      }
      touchedShapes.add(target);
      const tIdx = sqlNumber(target);
      sql.push(
        `DELETE FROM shape_points WHERE shape_idx = ${tIdx}`,
        `INSERT INTO shape_points VALUES ${sp.points
          .map((p, j) => `(${tIdx}, ${j}, ${sqlNumber(p.lon)}, ${sqlNumber(p.lat)}, ${sqlNumber(p.d)})`)
          .join(", ")}`,
        `UPDATE shapes_meta SET length_m = ${sqlNumber(sp.length)} WHERE shape_idx = ${tIdx}`
      );
      // The patterns' places on it: the old stops where the path puts them
      // now, the new ones along the stretch.
      for (const p of g.patterns) {
        const to = moved.get(p) as number;
        const rows = placed.filter((r) => r.pattern_idx === p).sort((x, y) => x.i - y.i);
        const n = (stopsOf.get(p)?.length ?? k) - k;
        const ext = dists.map((x, j) =>
          end === "end"
            ? `(${sqlNumber(to)}, ${tIdx}, ${n + j}, ${sqlNumber(g.d + x)})`
            : `(${sqlNumber(to)}, ${tIdx}, ${k - 1 - j}, ${sqlNumber(sp.map(g.d) - x)})`
        );
        const old = rows.map(
          (r) =>
            `(${sqlNumber(to)}, ${tIdx}, ${r.i + (end === "start" ? k : 0)}, ${r.d === null ? "NULL" : sqlNumber(sp.map(r.d))})`
        );
        // Its places where it runs now: off the old path where it ran it all.
        sql.push(
          to === p
            ? `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(p)} AND shape_idx IN (${sIdx}, ${tIdx})`
            : `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(to)} AND shape_idx = ${tIdx}`
        );
        sql.push(`INSERT INTO pattern_shape_stops VALUES ${[...old, ...ext].join(", ")}`);
      }
      for (const t of going) reach.set(t.trip_idx, dists);
      if (going.length > most) {
        most = going.length;
        facts.metres = dists[dists.length - 1] ?? 0;
      }
      gtfs.push({
        role: "shapes",
        op: "reshape",
        key: { shape_id: targetId },
        source: shape.shape_id,
        ...(perUnit ? { metres_per_unit: perUnit } : {}),
        trips: going.map((t) => t.trip_id),
        stretches: [
          {
            from: end === "end" ? Math.min(1, g.d / length) : null,
            to: end === "end" ? null : Math.max(0, g.d / length),
            at: null,
            points: stretch.via.points,
          } satisfies ShapeStretch,
        ],
      });
      facts.paths.push({
        shape_idx: target,
        color,
        coordinates: sp.points.map((p) => [p.lon, p.lat]),
        drawn: sp.drawn,
        ...(inPlace ? { replaces: shape.shape_id, old: cutAt(pts, [stretch]) } : {}),
      });
    }
  }
  // Lines through the stops: the one through each pattern's stops now,
  // taken where another trip has it; one no trip runs any more dropped.
  const dropped: string[] = [];
  if (chained.length) {
    const ids = new Map(
      (await db.all<{ stop_idx: number; stop_id: string }>(`SELECT stop_idx, stop_id FROM stops`)).map(
        (r) => [r.stop_idx, r.stop_id]
      )
    );
    const knownChains = new Map(
      (
        await db.all<{ shape_idx: number; shape_id: string }>(
          `SELECT shape_idx, shape_id FROM shapes_meta WHERE starts_with(shape_id, ${sqlText(STOP_CHAIN_PREFIX)})`
        )
      ).map((r) => [r.shape_id, r.shape_idx])
    );
    for (const c of chained) {
      for (const p of [
        ...new Set(tripRows.filter((t) => t.shape_idx === c.shape_idx).map((t) => t.pattern_idx)),
      ]) {
        const stops = stopsOf.get(p) as number[];
        const to = moved.get(p) as number;
        const id = await chainId(
          db,
          stops.map((x) => ids.get(x) as string)
        );
        let shape = knownChains.get(id);
        if (shape === undefined) {
          shape = next++;
          knownChains.set(id, shape);
          sql.push(
            `INSERT INTO shapes_meta VALUES (${sqlNumber(shape)}, ${sqlText(id)}, NULL)`,
            ...chainShapeSql(shape, stops),
            `INSERT INTO shape_route VALUES (${sqlNumber(shape)}, ${sqlNumber(scope.route_idx)})`
          );
        }
        touchedShapes.add(shape);
        sql.push(
          `UPDATE trips SET shape_idx = ${sqlNumber(shape)}
           WHERE trip_idx IN (${tripList}) AND pattern_idx = ${sqlNumber(p)} AND shape_idx = ${sqlNumber(c.shape_idx)}`,
          ...chainStopsSql(to, shape, stops),
          // Its places on the old line go with its trips.
          ...(to === p
            ? [
                `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(p)} AND shape_idx = ${sqlNumber(c.shape_idx)}`,
              ]
            : [])
        );
      }
      const [kept] = await db.all(
        `SELECT 1 FROM trips WHERE shape_idx = ${sqlNumber(c.shape_idx)} AND trip_idx NOT IN (${tripList}) LIMIT 1`
      );
      if (kept) continue;
      dropped.push(c.shape_id);
      touchedShapes.add(c.shape_idx);
      const o = sqlNumber(c.shape_idx);
      sql.push(
        `DELETE FROM pattern_shape_stops WHERE shape_idx = ${o}`,
        `DELETE FROM shape_points WHERE shape_idx = ${o}`,
        `DELETE FROM shape_route WHERE shape_idx = ${o}`,
        `DELETE FROM shapes_meta WHERE shape_idx = ${o}`
      );
    }
  }
  // Trips on a path through their stops, or none: straight from the
  // terminus through the new stops, for the times.
  if (termAt) {
    const straight = placesOn([termAt, ...adds.map(at)], adds.map(at));
    for (const t of tripRows) if (!reach.has(t.trip_idx)) reach.set(t.trip_idx, straight);
    if (most < 0) facts.metres = straight[straight.length - 1] ?? 0;
  }

  // The stop times: the new end timed from the line's speed, to the minute,
  // the stops between untimed; room made at the start.
  const ends = await db.all<{
    trip_idx: number;
    trip_id: string;
    seq: number;
    time: number | null;
    dist: number | null;
    headsign: string | null;
  }>(`
    SELECT st.trip_idx, t.trip_id, st.stop_sequence AS seq,
           ${end === "end" ? "COALESCE(st.arrival_s, st.departure_s)" : "COALESCE(st.departure_s, st.arrival_s)"} AS time,
           st.shape_dist AS dist, t.headsign
    FROM stop_times st JOIN trips t USING (trip_idx)
    WHERE st.trip_idx IN (${tripList})
    QUALIFY row_number() OVER (PARTITION BY st.trip_idx ORDER BY st.stop_sequence ${end === "end" ? "DESC" : "ASC"}) = 1
    ORDER BY st.trip_idx`);
  const minute = (s: number) => Math.round(s / 60) * 60;
  facts.seconds = minute(facts.metres / v);
  const inserts: string[] = [];
  for (const e of ends) {
    const dists = reach.get(e.trip_idx) ?? [];
    const far = dists[dists.length - 1] ?? facts.metres;
    if (e.time === null) return refuse("missing_trip_edge", { count: 1 });
    // At least a minute on from the terminus: never the same time.
    const span = Math.max(60, minute(far / v));
    const time = end === "end" ? e.time + span : e.time - span;
    if (time < 0) return refuse("goat_extend_before_midnight");
    const seqs = end === "end" ? added.map((_, j) => e.seq + 1 + j) : added.map((_, j) => e.seq - k + j);
    // At the start, room below the first stop where the feed has none.
    const shifts = end === "start" && e.seq - k < 0;
    if (shifts) {
      for (let j = 0; j < k; j++)
        gtfs.push({ role: "stop_times", op: "shift", key: { trip_id: e.trip_id }, after: e.seq - 1 });
      for (let j = 0; j < k; j++) seqs[j] = e.seq + j;
    }
    added.forEach((a, j) => {
      const timed = end === "end" ? j === k - 1 : j === 0;
      // Along the path from the terminus, in the feed's unit, at the end; at
      // the start none (the old stops' distances move on as the path grows).
      const d = end === "end" && perUnit && e.dist !== null ? e.dist + (dists[j] ?? far) / perUnit : null;
      inserts.push(
        `(${e.trip_idx}, ${seqs[j]}, ${sqlNumber(a)}, ${timed ? time : "NULL"}, ${timed ? time : "NULL"}, ${d === null ? "NULL" : sqlNumber(d)})`
      );
      gtfs.push({
        role: "stop_times",
        op: "insert",
        key: { trip_id: e.trip_id, stop_sequence: seqs[j] },
        values: {
          stop_id: stopOf.get(a)?.stop_id ?? "",
          ...(timed ? { arrival_time: gtfsTime(time), departure_time: gtfsTime(time) } : {}),
          ...(d !== null ? { shape_dist_traveled: d } : {}),
        },
      });
    });
    if (shifts) {
      const where = `trip_idx = ${e.trip_idx}`;
      sql.push(
        `UPDATE stop_time_extras SET stop_sequence = stop_sequence + ${k} WHERE ${where}`,
        `UPDATE stop_times SET stop_sequence = stop_sequence + ${k} WHERE ${where}`
      );
    }
    sql.push(
      end === "end"
        ? `UPDATE trips SET last_arr_s = ${time} WHERE trip_idx = ${e.trip_idx}`
        : `UPDATE trips SET first_dep_s = ${time} WHERE trip_idx = ${e.trip_idx}`
    );
    // Headed for the old terminus: for the new one.
    if (end === "end" && last && e.headsign && e.headsign === stopOf.get(terminus)?.place) {
      sql.push(`UPDATE trips SET headsign = ${sqlText(last.place)} WHERE trip_idx = ${e.trip_idx}`);
      gtfs.push({
        role: "trips",
        op: "update",
        key: { trip_id: e.trip_id },
        values: { trip_headsign: last.place },
      });
    }
  }
  sql.push(
    `INSERT INTO stop_times (trip_idx, stop_sequence, stop_idx, arrival_s, departure_s, shape_dist) VALUES ${inserts.join(", ")}`
  );
  // The trips onto the pattern they now run as; one left with none goes.
  for (const p of patterns) {
    const to = moved.get(p.pattern_idx) as number;
    if (to === p.pattern_idx) continue;
    sql.push(
      `UPDATE trips SET pattern_idx = ${sqlNumber(to)} WHERE pattern_idx = ${sqlNumber(p.pattern_idx)} AND trip_idx IN (${tripList})`
    );
    if (p.going === p.n)
      sql.push(
        `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(p.pattern_idx)}`,
        `DELETE FROM patterns WHERE pattern_idx = ${sqlNumber(p.pattern_idx)}`
      );
  }
  const pats = [...touched];
  sql.push(
    `UPDATE patterns SET
       n_trips = (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = patterns.pattern_idx)
     WHERE pattern_idx IN (${list(pats)})`,
    ...lengthsSql(trips, [...touchedShapes], pats, perUnit)
  );
  // Stop times first: the reshape names the trips whose rows it follows.
  gtfs.sort((x, y) => Number(x.role === "shapes") - Number(y.role === "shapes"));
  const shapesTouched = [...touchedShapes];
  const touches: Touch[] = [
    { table: "stop_times", where: `trip_idx IN (${tripList})` },
    { table: "stop_time_extras", where: `trip_idx IN (${tripList})` },
    { table: "trips", where: `trip_idx IN (${tripList})` },
    { table: "patterns", where: `pattern_idx IN (${list(pats)})` },
    { table: "pattern_shape_stops", where: `pattern_idx IN (${list(pats)})` },
  ];
  if (shapesTouched.length)
    touches.push(
      { table: "shapes_meta", where: `shape_idx IN (${list(shapesTouched)})` },
      { table: "shape_points", where: `shape_idx IN (${list(shapesTouched)})` },
      { table: "shape_route", where: `shape_idx IN (${list(shapesTouched)})` },
      { table: "pattern_shape_stops", where: `shape_idx IN (${list(shapesTouched)})` }
    );
  if (unrouted) checks.push({ code: "goat_snap_route_failed", severity: "notice" });
  return {
    ok: true,
    facts,
    checks,
    rows: {
      kind: "line_extend",
      touches,
      sql,
      gtfs,
      shapes: shapesTouched.filter(
        (x) => !chained.some((c) => c.shape_idx === x && dropped.includes(c.shape_id))
      ),
      dropped,
    },
  };
}
