// The globe's depth range (lib/scene/depth.ts) on a real MapLibre map in the lab's browser: what each frame is drawn
// with while the globe draws, in mercator, with terrain, during animations and gestures and after the range is let
// go, read from what MapLibre hands a custom layer for each frame. The range's far plane is compared with the one
// MapLibre computes itself, and a picture shows the extrusions on a tilted globe that the range is there for.
import { type CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { GLOBE_PROJECTION } from "@/lib/scene/compile";
import { globeCamera, globeDepthOverride, keepGlobeDepth } from "@/lib/scene/depth";
import { GLOBE_HANDOVER } from "@/lib/scene/visibility";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";

const SIZE = { width: 640, height: 480 };
/** A lab raster served at every tile address, read as elevation: terrain the lab can turn on without the network. */
const DEM_TILES = "/lab-raster/cells/{z}/{x}/{y}.webp";

/** The depth range of the last frame each map drew, as MapLibre handed it to the custom layer `globeMap` adds. */
const lastFrame = new WeakMap<MaplibreMap, Pick<CustomRenderMethodInput, "nearZ" | "farZ">>();

/** The depth range the map drew its last frame with, and the range set on its camera. */
const drawn = (map: MaplibreMap) => ({
  ...lastFrame.get(map)!,
  nearFarZOverride: map._camera.renderedState.nearFarZOverride,
});

/** The range `keepGlobeDepth` keeps for the map's camera. */
const kept = (map: MaplibreMap) => globeDepthOverride(globeCamera(map._camera.renderedState));

const maps: MaplibreMap[] = [];

afterEach(() => {
  while (maps.length) maps.pop()?.remove();
});

async function globeMap(zoom = 3): Promise<MaplibreMap> {
  const screen = await render(<div style={{ ...SIZE }} />);
  const map = new MaplibreMap({
    ...MAPLIBRE_MAP_OPTIONS,
    container: screen.container.firstElementChild as HTMLElement,
    center: [11.5, 48.1],
    zoom,
    attributionControl: false,
    fadeDuration: 0,
    // Keeps the frame in the drawing buffer after compositing, for the picture.
    canvasContextAttributes: { preserveDrawingBuffer: true },
    style: {
      version: 8,
      projection: GLOBE_PROJECTION,
      sources: {
        dem: { type: "raster-dem", tiles: [DEM_TILES], tileSize: 256, encoding: "terrarium", maxzoom: 4 },
      },
      layers: [{ id: "ground", type: "background", paint: { "background-color": "#e6ecef" } }],
    },
  });
  // As react-map-gl's <Map> does, so each camera change is shown to a callback.
  map.setTransformCameraUpdate(() => ({}));
  maps.push(map);
  await map.once("load");
  map.addLayer({
    id: "frame",
    type: "custom",
    render: (_gl, { nearZ, farZ }) => {
      lastFrame.set(map, { nearZ, farZ });
    },
  });
  return map;
}

/** Resolves once the map is idle, or rejects: a map that keeps requesting frames never gets there. */
const idle = (map: MaplibreMap, ms = 5000) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the map did not become idle")), ms);
    map.once("idle", () => {
      clearTimeout(timer);
      resolve();
    });
    map.triggerRepaint();
  });

/** A frame as the map painted it. */
interface Frame {
  zoom: number;
  nearZ: number;
  farZ: number;
  override: { nearZ: number; farZ: number } | null;
  expected: { nearZ: number; farZ: number } | null;
}

/**
 * Records each frame the map paints. Called before `keepGlobeDepth` attaches, so its listener reads each frame as it
 * was drawn, before the range is checked again after it.
 */
function recordFrames(map: MaplibreMap): Frame[] {
  const frames: Frame[] = [];
  map.on("render", () => {
    const frame = drawn(map);
    frames.push({
      zoom: map.getZoom(),
      nearZ: frame.nearZ,
      farZ: frame.farZ,
      override: frame.nearFarZOverride,
      expected: kept(map),
    });
  });
  return frames;
}

/** Each frame drawn while the globe draws has that frame's range; each frame past the handover has none. */
function expectInStep(frames: Frame[]) {
  for (const frame of frames) {
    if (frame.zoom >= GLOBE_HANDOVER.until) {
      expect(frame.override, `frame at zoom ${frame.zoom}`).toBeNull();
    } else {
      expect(frame.override, `frame at zoom ${frame.zoom}`).toEqual(frame.expected);
      if (frame.zoom < GLOBE_HANDOVER.from) {
        expect(frame.nearZ).toBeCloseTo(frame.expected!.nearZ, 6);
        expect(frame.farZ).toBeCloseTo(frame.expected!.farZ, 6);
      }
    }
  }
}

