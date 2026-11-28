/**
 * Distances on the Earth, for the edits: in SQL (DuckDB has no spatial
 * functions in the Explorer's build) and in the browser, the same formula as
 * the snapshot's `_hav_m`.
 */

const EARTH_M = 6371008.8;

/** Metres between two points, as SQL over the four expressions given. */
export function metresSql(lon1: string, lat1: string, lon2: string, lat2: string): string {
  return `(2 * ${EARTH_M} * asin(sqrt(
    pow(sin(radians(${lat2} - ${lat1}) / 2), 2)
    + cos(radians(${lat1})) * cos(radians(${lat2})) * pow(sin(radians(${lon2} - ${lon1}) / 2), 2))))`;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Metres between two `[lon, lat]` points. */
export function metres(a: [number, number], b: [number, number]): number {
  const s =
    Math.sin(rad(b[1] - a[1]) / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}
