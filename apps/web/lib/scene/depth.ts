// The depth range of a map while it draws the globe (MapLibre 6.19). MapLibre's globe puts the near plane 0.5 px in
// front of the camera, where mercator puts it at a fiftieth of the map height. The depth buffer's precision follows
// the near plane, so with the globe's the ground is resolved far more coarsely than in mercator and fill extrusions
// (3D buildings, extruded polygons and hexagons) fight over depth and flicker while the camera moves. While the globe
// draws, GOAT moves the near plane out to mercator's and keeps MapLibre's own far plane, just past the globe, through
// MapLibre's near/far override. In mercator MapLibre computes its own range, which follows the pitch.
// Not over terrain: there MapLibre hides points and labels behind the ground by comparing their globe clipping depth
// with the terrain's depth from the projection matrix, which only works with the globe's own near plane; with the
// mercator one the ground's depth drops below the points' and every circle and symbol near the camera is hidden.
// So the globe shows no raised terrain while it draws (see `terrainExaggerationAt` in lib/scene/compile.ts) and keeps
// this range; the terrain rises only once the map is mercator, where MapLibre computes its own.
import type { Map as MaplibreMap } from "maplibre-gl";

import { projectionKind, rendersGlobe } from "@/lib/scene/visibility";

/** The latitude where web mercator ends, which MapLibre clamps the globe's scale to. */
const MAX_VALID_LATITUDE = 85.051129;

export interface NearFarZ {
  nearZ: number;
  farZ: number;
}

export interface GlobeCamera {
  /** The map's height in CSS pixels. */
  height: number;
  cameraToCenterDistance: number;
  globeRadiusPixels: number;
}

/** The globe's radius in pixels at a world size, scaled for the latitude of the center as MapLibre's globe does. */
export const globeRadiusPixels = (worldSize: number, latitude: number): number =>
  worldSize / (2 * Math.PI) / Math.cos((Math.min(Math.abs(latitude), MAX_VALID_LATITUDE) * Math.PI) / 180);

/** What a camera's range is computed from, as MapLibre's camera view state holds it. */
export interface CameraView {
  /** The map's height in CSS pixels. */
  height: number;
  zoom: number;
  tileSize: number;
  /** The vertical field of view. */
  fovInRadians: number;
  center: { lat: number };
}

/** A camera view's distance to the center and globe radius, derived the way MapLibre derives them. */
export const globeCamera = (view: CameraView): GlobeCamera => ({
  height: view.height,
  cameraToCenterDistance: (0.5 / Math.tan(view.fovInRadians / 2)) * view.height,
  globeRadiusPixels: globeRadiusPixels(view.tileSize * 2 ** view.zoom, view.center.lat),
});

/** The depth range for a globe camera: mercator's near plane and the globe's far plane; null for a map without size. */
export function globeDepthOverride(camera: GlobeCamera): NearFarZ | null {
  if (!(camera.height > 0)) return null;
  return {
    nearZ: camera.height / 50,
    farZ: camera.cameraToCenterDistance + 2 * camera.globeRadiusPixels,
  };
}

/** Whether a map keeps the globe's depth range: while the globe draws and no terrain is on. */
export const keepsGlobeDepth = (look: {
  projection: "mercator" | "globe";
  zoom: number;
  terrain: boolean;
}): boolean => !look.terrain && rendersGlobe(look);

type Camera = MaplibreMap["_camera"];

const attached = new WeakMap<MaplibreMap, () => void>();

/** Whether a map's camera has the state the range is kept in and the way to change it. */
function hasCameraState(map: MaplibreMap): boolean {
  try {
    const camera: Partial<Camera> | undefined = map._camera;
    return (
      typeof camera?.applyStateChange === "function" && "nearFarZOverride" in (camera.renderedState ?? {})
    );
  } catch {
    return false;
  }
}

const warnUnkept = (error?: unknown) =>
  console.warn(
    "The globe's depth range cannot be kept with this MapLibre version; 3D shapes on the globe may flicker.",
    ...(error === undefined ? [] : [error])
  );

/**
 * Keeps the globe's depth range on a map (see `keepsGlobeDepth`): set before each frame the globe draws in without
 * terrain, cleared when the map draws in mercator or gets terrain, and cleared again by the returned function.
 * Attaching twice to the same map returns the first disposer.
 *
 * The range is a field of MapLibre's camera state, which is replaced on every change and set through
 * `applyStateChange`, the way MapLibre sets the camera's bounds and limits. A movement goes on from the state it
 * changes, so the range set on one frame carries over to the next until it is brought in line again. MapLibre works
 * out whether the globe draws only while it renders a frame, after the camera events, so the decision here follows
 * the zoom like the globe's handover to mercator does (see `rendersGlobe`). After each frame the range is checked
 * again, and a frame is requested when it had to change.
 *
 * The camera state and `applyStateChange` are MapLibre internals. A map whose camera lacks them, or a failure while
 * the range is brought in line, leaves the map without the range: a warning is logged once, the listeners are
 * removed, and the map goes on drawing with MapLibre's own range.
 */
export function keepGlobeDepth(map: MaplibreMap): () => void {
  const existing = attached.get(map);
  if (existing) return existing;
  if (!hasCameraState(map)) {
    warnUnkept();
    const none = () => {
      attached.delete(map);
    };
    attached.set(map, none);
    return none;
  }

  let applied = false;

  /** Sets the range on the camera, or clears it with null; true when it changed. */
  const setRange = (next: NearFarZ | null): boolean => {
    const camera = map._camera;
    const current = camera.renderedState.nearFarZOverride;
    if (next ? current?.nearZ === next.nearZ && current?.farZ === next.farZ : !current) return false;
    camera.applyStateChange((view) => ({ ...view, nearFarZOverride: next }));
    return true;
  };

  /** Brings the depth range in line with the camera; true when it changed. */
  const sync = (): boolean => {
    const keep = keepsGlobeDepth({
      projection: projectionKind(map.getProjection()),
      zoom: map.getZoom(),
      terrain: !!map.getTerrain(),
    });
    // Elsewhere a range is only cleared that this function set.
    if (!keep && !applied) return false;
    const changed = setRange(keep ? globeDepthOverride(globeCamera(map._camera.renderedState)) : null);
    applied = keep;
    return changed;
  };

  const detach = () => {
    map.off("move", onCamera);
    map.off("resize", onCamera);
    map.off("projectiontransition", onCamera);
    map.off("terrain", onCamera);
    map.off("render", onRender);
  };

  /** Runs a sync; on a failure the map is let go of for good and keeps working without the range. */
  const guarded = (): boolean => {
    try {
      return sync();
    } catch (error) {
      detach();
      try {
        if (applied) setRange(null);
      } catch {
        // The camera cannot be changed at all; it keeps whatever range it has.
      }
      applied = false;
      warnUnkept(error);
      return false;
    }
  };

  function onCamera() {
    guarded();
  }
  function onRender() {
    if (guarded()) map.triggerRepaint();
  }

  map.on("move", onCamera);
  map.on("resize", onCamera);
  map.on("projectiontransition", onCamera);
  map.on("terrain", onCamera);
  map.on("render", onRender);
  guarded();

  const dispose = () => {
    detach();
    if (applied) {
      try {
        setRange(null);
      } catch {
        // As above: nothing more can be done for this camera.
      }
      applied = false;
    }
    attached.delete(map);
  };
  attached.set(map, dispose);
  return dispose;
}
