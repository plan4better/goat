import { MAX_BASEMAPS, acceptedBasemap } from "@/lib/assistant/basemapInfo";
import type { ViewTarget } from "@/lib/assistant/mapEdits";
import type { BasemapInfo, MapViewPayload, ProjectMapContext, UndoFn, Viewport } from "@/lib/assistant/types";
import { ENTER_3D } from "@/lib/scene/view";

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
    options?: { padding?: number; duration?: number; bearing?: number; pitch?: number }
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
  basemap,
  basemaps,
  viewMode,
  projection,
}: {
  projectId: string;
  map: MapLike | null;
  activeLayerId: number | null;
  basemap?: BasemapInfo;
  basemaps?: BasemapInfo[];
  viewMode?: "2d" | "3d";
  projection?: "mercator" | "globe";
}): ProjectMapContext {
  const context: ProjectMapContext = { surface: "project.map", project_id: projectId };
  if (activeLayerId !== null && Number.isInteger(activeLayerId) && activeLayerId >= 1) {
    context.selected_layer_project_id = activeLayerId;
  }
  if (map) context.viewport = mapViewport(map);
  // A basemap the server would refuse is left out rather than sent.
  if (basemap && acceptedBasemap(basemap)) context.basemap = basemap;
  const offered = basemaps?.filter(acceptedBasemap).slice(0, MAX_BASEMAPS);
  if (offered?.length) context.basemaps = offered;
  if (viewMode === "2d" || viewMode === "3d") context.view_mode = viewMode;
  if (projection === "mercator" || projection === "globe") context.projection = projection;
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

interface Camera {
  center: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
}

/** Where the map's camera is now. */
function cameraOf(map: MapLike): Required<Camera> {
  const center = map.getCenter();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
}

/** Flies to a camera, or fits a box inside the view; `tilt` is the bearing and pitch a fitted box ends at. */
function moveCamera(
  map: MapLike,
  to: { camera?: Camera | null; bbox?: readonly number[] | null },
  tilt: { bearing?: number; pitch?: number } = {}
): void {
  if (to.camera) {
    const { center, zoom, bearing, pitch } = to.camera;
    map.flyTo({ center, zoom, bearing, pitch });
  } else if (to.bbox) {
    const [west, south, east, north] = to.bbox;
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 48, duration: 800, ...tilt }
    );
  }
}

/** Move the map to a proposed view (page state only, spec §10); the returned function flies back. */
export function applyMapView(map: MapLike, payload: MapViewPayload): () => void {
  const before = cameraOf(map);
  moveCamera(map, payload);
  return () => {
    map.flyTo(before);
  };
}

/** The page's 2D or 3D mode and projection, and the page's own switches of them. */
export interface PageView {
  get: () => { mode: "2d" | "3d"; projection: "mercator" | "globe" };
  setMode: (mode: "2d" | "3d") => void;
  setProjection: (projection: "mercator" | "globe") => void;
}

/**
 * Shows a view on the map (page state only): the projection and the mode through the page's own switches, the
 * camera as `applyMapView` moves it. The returned function puts back the camera, mode and projection from before.
 *
 * The page eases the camera itself when it draws a switched mode (tilted into 3D, flat and north up into 2D), and
 * that easing stops a move under way. A move that comes with a switch therefore starts after it, and ends at the
 * tilt the switch gives unless the target names its own.
 *
 * `getMap` answers the map the page draws now (null while it draws none): the page draws a new one after a switch
 * to Workflows or Reports and back, and the way back moves that one.
 */
export function applyViewTarget(getMap: () => MapLike | null, target: ViewTarget, view: PageView): UndoFn {
  const drawn = getMap();
  const before = { ...view.get(), camera: drawn ? cameraOf(drawn) : undefined };
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const show = (to: ViewTarget) => {
    if (waiting) clearTimeout(waiting);
    waiting = null;
    const shown = view.get();
    if (to.projection && to.projection !== shown.projection) view.setProjection(to.projection);
    if (to.mode && to.mode !== shown.mode) view.setMode(to.mode);
    // The page may keep its mode (3D where the browser would draw it in software).
    const mode = view.get().mode;
    const switched = mode !== shown.mode;
    const map = getMap();
    if (!map) return;
    const camera = to.camera && { ...to.camera, center: to.camera.center ?? cameraOf(map).center };
    if (!camera && !to.bbox) return;
    if (!switched) return moveCamera(map, { camera, bbox: to.bbox });
    // 2D is flat and north up whatever the target says; 3D takes the target's tilt when it names one.
    const tilt = mode === "3d" ? { pitch: ENTER_3D.pitch } : { pitch: 0, bearing: 0 };
    const tilted = camera && (mode === "3d" ? { ...tilt, ...camera } : { ...camera, ...tilt });
    waiting = setTimeout(() => {
      waiting = null;
      const live = getMap();
      if (live) moveCamera(live, { camera: tilted, bbox: to.bbox }, tilt);
    }, 0);
  };
  show(target);
  return () => show({ mode: before.mode, projection: before.projection, camera: before.camera });
}