/** Starts a camera movement and resolves once it has ended and the map is idle. */
async function moved(map: MaplibreMap, start: () => void) {
  const ended = map.once("moveend");
  start();
  await ended;
  await idle(map);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Turns the mouse wheel over the map's center, a notch at a time (in: -1, out: 1), until `done`. */
async function wheel(map: MaplibreMap, direction: 1 | -1, done: () => boolean) {
  const canvas = map.getCanvas();
  const box = canvas.getBoundingClientRect();
  for (let notch = 0; notch < 60 && !done(); notch++) {
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        // A multiple of this value is what MapLibre reads as a mouse wheel rather than a trackpad.
        deltaY: direction * 4.000244140625 * 50,
      })
    );
    await pause(60);
  }
  expect(done()).toBe(true);
  // The zoom eases on after the last notch, or has ended already.
  if (map.isMoving()) await map.once("moveend");
  await idle(map);
}

/** Drags the map with the mouse from its center by `by` pixels, in steps. */
async function drag(map: MaplibreMap, by: { x: number; y: number }) {
  const canvas = map.getCanvas();
  const box = canvas.getBoundingClientRect();
  const at = (t: number) => ({
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    clientX: box.left + box.width / 2 + by.x * t,
    clientY: box.top + box.height / 2 + by.y * t,
  });
  canvas.dispatchEvent(new MouseEvent("mousedown", at(0)));
  const steps = 12;
  for (let step = 1; step <= steps; step++) {
    canvas.dispatchEvent(new MouseEvent("mousemove", at(step / steps)));
    await pause(30);
  }
  canvas.dispatchEvent(new MouseEvent("mouseup", { ...at(1), buttons: 0 }));
  // The drag's inertia moves the map on, or it has ended already.
  if (map.isMoving()) await map.once("moveend");
  await idle(map);
}

const SHAPE_COLORS = ["#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e"];

