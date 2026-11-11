// The depth range of a map while it draws the globe (MapLibre 6.16). MapLibre's globe puts the near plane 0.5 px in
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

type Transform = MaplibreMap["_camera"]["transform"];

const overrideFor = (tr: Transform): NearFarZ | null =>
  globeDepthOverride({
    height: tr.height,
    cameraToCenterDistance: tr.cameraToCenterDistance,
    globeRadiusPixels: globeRadiusPixels(tr.worldSize, tr.center.lat),
  });

const attached = new WeakMap<MaplibreMap, () => void>();

/**
 * Keeps the globe's depth range on a map (see `keepsGlobeDepth`): set before each frame the globe draws in without
 * terrain, cleared when the map draws in mercator or gets terrain, and cleared again by the returned function.
 * Attaching twice to the same map returns the first disposer.
 *
 * MapLibre works out whether the globe draws only while it renders a frame, after the camera events, so the decision
 * here follows the zoom like the globe's handover to mercator does (see `rendersGlobe`). A camera gesture over terrain
 * moves a copy of the transform and writes it back, override included, so the copy is kept in step too. After each
 * frame the range is checked again, and a frame is requested when it had to change.
 */
export function keepGlobeDepth(map: MaplibreMap): () => void {
  const existing = attached.get(map);
  if (existing) return existing;

  let applied = false;

  const transforms = (): Transform[] => {
    const requested = map._camera._requestedCameraState;
    return requested ? [map._camera.transform, requested] : [map._camera.transform];
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
    let changed = false;
    for (const tr of transforms()) {
      const next = keep ? overrideFor(tr) : null;
      const current = tr.nearFarZOverride;
      if (next && (current?.nearZ !== next.nearZ || current?.farZ !== next.farZ)) {
        tr.overrideNearFarZ(next.nearZ, next.farZ);
        changed = true;
      } else if (!next && current) {
        tr.clearNearFarZOverride();
        changed = true;
      }
    }
    applied = keep;
    return changed;
  };

  const onCamera = () => {
    sync();
  };
  const onRender = () => {
    if (sync()) map.triggerRepaint();
  };

  map.on("move", onCamera);
  map.on("resize", onCamera);
  map.on("projectiontransition", onCamera);
  map.on("terrain", onCamera);
  map.on("render", onRender);
  sync();

  const dispose = () => {
    map.off("move", onCamera);
    map.off("resize", onCamera);
    map.off("projectiontransition", onCamera);
    map.off("terrain", onCamera);
    map.off("render", onRender);
    if (applied) {
      for (const tr of transforms()) if (tr.nearFarZOverride) tr.clearNearFarZOverride();
      applied = false;
    }
    attached.delete(map);
  };
  attached.set(map, dispose);
  return dispose;
}
