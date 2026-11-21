import { describe, expect, it, vi } from "vitest";

import * as compileModule from "@/lib/style/compile";
import type { CompileSource } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import {
  type RenderLayer,
  basemapAnchors,
  carryProjectLayers,
  mapLayerIdsOf,
  projectLayerOf,
  restoreGlobalState,
  syncMapLayers,
} from "@/lib/style/render/mapLayers";
import { loadImage } from "@/lib/transformers/map-image";

vi.mock("@/lib/transformers/map-image", () => ({ loadImage: vi.fn(async () => undefined) }));
vi.mock("@/lib/style/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/style/compile")>();
  return { ...actual, compileLayer: vi.fn(actual.compileLayer) };
});

/** A map that keeps its layers in order, bottom to top, as MapLibre does. */
function orderedMap(basemap: Array<{ id: string; type: string; "source-layer"?: string }> = []) {
  const order: string[] = basemap.map((l) => l.id);
  const specs = new Map<string, Record<string, unknown>>(basemap.map((l) => [l.id, l]));
  const sources = new Map<string, unknown>();
  const calls: string[] = [];
  const insert = (id: string, before?: string) => {
    const at = before ? order.indexOf(before) : -1;
    if (at < 0) order.push(id);
    else order.splice(at, 0, id);
  };
  const map = {
    calls,
    order,
    specs,
    getStyle: () => ({ layers: order.map((id) => specs.get(id)) }),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: unknown) =>
      sources.set(id, { ...(spec as object), setData: () => undefined }),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => specs.get(id),
    addLayer: (layer: { id: string }, before?: string) => {
      specs.set(layer.id, layer as Record<string, unknown>);
      insert(layer.id, before);
    },
    removeLayer: (id: string) => {
      specs.delete(id);
      order.splice(order.indexOf(id), 1);
    },
    moveLayer: (id: string, before?: string) => {
      order.splice(order.indexOf(id), 1);
      insert(id, before);
    },
    setPaintProperty: () => undefined,
    setLayoutProperty: () => undefined,
    setFilter: (id: string, filter: unknown) => {
      (specs.get(id) as Record<string, unknown>).filter = filter;
    },
    setLayerZoomRange: () => undefined,
    setGlobalStateProperty: (name: string, value: unknown) => calls.push(`state ${name}=${String(value)}`),
    setFeatureState: (target: { source: string; id: unknown }, state: object) =>
      calls.push(`featureState ${target.source} ${String(target.id)} ${JSON.stringify(state)}`),
    removeFeatureState: (target: { source: string; id?: unknown }) =>
      calls.push(`removeFeatureState ${target.source} ${String(target.id)}`),
    resolver: undefined as ((id: string) => void | Promise<void>) | undefined,
    setMissingStyleImageResolver(resolver: (id: string) => void | Promise<void>) {
      map.resolver = resolver;
    },
    hasImage: () => false,
  };
  return map;
}

const tiles = (key: string): CompileSource => ({
  type: "tiles",
  id: `src-${key}`,
  tiles: [`https://geoapi/collections/${key}/tiles/{z}/{x}/{y}`],
});
const polygon = (key: string, extra: Partial<RenderLayer> = {}): RenderLayer => ({
  key,
  style: {
    version: "1.0.0",
    kind: "vector",
    symbol: { fill: { color: "#cccccc" }, outline: { color: "#000000" } },
  } as LayerStyle,
  geometry: "polygon",
  entry: {},
  source: tiles(key),
  ...extra,
});
const ours = (map: ReturnType<typeof orderedMap>) => map.order.filter((id) => !id.startsWith("base"));

