import type { Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";

import {
  globeCamera,
  globeDepthOverride,
  globeRadiusPixels,
  keepGlobeDepth,
  keepsGlobeDepth,
} from "@/lib/scene/depth";
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

/** MapLibre's default vertical field of view, whose tangent at half the angle is a third. */
const DEFAULT_FOV = 2 * Math.atan(1 / 3);

describe("globeCamera", () => {
  it("derives the distance to the center and the globe's radius from the camera's view as MapLibre does", () => {
    const camera = globeCamera({
      height: 700,
      zoom: 5,
      tileSize: 512,
      fovInRadians: DEFAULT_FOV,
      center: { lat: 60 },
    });
    expect(camera.height).toBe(700);
    expect(camera.cameraToCenterDistance).toBeCloseTo(1050, 9);
    expect(camera.globeRadiusPixels).toBeCloseTo(globeRadiusPixels(512 * 2 ** 5, 60), 9);
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

/** The camera's view state, as MapLibre's camera hands it out. */
interface FakeView {
  height: number;
  zoom: number;
  tileSize: number;
  fovInRadians: number;
  center: { lat: number; lng: number };
  nearFarZOverride: { nearZ: number; farZ: number } | null;
}

/** MapLibre's camera: a state that is replaced, never written into, and changed only through `applyStateChange`. */
class FakeCamera {
  state: FakeView = {
    height: 700,
    zoom: 5,
    tileSize: 512,
    fovInRadians: DEFAULT_FOV,
    center: { lat: 0, lng: 0 },
    nearFarZOverride: null,
  };
  get renderedState() {
    return this.state;
  }
  applyStateChange = vi.fn((change: (view: FakeView) => FakeView) => {
    this.state = change(this.state);
  });
  /** Replaces the state with some of its values changed, as a camera change does. */
  move(changes: Partial<FakeView>) {
    this.state = { ...this.state, ...changes };
  }
}

function fakeMap(
  { projection = "globe", zoom = 5, terrain = false } = {},
  camera: object = new FakeCamera()
) {
  const listeners = new Map<string, Set<() => void>>();
  const state = { projection, zoom, terrain };
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
  return { map, maplibre: map as unknown as MaplibreMap, state, camera: camera as FakeCamera, fire, count };
}

const expected = (view: FakeView) => globeDepthOverride(globeCamera(view));

describe("keepGlobeDepth", () => {
  it("sets the range at once while the globe draws and follows each camera change", () => {
    const { maplibre, camera, fire } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    expect(camera.state.nearFarZOverride).toEqual(expected(camera.state));

    camera.move({ zoom: 6, center: { lat: 50, lng: 0 } });
    fire("move");
    expect(camera.state.nearFarZOverride).toEqual(expected(camera.state));

    camera.move({ height: 400 });
    fire("resize");
    expect(camera.state.nearFarZOverride?.nearZ).toBe(8);
    dispose();
  });

  it("changes only the depth range of the camera", () => {
    const { maplibre, camera } = fakeMap();
    const before = camera.state;
    const dispose = keepGlobeDepth(maplibre);
    expect(camera.state).toEqual({ ...before, nearFarZOverride: expected(before) });
    dispose();
  });

  it("leaves mercator alone and clears the range once the globe has handed over and on a switch to mercator", () => {
    const { maplibre, state, camera, fire } = fakeMap({ projection: "mercator" });
    const dispose = keepGlobeDepth(maplibre);
    expect(camera.applyStateChange).not.toHaveBeenCalled();

    state.projection = "globe";
    fire("projectiontransition");
    expect(camera.state.nearFarZOverride).not.toBeNull();

    state.zoom = until;
    fire("move");
    expect(camera.state.nearFarZOverride).toBeNull();

    state.zoom = until - 0.1;
    fire("move");
    expect(camera.state.nearFarZOverride).not.toBeNull();

    state.projection = "mercator";
    fire("projectiontransition");
    expect(camera.state.nearFarZOverride).toBeNull();
    dispose();
  });

  it("leaves the globe's own range while terrain is on, which its points and labels are depth-tested against", () => {
    const { maplibre, state, camera, fire } = fakeMap({ terrain: true });
    const dispose = keepGlobeDepth(maplibre);
    expect(camera.applyStateChange).not.toHaveBeenCalled();

    state.terrain = false;
    fire("terrain");
    expect(camera.state.nearFarZOverride).toEqual(expected(camera.state));

    state.terrain = true;
    fire("terrain");
    expect(camera.state.nearFarZOverride).toBeNull();
    dispose();
  });

  it("does not set the range again for an unchanged camera", () => {
    const { maplibre, camera, fire } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    fire("move");
    fire("move");
    expect(camera.applyStateChange).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("repaints after a frame whose range was stale", () => {
    const { map, maplibre, camera, fire } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    camera.move({ zoom: 6 });
    fire("render");
    expect(camera.state.nearFarZOverride).toEqual(expected(camera.state));
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    fire("render");
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("clears the range and its listeners on teardown, and attaches once per map", () => {
    const { maplibre, camera, count } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    expect(keepGlobeDepth(maplibre)).toBe(dispose);
    expect(count()).toBe(5);
    dispose();
    expect(count()).toBe(0);
    expect(camera.state.nearFarZOverride).toBeNull();
  });
});

describe("keepGlobeDepth on a MapLibre without the camera state it needs", () => {
  const warnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("does nothing but warn once when the camera has no state to set the range in", () => {
    const warn = warnings();
    for (const camera of [
      {},
      { renderedState: { nearFarZOverride: null } },
      { applyStateChange: () => {} },
    ]) {
      warn.mockClear();
      const { maplibre, count } = fakeMap({}, camera);
      let dispose: (() => void) | undefined;
      expect(() => (dispose = keepGlobeDepth(maplibre))).not.toThrow();
      expect(typeof dispose).toBe("function");
      expect(count()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(() => dispose!()).not.toThrow();
    }
    warn.mockRestore();
  });

  it("lets go of the map after the first failure while attaching", () => {
    const warn = warnings();
    const camera = new FakeCamera();
    camera.applyStateChange.mockImplementation(() => {
      throw new Error("changed camera");
    });
    const { maplibre, count, fire } = fakeMap({}, camera);
    expect(() => keepGlobeDepth(maplibre)).not.toThrow();
    expect(count()).toBe(0);
    fire("move");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("removes its listeners after the first failure in a camera event, and warns once", () => {
    const warn = warnings();
    const { maplibre, camera, count, fire, map } = fakeMap();
    const dispose = keepGlobeDepth(maplibre);
    expect(count()).toBe(5);
    camera.applyStateChange.mockImplementation(() => {
      throw new Error("changed camera");
    });
    camera.move({ zoom: 6 });
    expect(() => fire("move")).not.toThrow();
    expect(count()).toBe(0);
    expect(() => fire("render")).not.toThrow();
    expect(map.triggerRepaint).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => dispose()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
