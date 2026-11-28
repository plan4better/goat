/**
 * 1.2 Reroute a path (01-editing-operations § 1): the path between two stops
 * in a row drawn anew through points dragged off it (decided 8 Nov 2026),
 * for the trips the scope takes. Straight through the points, or, with Snap
 * on, for a line on the streets, along them through the points. The stops
 * stay where they are and the trips keep their times; everything measured
 * along the path follows it (the stops' places on it, the feed's distances,
 * the path's and the trips' lengths), as a moved stop's path does.
 *
 * At the whole line, the other direction's path between the same two stops
 * (run the other way round) is drawn through the same points too. A path
 * shared with trips the scope does not take, that run the stretch, is not
 * bent for them: the trips rerouted get their own copy (`<id>_goat<n>`).
 * A path drawn through the stops (no shape in the feed) has no streets of
 * its own to leave: passed over, and said; refused where it is all there is.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { METRES_PER_UNIT } from "@/lib/explorer/derive/stopsLine";
import { STOP_CHAIN_PREFIX } from "@/lib/explorer/edit/ops/chains";
import { type LineScope, type ScopeLevel, tripsBetween } from "@/lib/explorer/edit/ops/lineStops";
import {
  type MoveStopFacts,
  ROAD_MODES,
  type Router,
  type Stretch,
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

export interface RerouteFacts {
  route_idx: number;
  /** The line as riders know it: its number, else its name. */
  line: string;
  level: ScopeLevel;
  from_name: string;
  to_name: string;
  trips: number;
  trip_idxs: number[];
  /** Paths given their own copy, as trips not rerouted share the stretch. */
  forked: number;
  /** How much longer (or, below 0, shorter) the path got, in metres: the
   * path most trips run. */
  metres: number;
  /** Each path as it would run, for the map to preview (a move's). */
  paths: MoveStopFacts["paths"];
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");
const round = (x: number) => Math.round(x * 10) / 10;

/** 1.2: the path from `a` to `b` (stop_idx, called back to back) through
 * `via`, for the trips `scope` takes. */
