import type { MapViewPayload, ProjectMapContext, Viewport } from "@/lib/assistant/types";

/** The methods of a MapLibre map (react-map-gl's MapRef) the project surface uses. */
export interface MapLike {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } | null;
  flyTo(options: { center: [number, number]; zoom?: number; bearing?: number; pitch?: number }): unknown;
  fitBounds(
    bounds: [[number, number], [number, number]],
    options?: { padding?: number; duration?: number }
  ): unknown;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
// A wrapped world view reports longitudes past ±180; the server accepts WGS84 only.
const lon = (value: number) => round(clamp(value, -180, 180), 5);
// The center of a map panned across world copies wraps back to its real longitude.
const wrapLon = (value: number) => round(((((value + 180) % 360) + 360) % 360) - 180, 5);
const lat = (value: number) => round(clamp(value, -90, 90), 5);

export function mapViewport(map: MapLike): Viewport {
  const center = map.getCenter();
  const viewport: Viewport = {
    center: [wrapLon(center.lng), lat(center.lat)],
    zoom: round(clamp(map.getZoom(), 0, 24), 2),
    bearing: round(clamp(map.getBearing(), -360, 360), 1),
    pitch: round(clamp(map.getPitch(), 0, 90), 1),
  };
  const bounds = map.getBounds();
  if (bounds) {
    const box: [number, number, number, number] = [
      lon(bounds.getWest()),
      lat(bounds.getSouth()),
      lon(bounds.getEast()),
      lat(bounds.getNorth()),
    ];
    if (box[0] < box[2] && box[1] < box[3]) viewport.bbox = box;
  }
  return viewport;
}

export function projectMapContext({
  projectId,
  map,
  activeLayerId,
}: {
  projectId: string;
  map: MapLike | null;
  activeLayerId: number | null;
}): ProjectMapContext {
  const context: ProjectMapContext = { surface: "project.map", project_id: projectId };
  if (activeLayerId !== null && Number.isInteger(activeLayerId) && activeLayerId >= 1) {
    context.selected_layer_project_id = activeLayerId;
  }
  if (map) context.viewport = mapViewport(map);
  return context;
}

/** Whether two [west, south, east, north] boxes share any area or edge. */
export const boxesOverlap = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * Whether two views of the map show the same area: each side moved by less
 * than 1% of the view's width or height. Any move counts, the user's or one a
 * map control made (search, zoom buttons, zoom to layer).
 */
export const sameView = (a: readonly number[], b: readonly number[]): boolean => {
  const dx = (a[2] - a[0]) / 100;
  const dy = (a[3] - a[1]) / 100;
  return (
    Math.abs(a[0] - b[0]) <= dx &&
    Math.abs(a[2] - b[2]) <= dx &&
    Math.abs(a[1] - b[1]) <= dy &&
    Math.abs(a[3] - b[3]) <= dy
  );
};

/** Move the map to a proposed view (page state only, spec §10); the returned function flies back. */
export function applyMapView(map: MapLike, payload: MapViewPayload): () => void {
  const center = map.getCenter();
  const before = {
    center: [center.lng, center.lat] as [number, number],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
  if (payload.camera) {
    const { center: target, zoom, bearing, pitch } = payload.camera;
    map.flyTo({ center: target, zoom, bearing, pitch });
  } else if (payload.bbox) {
    const [west, south, east, north] = payload.bbox;
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 48, duration: 800 }
    );
  }
  return () => {
    map.flyTo(before);
  };
}
