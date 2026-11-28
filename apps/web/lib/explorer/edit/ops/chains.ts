/**
 * The line through a trip's stops, for a trip whose feed gives no shape
 * (goatlib `stop_chains`, the snapshot's `_stop_chain_shapes`): its id is
 * `stops-` and the md5 of its stop ids in order, its points the stops
 * themselves (a stop without a position takes its station's), the distance
 * along it the stop-to-stop distance. An edit that changes such a trip's
 * stops, or moves one, draws its line anew the same way, so the browser and
 * the bundle (which the server redraws on save) agree.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { metresSql } from "@/lib/explorer/edit/ops/geo";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";

export const STOP_CHAIN_PREFIX = "stops-";

/** The id of the line through `stopIds`, in order. */
export async function chainId(db: SqlRunner, stopIds: string[]): Promise<string> {
  const [{ h }] = await db.all<{ h: string }>(`SELECT md5(${sqlText(stopIds.join("\x1f"))}) AS h`);
  return STOP_CHAIN_PREFIX + h;
}

/** Each stop of `stops` (stop_idx in order) with a position, its place in
 * the list (`i`), among those with a position (`j`), and how far along the
 * line through them it lies (`d`, metres). */
export function placedSql(stops: number[]): string {
  const values = stops.map((s, i) => `(${sqlNumber(i)}, ${sqlNumber(s)})`).join(", ");
  return `
    WITH calls(i, stop_idx) AS (VALUES ${values}),
    pos AS (
      SELECT c.i, coalesce(s.lon, p.lon) AS lon, coalesce(s.lat, p.lat) AS lat
      FROM calls c JOIN stops s USING (stop_idx) LEFT JOIN stops p ON p.stop_idx = s.parent_idx
      WHERE coalesce(s.lon, p.lon) IS NOT NULL AND coalesce(s.lat, p.lat) IS NOT NULL
    ),
    hops AS (
      SELECT *, ${metresSql("lag(lon) OVER (ORDER BY i)", "lag(lat) OVER (ORDER BY i)", "lon", "lat")} AS hop
      FROM pos
    )
    SELECT i, CAST(row_number() OVER (ORDER BY i) - 1 AS INTEGER) AS j, lon, lat,
           coalesce(sum(hop) OVER (ORDER BY i ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS d
    FROM hops`;
}

/** Statements that draw the line through `stops` as shape `shape_idx`: its
 * points and length, replacing any it had. */
export function chainShapeSql(shape_idx: number, stops: number[]): string[] {
  const idx = sqlNumber(shape_idx);
  return [
    `DELETE FROM shape_points WHERE shape_idx = ${idx}`,
    `INSERT INTO shape_points
     SELECT ${idx}, j, CAST(lon AS FLOAT), CAST(lat AS FLOAT), CAST(d AS FLOAT) FROM (${placedSql(stops)})`,
    `UPDATE shapes_meta SET length_m = (SELECT CAST(max(d) AS REAL) FROM shape_points WHERE shape_idx = ${idx})
     WHERE shape_idx = ${idx}`,
  ];
}

/** Statements that place each stop of a pattern on the line through its
 * stops (`pattern_shape_stops`), replacing what it had on that line. */
export function chainStopsSql(pattern_idx: number, shape_idx: number, stops: number[]): string[] {
  const p = sqlNumber(pattern_idx);
  const idx = sqlNumber(shape_idx);
  return [
    `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${p} AND shape_idx = ${idx}`,
    `INSERT INTO pattern_shape_stops
     SELECT ${p}, ${idx}, CAST(i AS INTEGER), CAST(d AS FLOAT) FROM (${placedSql(stops)})`,
  ];
}
