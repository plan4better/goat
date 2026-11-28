/**
 * 2.2 Move stop (01-editing-operations § 2; board 23): the stop where it
 * was dropped, and the paths through it with it (decided 28 Oct 2026). Each
 * line's path between the stops either side of it is drawn again through
 * its new place; at a terminus, from its neighbour to it, unless the path
 * runs on past the stop for other patterns calling there: then as theirs,
 * the terminus running the bent path as far as it goes. Times are kept.
 *
 * Straight, or, with Snap on, along the streets for a line that runs on them
 * (bus, trolleybus, tram): the whole way from the stop before to the stop
 * after is asked of a car router, the path passes the route's point nearest
 * the stop, and the stop stays where it was dropped. A route that cannot be
 * had, or detours implausibly, leaves a straight stretch near the stop, as
 * without Snap, and says so in passing (`goat_snap_route_failed`, a notice).
 *
 * A path shared with a pattern that runs that stretch without stopping
 * there is not bent for it: the patterns that stop there get their own copy
 * (a new shape id, `<id>_goat<n>`), the rest keep theirs. A path drawn
 * through the stops (no shape in the feed) follows them anyway.
 *
 * Everything measured along a changed path follows it: the stops' places on
 * it (`pattern_shape_stops`), the feed's distances where it gives them
 * (`stop_times.shape_dist`, in its unit), the path's length and the trips'
 * lengths. The server does the same to the bundle's full shape on save (the
 * change set's `reshape`), from the same stretches.

 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { METRES_PER_UNIT } from "@/lib/explorer/derive/stopsLine";
import { STOP_CHAIN_PREFIX, chainShapeSql, chainStopsSql } from "@/lib/explorer/edit/ops/chains";
import { metres, metresSql } from "@/lib/explorer/edit/ops/geo";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, ShapeStretch, Touch } from "@/lib/explorer/edit/types";
import { modeOf, routeColor } from "@/lib/explorer/modes";

/** Less than this is no move: a stop let go where it was picked up. */
const MIN_MOVE_M = 1;

/** How much of a path either side of a moved stop is drawn anew straight:
 * three times as far as it moved, at least this, never past the stops either
 * side. Beyond, the path keeps following its streets. */
export const REDRAW_MIN_M = 60;

type LonLat = [number, number];

/** Asks for the road between waypoints: its line and, per waypoint, where it
 * met the road; null where there is none. */
export type Router = (waypoints: LonLat[]) => Promise<{ line: LonLat[]; snapped: LonLat[] } | null>;

/** The lines whose paths follow the streets with Snap on. */
export const ROAD_MODES = new Set(["bus", "trolleybus", "tram"]);

/** A route longer than this many times the straight stretch, plus
 * ROUTE_SLACK_M, is not the stretch's road: it stays straight. */
const ROUTE_DETOUR = 3;
const ROUTE_SLACK_M = 300;

export interface MoveStopFacts {
  stop_id: string;
  name: string;
  from: LonLat;
  to: LonLat;
  metres: number;
  /** The routes whose paths through it change, and their trips. */
  routes: number[];
  trips: number;
  trip_idxs: number[];
  /** Paths given their own copy, as another pattern shares the stretch. */
  forked: number;
  /** Each path as it would run, in its line's colour, for the map to
   * preview: whole (`coordinates`), and the pieces drawn anew through the
   * stop, from the stop before to the stop after (`drawn`). One redrawn in
   * place also has the path it replaces (`replaces`, its shape id), cut into
   * what it keeps and what is drawn anew. */
  paths: {
    shape_idx: number;
    color: string;
    coordinates: LonLat[];
    drawn: LonLat[][];
    replaces?: string;
    old?: { kept: LonLat[][]; replaced: LonLat[][] };
  }[];
}

/** A stretch of a path, in metres along it: from the stop before to the
 * stop after (null: the path's start or end, at a terminus). */
export interface Stretch {
  a: number | null;
  b: number | null;
  /** Where the stop was on it, if it was placed. */
  here?: number | null;
  /** The road it follows (Snap): the points between its ends, `stop` the
   * one the stop lies at. Straight through the stop where absent. */
  via?: { points: LonLat[]; stop: number };
}

interface Spliced {
  points: { lon: number; lat: number; d: number }[];
  /** Where each stretch's new point (the stop) lies along the new path. */
  at: number[];
  /** Old metres → new, outside the stretches. */
  map: (old: number) => number;
  length: number;
  /** Per stretch, in order: its new points, from its start through the
   * stop to its end. */
  drawn: LonLat[][];
  /** Per stretch, in order: the new segments either side of the stop, and
   * how far the path beyond its start and its end moved on (metres). */
  legs: {
    a: number | null;
    here: number | null;
    at: number;
    into: number;
    out: number;
    before: number;
    after: number;
  }[];
}

