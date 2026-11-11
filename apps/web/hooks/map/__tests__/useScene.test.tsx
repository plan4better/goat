import { act, renderHook } from "@testing-library/react";
import type { Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { GLOBE_HANDOVER } from "@/lib/scene/visibility";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type RenderLayer, basemapAnchorsOf, syncMapLayers } from "@/lib/style/render/mapLayers";

import type { Basemap } from "@/types/map/common";

import { type UseSceneInputs, useScene } from "@/hooks/map/useScene";

const DEM = "https://dem.example/{z}/{x}/{y}.webp";
const LIGHT: Basemap = {
  source: "builtin",
  type: "vector",
  value: "light",
  url: "https://tiles.example/styles/positron",
  title: "Light",
  subtitle: "",
  thumbnail: "",
  buildings: { source: "openmaptiles" },
};

/** A positron-like style: background, a flat building fill, roads, labels. */
const BASE_LAYERS = [
  { id: "background", type: "background" },
  {
    id: "building",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "building",
    paint: { "fill-color": "#eaeae5" },
  },
  { id: "road", type: "line", source: "openmaptiles", "source-layer": "transportation" },
  { id: "place", type: "symbol", source: "openmaptiles", "source-layer": "place" },
];

type Call = [string, ...unknown[]];

/** A map that records calls and keeps sources, layers, terrain, sky, light, projection and global state. */
function fakeMap(
  base: Array<Record<string, unknown>> = BASE_LAYERS,
  baseSources: Record<string, unknown> = { openmaptiles: { type: "vector" } }
) {
  const calls: Call[] = [];
  const handlers = new Map<string, Set<() => void>>();
  let sources: Record<string, unknown> = { ...baseSources };
  let layers: Array<Record<string, unknown>> = base.map((l) => ({ ...l }));
  let terrain: unknown = null;
  let sky: unknown = undefined;
  let light: unknown = { anchor: "viewport" };
  let projection: unknown = { type: "mercator" };
  let state: Record<string, unknown> = {};
  const record = (name: string, ...args: unknown[]) => calls.push([name, ...args]);
  const map = {
    calls,
    getStyle: () => ({ version: 8, sources, layers }),
    isStyleLoaded: () => true,
    getCenter: () => ({ lng: 13.405, lat: 52.52 }),
    zoom: 2,
    getZoom: () => map.zoom,
    getSource: (id: string) => sources[id],
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addSource: (id: string, spec: unknown) => {
      record("addSource", id);
      sources[id] = { ...(spec as object) };
    },
    removeSource: (id: string) => {
      record("removeSource", id);
      delete sources[id];
    },
    addLayer: (layer: Record<string, unknown>, before?: string) => {
      record("addLayer", layer.id, before);
      const i = before ? layers.findIndex((l) => l.id === before) : -1;
      if (i >= 0) layers.splice(i, 0, layer);
      else layers.push(layer);
    },
    removeLayer: (id: string) => {
      record("removeLayer", id);
      layers = layers.filter((l) => l.id !== id);
    },
    moveLayer: (id: string, before?: string) => {
      const layer = layers.find((l) => l.id === id)!;
      layers = layers.filter((l) => l.id !== id);
      const i = before ? layers.findIndex((l) => l.id === before) : -1;
      if (i >= 0) layers.splice(i, 0, layer);
      else layers.push(layer);
    },
    setFilter: () => undefined,
    setLayerZoomRange: (id: string, minzoom: number, maxzoom: number) => {
      record("setLayerZoomRange", id, minzoom, maxzoom);
      const layer = layers.find((l) => l.id === id)!;
      layer.minzoom = minzoom;
      layer.maxzoom = maxzoom;
    },
    setMissingStyleImageResolver: () => undefined,
    hasImage: () => false,
    setFeatureState: () => undefined,
    getLayoutProperty: (id: string, key: string) =>
      (layers.find((l) => l.id === id)?.layout as Record<string, unknown> | undefined)?.[key],
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      record("setLayoutProperty", id, key, value);
      const layer = layers.find((l) => l.id === id)!;
      layer.layout = { ...(layer.layout as object), [key]: value };
    },
    getPaintProperty: (id: string, key: string) =>
      (layers.find((l) => l.id === id)?.paint as Record<string, unknown> | undefined)?.[key],
    setPaintProperty: (id: string, key: string, value: unknown) => {
      record("setPaintProperty", id, key, value);
      const layer = layers.find((l) => l.id === id)!;
      const paint = { ...(layer.paint as object), [key]: value } as Record<string, unknown>;
      if (value === undefined) delete paint[key];
      layer.paint = paint;
    },
    setTerrain: (t: unknown) => {
      record("setTerrain", t);
      terrain = t;
    },
    getTerrain: () => terrain,
    setSky: (s: unknown) => {
      record("setSky");
      sky = s;
    },
    getSky: () => sky,
    setLight: (l: unknown) => {
      record("setLight");
      light = l;
    },
    getLight: () => light,
    setProjection: (p: unknown) => {
      record("setProjection", p);
      projection = p;
    },
    getProjection: () => projection,
    setGlobalStateProperty: (name: string, value: unknown) => {
      record("setGlobalStateProperty", name, value);
      state = { ...state, [name]: value };
    },
    getGlobalState: () => state,
    on: (event: string, fn: () => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off: (event: string, fn: () => void) => handlers.get(event)?.delete(fn),
    fire: (event: string) => handlers.get(event)?.forEach((fn) => fn()),
    /** A basemap switch: the new style without GOAT's sources, layers, terrain, sky, light and state. */
    newStyle: () => {
      sources = { ...baseSources };
      layers = base.map((l) => ({ ...l }));
      terrain = null;
      sky = undefined;
      light = { anchor: "viewport" };
      projection = { type: "mercator" };
      state = {};
    },
  };
  return map;
}

