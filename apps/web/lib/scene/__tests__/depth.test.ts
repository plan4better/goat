import type { Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";

import { globeDepthOverride, globeRadiusPixels, keepGlobeDepth, keepsGlobeDepth } from "@/lib/scene/depth";
import { GLOBE_HANDOVER } from "@/lib/scene/visibility";

const { from, until } = GLOBE_HANDOVER;

describe("globe depth range", () => {
  it("puts the near plane at a fiftieth of the height and the far plane past the globe", () => {
    expect(
      globeDepthOverride({ height: 700, cameraToCenterDistance: 1050, globeRadiusPixels: 4000 })
    ).toEqual({
      nearZ: 14,
      farZ: 9050,
    });
  });

  it("gives no range for a map without size", () => {
    expect(globeDepthOverride({ height: 0, cameraToCenterDistance: 0, globeRadiusPixels: 100 })).toBeNull();
  });

  it("scales the globe radius with the latitude like MapLibre, clamped at mercator's edge", () => {
    expect(globeRadiusPixels(2 * Math.PI * 100, 0)).toBeCloseTo(100);
    expect(globeRadiusPixels(2 * Math.PI * 100, 60)).toBeCloseTo(200);
    expect(globeRadiusPixels(2 * Math.PI * 100, -60)).toBeCloseTo(200);
    expect(globeRadiusPixels(2 * Math.PI * 100, 90)).toBeCloseTo(
      globeRadiusPixels(2 * Math.PI * 100, 85.051129)
    );
  });
});

describe("keepsGlobeDepth", () => {
  it("keeps the globe's range while the globe draws without terrain", () => {
    expect(keepsGlobeDepth({ projection: "globe", zoom: 5, terrain: false })).toBe(true);
    expect(keepsGlobeDepth({ projection: "globe", zoom: (from + until) / 2, terrain: false })).toBe(true);
  });

  it("leaves MapLibre's own range with terrain on, once the globe has handed over and in mercator", () => {
    expect(keepsGlobeDepth({ projection: "globe", zoom: (from + until) / 2, terrain: true })).toBe(false);
    expect(keepsGlobeDepth({ projection: "globe", zoom: until, terrain: false })).toBe(false);
    expect(keepsGlobeDepth({ projection: "mercator", zoom: 5, terrain: false })).toBe(false);
  });
});

class FakeTransform {
  height = 700;
  cameraToCenterDistance = 1050;
  worldSize = 512 * 2 ** 5;
  center = { lat: 0, lng: 0 };
  nearFarZOverride: { nearZ: number; farZ: number } | null = null;
  overrideNearFarZ = vi.fn((nearZ: number, farZ: number) => {
    this.nearFarZOverride = { nearZ, farZ };
  });
  clearNearFarZOverride = vi.fn(() => {
    this.nearFarZOverride = null;
  });
}

function fakeMap({ projection = "globe", zoom = 5, terrain = false } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const state = { projection, zoom, terrain };
  const camera: { transform: FakeTransform; _requestedCameraState?: FakeTransform } = {
    transform: new FakeTransform(),
  };
  const map = {
    _camera: camera,
    getProjection: () => ({ type: state.projection }),
    getZoom: () => state.zoom,
    getTerrain: () => (state.terrain ? { source: "goat-terrain" } : null),
    triggerRepaint: vi.fn(),
    on: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    off: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  };
  const fire = (type: string) => listeners.get(type)?.forEach((fn) => fn());
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { map, maplibre: map as unknown as MaplibreMap, state, camera, fire, count };
}

const expected = (tr: FakeTransform) =>
  globeDepthOverride({
    height: tr.height,
    cameraToCenterDistance: tr.cameraToCenterDistance,
    globeRadiusPixels: globeRadiusPixels(tr.worldSize, tr.center.lat),
  });

describe("keepGlobeDepth", () => {
  it("sets the range at once while the globe draws and follows each camera change", () => {
    const { maplibre, camera, fire } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    expect(camera.transform.nearFarZOverride).toEqual(expected(camera.transform));

    camera.transform.worldSize *= 2;
    camera.transform.center.lat = 50;
    fire("move");
    expect(camera.transform.nearFarZOverride).toEqual(expected(camera.transform));

    camera.transform.height = 400;
    fire("resize");
    expect(camera.transform.nearFarZOverride?.nearZ).toBe(8);
    dispose();
  });

  it("leaves mercator alone and clears the range once the globe has handed over and on a switch to mercator", () => {
    const { maplibre, state, camera, fire } = fakeMap({ projection: "mercator" });
    const dispose = keepGlobeDepth(maplibre);
    expect(camera.transform.overrideNearFarZ).not.toHaveBeenCalled();

    state.projection = "globe";
    fire("projectiontransition");
    expect(camera.transform.nearFarZOverride).not.toBeNull();

    state.zoom = until;
    fire("move");
    expect(camera.transform.nearFarZOverride).toBeNull();

    state.zoom = until - 0.1;
    fire("move");
    expect(camera.transform.nearFarZOverride).not.toBeNull();

    state.projection = "mercator";
    fire("projectiontransition");
    expect(camera.transform.nearFarZOverride).toBeNull();
    dispose();
  });

  it("leaves the globe's own range while terrain is on, which its points and labels are depth-tested against", () => {
    const { maplibre, state, camera, fire } = fakeMap({ terrain: true });
    const dispose = keepGlobeDepth(maplibre);
    expect(camera.transform.overrideNearFarZ).not.toHaveBeenCalled();

    state.terrain = false;
    fire("terrain");
    expect(camera.transform.nearFarZOverride).toEqual(expected(camera.transform));

    state.terrain = true;
    fire("terrain");
    expect(camera.transform.nearFarZOverride).toBeNull();
    dispose();
  });

  it("does not set the range again for an unchanged camera", () => {
    const { maplibre, camera, fire } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    fire("move");
    fire("move");
    expect(camera.transform.overrideNearFarZ).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("keeps a gesture's camera copy in step, and repaints after a frame whose range was stale", () => {
    const { map, maplibre, camera, fire } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    camera._requestedCameraState = new FakeTransform();
    fire("move");
    expect(camera._requestedCameraState.nearFarZOverride).toEqual(expected(camera._requestedCameraState));

    // Writing the copy back carries its range over; a frame drawn before the next camera event then repairs it.
    camera.transform.nearFarZOverride = null;
    fire("render");
    expect(camera.transform.nearFarZOverride).toEqual(expected(camera.transform));
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    fire("render");
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("reads the transform afresh after a projection change replaces it", () => {
    const { maplibre, camera, fire } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    camera.transform = new FakeTransform();
    fire("projectiontransition");
    expect(camera.transform.nearFarZOverride).toEqual(expected(camera.transform));
    dispose();
  });

  it("clears the range and its listeners on teardown, and attaches once per map", () => {
    const { maplibre, camera, count } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    expect(keepGlobeDepth(maplibre)).toBe(dispose);
    expect(count()).toBe(5);
    dispose();
    expect(count()).toBe(0);
    expect(camera.transform.nearFarZOverride).toBeNull();
  });
});
