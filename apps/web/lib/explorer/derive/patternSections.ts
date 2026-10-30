/**
 * The stretch of line a pattern runs: its shape from its first stop to its
 * last. A short turn usually rides its route's full shape and stops early,
 * so the shape alone would show the whole route; this is the part it runs.
 *
 * Stops are placed along each shape by the snapshot (`pattern_shape_stops`,
 * metres along it, as `shape_points.d`); the shape is cut there, between its
 * points, so the section starts and ends at the stops. Shapes made through
 * the stops of trips without one (stop chains) are cut the same way.
 */
import type { Feature, FeatureCollection, LineString } from "geojson";

import type { SqlRunner } from "@/lib/explorer/db/types";

export interface SectionProps {
  pattern_idx: number;
}

/** The trips that run `patterns`, by trip_idx: their vehicles are the ones
 * the map keeps in colour while those patterns are picked. */
export async function patternTrips(db: SqlRunner, patterns: number[]): Promise<Set<number>> {
  if (!patterns.length) return new Set();
  const rows = await db.all<{ trip_idx: number }>(
    `SELECT trip_idx FROM trips WHERE pattern_idx IN (${patterns.join(",")})`
  );
  return new Set(rows.map((r) => r.trip_idx));
}

/** The sections of `patterns`, one line per pattern and shape it rides. */
export async function patternSections(
  db: SqlRunner,
  patterns: number[]
): Promise<FeatureCollection<LineString, SectionProps>> {
  if (!patterns.length) return { type: "FeatureCollection", features: [] };
  // Each pattern's span along each of its shapes, and the shape's points
  // from the last one at or before the first stop to the first one at or
  // after the last, so both ends can be cut between points.
  const rows = await db.all<{
    pattern_idx: number;
    shape_idx: number;
    d0: number;
    d1: number;
    lon: number;
    lat: number;
    d: number;
  }>(`
    WITH ends AS (
      SELECT pattern_idx, shape_idx, min(d) AS d0, max(d) AS d1
      FROM pattern_shape_stops
      WHERE pattern_idx IN (${patterns.join(",")}) AND d IS NOT NULL
      GROUP BY 1, 2
    ),
    span AS (
      SELECT e.*,
             (SELECT max(d) FROM shape_points p WHERE p.shape_idx = e.shape_idx AND p.d <= e.d0) AS lo,
             (SELECT min(d) FROM shape_points p WHERE p.shape_idx = e.shape_idx AND p.d >= e.d1) AS hi
      FROM ends e
    )
    SELECT s.pattern_idx, s.shape_idx, s.d0, s.d1, p.lon, p.lat, p.d
    FROM span s JOIN shape_points p
      ON p.shape_idx = s.shape_idx AND p.d BETWEEN coalesce(s.lo, s.d0) AND coalesce(s.hi, s.d1)
    ORDER BY s.pattern_idx, s.shape_idx, p.i`);

  const features: Feature<LineString, SectionProps>[] = [];
  let i = 0;
  while (i < rows.length) {
    const { pattern_idx, shape_idx, d0, d1 } = rows[i];
    let j = i;
    while (j < rows.length && rows[j].pattern_idx === pattern_idx && rows[j].shape_idx === shape_idx) j++;
    const line = cut(rows.slice(i, j), d0, d1);
    if (line.length >= 2)
      features.push({
        type: "Feature",
        properties: { pattern_idx },
        geometry: { type: "LineString", coordinates: line },
      });
    i = j;
  }
  return { type: "FeatureCollection", features };
}

/** The line through `points` (in order along the shape) from `d0` to `d1`
 * metres along it, its ends placed between points where they fall. */
export function cut(
  points: { lon: number; lat: number; d: number }[],
  d0: number,
  d1: number
): [number, number][] {
  const out: [number, number][] = [];
  const at = (a: (typeof points)[number], b: (typeof points)[number], d: number): [number, number] => {
    const f = b.d === a.d ? 0 : (d - a.d) / (b.d - a.d);
    return [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f];
  };
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    const prev = points[k - 1];
    if (p.d < d0) continue;
    if (!out.length && prev && prev.d < d0) out.push(at(prev, p, d0));
    if (p.d > d1) {
      if (prev && prev.d <= d1) out.push(at(prev, p, d1));
      break;
    }
    out.push([p.lon, p.lat]);
  }
  return out;
}