export async function reroutePath(
  db: SqlRunner,
  a: number,
  b: number,
  via: LonLat[],
  scope: LineScope,
  shapeDistUnit: string | null,
  /** With Snap on: the router the streets are asked of. */
  route?: Router
): Promise<Built<RerouteFacts>> {
  const names = await db.all<{ stop_idx: number; place: string }>(`
    SELECT s.stop_idx, COALESCE(p.name, s.name, s.stop_id) AS place
    FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx IN (${list([a, b])})`);
  const [line] = await db.all<{ line: string; route_type: number | null; color: string | null }>(`
    SELECT COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line, route_type, color FROM routes
    WHERE route_idx = ${sqlNumber(scope.route_idx)}`);
  const facts: RerouteFacts = {
    route_idx: scope.route_idx,
    line: line?.line ?? "",
    level: scope.level,
    from_name: names.find((r) => r.stop_idx === a)?.place ?? "",
    to_name: names.find((r) => r.stop_idx === b)?.place ?? "",
    trips: 0,
    trip_idxs: [],
    forked: 0,
    metres: 0,
    paths: [],
  };
  const refuse = (code: string): Built<RerouteFacts> => ({
    ok: false,
    refused: { code, severity: "error" },
    facts,
    checks: [],
  });
  const inScope = await tripsBetween(db, scope, scope.level, a, b);
  if (!inScope.length) return refuse("goat_scope_empty");
  facts.trips = inScope.length;
  facts.trip_idxs = inScope;
  const checks: Check[] = [];
  // Nothing dragged off the path yet: nothing to change.
  if (!via.length)
    return { ok: true, facts, checks, rows: { kind: "path_reroute", touches: [], sql: [], gtfs: [] } };

  const taken = new Set(inScope);
  const eitherWay = scope.level === "line";
  const trips = await db.all<{
    trip_idx: number;
    trip_id: string;
    pattern_idx: number;
    shape_idx: number | null;
  }>(`
    SELECT trip_idx, trip_id, pattern_idx, shape_idx FROM trips WHERE trip_idx IN (${list(inScope)})`);
  const patternIdxs = [...new Set(trips.map((t) => t.pattern_idx))];
  const patternRows = await db.all<{ pattern_idx: number; stops: ArrayLike<number> }>(`
    SELECT pattern_idx, stops FROM patterns WHERE pattern_idx IN (${list(patternIdxs)})`);
  const stopsOf = new Map(patternRows.map((p) => [p.pattern_idx, Array.from(p.stops)]));
  const shapeIdxs = [...new Set(trips.flatMap((t) => (t.shape_idx === null ? [] : [t.shape_idx])))];
  const shapes = await db.all<{ shape_idx: number; shape_id: string }>(`
    SELECT shape_idx, shape_id FROM shapes_meta WHERE shape_idx IN (${list(shapeIdxs)})`);
  // A path drawn through the stops is no street of the feed's to leave:
  // passed over, and said; with nothing else, refused.
  const chained = shapes.filter((s) => s.shape_id.startsWith(STOP_CHAIN_PREFIX));
  if (chained.length === shapes.length) return refuse("goat_reroute_chain");
  if (chained.length) checks.push({ code: "goat_reroute_chain_skipped", severity: "notice" });

  const color = routeColor(line?.color ?? null, modeOf(line?.route_type ?? null));
  const routed = !!route && ROAD_MODES.has(modeOf(line?.route_type ?? null));
  // One request per way through the points, whichever path asks it.
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
  const sql: string[] = [];
  const gtfs: GtfsRowOp[] = [];
  const touchedShapes = new Set<number>();
  const touchedPatterns = new Set<number>(patternIdxs);
  // The path most trips run, for the length it gained.
  let most = -1;

  for (const shape of shapes) {
    if (chained.includes(shape)) continue;
    const s = shape.shape_idx;
    const sIdx = sqlNumber(s);
    const placed = await db.all<{ pattern_idx: number; i: number; d: number | null }>(`
      SELECT pattern_idx, i, d FROM pattern_shape_stops WHERE shape_idx = ${sIdx}`);
    const placeOf = (p: number, i: number) => placed.find((r) => r.pattern_idx === p && r.i === i)?.d ?? null;
    const pts = await db.all<{ lon: number; lat: number; d: number }>(
      `SELECT lon, lat, d FROM shape_points WHERE shape_idx = ${sIdx} ORDER BY i`
    );
    if (pts.length < 2 || !(pts[pts.length - 1].d > 0)) continue;
    const onShape = await db.all<{ trip_idx: number; trip_id: string; pattern_idx: number }>(
      `SELECT trip_idx, trip_id, pattern_idx FROM trips WHERE shape_idx = ${sIdx} ORDER BY trip_idx`
    );
    const counts = await db.all<{ pattern_idx: number; n: number }>(`
      SELECT pattern_idx, CAST(n_stops AS INTEGER) AS n FROM patterns
      WHERE pattern_idx IN (SELECT pattern_idx FROM trips WHERE shape_idx = ${sIdx})`);
    const callsOf = new Map(counts.map((r) => [r.pattern_idx, r.n]));
    const mine = [...new Set(trips.filter((t) => t.shape_idx === s).map((t) => t.pattern_idx))];

    // Each pattern's stretches: wherever it calls at `a` then `b` (or, the
    // whole line, `b` then `a`: run the other way through the points).
    const stretchesOf = (p: number): (Stretch & { back: boolean })[] => {
      const stops = stopsOf.get(p) ?? [];
      return stops.flatMap((x, i) => {
        const y = stops[i + 1];
        const fore = x === a && y === b;
        const back = eitherWay && x === b && y === a;
        if (!fore && !back) return [];
        const lo = placeOf(p, i);
        const hi = placeOf(p, i + 1);
        return lo !== null && hi !== null && hi > lo ? [{ a: lo, b: hi, back }] : [];
      });
    };
    const groups = new Map<string, { stretches: (Stretch & { back: boolean })[]; patterns: number[] }>();
    for (const p of mine) {
      const st = stretchesOf(p);
      if (!st.length) continue;
      const key = st.map((x) => `${round(x.a as number)}|${round(x.b as number)}`).join(";");
      const g = groups.get(key);
      if (g) g.patterns.push(p);
      else groups.set(key, { stretches: st, patterns: [p] });
    }
    if (!groups.size) continue;
    // Trips on the path the scope does not take, running a stretch: the
    // path stays theirs, and every group gets a copy.
    const crossing = onShape.some((t) => {
      if (taken.has(t.trip_idx)) return false;
      const ds = placed.flatMap((r) => (r.pattern_idx === t.pattern_idx && r.d !== null ? [r.d] : []));
      if (!ds.length) return false;
      const [lo, hi] = [Math.min(...ds), Math.max(...ds)];
      return [...groups.values()].some((g) =>
        g.stretches.some((x) => (x.a as number) < hi && (x.b as number) > lo)
      );
    });
    const rerouted = (g: { patterns: number[] }) =>
      trips.filter((t) => t.shape_idx === s && g.patterns.includes(t.pattern_idx));
    const ordered = [...groups.values()].sort((x, y) => rerouted(x).length - rerouted(y).length);
    const keeper = crossing ? null : ordered[ordered.length - 1];
    const leaving = new Set(
      ordered.filter((g) => g !== keeper).flatMap((g) => rerouted(g).map((t) => t.trip_idx))
    );

    // Each stretch through the points: along the streets with Snap, else straight.
    for (const g of groups.values())
      for (const x of g.stretches) {
        const points = x.back ? [...via].reverse() : via;
        let line: LonLat[] | null = null;
        if (routed) {
          line = await road([along(pts, x.a as number), ...points, along(pts, x.b as number)]);
          if (!line) unrouted = true;
        }
        x.via = { points: line ?? points, stop: 0 };
      }

    for (const g of ordered) {
      const inPlace = g === keeper;
      const sp = splice(pts, g.stretches, via[0]);
      const moving = inPlace ? onShape.filter((t) => !leaving.has(t.trip_idx)) : rerouted(g);
      let target = s;
      let targetId = shape.shape_id;
      if (!inPlace) {
        target = next++;
        facts.forked++;
        targetId = await forkId(db, shape.shape_id, issued);
        sql.push(
          `INSERT INTO shapes_meta VALUES (${sqlNumber(target)}, ${sqlText(targetId)}, NULL)`,
          `INSERT INTO shape_route VALUES (${sqlNumber(target)}, ${sqlNumber(scope.route_idx)})`,
          `UPDATE trips SET shape_idx = ${sqlNumber(target)} WHERE trip_idx IN (${list(moving.map((t) => t.trip_idx))})`
        );
        for (const t of moving)
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
          .map((p, k) => `(${tIdx}, ${k}, ${sqlNumber(p.lon)}, ${sqlNumber(p.lat)}, ${sqlNumber(p.d)})`)
          .join(", ")}`,
        `UPDATE shapes_meta SET length_m = ${sqlNumber(sp.length)} WHERE shape_idx = ${tIdx}`
      );
      if (moving.length > most) {
        most = moving.length;
        facts.metres = sp.length - pts[pts.length - 1].d;
      }

      // The stops' places on it, each moved on as far as the path did where
      // it lies; and the feed's distances with them, per call of each trip.
      const patterns = [...new Set(moving.map((t) => t.pattern_idx))];
      const shifts: string[] = [];
      for (const p of patterns) {
        touchedPatterns.add(p);
        const rows = placed.filter((r) => r.pattern_idx === p).sort((x, y) => x.i - y.i);
        // Some of its trips stay on the old path: its places there stay too.
        const stays = !inPlace && onShape.some((t) => t.pattern_idx === p && !taken.has(t.trip_idx));
        if (!stays || inPlace)
          sql.push(
            `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(p)} AND shape_idx = ${sIdx}`
          );
        if (rows.length)
          sql.push(
            `INSERT INTO pattern_shape_stops VALUES ${rows
              .map(
                (r) =>
                  `(${sqlNumber(p)}, ${tIdx}, ${sqlNumber(r.i)}, ${r.d === null ? "NULL" : sqlNumber(sp.map(r.d))})`
              )
              .join(", ")}`
          );
        let shift = 0;
        for (let k = 0; k < (callsOf.get(p) ?? 0); k++) {
          const d = placeOf(p, k);
          if (d !== null) shift = sp.map(d) - d;
          if (perUnit && Math.abs(shift) > 0.01)
            shifts.push(`(${sqlNumber(p)}, ${k}, ${sqlNumber(shift / perUnit)})`);
        }
      }
      if (perUnit && shifts.length)
        sql.push(`UPDATE stop_times SET shape_dist = CAST(stop_times.shape_dist + x.shift AS REAL) FROM (
            SELECT st.trip_idx, st.stop_sequence, v.shift FROM (
              SELECT st.trip_idx, st.stop_sequence, t.pattern_idx,
                     row_number() OVER (PARTITION BY st.trip_idx ORDER BY st.stop_sequence) - 1 AS k
              FROM stop_times st JOIN trips t USING (trip_idx)
              WHERE st.trip_idx IN (${list(moving.map((t) => t.trip_idx))})
            ) st JOIN (VALUES ${shifts.join(", ")}) v(pattern_idx, k, shift) USING (pattern_idx, k)
          ) x
          WHERE stop_times.trip_idx = x.trip_idx AND stop_times.stop_sequence = x.stop_sequence
            AND stop_times.shape_dist IS NOT NULL`);

      const length = pts[pts.length - 1].d;
      gtfs.push({
        role: "shapes",
        op: "reshape",
        key: { shape_id: targetId },
        source: shape.shape_id,
        ...(perUnit ? { metres_per_unit: perUnit } : {}),
        trips: moving.map((t) => t.trip_id),
        stretches: [...g.stretches]
          .sort((x, y) => (x.a as number) - (y.a as number))
          .map(
            (x): ShapeStretch => ({
              from: Math.max(0, (x.a as number) / length),
              to: Math.min(1, (x.b as number) / length),
              at: null,
              points: x.via?.points ?? [],
            })
          ),
      });
      facts.paths.push({
        shape_idx: target,
        color,
        coordinates: sp.points.map((p) => [p.lon, p.lat]),
        drawn: sp.drawn,
        ...(inPlace ? { replaces: shape.shape_id, old: cutAt(pts, g.stretches) } : {}),
      });
    }
  }
  if (!touchedShapes.size) return refuse("goat_reroute_unplaced");

  sql.push(...lengthsSql(inScope, [...touchedShapes], [...touchedPatterns], perUnit));
  const shapesTouched = [...touchedShapes];
  const touches: Touch[] = [
    { table: "trips", where: `pattern_idx IN (${list([...touchedPatterns])})` },
    {
      table: "stop_times",
      where: `trip_idx IN (SELECT trip_idx FROM trips WHERE pattern_idx IN (${list([...touchedPatterns])}))`,
    },
    { table: "patterns", where: `pattern_idx IN (${list([...touchedPatterns])})` },
    { table: "pattern_shape_stops", where: `pattern_idx IN (${list([...touchedPatterns])})` },
    { table: "shapes_meta", where: `shape_idx IN (${list(shapesTouched)})` },
    { table: "shape_points", where: `shape_idx IN (${list(shapesTouched)})` },
    { table: "shape_route", where: `shape_idx IN (${list(shapesTouched)})` },
  ];
  if (unrouted) checks.push({ code: "goat_snap_route_failed", severity: "notice" });
  return {
    ok: true,
    facts,
    checks,
    rows: { kind: "path_reroute", touches, sql, gtfs, shapes: shapesTouched },
  };
}
