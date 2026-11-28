/**
 * A path: the stretch of a pattern between two of its stops in a row (board
 * 21, "Path between two stops"), the level below a direction where reroutes,
 * inserted stops and running times between stops apply.
 *
 * In a line mode the pointer picks it: placed along the pattern's
 * shape (the nearest point of the line, as the shape's metres
 * `shape_points.d` run), and the path is the one between the last stop at or
 * before that point and the next. Stops are placed along the shape by the
 * snapshot (`pattern_shape_stops`).
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { cut } from "@/lib/explorer/derive/patternSections";

export interface PatternPath {
  pattern_idx: number;
  /** The two stops, by their place in the pattern (0-based) and name. */
  from_i: number;
  to_i: number;
  from_name: string;
  to_name: string;
  /** The two stops' stop_idx, and the line the pattern is of: what an edit
   * on the path (a reroute) starts from. */
  from_stop: number;
  to_stop: number;
  route_idx: number;
  /** The line between them, along the shape. */
  line: [number, number][];
}

/** Metres per degree of latitude: the local plane the click is placed on. */
const M_PER_DEG = 111_195;

/** A pattern's line as the paths along it are found: its stops placed
 * along its shape (`d`, the shape's metres), and the shape's points. Loaded
 * once, the path under the pointer is found as it moves (`stretchAt`). */
export interface PatternLine {
  pattern_idx: number;
  stops: { i: number; d: number; name: string; stop_idx: number; route_idx: number }[];
  points: { lon: number; lat: number; d: number }[];
}

/** `pattern_idx`'s line, or null when it has none (a pattern of one stop). */
export async function patternLine(db: SqlRunner, pattern_idx: number): Promise<PatternLine | null> {
  const stops = await db.all<{
    shape_idx: number;
    i: number;
    d: number;
    name: string;
    stop_idx: number;
    route_idx: number;
  }>(`
    SELECT pss.shape_idx, pss.i, pss.d, s.name, s.stop_idx, p.route_idx
    FROM pattern_shape_stops pss
    JOIN patterns p USING (pattern_idx)
    JOIN stops s ON s.stop_idx = p.stops[pss.i + 1]
    WHERE pss.pattern_idx = ${pattern_idx} AND pss.d IS NOT NULL
      AND pss.shape_idx = (SELECT min(shape_idx) FROM pattern_shape_stops
                           WHERE pattern_idx = ${pattern_idx} AND d IS NOT NULL)
    ORDER BY pss.i`);
  if (stops.length < 2) return null;
  const points = await db.all<{ lon: number; lat: number; d: number }>(
    `SELECT lon, lat, d FROM shape_points WHERE shape_idx = ${stops[0].shape_idx} ORDER BY i`
  );
  return points.length < 2 ? null : { pattern_idx, stops, points };
}

/** The path of `line` nearest to `[lon, lat]`, with the nearest point on
 * the line (`at`) and how far it is from there, in metres (`off`). */
export function stretchAt(
  line: PatternLine,
  lon: number,
  lat: number
): PatternPath & { at: [number, number]; off: number } {
  const { points, stops } = line;
  // The point's distance along the shape: its nearest point on the line.
  const kx = Math.cos((lat * Math.PI) / 180) * M_PER_DEG;
  let best = Infinity;
  let along = points[0].d;
  let at: [number, number] = [points[0].lon, points[0].lat];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const [ax, ay] = [(a.lon - lon) * kx, (a.lat - lat) * M_PER_DEG];
    const [bx, by] = [(b.lon - lon) * kx, (b.lat - lat) * M_PER_DEG];
    const [dx, dy] = [bx - ax, by - ay];
    const len2 = dx * dx + dy * dy;
    const f = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const [px, py] = [ax + dx * f, ay + dy * f];
    const dist = px * px + py * py;
    if (dist < best) {
      best = dist;
      along = a.d + (b.d - a.d) * f;
      at = [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f];
    }
  }

  // The stops either side of it; past the last stop, the last stretch.
  let k = 0;
  while (k < stops.length - 2 && stops[k + 1].d <= along) k++;
  const [from, to] = [stops[k], stops[k + 1]];
  return {
    pattern_idx: line.pattern_idx,
    from_i: from.i,
    to_i: to.i,
    from_name: from.name,
    to_name: to.name,
    from_stop: from.stop_idx,
    to_stop: to.stop_idx,
    route_idx: from.route_idx,
    line: cut(points, from.d, to.d),
    at,
    off: Math.sqrt(best),
  };
}
