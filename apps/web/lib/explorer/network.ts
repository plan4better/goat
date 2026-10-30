/**
 * The Explorer's own drawing of the network: every shape of the bundle in
 * its route's colour, whatever GOAT's layers beneath show. The map draws the
 * bundle's shape_lines tiles and styles each shape from here, so this holds
 * what a shape is for — its colour and the routes on it — read once from the
 * snapshot. Kept outside Redux, as the playback clock is: thousands of shapes,
 * read by the map from outside the Explorer's provider.
 */
import type { FeatureCollection, Point, Polygon } from "geojson";

import type { SqlRunner } from "@/lib/explorer/db/types";
import { modeOf, routeColor } from "@/lib/explorer/modes";

export interface NetworkShape {
  /** `#RRGGBB`: the first route's colour, or its mode's. */
  color: string;
  route_ids: string[];
}

/** What the map needs of a route: to fade it by the Explorer tab's filter,
 * and to name it where a click finds several. */
export interface NetworkRoute {
  route_idx: number;
  route_id: string;
  route_type: number | null;
  agency_idx: number | null;
  short_name: string | null;
  long_name: string | null;
  /** The feed's colours, as RouteBadge draws them. */
  color: string | null;
  text_color: string | null;
}

export interface NetworkDrawing {
  /** The bundle's shape_lines layer, which the map draws shapes from. */
  shapeLinesLayerId: string | null;
  /** By `shape_id`, as the tiles carry it. */
  shapes: Map<string, NetworkShape>;
  /** A route's shapes, for highlighting it. */
  byRoute: Map<string, string[]>;
  routes: Map<string, NetworkRoute>;
  /** Every stop vehicles call at (not stations), to click for its timetable. */
  stops: FeatureCollection<Point, NetworkStopProps>;
  /** Each station as a faint area around its stops, to click for the
   * timetable of them all. */
  stations: FeatureCollection<Polygon, NetworkStopProps>;
}

export interface NetworkStopProps {
  stop_idx: number;
  name: string;
}

const NO_STOPS: FeatureCollection<Point, NetworkStopProps> = { type: "FeatureCollection", features: [] };
const NO_STATIONS: FeatureCollection<Polygon, NetworkStopProps> = { type: "FeatureCollection", features: [] };

const EMPTY: NetworkDrawing = {
  shapeLinesLayerId: null,
  shapes: new Map(),
  byRoute: new Map(),
  routes: new Map(),
  stops: NO_STOPS,
  stations: NO_STATIONS,
};

let drawing: NetworkDrawing = EMPTY;
const listeners = new Set<() => void>();

export const networkStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): NetworkDrawing {
    return drawing;
  },
  /** Some of the drawing, the rest kept: the lines, their colours and the
   * stops each arrive as soon as what they come from is in. */
  update(part: Partial<NetworkDrawing>): void {
    drawing = { ...drawing, ...part };
    listeners.forEach((l) => l());
  },
  reset(): void {
    drawing = EMPTY;
    listeners.forEach((l) => l());
  },
};

/** Every shape trips use, with its routes, read from the snapshot: the
 * feed's, and the lines through the stops of trips without one. And every
 * route, for the filter and the line chooser, whatever it is drawn with. */
export async function networkShapes(
  db: SqlRunner
): Promise<Pick<NetworkDrawing, "shapes" | "byRoute" | "routes">> {
  const [rows, all] = await Promise.all([
    db.all<{ shape_id: string; route_id: string; color: string | null; route_type: number | null }>(`
      SELECT m.shape_id, r.route_id, r.color, r.route_type
      FROM shape_route sr JOIN shapes_meta m USING (shape_idx) JOIN routes r USING (route_idx)
      ORDER BY m.shape_id, r.route_idx`),
    db.all<NetworkRoute>(`
      SELECT route_idx, route_id, route_type, agency_idx, short_name, long_name, color, text_color
      FROM routes ORDER BY route_idx`),
  ]);
  const shapes = new Map<string, NetworkShape>();
  const byRoute = new Map<string, string[]>();
  for (const r of rows) {
    const color = routeColor(r.color, modeOf(r.route_type));
    const s = shapes.get(r.shape_id);
    if (s) s.route_ids.push(r.route_id);
    else shapes.set(r.shape_id, { color, route_ids: [r.route_id] });
    const list = byRoute.get(r.route_id);
    if (list) list.push(r.shape_id);
    else byRoute.set(r.route_id, [r.shape_id]);
  }
  const routes = new Map(all.map((r) => [r.route_id, r]));
  return { shapes, byRoute, routes };
}