const inputs = (extra: Partial<UseSceneInputs> = {}): UseSceneInputs => ({
  mode: "3d",
  projection: "mercator",
  tone: "light",
  terrainUrl: DEM,
  projectExtrudes: false,
  imagery: false,
  basemap: LIGHT,
  ...extra,
});

const named = (calls: Call[], name: string) => calls.filter((c) => c[0] === name);
const STATE_KEYS = ["sunAzimuth", "sunAltitude", "lightPosition"];

describe("useScene", () => {
  it("GOAT's buildings go above the basemap's last ground layer, past symbols among them and GOAT's overlays", () => {
    // Dark's shape: a water label below the flat building fill, roads and a road arrow after it, then the labels;
    // a mask drawn on top of the map on its own GeoJSON source.
    const omt = (id: string, type: string, sourceLayer: string) => ({
      id,
      type,
      source: "openmaptiles",
      "source-layer": sourceLayer,
    });
    const dark = [
      { id: "background", type: "background" },
      omt("water", "fill", "water"),
      omt("water_name", "symbol", "water_name"),
      omt("building", "fill", "building"),
      omt("highway_minor", "line", "transportation"),
      omt("road_oneway", "symbol", "transportation"),
      omt("railway", "line", "transportation"),
      omt("boundary_state", "line", "boundary"),
      omt("place_other", "symbol", "place"),
      omt("place_city", "symbol", "place"),
      { id: "mask", type: "fill", source: "mask" },
    ];
    const map = fakeMap(dark, { openmaptiles: { type: "vector" }, mask: { type: "geojson" } });
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs()));
    expect(named(map.calls, "addLayer")).toContainEqual(["addLayer", "goat-buildings", "place_other"]);
    expect(named(map.calls, "addLayer")).toContainEqual([
      "addLayer",
      "goat-terrain-hillshade",
      "highway_minor",
    ]);
  });

  it("GOAT's buildings go above the ground parts of the layers below the labels, below their points", () => {
    // Positron's shape: the labels and the buildings share their anchor (`place`).
    const map = fakeMap();
    const layer = (key: string, symbol: object, geometry: RenderLayer["geometry"]): RenderLayer => ({
      key,
      style: { version: 1, kind: "vector", symbol } as LayerStyle,
      geometry,
      entry: { position: "below_labels" },
      source: { type: "tiles", id: `src-${key}`, tiles: [`https://geoapi/${key}/{z}/{x}/{y}`] },
    });
    const layers = [
      layer("1", { marker: {} }, "point"),
      layer("2", { fill: { color: "#cccccc" } }, "polygon"),
    ];
    const scene = (opacity: number) => inputs({ scene: { terrain: false, buildings: { opacity } } });
    const { rerender } = renderHook(
      ({ opacity }) => useScene(map as unknown as MaplibreMap, scene(opacity)),
      {
        initialProps: { opacity: 0.6 },
      }
    );
    const opts = { locale: "en", anchors: basemapAnchorsOf(map as never), ground: "goat-buildings" };
    syncMapLayers(map as never, null, layers, opts);
    // GOAT's copy of positron's building fill (`goat-footprint-building`) goes right above it.
    const order = [
      "background",
      "building",
      "goat-footprint-building",
      "road",
      "2-fill",
      "2-outline",
      "goat-buildings",
      "1-marker",
      "place",
    ];
    const ids = () => map.getStyle().layers.map((l) => l.id);
    expect(ids()).toEqual(order);
    // A new opacity adds GOAT's building layer again: back between the two, not above the points.
    rerender({ opacity: 0.3 });
    expect(named(map.calls, "removeLayer")).toContainEqual(["removeLayer", "goat-buildings"]);
    expect(ids()).toEqual(order);
  });

  it("the basemap's anchors leave out project layers, GOAT's scene and GeoJSON overlays", () => {
    const map = fakeMap(BASE_LAYERS, { openmaptiles: { type: "vector" }, draw: { type: "geojson" } });
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs({ scene: { terrain: false } })));
    const polygon: RenderLayer = {
      key: "7",
      style: { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle,
      geometry: "polygon",
      entry: {},
      source: { type: "tiles", id: "src-7", tiles: ["https://geoapi/7/{z}/{x}/{y}"] },
    };
    syncMapLayers(map as never, null, [polygon], { locale: "en" });
    map.addLayer({ id: "draw-fill", type: "fill", source: "draw" });
    map.addLayer({ id: "draw-label", type: "symbol", source: "draw" });
    expect(basemapAnchorsOf(map as never)).toEqual({ labels: "place", roads: "road", buildings: "place" });
  });

  it("(a) 3D with terrain: terrain, both DEM sources, the hillshade before the roads", () => {
    const map = fakeMap();
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs()));
    expect(named(map.calls, "setTerrain")).toEqual([
      ["setTerrain", { source: "goat-terrain", exaggeration: 1 }],
    ]);
    expect(named(map.calls, "addSource").map((c) => c[1])).toEqual(
      expect.arrayContaining(["goat-terrain", "goat-terrain-hillshade"])
    );
    expect(named(map.calls, "addLayer")).toContainEqual(["addLayer", "goat-terrain-hillshade", "road"]);
    expect(named(map.calls, "addLayer")).toContainEqual(["addLayer", "goat-buildings", "place"]);
    expect(
      named(map.calls, "setGlobalStateProperty")
        .map((c) => c[1])
        .sort()
    ).toEqual([...STATE_KEYS].sort());
    expect(named(map.calls, "setSky")).toHaveLength(1);
    expect(named(map.calls, "setLight")).toHaveLength(1);
  });

  it("(b) reapplies on style.load", () => {
    const map = fakeMap();
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs()));
    const first = map.calls.length;
    map.newStyle();
    act(() => map.fire("style.load"));
    const again = map.calls.slice(first);
    expect(named(again, "setTerrain")).toEqual([["setTerrain", { source: "goat-terrain", exaggeration: 1 }]]);
    expect(named(again, "addSource").map((c) => c[1])).toEqual(
      expect.arrayContaining(["goat-terrain", "goat-terrain-hillshade"])
    );
    expect(named(again, "addLayer")).toContainEqual(["addLayer", "goat-terrain-hillshade", "road"]);
    expect(
      named(again, "setGlobalStateProperty")
        .map((c) => c[1])
        .sort()
    ).toEqual([...STATE_KEYS].sort());
    expect(named(again, "setSky")).toHaveLength(1);
    expect(named(again, "setLight")).toHaveLength(1);
    expect(named(again, "setProjection")).toHaveLength(1);
  });

  it("reapplies when a style diff dropped the scene without a style.load", () => {
    const map = fakeMap();
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs()));
    const first = map.calls.length;
    act(() => map.fire("styledata"));
    expect(map.calls.length).toBe(first);
    map.newStyle();
    act(() => map.fire("styledata"));
    expect(named(map.calls.slice(first), "setTerrain")).toHaveLength(1);
  });

  it.each(["2d", "3d"] as const)("in %s, styledata after an apply changes nothing (no loop)", (mode) => {
    const map = fakeMap();
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs({ mode })));
    expect(named(map.calls, "setProjection")).toHaveLength(1);
    const first = map.calls.length;
    act(() => {
      map.fire("styledata");
      map.fire("styledata");
      map.fire("styledata");
    });
    expect(map.calls.length).toBe(first);
  });

  it("(c) switching to 2D drops terrain and GOAT's sources and layers", () => {
    const map = fakeMap();
    const { rerender } = renderHook(
      (props: UseSceneInputs) => useScene(map as unknown as MaplibreMap, props),
      {
        initialProps: inputs(),
      }
    );
    const first = map.calls.length;
    rerender(inputs({ mode: "2d" }));
    const after = map.calls.slice(first);
    expect(named(after, "setTerrain")).toEqual([["setTerrain", null]]);
    expect(
      named(after, "removeLayer")
        .map((c) => c[1])
        .sort()
    ).toEqual(["goat-buildings", "goat-footprint-building", "goat-terrain-hillshade"]);
    expect(
      named(after, "removeSource")
        .map((c) => c[1])
        .sort()
    ).toEqual(["goat-terrain", "goat-terrain-hillshade"]);
    expect(map.getSource("goat-terrain")).toBeUndefined();
  });

  it("(d) a light change only sets the global state", () => {
    const map = fakeMap();
    const light = (direction: number) => inputs({ scene: { light: { direction, altitude: 40 } } });
    const { rerender } = renderHook(
      (props: UseSceneInputs) => useScene(map as unknown as MaplibreMap, props),
      {
        initialProps: light(200),
      }
    );
    const first = map.calls.length;
    rerender(light(250));
    const after = map.calls.slice(first);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c[0] === "setGlobalStateProperty")).toBe(true);
    expect(map.getGlobalState().sunAzimuth).toBe(250);
  });

  it("leaving the automatic light sets the light again, standing on the map", () => {
    const map = fakeMap();
    const { rerender } = renderHook(
      (props: UseSceneInputs) => useScene(map as unknown as MaplibreMap, props),
      { initialProps: inputs() }
    );
    expect(map.getLight()).toMatchObject({ anchor: "viewport" });
    const first = map.calls.length;
    rerender(inputs({ scene: { light: { direction: 200, altitude: 40 } } }));
    expect(named(map.calls.slice(first), "setLight")).toHaveLength(1);
    expect(map.getLight()).toMatchObject({ anchor: "map", position: ["global-state", "lightPosition"] });
  });

  it("a custom light on the globe changes its anchor only when the zoom crosses the globe's zoomed-out range", () => {
    const map = fakeMap();
    renderHook(() =>
      useScene(
        map as unknown as MaplibreMap,
        inputs({ projection: "globe", scene: { light: { direction: 200, altitude: 40 } } })
      )
    );
    expect(map.getLight()).toMatchObject({ anchor: "viewport" });
    const first = map.calls.length;
    map.zoom = 4;
    act(() => map.fire("zoom"));
    expect(map.calls.length).toBe(first);
    map.zoom = 12;
    act(() => map.fire("zoom"));
    expect(named(map.calls.slice(first), "setLight")).toHaveLength(1);
    expect(map.getLight()).toMatchObject({ anchor: "map" });
  });

  it("on the globe the terrain is off while the globe draws and rises in steps once flat, nothing else set again", () => {
    const { until } = GLOBE_HANDOVER;
    const map = fakeMap();
    map.zoom = 3;
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs({ projection: "globe" })));
    expect(map.getTerrain()).toBeNull();
    expect(map.getLayer("goat-terrain-hillshade")).toBeDefined();
    const first = map.calls.length;
    const zoomTo = (zoom: number) => {
      map.zoom = zoom;
      act(() => map.fire("zoom"));
    };
    zoomTo(until - 0.1);
    expect(map.calls.length).toBe(first);
    zoomTo(until + 0.5);
    expect(map.getTerrain()).toEqual({ source: "goat-terrain", exaggeration: 0.5 });
    zoomTo(until + 0.52);
    zoomTo(until + 0.7);
    expect(map.getTerrain()).toEqual({ source: "goat-terrain", exaggeration: 0.7 });
    zoomTo(until + 2);
    expect(map.getTerrain()).toEqual({ source: "goat-terrain", exaggeration: 1 });
    zoomTo(until + 3);
    zoomTo(until - 1);
    expect(map.getTerrain()).toBeNull();
    const after = map.calls.slice(first);
    expect(after.map((c) => c[0])).toEqual(Array(4).fill("setTerrain"));

    // The style's own data events see the terrain set by zoom as applied: no loop, no full apply.
    const settled = map.calls.length;
    act(() => {
      map.fire("styledata");
      map.fire("styledata");
    });
    zoomTo(until + 1.5);
    act(() => map.fire("styledata"));
    expect(named(map.calls.slice(settled), "setTerrain")).toHaveLength(1);
    expect(map.calls.length).toBe(settled + 1);
  });

  it("a new style on a zoomed-out globe gets no terrain, and the terrain of the zoom once zoomed in", () => {
    const map = fakeMap();
    map.zoom = 3;
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs({ projection: "globe" })));
    map.zoom = 14;
    map.newStyle();
    act(() => map.fire("style.load"));
    expect(map.getTerrain()).toEqual({ source: "goat-terrain", exaggeration: 1 });
  });

  it("in mercator the terrain does not follow the zoom", () => {
    const map = fakeMap();
    renderHook(() => useScene(map as unknown as MaplibreMap, inputs()));
    const first = map.calls.length;
    map.zoom = GLOBE_HANDOVER.until + 0.5;
    act(() => map.fire("zoom"));
    expect(map.calls.length).toBe(first);
    expect(map.getTerrain()).toEqual({ source: "goat-terrain", exaggeration: 1 });
  });

  it("a basemap's own buildings are shown in 3D and get their own visibility back in 2D", () => {
    const map = fakeMap();
    const own: Basemap = { ...LIGHT, value: "basemap_de_gry", buildings: "own" };
    map.addLayer({
      id: "Gebaeude3D",
      type: "fill-extrusion",
      source: "openmaptiles",
      layout: { visibility: "none" },
    });
    const { rerender } = renderHook(
      (props: UseSceneInputs) => useScene(map as unknown as MaplibreMap, props),
      {
        initialProps: inputs({ basemap: own }),
      }
    );
    expect(map.getLayoutProperty("Gebaeude3D", "visibility")).toBe("visible");
    rerender(inputs({ basemap: own, mode: "2d" }));
    expect(map.getLayoutProperty("Gebaeude3D", "visibility")).toBe("none");
  });

  it("a basemap's own buildings take the scene's opacity and get their own back when off, in 2D and on a new style", () => {
    const map = fakeMap();
    const own: Basemap = { ...LIGHT, value: "basemap_de_gry", buildings: "own" };
    const addOwn = () =>
      map.addLayer({
        id: "Gebaeude3D",
        type: "fill-extrusion",
        source: "openmaptiles",
        paint: { "fill-extrusion-opacity": 0.9 },
      });
    addOwn();
    const opacity = () => map.getPaintProperty("Gebaeude3D", "fill-extrusion-opacity");
    const { rerender } = renderHook(
      (props: UseSceneInputs) => useScene(map as unknown as MaplibreMap, props),
      { initialProps: inputs({ basemap: own }) }
    );
    expect(opacity()).toBe(0.6);
    rerender(inputs({ basemap: own, scene: { buildings: { opacity: 0.3 } } }));
    expect(opacity()).toBe(0.3);
    rerender(inputs({ basemap: own, scene: { buildings: { on: false, opacity: 0.3 } } }));
    expect(opacity()).toBe(0.9);
    rerender(inputs({ basemap: own, scene: { buildings: { opacity: 0.3 } } }));
    expect(opacity()).toBe(0.3);
    rerender(inputs({ basemap: own, mode: "2d", scene: { buildings: { opacity: 0.3 } } }));
    expect(opacity()).toBe(0.9);

    // A new style brings its own value, which is what the scene gives back from then on.
    rerender(inputs({ basemap: own, scene: { buildings: { opacity: 0.3 } } }));
    act(() => {
      map.newStyle();
      addOwn();
      map.setPaintProperty("Gebaeude3D", "fill-extrusion-opacity", 0.7);
      map.fire("style.load");
    });
    expect(opacity()).toBe(0.3);
    rerender(inputs({ basemap: own, mode: "2d", scene: { buildings: { opacity: 0.3 } } }));
    expect(opacity()).toBe(0.7);
  });

  it("a basemap's own buildings reach down to their footprints' tiles while shown, and get their own range back", () => {
    const own: Basemap = { ...LIGHT, value: "basemap_de_gry", buildings: "own" };
    const base = [
      ...BASE_LAYERS.filter((l) => l.id !== "building"),
      {
        id: "flat",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 12,
        maxzoom: 22,
        paint: { "fill-opacity": 1 },
      },
      {
        id: "tall",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 16,
        maxzoom: 22,
        layout: { visibility: "none" },
        paint: { "fill-extrusion-opacity": 0.8, "fill-extrusion-height": ["get", "h"] },
      },
    ];
    const map = fakeMap(base);
    const tall = () => map.getLayer("tall")!;
    const look = () => [
      tall().minzoom,
      tall().maxzoom,
      map.getPaintProperty("tall", "fill-extrusion-opacity"),
      map.getPaintProperty("flat", "fill-opacity"),
      // GOAT's copy of the footprint for the buildings without a height, and the layer drawn right below it.
      order().find((id) => id.startsWith("goat-footprint-")) ?? null,
      order()[order().indexOf("goat-footprint-flat") - 1] ?? null,
    ];
    const order = () => map.getStyle().layers.map((l) => l.id as string);
    const shown = [
      12,
      22,
      ["step", ["zoom"], 0, 16, 0.6],
      ["step", ["zoom"], 1, 16, 0],
      "goat-footprint-flat",
      "flat",
    ];
    const flat = [16, 22, 0.8, 1, null, null];
    const { rerender } = renderHook(
      (props: UseSceneInputs) => useScene(map as unknown as MaplibreMap, props),
      { initialProps: inputs({ basemap: own }) }
    );
    expect(look()).toEqual(shown);
    // The copy draws with the footprint's own paint where the footprint is hidden.
    expect(map.getLayer("goat-footprint-flat")).toMatchObject({
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 12,
      maxzoom: 22,
      filter: ["!", [">", ["to-number", ["get", "h"], 0], 0]],
      paint: { "fill-opacity": ["step", ["zoom"], 0, 16, 1] },
    });
    rerender(inputs({ basemap: own, scene: { buildings: false } }));
    expect(look()).toEqual(flat);
    rerender(inputs({ basemap: own }));
    expect(look()).toEqual(shown);
    // A style diff that leaves the scene's paint in place applies nothing again: the lowered range is not read as
    // the basemap's own.
    act(() => {
      map.setPaintProperty("flat", "fill-opacity", 1);
      map.fire("styledata");
    });
    expect(look()).toEqual(shown);
    rerender(inputs({ basemap: own, mode: "2d" }));
    expect(look()).toEqual(flat);

    // A new style: reached down again, and its own range back in 2D.
    rerender(inputs({ basemap: own }));
    act(() => {
      map.newStyle();
      map.fire("style.load");
    });
    expect(look()).toEqual(shown);
    rerender(inputs({ basemap: own, mode: "2d" }));
    expect(look()).toEqual(flat);
  });
});