/** A grid of squares around a center, each extruded to its own height in meters, one color per row. */
function extrudedGrid(center: [number, number], rows = 5, step = 0.6, side = 0.4): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < rows; col++) {
      const west = center[0] + (col - (rows - 1) / 2) * step - side / 2;
      const south = center[1] + (row - (rows - 1) / 2) * step - side / 2;
      features.push({
        type: "Feature",
        properties: {
          color: SHAPE_COLORS[row % SHAPE_COLORS.length],
          height: 8_000 + ((row * rows + col) % 4) * 8_000,
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [west + side, south],
              [west + side, south + side],
              [west, south + side],
              [west, south],
            ],
          ],
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

describe("globe depth range on a map", () => {
  it("draws the globe with mercator's near plane and the far plane MapLibre computes for the globe", async () => {
    const cameras = [
      { center: [11.5, 48.1] as [number, number], zoom: 3, pitch: 0, bearing: 0 },
      { center: [-70, 62] as [number, number], zoom: 5.5, pitch: 55, bearing: 30 },
      { center: [140, -40] as [number, number], zoom: 7.5, pitch: 35, bearing: -60 },
    ];
    const map = await globeMap();
    for (const camera of cameras) {
      map.jumpTo(camera);
      await idle(map);
      const own = drawn(map);
      expect(own.nearZ).toBeLessThan(1);

      const dispose = keepGlobeDepth(map);
      await idle(map);
      const frame = drawn(map);
      expect(frame.nearZ).toBeCloseTo(SIZE.height / 50, 6);
      expect(frame.farZ / own.farZ).toBeCloseTo(1, 9);
      dispose();
    }
  });

  it("follows a jump, and lets go once the globe has handed over and on a switch to mercator", async () => {
    const map = await globeMap();
    const dispose = keepGlobeDepth(map);

    map.jumpTo({ center: [-70, -30], zoom: 5 });
    await idle(map);
    expect(drawn(map).nearFarZOverride).toEqual(kept(map));
    expect(drawn(map).nearZ).toBeCloseTo(SIZE.height / 50, 6);

    map.jumpTo({ zoom: GLOBE_HANDOVER.until + 0.5 });
    await idle(map);
    expect(drawn(map).nearFarZOverride).toBeNull();

    map.jumpTo({ zoom: 4 });
    await idle(map);
    expect(drawn(map).nearFarZOverride).toEqual(kept(map));

    map.setProjection({ type: "mercator" });
    await idle(map);
    expect(drawn(map).nearFarZOverride).toBeNull();
    dispose();
  });

  it("draws every frame of an animation over the globe with the range of that frame", async () => {
    const map = await globeMap(2);
    const frames = recordFrames(map);
    const dispose = keepGlobeDepth(map);

    await moved(map, () => map.easeTo({ center: [30, 20], zoom: 6, pitch: 40, duration: 1500 }));
    expect(frames.filter((f) => f.zoom < GLOBE_HANDOVER.from).length).toBeGreaterThan(1);
    expectInStep(frames);
    dispose();
  });

  it("lets go of the range on every frame past the handover, during an ease and a flight and at rest after them", async () => {
    for (const fly of [false, true]) {
      const map = await globeMap(4);
      const frames = recordFrames(map);
      const dispose = keepGlobeDepth(map);

      const to = { center: [12, 47] as [number, number], zoom: GLOBE_HANDOVER.until + 2, duration: 1500 };
      await moved(map, () => (fly ? map.flyTo(to) : map.easeTo(to)));
      expect(frames.filter((f) => f.zoom >= GLOBE_HANDOVER.until).length).toBeGreaterThan(1);
      expectInStep(frames);
      expect(drawn(map).nearFarZOverride).toBeNull();
      dispose();
    }
  });

  it("takes the range up again on the way back to the globe", async () => {
    const map = await globeMap(GLOBE_HANDOVER.until + 2);
    const frames = recordFrames(map);
    const dispose = keepGlobeDepth(map);

    await moved(map, () => map.easeTo({ zoom: 4, duration: 1500 }));
    expect(frames.filter((f) => f.zoom < GLOBE_HANDOVER.from).length).toBeGreaterThan(1);
    expectInStep(frames);
    expect(drawn(map).nearFarZOverride).toEqual(kept(map));
    dispose();
  });

  it("keeps each frame in step while the mouse wheel zooms past the handover and back", async () => {
    const map = await globeMap(GLOBE_HANDOVER.from - 2);
    const frames = recordFrames(map);
    const dispose = keepGlobeDepth(map);

    await wheel(map, -1, () => map.getZoom() >= GLOBE_HANDOVER.until + 1);
    expect(drawn(map).nearFarZOverride).toBeNull();
    await wheel(map, 1, () => map.getZoom() < GLOBE_HANDOVER.from - 1);
    expect(drawn(map).nearFarZOverride).toEqual(kept(map));
    expect(frames.some((f) => f.zoom >= GLOBE_HANDOVER.until)).toBe(true);
    expect(frames.some((f) => f.zoom < GLOBE_HANDOVER.from)).toBe(true);
    expectInStep(frames);
    dispose();
  });

  it("keeps each frame in step while the globe is dragged", async () => {
    const map = await globeMap(4);
    const frames = recordFrames(map);
    const dispose = keepGlobeDepth(map);
    const before = map.getCenter();

    await drag(map, { x: 200, y: 120 });
    expect(map.getCenter().lng).not.toBeCloseTo(before.lng, 1);
    expect(frames.length).toBeGreaterThan(1);
    expectInStep(frames);
    expect(drawn(map).nearFarZOverride).toEqual(kept(map));
    dispose();
  });

  it("leaves the globe's own range while terrain is on and keeps it again once terrain is off", async () => {
    const map = await globeMap();
    const dispose = keepGlobeDepth(map);
    await idle(map);
    expect(drawn(map).nearFarZOverride).not.toBeNull();

    map.setTerrain({ source: "dem", exaggeration: 1 });
    await idle(map);
    expect(drawn(map).nearFarZOverride).toBeNull();
    expect(drawn(map).nearZ).toBeLessThan(1);

    map.setTerrain(null);
    await idle(map);
    expect(drawn(map).nearFarZOverride).toEqual(kept(map));
    dispose();
  });

  it("gives MapLibre its own range back on teardown, and the map comes to rest", async () => {
    const map = await globeMap();
    const dispose = keepGlobeDepth(map);
    await idle(map);
    dispose();
    await idle(map);
    expect(drawn(map).nearFarZOverride).toBeNull();
    expect(drawn(map).nearZ).toBeLessThan(1);
  });

  it("draws extrusions on a tilted globe, each in front of the ones behind it", async () => {
    const map = await globeMap(6.5);
    const dispose = keepGlobeDepth(map);
    map.jumpTo({ pitch: 60, bearing: 20 });
    map.addSource("shapes", { type: "geojson", data: extrudedGrid([11.5, 48.1], 6, 0.4, 0.28) });
    map.addLayer(
      {
        id: "shapes",
        type: "fill-extrusion",
        source: "shapes",
        paint: {
          "fill-extrusion-color": ["get", "color"],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
        },
      },
      "frame"
    );
    await idle(map);
    expect(drawn(map).nearZ).toBeCloseTo(SIZE.height / 50, 6);
    await expect(map.getContainer()).toMatchScreenshot("extrusions-on-tilted-globe");
    dispose();
  });
});