/** The point `d` metres along `pts` (ordered by d). */
export function along(pts: { lon: number; lat: number; d: number }[], d: number): LonLat {
  if (d <= pts[0].d) return [pts[0].lon, pts[0].lat];
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1];
    const q = pts[k];
    if (d <= q.d) {
      const f = q.d > p.d ? (d - p.d) / (q.d - p.d) : 0;
      return [p.lon + f * (q.lon - p.lon), p.lat + f * (q.lat - p.lat)];
    }
  }
  const last = pts[pts.length - 1];
  return [last.lon, last.lat];
}

/** `pts` cut at the stretches: what lies outside them, kept, and what lies
 * inside, drawn anew. */
export function cutAt(
  pts: { lon: number; lat: number; d: number }[],
  stretches: Stretch[]
): { kept: LonLat[][]; replaced: LonLat[][] } {
  const kept: LonLat[][] = [];
  const replaced: LonLat[][] = [];
  const piece = (lo: number, hi: number): LonLat[] => {
    const inside = pts.filter((p) => p.d > lo && p.d < hi).map((p): LonLat => [p.lon, p.lat]);
    const ends = (d: number) => (Number.isFinite(d) ? [along(pts, d)] : []);
    return [...ends(lo), ...inside, ...ends(hi)];
  };
  let cursor = -Infinity;
  for (const { a, b } of [...stretches].sort((x, y) => (x.a ?? -1) - (y.a ?? -1))) {
    const lo = a ?? -Infinity;
    const hi = b ?? Infinity;
    if (a !== null) kept.push(piece(cursor, lo));
    replaced.push(piece(lo, hi));
    cursor = hi;
  }
  if (Number.isFinite(cursor)) kept.push(piece(cursor, Infinity));
  const lines = (xs: LonLat[][]) => xs.filter((x) => x.length > 1);
  return { kept: lines(kept), replaced: lines(replaced) };
}

/** `pts` with each stretch drawn through `to`: straight, or along its
 * `via`. The path either side keeps its distances, moved on by as much as the
 * stretches before it grew or shrank; only the new segments are measured. */
