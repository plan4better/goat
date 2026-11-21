// The box a layer's stored extent (WKT) gives, without the app's API clients: what the style compiler's sources and
// zoom to layer both read.
import bbox from "@turf/bbox";

import { wktToGeoJSON } from "@/lib/utils/map/wkt";

/** West, south, east, north in degrees. */
export type Bounds = [number, number, number, number];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A box of four finite numbers, south below north, clamped into WGS84; undefined for anything else. */
export const asBounds = (box: unknown): Bounds | undefined => {
  if (!Array.isArray(box) || box.length < 4) return undefined;
  const [w, s, e, n] = box.slice(0, 4).map(Number);
  if (![w, s, e, n].every(Number.isFinite) || s > n) return undefined;
  return [clamp(w, -180, 180), clamp(s, -90, 90), clamp(e, -180, 180), clamp(n, -90, 90)];
};

/** The bounds of a WKT (or EWKT) extent; undefined for none or one that does not parse. */
export function boundsOfExtent(extent: unknown): Bounds | undefined {
  if (typeof extent !== "string" || !extent.trim()) return undefined;
  try {
    const geometry = wktToGeoJSON(extent.trim().replace(/^SRID=\d+;/i, ""));
    if (!geometry) return undefined;
    const box = asBounds(bbox(geometry as never));
    // A bounded box west of east; an empty geometry measures as infinities, which `asBounds` refuses.
    return box && box[0] <= box[2] ? box : undefined;
  } catch {
    return undefined;
  }
}

/** The whole world: what a layer without an extent reads as, once a schema has put in its default. */
export const isWholeWorld = ([w, s, e, n]: Bounds) => e - w >= 359 && n - s >= 170;

/** A layer's stored extent, where it says something: none, or the world box, says nothing. */
export function storedBounds(layer: { extent?: string | null }): Bounds | undefined {
  const box = boundsOfExtent(layer.extent);
  return box && !isWholeWorld(box) ? box : undefined;
}