/** Every stop vehicles call at, as points: platforms and stops on their own
 * (location_type 0), each known by its station's name where it has one.
 * Stops no route calls at are left out. */
export async function networkStops(db: SqlRunner): Promise<FeatureCollection<Point, NetworkStopProps>> {
  const rows = await db.all<{ stop_idx: number; name: string; lon: number; lat: number }>(`
    WITH served AS (SELECT DISTINCT UNNEST(stops) AS stop_idx FROM patterns)
    SELECT s.stop_idx, COALESCE(p.name, s.name, s.stop_id) AS name, s.lon, s.lat
    FROM stops s JOIN served USING (stop_idx) LEFT JOIN stops p ON p.stop_idx = s.parent_idx
    WHERE COALESCE(s.location_type, 0) = 0 AND s.lon IS NOT NULL AND s.lat IS NOT NULL`);
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: { stop_idx: r.stop_idx, name: r.name },
    })),
  };
}

/** How far (m) a station's area reaches past its outermost stops, and how
 * many points round each corner. */
const STATION_MARGIN_M = 12;
const CORNER_POINTS = 12;

/** The convex hull of points, counter-clockwise (Andrew's monotone chain). */
export function convexHull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A station's area: its stops' outline widened by `margin` metres, rounded —
 * a circle round one stop, a capsule round two. Worked in metres on the spot
 * (longitude scaled by the latitude), returned as lon/lat. */
export function stationArea(stops: [number, number][], margin = STATION_MARGIN_M): [number, number][] {
  const lat0 = stops.reduce((sum, s) => sum + s[1], 0) / stops.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const round: [number, number][] = [];
  for (const [lon, lat] of stops)
    for (let k = 0; k < CORNER_POINTS; k++) {
      const a = (2 * Math.PI * k) / CORNER_POINTS;
      round.push([lon * kx + margin * Math.cos(a), lat * ky + margin * Math.sin(a)]);
    }
  const hull = convexHull(round).map(([x, y]) => [x / kx, y / ky] as [number, number]);
  return [...hull, hull[0]];
}

/** Every station some route calls at, as the area its stops (platforms)
 * cover. */
export async function networkStations(db: SqlRunner): Promise<FeatureCollection<Polygon, NetworkStopProps>> {
  const rows = await db.all<{ station: number; name: string; lon: number; lat: number }>(`
    WITH served AS (SELECT DISTINCT UNNEST(stops) AS stop_idx FROM patterns)
    SELECT s.parent_idx AS station, COALESCE(p.name, p.stop_id) AS name, s.lon, s.lat
    FROM stops s JOIN served USING (stop_idx) JOIN stops p ON p.stop_idx = s.parent_idx
    WHERE COALESCE(s.location_type, 0) = 0 AND s.lon IS NOT NULL AND s.lat IS NOT NULL
    ORDER BY s.parent_idx`);
  const byStation = new Map<number, { name: string; points: [number, number][] }>();
  for (const r of rows) {
    const st = byStation.get(r.station);
    if (st) st.points.push([r.lon, r.lat]);
    else byStation.set(r.station, { name: r.name, points: [[r.lon, r.lat]] });
  }
  return {
    type: "FeatureCollection",
    features: [...byStation].map(([stop_idx, st]) => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [stationArea(st.points)] },
      properties: { stop_idx, name: st.name },
    })),
  };
}

/**
 * Each shape's colour as one style expression, a `match` on the tiles'
 * `shape_id`: the map works it out once, as it reads each tile, instead of
 * keeping a feature-state per shape, which it applies again to every tile
 * that loads and repaints for every change (the whole network, on the
 * largest feeds, a second and more of the main thread). Shapes of one colour
 * share a branch; any other shape is `fallback`.
 */
export function shapeColorExpression(
  shapes: Map<string, NetworkShape>,
  fallback: string,
  /** How the map draws a colour (lifted on a dark basemap). */
  paint: (color: string) => string = (color) => color
): string | ["match", ["to-string", ["get", "shape_id"]], ...unknown[]] {
  const byColor = new Map<string, string[]>();
  for (const [id, shape] of shapes) {
    const color = paint(shape.color);
    const ids = byColor.get(color);
    if (ids) ids.push(id);
    else byColor.set(color, [id]);
  }
  if (!byColor.size) return fallback;
  const branches = [...byColor].flatMap(([color, ids]) => [ids, color]);
  return ["match", ["to-string", ["get", "shape_id"]], ...branches, fallback];
}