export function splice(
  pts: { lon: number; lat: number; d: number }[],
  stretches: Stretch[],
  to: LonLat
): Spliced {
  const sorted = [...stretches].sort((x, y) => (x.a ?? -1) - (y.a ?? -1));
  const out: { lon: number; lat: number; d: number }[] = [];
  const at: number[] = [];
  // From `from` on (old metres), the old path plus `offset`.
  const segments: { from: number; offset: number }[] = [{ from: -Infinity, offset: 0 }];
  const cuts: { a: number | null; b: number | null; newA: number }[] = [];
  const legs: Spliced["legs"] = [];
  const drawn: LonLat[][] = [];
  let cursor = -Infinity;
  let offset = 0;
  for (const { a, b, here = null, via } of sorted) {
    let start: { lon: number; lat: number; d: number } | null = null;
    if (a !== null) {
      for (const p of pts) if (p.d > cursor && p.d < a) out.push({ ...p, d: p.d + offset });
      const [lon, lat] = along(pts, a);
      start = { lon, lat, d: a + offset };
      out.push(start);
    }
    // Its points: the stop alone, or the road with the stop on it.
    const through = via ?? { points: [to], stop: 0 };
    let d = start ? start.d : 0;
    let prev: LonLat | null = start ? [start.lon, start.lat] : null;
    let ds = d;
    const piece: LonLat[] = start ? [[start.lon, start.lat]] : [];
    through.points.forEach((q, k) => {
      if (prev) d += metres(prev, q);
      out.push({ lon: q[0], lat: q[1], d });
      piece.push(q);
      if (k === through.stop) ds = d;
      prev = q;
    });
    drawn.push(piece);
    at.push(ds);
    cuts.push({ a, b, newA: start?.d ?? ds });
    const before = offset;
    if (b !== null) {
      const [lon, lat] = along(pts, b);
      const db = d + metres(prev as LonLat, [lon, lat]);
      out.push({ lon, lat, d: db });
      piece.push([lon, lat]);
      offset = db - b;
      segments.push({ from: b, offset });
      cursor = b;
      legs.push({ a, here, at: ds, into: start ? ds - start.d : 0, out: db - ds, before, after: offset });
    } else {
      cursor = Infinity;
      legs.push({ a, here, at: ds, into: start ? ds - start.d : 0, out: 0, before, after: before });
    }
  }
  for (const p of pts) if (p.d > cursor) out.push({ ...p, d: p.d + offset });
  const map = (old: number) => {
    // Inside a stretch, where only the moved stop lies: at its start.
    for (const c of cuts) if ((c.a ?? -Infinity) < old && old < (c.b ?? Infinity)) return c.newA;
    let o = 0;
    for (const x of segments) if (old >= x.from) o = x.offset;
    return old + o;
  };
  return { points: out, at, map, length: out[out.length - 1]?.d ?? 0, drawn, legs };
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");
const round = (x: number) => Math.round(x * 10) / 10;

/** The road for a stretch from `start` through `to` to `end` (either end
 * absent at a terminus), as `via`; null where the router has none or it
 * detours implausibly. */
/** A route plausible for the stretch along `waypoints`: no longer than
 * ROUTE_DETOUR times the straight way plus ROUTE_SLACK_M. */
export function plausible(waypoints: LonLat[], line: LonLat[]): boolean {
  const length = (xs: LonLat[]) => xs.slice(1).reduce((m, p, k) => m + metres(xs[k], p), 0);
  return length(line) <= ROUTE_DETOUR * length(waypoints) + ROUTE_SLACK_M;
}

export async function roadVia(
  route: Router,
  start: LonLat | null,
  to: LonLat,
  end: LonLat | null
): Promise<Stretch["via"] | null> {
  const waypoints = [start, to, end].filter((p): p is LonLat => p !== null);
  let road: Awaited<ReturnType<Router>>;
  try {
    road = await route(waypoints);
  } catch {
    return null;
  }
  if (!road || road.line.length < 2) return null;
  if (!plausible(waypoints, road.line)) return null;
  // The stop on it: the road's point nearest where the router met it there.
  const met = road.snapped[start ? 1 : 0] ?? to;
  let stop = 0;
  road.line.forEach((p, k) => {
    if (metres(p, met) < metres(road.line[stop], met)) stop = k;
  });
  return { points: road.line, stop };
}

export async function moveStop(
  db: SqlRunner,
  stop_idx: number,
  to: LonLat,
  shapeDistUnit: string | null,
  /** With Snap on: the router road lines' stretches are asked of. */
  route?: Router,
  /** A stop added to a line (3.1) is drawn into it as one moved there from
   * its place on the path (`from`), only for the patterns it was added to
   * (`only`), the whole way between its neighbours (`stopToStop`). */
  opts: { from?: LonLat; only?: number[]; stopToStop?: boolean } = {}
): Promise<Built<MoveStopFacts>> {
  const n = sqlNumber(stop_idx);
  const [stop] = await db.all<{
    stop_id: string;
    place: string;
    lon: number | null;
    lat: number | null;
    location_type: number;
  }>(`
    SELECT s.stop_id, COALESCE(p.name, s.name, s.stop_id) AS place, s.lon, s.lat,
           COALESCE(s.location_type, 0) AS location_type
    FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx = ${n}`);
  if (!stop) throw new Error(`No stop ${stop_idx}`);
  const from: LonLat = opts.from ?? [stop.lon ?? to[0], stop.lat ?? to[1]];
  const moved = metres(from, to);
  const facts: MoveStopFacts = {
    stop_id: stop.stop_id,
    name: stop.place,
    from,
    to,
    metres: moved,
    routes: [],
    trips: 0,
    trip_idxs: [],
    forked: 0,
    paths: [],
  };
  if (stop.location_type !== 0)
    return { ok: false, refused: { code: "goat_move_station", severity: "error" }, facts, checks: [] };
  const checks: Check[] = [];
  // Let go where it was picked up: nothing to change, no path redrawn.
  if (moved < MIN_MOVE_M)
    return { ok: true, facts, checks, rows: { kind: "stop_move", touches: [], sql: [], gtfs: [] } };

  const sql: string[] = [
    `UPDATE stops SET lon = ${sqlNumber(to[0])}, lat = ${sqlNumber(to[1])} WHERE stop_idx = ${n}`,
  ];
  const gtfs: GtfsRowOp[] = [
    {
      role: "stops",
      op: "update",
      key: { stop_id: stop.stop_id },
      values: { stop_lat: to[1], stop_lon: to[0] },
    },
  ];

  // The patterns through the stop, the paths their trips run on, and every
  // pattern's place on those paths.
  const patterns = await db.all<{ pattern_idx: number; route_idx: number; stops: ArrayLike<number> }>(`
    SELECT pattern_idx, route_idx, stops FROM patterns WHERE list_contains(stops, ${n})
    ${opts.only ? `AND pattern_idx IN (${list(opts.only)})` : ""}`);
  const through = new Map(
    patterns.map((p) => [p.pattern_idx, { route: p.route_idx, stops: Array.from(p.stops) }])
  );
  const trips = await db.all<{
    trip_idx: number;
    trip_id: string;
    pattern_idx: number;
    shape_idx: number | null;
  }>(`
    SELECT trip_idx, trip_id, pattern_idx, shape_idx FROM trips WHERE pattern_idx IN (${list([...through.keys()])})`);
  facts.trips = trips.length;
  facts.trip_idxs = trips.map((t) => t.trip_idx);
  facts.routes = [...new Set(patterns.map((p) => p.route_idx))].sort((a, b) => a - b);
  const routeRows = await db.all<{ route_idx: number; route_type: number | null; color: string | null }>(
    `SELECT route_idx, route_type, color FROM routes WHERE route_idx IN (${list(facts.routes)})`
  );
  const routeTypes = new Map(routeRows.map((r) => [r.route_idx, r.route_type]));
  const routeColors = new Map(routeRows.map((r) => [r.route_idx, routeColor(r.color, modeOf(r.route_type))]));
  const colorOf = (patterns: number[]) =>
    routeColors.get(through.get(patterns[0])?.route ?? -1) ?? routeColor(null, "other");
  // A stretch Snap could not route: drawn straight, and said.
  let unrouted = false;
  const shapeIdxs = [...new Set(trips.flatMap((t) => (t.shape_idx === null ? [] : [t.shape_idx])))];
  const shapes = await db.all<{ shape_idx: number; shape_id: string; length_m: number | null }>(`
    SELECT shape_idx, shape_id, length_m FROM shapes_meta WHERE shape_idx IN (${list(shapeIdxs)})`);
  const placed = await db.all<{ pattern_idx: number; shape_idx: number; i: number; d: number }>(`
    SELECT pattern_idx, shape_idx, i, d FROM pattern_shape_stops WHERE shape_idx IN (${list(shapeIdxs)})`);
  const placeOf = (p: number, s: number, i: number) =>
    placed.find((r) => r.pattern_idx === p && r.shape_idx === s && r.i === i)?.d ?? null;

  const perUnit = shapeDistUnit ? METRES_PER_UNIT[shapeDistUnit] : undefined;
  let [{ next }] = await db.all<{ next: number }>(
    "SELECT CAST(COALESCE(max(shape_idx) + 1, 0) AS INTEGER) AS next FROM shapes_meta"
  );
  // The copies' shape ids given out so far.
  const issued = new Set<string>();
  const touchedShapes = new Set<number>();
  const touchedPatterns = new Set<number>(through.keys());

  for (const shape of shapes) {
    const s = shape.shape_idx;
    const onIt = [...new Set(placed.filter((r) => r.shape_idx === s).map((r) => r.pattern_idx))];
    const mine = onIt.filter(
      (p) => through.has(p) && trips.some((t) => t.pattern_idx === p && t.shape_idx === s)
    );

    // A path through the stops: drawn again through them, for every pattern on it.
    if (shape.shape_id.startsWith(STOP_CHAIN_PREFIX)) {
      const stops = through.get(mine[0])?.stops;
      if (!stops) continue;
      touchedShapes.add(s);
      sql.push(...chainShapeSql(s, stops));
      for (const p of onIt) {
        touchedPatterns.add(p);
        sql.push(...chainStopsSql(p, s, through.get(p)?.stops ?? stops));
      }
      const at = await db.all<{ stop_idx: number; lon: number; lat: number }>(`
        SELECT s.stop_idx, coalesce(s.lon, p.lon) AS lon, coalesce(s.lat, p.lat) AS lat
        FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx IN (${list(stops)})`);
      const pos = new Map(at.map((r) => [r.stop_idx, [r.lon, r.lat] as LonLat]));
      facts.paths.push({
        shape_idx: s,
        color: colorOf(mine),
        coordinates: stops.flatMap((x) => (x === stop_idx ? [to] : pos.has(x) ? [pos.get(x) as LonLat] : [])),
        // From the stop before through the stop to the stop after, at each call.
        drawn: stops.flatMap((x, i) =>
          x === stop_idx
            ? [
                [
                  ...(i > 0 && pos.has(stops[i - 1]) ? [pos.get(stops[i - 1]) as LonLat] : []),
                  to,
                  ...(i < stops.length - 1 && pos.has(stops[i + 1]) ? [pos.get(stops[i + 1]) as LonLat] : []),
                ],
              ]
            : []
        ),
      });
      continue;
    }

    // With Snap on, a line on the streets follows them from the stop before
    // to the stop after: the whole of both segments is drawn anew.
    const onRoads = mine.every((p) =>
      ROAD_MODES.has(modeOf(routeTypes.get(through.get(p)?.route ?? -1) ?? null))
    );
    const routed = !!route && onRoads;

    // A path of the feed's: each pattern's stretches through the stop.
    const local = Math.max(REDRAW_MIN_M, 3 * moved);
    const reach = routed || opts.stopToStop ? Infinity : local;
    const rawStretchesOf = (p: number): Stretch[] => {
      const stops = through.get(p)?.stops ?? [];
      // The nearest other stop placed on the path, back or on from call i:
      // one without a place is passed over, not taken for the path's end;
      // the stop again right after itself is the same call, not a neighbour.
      const neighbour = (i: number, step: -1 | 1): number | null | undefined => {
        for (let j = i + step; j >= 0 && j < stops.length; j += step) {
          if (stops[j] === stop_idx) continue;
          const d = placeOf(p, s, j);
          if (d !== null) return d;
        }
        // None: the path's end, at a terminus; else no place to draw from.
        return i + step < 0 || i + step >= stops.length ? null : undefined;
      };
      return stops.flatMap((x, i) => {
        // A call here right after one here is drawn with it.
        if (x !== stop_idx || (i > 0 && stops[i - 1] === stop_idx)) return [];
        const here = placeOf(p, s, i);
        const before = neighbour(i, -1);
        let j = i;
        while (j + 1 < stops.length && stops[j + 1] === stop_idx) j++;
        const after = neighbour(j, 1);
        // Nothing placed either side, and the stop not either: nothing to draw.
        if (here === null && (before === undefined || after === undefined)) return [];
        // A terminus: from or to the path's end there. A neighbour without a
        // place: as far as a straight redraw reaches, the path kept beyond.
        const a =
          before === null
            ? null
            : before === undefined
              ? Math.max(0, (here as number) - local)
              : here === null
                ? before
                : Math.max(before, here - reach);
        const b =
          after === null
            ? null
            : after === undefined
              ? (here as number) + local
              : here === null
                ? after
                : Math.min(after, here + reach);
        return [{ a, b, here }];
      });
    };
    const raw = new Map(mine.map((p) => [p, rawStretchesOf(p)]));
    // A pattern that starts or ends at the stop has no stop before or after
    // it there; where another pattern calling there on the path has one, the
    // terminus takes its end of the stretch. Drawn from the path's own end,
    // the stretch reached over stops the terminus never runs to, and every
    // pattern running those (a short turn ending a stop earlier) seemed to
    // cross it without stopping: the path was copied for each, and the old
    // one left drawn through the stop's old place.
    const ends = new Map<number, { a: number | null; b: number | null }>();
    for (const st of raw.values())
      for (const x of st) {
        if (x.here == null) continue;
        const e = ends.get(x.here) ?? { a: null, b: null };
        if (x.a !== null) e.a = e.a === null ? x.a : Math.max(e.a, x.a);
        if (x.b !== null) e.b = e.b === null ? x.b : Math.min(e.b, x.b);
        ends.set(x.here, e);
      }
    const stretchesOf = (p: number): Stretch[] =>
      (raw.get(p) ?? []).map((x) => {
        const e = x.here == null ? undefined : ends.get(x.here);
        return { ...x, a: x.a ?? e?.a ?? null, b: x.b ?? e?.b ?? null };
      });
    const groups = new Map<string, { stretches: Stretch[]; patterns: number[] }>();
    for (const p of mine) {
      const st = stretchesOf(p);
      const key = st
        .map((x) => `${x.a === null ? "-" : round(x.a)}|${x.b === null ? "-" : round(x.b)}`)
        .join(";");
      const g = groups.get(key);
      if (g) g.patterns.push(p);
      else groups.set(key, { stretches: st, patterns: [p] });
    }
    // Patterns on the path that run a stretch without stopping there.
    const crossing = onIt.some((p) => {
      if (mine.includes(p)) return false;
      const ds = placed.filter((r) => r.pattern_idx === p && r.shape_idx === s).map((r) => r.d);
      const lo = Math.min(...ds);
      const hi = Math.max(...ds);
      return [...groups.values()].some((g) =>
        g.stretches.some((x) => (x.a ?? 0) < hi && (x.b ?? Infinity) > lo)
      );
    });
    // The group with the most trips keeps the path, unless a pattern runs
    // the stretch without stopping: then every group gets its own copy.
    // Copies first, so the trips they take are off the path before it is
    // measured anew.
    const tripsIn = (g: { patterns: number[] }) =>
      trips.filter((t) => g.patterns.includes(t.pattern_idx)).length;
    const ordered = [...groups.values()].sort((x, y) => tripsIn(x) - tripsIn(y));
    const keeper = crossing ? null : ordered[ordered.length - 1];
    const leaving = ordered.filter((g) => g !== keeper).flatMap((g) => g.patterns);
    // Every trip on the path, calling here or not: those its redrawing takes along.
    const onShape = await db.all<{ trip_id: string; pattern_idx: number }>(
      `SELECT trip_id, pattern_idx FROM trips WHERE shape_idx = ${sqlNumber(s)} ORDER BY trip_idx`
    );
    const pts = await db.all<{ lon: number; lat: number; d: number }>(
      `SELECT lon, lat, d FROM shape_points WHERE shape_idx = ${sqlNumber(s)} ORDER BY i`
    );
    if (pts.length < 2) continue;
    // Shares of the path, of the line its places were measured on (as the
    // server measures the line it redraws); none where it has no length.
    const length = pts[pts.length - 1].d;
    if (!(length > 0)) continue;

    if (route && routed) {
      for (const g of groups.values())
        for (const x of g.stretches) {
          // The stop alone on the path: nothing to route between.
          if (x.a === null && x.b === null) continue;
          const via = await roadVia(
            route,
            x.a === null ? null : along(pts, x.a),
            to,
            x.b === null ? null : along(pts, x.b)
          );
          if (via) x.via = via;
          else {
            // No road: straight, near the stop only, as without Snap.
            unrouted = true;
            if (x.here != null) {
              if (x.a !== null) x.a = Math.max(x.a, x.here - local);
              if (x.b !== null) x.b = Math.min(x.b, x.here + local);
            }
          }
        }
    }

    for (const g of ordered) {
      const inPlace = g === keeper;
      const sp = splice(pts, g.stretches, to);
      let target = s;
      let targetId = shape.shape_id;
      // The patterns it is redrawn for: all on it, or the group's own copy.
      let redrawn = onIt.filter((p) => !leaving.includes(p));
      if (!inPlace) {
        target = next++;
        facts.forked++;
        targetId = await forkId(db, shape.shape_id, issued);
        redrawn = g.patterns;
        const groupTrips = trips.filter((t) => g.patterns.includes(t.pattern_idx) && t.shape_idx === s);
        sql.push(
          `INSERT INTO shapes_meta VALUES (${sqlNumber(target)}, ${sqlText(targetId)}, NULL)`,
          `INSERT INTO shape_route SELECT ${sqlNumber(target)}, route_idx FROM routes
           WHERE route_idx IN (${list([...new Set(g.patterns.map((p) => through.get(p)?.route as number))])})`,
          `UPDATE trips SET shape_idx = ${sqlNumber(target)} WHERE trip_idx IN (${list(groupTrips.map((t) => t.trip_idx))})`
        );
        for (const t of groupTrips)
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
      // The stops' places on it: the moved stop at its new point, the rest
      // where the path they lie on now puts them.
      for (const p of redrawn) {
        touchedPatterns.add(p);
        const stops = through.get(p)?.stops;
        const rows = placed.filter((r) => r.pattern_idx === p && r.shape_idx === s);
        // The k-th call here, one right after another here counted with it.
        let k = -1;
        const values = rows
          .sort((x, y) => x.i - y.i)
          .map((r) => {
            if (stops?.[r.i] === stop_idx && stops?.[r.i - 1] !== stop_idx) k++;
            const d =
              stops?.[r.i] === stop_idx ? sp.at[Math.max(0, Math.min(k, sp.at.length - 1))] : sp.map(r.d);
            return `(${sqlNumber(p)}, ${tIdx}, ${sqlNumber(r.i)}, ${sqlNumber(d)})`;
          });
        sql.push(
          `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(p)} AND shape_idx = ${sqlNumber(s)}`
        );
        if (values.length) sql.push(`INSERT INTO pattern_shape_stops VALUES ${values.join(", ")}`);
      }
      // The feed's distances along it, in its unit, for the trips now on it.
      if (perUnit) {
        const onTarget = trips
          .filter(
            (t) =>
              t.shape_idx === s &&
              (inPlace ? !leaving.includes(t.pattern_idx) : g.patterns.includes(t.pattern_idx))
          )
          .map((t) => t.trip_idx);
        if (onTarget.length) sql.push(distancesSql(onTarget, sp, stop_idx, perUnit));
        // Patterns on the path that do not call here lie wholly before or
        // after the stretches: moved on as far as the path where they are.
        for (const p of redrawn.filter((x) => !mine.includes(x))) {
          const first = placed.find((r) => r.pattern_idx === p && r.shape_idx === s && r.i === 0);
          const shift = first ? sp.map(first.d) - first.d : 0;
          if (Math.abs(shift) > 0.01)
            sql.push(`UPDATE stop_times SET shape_dist = CAST(shape_dist + ${sqlNumber(shift / perUnit)} AS REAL)
              WHERE shape_dist IS NOT NULL AND trip_idx IN (
                SELECT trip_idx FROM trips WHERE pattern_idx = ${sqlNumber(p)} AND shape_idx = ${sqlNumber(s)})`);
        }
      }
      gtfs.push({
        role: "shapes",
        op: "reshape",
        key: { shape_id: targetId },
        source: shape.shape_id,
        through: stop.stop_id,
        ...(perUnit ? { metres_per_unit: perUnit } : {}),
        trips: onShape
          .filter((t) => (inPlace ? !leaving.includes(t.pattern_idx) : g.patterns.includes(t.pattern_idx)))
          .map((t) => t.trip_id),
        stretches: [...g.stretches]
          .sort((x, y) => (x.a ?? -1) - (y.a ?? -1))
          .map(
            (x): ShapeStretch => ({
              from: x.a === null ? null : Math.max(0, x.a / length),
              to: x.b === null ? null : Math.min(1, x.b / length),
              at: x.here == null ? null : Math.min(1, Math.max(0, x.here / length)),
              points: x.via?.points ?? [to],
              ...(x.via?.stop ? { stop_point: x.via.stop } : {}),
            })
          ),
      });
      facts.paths.push({
        shape_idx: target,
        color: colorOf(redrawn),
        coordinates: sp.points.map((p) => [p.lon, p.lat]),
        drawn: sp.drawn,
        ...(inPlace ? { replaces: shape.shape_id, old: cutAt(pts, g.stretches) } : {}),
      });
    }
  }

  // Trips' lengths, by where each was measured from.
  sql.push(...lengthsSql(facts.trip_idxs, [...touchedShapes], [...touchedPatterns], perUnit));

  const shapesTouched = [...touchedShapes];
  const touches: Touch[] = [
    { table: "stops", where: `stop_idx = ${n}` },
    // Before and after: trips forked onto a new path, and those left on the old.
    { table: "trips", where: `pattern_idx IN (${list([...touchedPatterns])})` },
    {
      table: "stop_times",
      where: `trip_idx IN (SELECT trip_idx FROM trips WHERE pattern_idx IN (${list([...touchedPatterns])}))`,
    },
    { table: "patterns", where: `pattern_idx IN (${list([...touchedPatterns])})` },
    { table: "pattern_shape_stops", where: `pattern_idx IN (${list([...touchedPatterns])})` },
  ];
  if (shapesTouched.length)
    touches.push(
      { table: "shapes_meta", where: `shape_idx IN (${list(shapesTouched)})` },
      { table: "shape_points", where: `shape_idx IN (${list(shapesTouched)})` },
      { table: "shape_route", where: `shape_idx IN (${list(shapesTouched)})` }
    );
  if (unrouted) checks.push({ code: "goat_snap_route_failed", severity: "notice" });
  return {
    ok: true,
    facts,
    checks,
    rows: { kind: "stop_move", touches, sql, gtfs, shapes: shapesTouched },
  };
}

/** Trips' lengths after their paths or stops changed, by where each was
 * measured from (`length_src`: the feed's distances, the path, the chain of
 * its stops), and their patterns' lengths from them: for `trips`, and every
 * trip on `shapes`. */
export function lengthsSql(
  trips: number[],
  shapes: number[],
  patterns: number[],
  perUnit?: number
): string[] {
  const forShapes = shapes.length ? `OR shape_idx IN (${list(shapes)})` : "";
  return [
    `UPDATE trips SET length_m = CASE trips.length_src
       WHEN 1 THEN ${perUnit ? `CAST(x.dist * ${sqlNumber(perUnit)} AS REAL)` : "trips.length_m"}
       WHEN 2 THEN COALESCE((SELECT length_m FROM shapes_meta m WHERE m.shape_idx = trips.shape_idx), trips.length_m)
       ELSE CAST(x.chain AS REAL) END
     FROM (
       SELECT trip_idx, max(shape_dist) - min(shape_dist) AS dist, coalesce(sum(hop), 0) AS chain
       FROM (
         SELECT st.*, ${metresSql(
           "lag(coalesce(s.lon, p.lon)) OVER w",
           "lag(coalesce(s.lat, p.lat)) OVER w",
           "coalesce(s.lon, p.lon)",
           "coalesce(s.lat, p.lat)"
         )} AS hop
         FROM stop_times st JOIN stops s USING (stop_idx) LEFT JOIN stops p ON p.stop_idx = s.parent_idx
         WHERE st.trip_idx IN (SELECT trip_idx FROM trips WHERE trip_idx IN (${list(trips)}) ${forShapes})
         WINDOW w AS (PARTITION BY st.trip_idx ORDER BY st.stop_sequence)
       ) GROUP BY trip_idx
     ) x WHERE trips.trip_idx = x.trip_idx`,
    `UPDATE patterns SET length_m = (SELECT CAST(median(t.length_m) AS REAL) FROM trips t
       WHERE t.pattern_idx = patterns.pattern_idx) WHERE pattern_idx IN (${list(patterns)})`,
  ];
}

/** `<id>_goat<n>`, the first neither the feed nor this edit uses: one move
 * can copy a path for several patterns, and the copies are not in the
 * snapshot until it is applied. Two with one id were read back as one line. */
export async function forkId(db: SqlRunner, id: string, issued: Set<string>): Promise<string> {
  for (let k = 1; ; k++) {
    const candidate = `${id}_goat${k}`;
    if (issued.has(candidate)) continue;
    const [taken] = await db.all(`SELECT 1 FROM shapes_meta WHERE shape_id = ${sqlText(candidate)}`);
    if (!taken) {
      issued.add(candidate);
      return candidate;
    }
  }
}

/** The feed's distances along a redrawn path, in its unit, for trips that
 * call at the moved stop: the stop measured from its neighbour along the new
 * segment, every stop past it moved on by as much as the path grew or
 * shrank there. Each from the trip's own distance (a feed's distances need
 * not match its points), moved on by what the path's change measures. */
function distancesSql(trips: number[], sp: Spliced, stop_idx: number, perUnit: number): string {
  const u = (m: number) => sqlNumber(m / perUnit);
  // Past the k-th call here: the k-th stretch's offset (0 before the first).
  const passed = sp.legs.map((l, k) => `WHEN ${k + 1} THEN ${u(l.after)}`).join(" ");
  // At the k-th call here: its own distance, moved on by as far as its new
  // point lies past (or short of) where it was on the path; from its
  // neighbour where it had no place on it.
  const here = sp.legs
    .map((l, k) => {
      const moved =
        l.here !== null
          ? `shape_dist + ${u(l.at - l.here)}`
          : l.a === null
            ? `nxt + ${u(l.after - l.out)}`
            : `prev + ${u(l.before + l.into)}`;
      return `WHEN ${k + 1} THEN ${moved}`;
    })
    .join(" ");
  return `UPDATE stop_times SET shape_dist = x.nd FROM (
      -- A neighbour without a distance leaves the stop's own as it was.
      SELECT trip_idx, stop_sequence, CAST(COALESCE(CASE WHEN here THEN CASE upto ${here} END
                  ELSE shape_dist + CASE upto WHEN 0 THEN 0 ${passed} ELSE 0 END END, shape_dist) AS REAL) AS nd
      FROM (
        -- The k-th call here, a call right after one here counted with it
        -- (one stretch: splice draws them as one).
        SELECT *, stop_idx = ${sqlNumber(stop_idx)} AS here,
               sum(CASE WHEN stop_idx = ${sqlNumber(stop_idx)} AND prev_stop IS DISTINCT FROM ${sqlNumber(stop_idx)}
                        THEN 1 ELSE 0 END)
                 OVER (PARTITION BY trip_idx ORDER BY stop_sequence ROWS UNBOUNDED PRECEDING) AS upto,
               lag(shape_dist) OVER w AS prev, lead(shape_dist) OVER w AS nxt
        FROM (SELECT *, lag(stop_idx) OVER (PARTITION BY trip_idx ORDER BY stop_sequence) AS prev_stop
              FROM stop_times WHERE trip_idx IN (${list(trips)}))
        WINDOW w AS (PARTITION BY trip_idx ORDER BY stop_sequence)
      )
    ) x
    WHERE stop_times.trip_idx = x.trip_idx AND stop_times.stop_sequence = x.stop_sequence
      AND stop_times.shape_dist IS NOT NULL`;
}