describe("syncMapLayers", () => {
  it("adding, removing and reordering project layers moves every sublayer", () => {
    const map = orderedMap([{ id: "base-bg", type: "background" }]);
    let state = syncMapLayers(map, null, [polygon("1"), polygon("2")], { locale: "en" });
    expect(ours(map)).toEqual(["2-fill", "2-outline", "1-fill", "1-outline"]);
    state = syncMapLayers(map, state, [polygon("2"), polygon("1")], { locale: "en" });
    expect(ours(map)).toEqual(["1-fill", "1-outline", "2-fill", "2-outline"]);
    syncMapLayers(map, state, [polygon("2")], { locale: "en" });
    expect(ours(map)).toEqual(["2-fill", "2-outline"]);
  });

  it("a re-added layer lands under its upper neighbour", () => {
    const map = orderedMap();
    let state = syncMapLayers(map, null, [polygon("1"), polygon("2"), polygon("3")], { locale: "en" });
    state = syncMapLayers(map, state, [polygon("1"), polygon("3")], { locale: "en" });
    syncMapLayers(map, state, [polygon("1"), polygon("2"), polygon("3")], { locale: "en" });
    expect(ours(map)).toEqual(["3-fill", "3-outline", "2-fill", "2-outline", "1-fill", "1-outline"]);
  });

  it("exclusion and atlas filters wrap every layer of the source", () => {
    const map = orderedMap();
    syncMapLayers(map, null, [polygon("1", { filter: { exclude: [5, 6], atlas: 7 } })], { locale: "en" });
    const exclusion = ["!", ["in", ["id"], ["literal", [5, 6]]]];
    for (const id of ["1-fill", "1-outline"])
      expect(map.specs.get(id)?.filter).toEqual(["all", exclusion, ["==", ["id"], 7]]);
  });

  it("H3 hexagons count only the atlas page's feature, asked of geoapi; the editor's exclusions stay counted", () => {
    const map = orderedMap();
    const hexagons = polygon("1", {
      geometry: "point",
      style: { version: "1.0.0", kind: "vector", render: { type: "h3", points_from_zoom: 15 } } as LayerStyle,
      filter: { exclude: [5], atlas: 7 },
    });
    syncMapLayers(map, null, [hexagons], { locale: "en" });
    expect(map.specs.get("1-h3-fill")?.filter).toBeUndefined();
    expect(map.specs.get("1-h3-outline")?.filter).toBeUndefined();
    const hexagonTiles = (map.getSource("src-1-h3") as { tiles: string[] }).tiles;
    expect(hexagonTiles[0]).toMatch(/[?&]ids=7(&|$)/);
    expect((map.getSource("src-1") as { tiles: string[] }).tiles[0]).not.toContain("ids=");
    expect(map.specs.get("1-marker")?.filter).toEqual([
      "all",
      ["!", ["in", ["id"], ["literal", [5]]]],
      ["==", ["id"], 7],
    ]);
  });

  it("one layer's en-US default never overwrites the map's locale", () => {
    const map = orderedMap();
    const labelled = polygon("1", {
      style: { version: "1.0.0", kind: "vector", symbol: { label: { text: "{pop}" } } } as LayerStyle,
    });
    const state = syncMapLayers(map, null, [labelled], { locale: "de-DE" });
    syncMapLayers(map, state, [labelled, polygon("2")], { locale: "de-DE" });
    expect(map.calls.filter((c) => c.startsWith("state locale"))).toEqual(["state locale=de-DE"]);
  });

  it("feature state is set and cleared", () => {
    const map = orderedMap();
    const state = syncMapLayers(map, null, [polygon("1", { highlight: 7 })], { locale: "en" });
    syncMapLayers(map, state, [polygon("1")], { locale: "en" });
    expect(map.calls.filter((c) => c.includes("eatureState"))).toEqual([
      'featureState src-1 7 {"active":true}',
      'featureState src-1 7 {"active":false}',
    ]);
  });

  it("the registry maps -fill, -outline, -label, -cluster-*, -raster and -hillshade back to the project layer", () => {
    const map = orderedMap();
    const labelled = polygon("1", {
      style: {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: "#cccccc" }, outline: { color: "#000000" }, label: { text: "{name}" } },
      } as LayerStyle,
    });
    const clusters: RenderLayer = {
      key: "2",
      style: {
        version: "1.0.0",
        kind: "vector",
        render: { type: "cluster" },
        symbol: { marker: {} },
      } as LayerStyle,
      geometry: "point",
      entry: {},
      source: { type: "points", id: "src-2", data: "https://geoapi/items" },
    };
    const hillshade: RenderLayer = {
      key: "3",
      style: { version: "1.0.0", kind: "raster", render: { type: "hillshade", band: 1 } } as LayerStyle,
      entry: {},
      source: {
        type: "raster",
        id: "src-3",
        tiles: "https://geo/collections/d/raster/tiles/{z}/{x}/{y}.webp",
        coverage: "https://geo/collections/d/coverage/tiles/WebMercatorQuad",
        values: {
          encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 32769 },
          range: [100, 400],
          integer: true,
          version: "1-e1",
        },
      },
    };
    const image: RenderLayer = {
      key: "4",
      style: { version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle,
      entry: {},
      source: {
        type: "raster",
        id: "src-4",
        tiles: "https://geo/collections/d/raster/tiles/{z}/{x}/{y}.webp",
        coverage: "https://geo/collections/d/coverage/tiles/WebMercatorQuad",
      },
    };
    syncMapLayers(map, null, [labelled, clusters, hillshade, image], { locale: "en" });
    for (const id of ours(map)) expect([id, projectLayerOf(map, id)]).toEqual([id, id.split("-")[0]]);
    expect(map.order.some((id) => id.startsWith("2-cluster-"))).toBe(true);
    expect(map.order).toContain("3-hillshade");
    expect(map.order).toContain("4-raster");
    expect(projectLayerOf(map, "background")).toBeUndefined();
    expect(mapLayerIdsOf(map, "1", { kinds: ["fill", "outline"] })).toEqual(["1-fill", "1-outline"]);
    expect(mapLayerIdsOf(map, "2", { kinds: ["cluster"] }).every((id) => id.startsWith("2-cluster-"))).toBe(
      true
    );
  });

  it("below_labels uses the basemap's label anchor", () => {
    const basemap = [
      { id: "base-bg", type: "background" },
      { id: "base-road", type: "line", "source-layer": "transportation" },
      { id: "base-label", type: "symbol" },
    ];
    expect(basemapAnchors(basemap)).toEqual({
      labels: "base-label",
      roads: "base-road",
      buildings: "base-label",
    });
    const map = orderedMap(basemap);
    syncMapLayers(
      map,
      null,
      [
        polygon("1"),
        polygon("2", { entry: { position: "below_labels" } }),
        polygon("3", { entry: { position: "below_roads" } }),
      ],
      { locale: "en", anchors: basemapAnchors(basemap) }
    );
    expect(map.order).toEqual([
      "base-bg",
      "3-fill",
      "3-outline",
      "base-road",
      "2-fill",
      "2-outline",
      "base-label",
      "1-fill",
      "1-outline",
    ]);
  });

  it("a raster below the labels goes below the basemap's labels", () => {
    const basemap = [
      { id: "base-bg", type: "background" },
      { id: "base-road", type: "line", "source-layer": "transportation" },
      { id: "base-label", type: "symbol" },
    ];
    const anchors = basemapAnchors(basemap);
    const coverage = "https://geo/collections/d/coverage/tiles/WebMercatorQuad";
    const tilesUrl = "https://geo/collections/d/raster/tiles/{z}/{x}/{y}.webp";
    // A colored image of a file, a file's values colored and shaded in the browser, and a map service.
    const image: RenderLayer = {
      key: "1",
      style: { version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle,
      entry: { position: "below_labels" },
      source: { type: "raster", id: "src-1", tiles: tilesUrl, coverage },
    };
    const values = {
      encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 32769 },
      range: [100, 400] as [number, number],
      integer: true,
      version: "1-e1",
    };
    const reliefSource = { type: "raster" as const, id: "src-2", tiles: tilesUrl, coverage };
    const relief: RenderLayer = {
      key: "2",
      style: {
        version: "1.0.0",
        kind: "raster",
        render: { type: "hillshade", band: 1, palette: "goat:elevation", domain: [100, 400] },
      } as LayerStyle,
      entry: { position: "below_labels" },
      source: reliefSource,
    };
    const service: RenderLayer = {
      key: "3",
      style: { version: "1.0.0", kind: "raster" } as LayerStyle,
      entry: { position: "below_roads" },
      source: {
        type: "service",
        id: "src-3",
        service: "wms",
        tiles: "https://wms.example/service?LAYERS=aerial&BBOX={bbox-epsg-3857}",
      },
    };
    const map = orderedMap(basemap);
    // The value tiles' description loads after the first draw: the layer draws nothing until then.
    const state = syncMapLayers(map, null, [polygon("0"), image, relief, service], { locale: "en", anchors });
    expect(map.order.some((id) => id.startsWith("2-"))).toBe(false);
    syncMapLayers(
      map,
      state,
      [polygon("0"), image, { ...relief, source: { ...reliefSource, values } }, service],
      { locale: "en", anchors }
    );
    const at = (id: string) => map.order.indexOf(id);
    expect(at("1-raster")).toBeGreaterThan(at("base-road"));
    expect(at("1-raster")).toBeLessThan(at("base-label"));
    for (const id of ["2-relief", "2-hillshade"]) {
      expect(at(id)).toBeGreaterThan(at("base-road"));
      expect(at(id)).toBeLessThan(at("1-raster"));
    }
    expect(at("3-raster")).toBeGreaterThan(at("base-bg"));
    expect(at("3-raster")).toBeLessThan(at("base-road"));
    expect(at("0-fill")).toBeGreaterThan(at("base-label"));
  });

  it("a basemap switch keeps layers, images, locale and time state", async () => {
    const map = orderedMap([{ id: "old-bg", type: "background" }]);
    const timed = polygon("1", {
      style: {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "icon", icon: "goat:park" }, label: { text: "{pop}" } },
        time: { field: "year" },
      } as LayerStyle,
      geometry: "point",
      entry: { time: { value: 2024 } },
    });
    const state = syncMapLayers(map, null, [timed], { locale: "de-DE" });
    const previous = {
      version: 8 as const,
      sources: { basemap: { type: "vector" as const }, "src-1": { type: "vector" as const } },
      layers: map.order.map((id) => map.specs.get(id)) as never,
    };
    const next = {
      version: 8 as const,
      sources: { satellite: { type: "raster" as const } },
      layers: [{ id: "new-bg", type: "background" }] as never,
    };
    const carried = carryProjectLayers(previous, next);
    expect(Object.keys(carried.sources)).toEqual(["satellite", "src-1"]);
    expect(carried.layers.map((l) => l.id)).toEqual(["new-bg", ...ours(map).filter((id) => id !== "old-bg")]);
    // The new style replaced the global state: the renderer sets it again.
    map.calls.length = 0;
    restoreGlobalState(map, state);
    expect(map.calls).toEqual(["state locale=de-DE", "state 1:time=2024"]);
    // Images come back on demand through the map's one resolver.
    await map.resolver?.("goat:park");
    expect(loadImage).toHaveBeenCalledWith(
      map,
      expect.stringContaining("park"),
      "goat:park",
      true,
      24,
      24,
      4
    );
  });

  describe("3D buildings (`ground`)", () => {
    const basemap = [
      { id: "base-bg", type: "background" },
      { id: "base-road", type: "line", "source-layer": "transportation" },
      { id: "base-label", type: "symbol" },
      { id: "base-buildings", type: "fill-extrusion" },
      { id: "base-boundary", type: "line" },
    ];
    const point = polygon("1", {
      style: { version: "1.0.0", kind: "vector", symbol: { marker: {} } } as LayerStyle,
      geometry: "point",
    });
    const labelled = polygon("2", {
      style: {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: "#cccccc" }, outline: { color: "#000000" }, label: { text: "{name}" } },
      } as LayerStyle,
    });
    const line = polygon("3", {
      style: { version: "1.0.0", kind: "vector", symbol: { line: { color: "#3366cc" } } } as LayerStyle,
      geometry: "line",
    });

    it("fills and lines on top go below the buildings, points and labels stay above them", () => {
      const map = orderedMap(basemap);
      syncMapLayers(map, null, [point, labelled, line], {
        locale: "en",
        anchors: basemapAnchors(basemap),
        ground: "base-buildings",
      });
      expect(map.order).toEqual([
        "base-bg",
        "base-road",
        "base-label",
        "3-line",
        "2-fill",
        "2-outline",
        "base-buildings",
        "base-boundary",
        "2-label",
        "1-marker",
      ]);
    });

    it("buildings switched on and off move the ground parts below them and back", () => {
      const map = orderedMap(basemap);
      const layers = [point, labelled, line];
      const anchors = basemapAnchors(basemap);
      let state = syncMapLayers(map, null, layers, { locale: "en", anchors });
      const flat = [...map.order];
      expect(flat.slice(basemap.length)).toEqual(["3-line", "2-fill", "2-outline", "2-label", "1-marker"]);
      state = syncMapLayers(map, state, layers, { locale: "en", anchors, ground: "base-buildings" });
      expect(map.order.indexOf("2-fill")).toBeLessThan(map.order.indexOf("base-buildings"));
      expect(map.order.indexOf("2-label")).toBeGreaterThan(map.order.indexOf("base-buildings"));
      syncMapLayers(map, state, layers, { locale: "en", anchors });
      expect(map.order).toEqual(flat);
    });

    it("a building layer below the labels takes the ground parts of the layers below the labels too", () => {
      const map = orderedMap([
        { id: "base-bg", type: "background" },
        { id: "goat-buildings", type: "fill-extrusion" },
        { id: "base-label", type: "symbol" },
      ]);
      syncMapLayers(map, null, [polygon("1", { entry: { position: "below_labels" } })], {
        locale: "en",
        anchors: { labels: "base-label" },
        ground: "goat-buildings",
      });
      expect(map.order).toEqual(["base-bg", "1-fill", "1-outline", "goat-buildings", "base-label"]);
    });

    it("a building layer not on the map yet changes nothing", () => {
      const map = orderedMap([{ id: "base-bg", type: "background" }]);
      syncMapLayers(map, null, [labelled], { locale: "en", ground: "goat-buildings" });
      expect(map.order).toEqual(["base-bg", "2-fill", "2-outline", "2-label"]);
    });
  });

  it("position changes the beforeId: a layer moved below the labels lands there", () => {
    const basemap = [
      { id: "base-bg", type: "background" },
      { id: "base-label", type: "symbol" },
    ];
    const map = orderedMap(basemap);
    const anchors = basemapAnchors(basemap);
    const state = syncMapLayers(map, null, [polygon("1"), polygon("2")], { locale: "en", anchors });
    expect(map.order).toEqual(["base-bg", "base-label", "2-fill", "2-outline", "1-fill", "1-outline"]);
    syncMapLayers(map, state, [polygon("1"), polygon("2", { entry: { position: "below_labels" } })], {
      locale: "en",
      anchors,
    });
    expect(map.order).toEqual(["base-bg", "2-fill", "2-outline", "base-label", "1-fill", "1-outline"]);
  });

  it("the time slider moves the global state without a recompile", () => {
    const map = orderedMap();
    const style = {
      version: "1.0.0",
      kind: "vector",
      symbol: { fill: { color: "#cccccc" } },
      time: { field: "year" },
    } as LayerStyle;
    const timed = (value: number) => polygon("1", { style, version: "s1:1", entry: { time: { value } } });
    const state = syncMapLayers(map, null, [timed(2020)], { locale: "en" });
    const compileLayer = vi.mocked(compileModule.compileLayer);
    compileLayer.mockClear();
    const addLayer = vi.spyOn(map, "addLayer");
    const setFilter = vi.spyOn(map, "setFilter");
    map.calls.length = 0;
    const next = syncMapLayers(map, state, [timed(2021)], { locale: "en" });
    expect(compileLayer).not.toHaveBeenCalled();
    expect(addLayer).not.toHaveBeenCalled();
    expect(setFilter).not.toHaveBeenCalled();
    expect(map.calls).toEqual(["state 1:time=2021"]);
    // A new basemap style sets the moved value again, not the first one.
    map.calls.length = 0;
    restoreGlobalState(map, next);
    expect(map.calls).toEqual(["state locale=en", "state 1:time=2021"]);
  });
});
