import { afterEach, describe, expect, it, vi } from "vitest";

import { TERRAIN_HILLSHADE_LAYER } from "@/lib/scene/compile";
import * as compileModule from "@/lib/style/compile";
import * as derivedModule from "@/lib/style/compile/derived";
import type { CompileSource } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import {
  type RenderLayer,
  basemapAnchors,
  basemapAnchorsOf,
  carryProjectLayers,
  mapLayerIdsOf,
  projectLayerOf,
  restoreGlobalState,
  syncMapLayers,
} from "@/lib/style/render/mapLayers";
import { loadImage } from "@/lib/transformers/map-image";

vi.mock("@/lib/transformers/map-image", () => ({ loadImage: vi.fn(async () => undefined) }));
vi.mock("@/lib/style/compile/derived", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/style/compile/derived")>();
  return { ...actual, usesTone: vi.fn(actual.usesTone) };
});
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
      style: {
        version: "1.0.0",
        kind: "vector",
        render: { type: "h3", points_from_zoom: 15, outline: {} },
      } as LayerStyle,
      filter: { exclude: [5], atlas: 7 },
    });
    syncMapLayers(map, null, [hexagons], { locale: "en" });
    expect(map.specs.get("1-h3-fill")?.filter).toBeUndefined();
    expect(map.specs.has("1-h3-outline")).toBe(true);
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
    // A map service below the labels: between the roads and the labels.
    const labelled: RenderLayer = {
      ...service,
      key: "4",
      entry: { position: "below_labels" },
      source: { ...service.source, id: "src-4" } as RenderLayer["source"],
    };
    const map = orderedMap(basemap);
    // The value tiles' description loads after the first draw: the layer draws nothing until then.
    const state = syncMapLayers(map, null, [polygon("0"), image, relief, service, labelled], {
      locale: "en",
      anchors,
    });
    expect(map.order.some((id) => id.startsWith("2-"))).toBe(false);
    syncMapLayers(
      map,
      state,
      [polygon("0"), image, { ...relief, source: { ...reliefSource, values } }, service, labelled],
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
    expect(at("4-raster")).toBeGreaterThan(at("base-road"));
    expect(at("4-raster")).toBeLessThan(at("base-label"));
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

    describe("a basemap of two blocks, the lower with its own buildings below the upper block's land", () => {
      const twoBlocks = [
        { id: "base-bg", type: "background" },
        { id: "low-fill", type: "fill" },
        { id: "low-road", type: "line", "source-layer": "transportation" },
        { id: "low-buildings", type: "fill-extrusion" },
        { id: "low-label", type: "symbol" },
        { id: "high-land", type: "fill" },
        { id: "high-road", type: "line", "source-layer": "transportation" },
        { id: "high-buildings", type: "fill-extrusion" },
        { id: "high-label", type: "symbol" },
      ];
      const lowBlock = ["base-bg", "low-fill", "low-road", "low-buildings", "low-label"];
      // The scene's anchor is the lowest building layer it shows: the lower block's.
      const sync = (position?: "top" | "below_labels" | "below_roads") => {
        const map = orderedMap(twoBlocks);
        syncMapLayers(map, null, [polygon("2", { ...labelled, entry: position ? { position } : {} })], {
          locale: "en",
          anchors: basemapAnchors(twoBlocks),
          ground: "low-buildings",
        });
        return map.order;
      };

      it("on top: the ground parts go above the upper block's land, below its buildings", () => {
        expect(sync()).toEqual([
          ...lowBlock,
          "high-land",
          "high-road",
          "2-fill",
          "2-outline",
          "high-buildings",
          "high-label",
          "2-label",
        ]);
      });

      it("below the labels: the ground parts go below the upper block's buildings, the label below its labels", () => {
        expect(sync("below_labels")).toEqual([
          ...lowBlock,
          "high-land",
          "high-road",
          "2-fill",
          "2-outline",
          "high-buildings",
          "2-label",
          "high-label",
        ]);
      });

      it("below the roads: every part goes below the upper block's first road, above its land", () => {
        expect(sync("below_roads")).toEqual([
          ...lowBlock,
          "high-land",
          "2-fill",
          "2-outline",
          "2-label",
          "high-road",
          "high-buildings",
          "high-label",
        ]);
      });

      it("the roads anchor, which the scene's terrain shading also goes below, is the upper block's first road", () => {
        expect(basemapAnchors(twoBlocks).roads).toBe("high-road");
        expect(basemapAnchorsOf(orderedMap(twoBlocks) as never).roads).toBe("high-road");
      });

      it("with the lower block's buildings hidden the roads anchor is the first road", () => {
        const hidden = twoBlocks.map((l) =>
          l.id === "low-buildings" ? { ...l, layout: { visibility: "none" } } : l
        );
        expect(basemapAnchors(hidden).roads).toBe("low-road");
      });

      it("without a road on the ground above the lower block's buildings the position below the roads takes the labels", () => {
        // A road's labels are no road.
        const noRoad = twoBlocks.map((l) =>
          l.id === "high-road"
            ? { id: "high-road-name", type: "symbol", "source-layer": "transportation" }
            : l
        );
        expect(basemapAnchors(noRoad).roads).toBeUndefined();
      });

      it("without a shown building layer in the upper block the parts go where they go without buildings", () => {
        const hidden = twoBlocks.map((l) =>
          l.id === "high-buildings" ? { ...l, layout: { visibility: "none" } } : l
        );
        const map = orderedMap(hidden);
        syncMapLayers(map, null, [labelled], {
          locale: "en",
          anchors: basemapAnchors(hidden),
          ground: "low-buildings",
        });
        expect(map.order).toEqual([...hidden.map((l) => l.id), "2-fill", "2-outline", "2-label"]);
      });
    });

    describe("other shapes of basemaps", () => {
      type Layer = Record<string, unknown> & { id: string; type: string };
      /** The order after placing a labelled polygon; the anchors come from `basemap`, the map holds `onMap`. */
      const placed = (basemap: Layer[], ground: string, onMap: Layer[] = basemap) => {
        const map = orderedMap(onMap);
        syncMapLayers(map, null, [labelled], {
          locale: "en",
          anchors: basemapAnchors(basemap),
          ground,
        });
        return map.order;
      };
      const onTop = (basemap: Layer[]) => [...basemap.map((l) => l.id), "2-fill", "2-outline", "2-label"];

      it("buildings as the last ground layer stay the anchor", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill" },
          { id: "c", type: "line" },
          { id: "d", type: "fill-extrusion" },
          { id: "e", type: "symbol" },
        ];
        expect(placed(basemap, "d")).toEqual(["a", "b", "c", "2-fill", "2-outline", "d", "e", "2-label"]);
      });

      it("a translucent area above the buildings counts as covering: the parts go where they go without buildings", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill-extrusion" },
          { id: "c", type: "line" },
          { id: "d", type: "fill", paint: { "fill-opacity": 0.2 } },
          { id: "e", type: "symbol" },
        ];
        expect(placed(basemap, "b")).toEqual(onTop(basemap));
      });

      it("an opaque background after the buildings, among the labels, counts as covering", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill" },
          { id: "c", type: "fill-extrusion" },
          { id: "d", type: "symbol" },
          { id: "e", type: "background" },
          { id: "f", type: "symbol" },
        ];
        expect(placed(basemap, "c")).toEqual(onTop(basemap));
      });

      it("an opaque fill after the buildings between labels counts as covering", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill" },
          { id: "c", type: "fill-extrusion" },
          { id: "d", type: "symbol" },
          { id: "e", type: "fill" },
          { id: "f", type: "symbol" },
        ];
        expect(placed(basemap, "c")).toEqual(onTop(basemap));
      });

      it("an opaque fill among the labels counts as covering", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill" },
          { id: "c", type: "fill-extrusion" },
          { id: "d", type: "symbol" },
          { id: "e", type: "symbol" },
          { id: "f", type: "symbol" },
          { id: "g", type: "fill" },
          { id: "h", type: "symbol" },
        ];
        expect(placed(basemap, "c")).toEqual(onTop(basemap));
      });

      it("a fill of a pattern among the labels does not count: the buildings stay the anchor", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "line", "source-layer": "transportation" },
          { id: "c", type: "fill-extrusion" },
          { id: "d", type: "symbol" },
          { id: "e", type: "fill", paint: { "fill-pattern": "rocks" } },
          { id: "f", type: "symbol" },
        ];
        expect(placed(basemap, "c")).toEqual([
          "a",
          "b",
          "2-fill",
          "2-outline",
          "c",
          "d",
          "e",
          "f",
          "2-label",
        ]);
      });

      it("a hidden area above the buildings does not count", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill-extrusion" },
          { id: "c", type: "fill", layout: { visibility: "none" } },
          { id: "d", type: "symbol" },
        ];
        expect(placed(basemap, "b")).toEqual(["a", "2-fill", "2-outline", "b", "c", "d", "2-label"]);
      });

      it("a basemap layer named like the app's own layers counts as the basemap's", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill-extrusion" },
          { id: "goat-land", type: "fill" },
          { id: "d", type: "symbol" },
        ];
        expect(placed(basemap, "b")).toEqual(onTop(basemap));
      });

      it("the upper block of fewer ground layers than the lower block has labels: above its land, below its buildings", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "low-fill", type: "fill" },
          { id: "low-buildings", type: "fill-extrusion" },
          { id: "low-label-1", type: "symbol" },
          { id: "low-label-2", type: "symbol" },
          { id: "low-label-3", type: "symbol" },
          { id: "high-land", type: "fill" },
          { id: "high-road", type: "line", "source-layer": "transportation" },
          { id: "high-buildings", type: "fill-extrusion" },
          { id: "high-label", type: "symbol" },
        ];
        expect(placed(basemap, "low-buildings")).toEqual([
          "a",
          "low-fill",
          "low-buildings",
          "low-label-1",
          "low-label-2",
          "low-label-3",
          "high-land",
          "high-road",
          "2-fill",
          "2-outline",
          "high-buildings",
          "high-label",
          "2-label",
        ]);
      });

      it("a two-block basemap without its own buildings: GOAT's building layer in the lower block is no anchor", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "low-fill", type: "fill" },
          { id: "low-road", type: "line", "source-layer": "transportation" },
          { id: "low-label-1", type: "symbol" },
          { id: "low-label-2", type: "symbol" },
          { id: "low-label-3", type: "symbol" },
          { id: "high-land", type: "fill" },
          { id: "high-road", type: "line", "source-layer": "transportation" },
          { id: "high-label", type: "symbol" },
        ];
        // The scene puts its building layer where the label block starts.
        expect(basemapAnchors(basemap).buildings).toBe("low-label-1");
        const onMap = [
          ...basemap.slice(0, 3),
          { id: "goat-buildings", type: "fill-extrusion" },
          ...basemap.slice(3),
        ];
        expect(placed(basemap, "goat-buildings", onMap)).toEqual(onTop(onMap));
      });

      it("a building layer first in the style, under the land, is no anchor", () => {
        const basemap = [
          { id: "a", type: "fill-extrusion" },
          { id: "b", type: "fill" },
          { id: "c", type: "symbol" },
        ];
        expect(placed(basemap, "a")).toEqual(onTop(basemap));
      });

      it("a style without labels: buildings with only lines above stay the anchor, under an area they are none", () => {
        const lines = [
          { id: "a", type: "background" },
          { id: "b", type: "fill" },
          { id: "c", type: "fill-extrusion" },
          { id: "d", type: "line" },
        ];
        expect(placed(lines, "c")).toEqual(["a", "b", "2-fill", "2-outline", "c", "d", "2-label"]);
        const area = [
          { id: "a", type: "background" },
          { id: "b", type: "fill-extrusion" },
          { id: "c", type: "fill" },
        ];
        expect(placed(area, "b")).toEqual(onTop(area));
      });

      it("a basemap without buildings keeps GOAT's building layer at the start of its labels as the anchor", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill" },
          { id: "goat-buildings", type: "fill-extrusion" },
          { id: "c", type: "symbol" },
        ];
        expect(placed(basemap, "goat-buildings")).toEqual([
          "a",
          "b",
          "2-fill",
          "2-outline",
          "goat-buildings",
          "c",
          "2-label",
        ]);
      });

      it("the app's terrain shading above GOAT's building layer does not count: the building layer stays the anchor", () => {
        const basemap = [
          { id: "bg", type: "background" },
          { id: "land", type: "fill" },
          { id: "street", type: "line" },
          { id: "goat-buildings", type: "fill-extrusion" },
          { id: TERRAIN_HILLSHADE_LAYER, type: "hillshade" },
          { id: "name", type: "symbol" },
          { id: "poi", type: "symbol" },
        ];
        expect(placed(basemap, "goat-buildings")).toEqual([
          "bg",
          "land",
          "street",
          "2-fill",
          "2-outline",
          "goat-buildings",
          TERRAIN_HILLSHADE_LAYER,
          "name",
          "poi",
          "2-label",
        ]);
      });

      it("a basemap's own hillshade above the buildings counts as covering", () => {
        const basemap = [
          { id: "a", type: "background" },
          { id: "b", type: "fill-extrusion" },
          { id: "c", type: "hillshade" },
          { id: "d", type: "symbol" },
        ];
        expect(placed(basemap, "b")).toEqual(onTop(basemap));
      });

      it("a basemap of raster tiles keeps GOAT's building layer on top of it as the anchor", () => {
        const basemap = [
          { id: "a", type: "raster" },
          { id: "goat-buildings", type: "fill-extrusion" },
        ];
        expect(placed(basemap, "goat-buildings")).toEqual([
          "a",
          "2-fill",
          "2-outline",
          "goat-buildings",
          "2-label",
        ]);
      });
    });

    describe("on top: below the buildings only from the camera zoom at which a building can draw", () => {
      type Layer = Record<string, unknown> & { id: string; type: string };
      const streets: Layer[] = [
        { id: "base-bg", type: "background" },
        { id: "base-road", type: "line", "source-layer": "transportation" },
        { id: "goat-buildings", type: "fill-extrusion", minzoom: 14 },
        { id: "base-label", type: "symbol" },
      ];
      const anchors = basemapAnchors(streets);
      /** A map whose camera is at `zoom`, `zoomTo` moves it. */
      const atZoom = (basemap: Layer[], zoom: number) => {
        let at = zoom;
        return Object.assign(orderedMap(basemap), {
          getZoom: () => at,
          zoomTo: (next: number) => {
            at = next;
          },
        });
      };
      const hexagons = polygon("1");
      const top = [hexagons, labelled];
      const onTop = [
        "base-bg",
        "base-road",
        "goat-buildings",
        "base-label",
        "2-fill",
        "2-outline",
        "2-label",
        "1-fill",
        "1-outline",
      ];
      const under = [
        "base-bg",
        "base-road",
        "2-fill",
        "2-outline",
        "1-fill",
        "1-outline",
        "goat-buildings",
        "base-label",
        "2-label",
      ];

      it("below that zoom a fill on top goes above the labels, as with the buildings off", () => {
        const off = atZoom(streets, 12);
        syncMapLayers(off, null, top, { locale: "en", anchors });
        const map = atZoom(streets, 12);
        syncMapLayers(map, null, top, { locale: "en", anchors, ground: "goat-buildings" });
        expect(map.order).toEqual(off.order);
        expect(map.order).toEqual(onTop);
      });

      it("from that zoom on it goes below the buildings as it does without a known zoom", () => {
        for (const zoom of [14, 16.5]) {
          const map = atZoom(streets, zoom);
          syncMapLayers(map, null, top, { locale: "en", anchors, ground: "goat-buildings" });
          expect(map.order).toEqual(under);
        }
        const unknown = orderedMap(streets);
        syncMapLayers(unknown, null, top, { locale: "en", anchors, ground: "goat-buildings" });
        expect(unknown.order).toEqual(under);
      });

      it("a still map (print, thumbnail) placed once follows the same rule for its zoom", () => {
        const low = atZoom(streets, 13.99);
        const lowState = syncMapLayers(low, null, top, { locale: "en", anchors, ground: "goat-buildings" });
        expect(low.order).toEqual(onTop);
        const high = atZoom(streets, 15);
        const highState = syncMapLayers(high, null, top, { locale: "en", anchors, ground: "goat-buildings" });
        expect(high.order).toEqual(under);
        // What the renderer's owner watches the camera with.
        expect(lowState).toMatchObject({ buildingsFrom: 14, underBuildings: false });
        expect(highState).toMatchObject({ buildingsFrom: 14, underBuildings: true });
        const off = syncMapLayers(atZoom(streets, 15), null, top, { locale: "en", anchors });
        expect(off.buildingsFrom).toBeUndefined();
      });

      /** The order a fresh placement of `layers` at `zoom` gives. */
      const freshAt = (basemap: Layer[], zoom: number, layers: RenderLayer[]) => {
        const map = atZoom(basemap, zoom);
        syncMapLayers(map, null, layers, {
          locale: "en",
          anchors: basemapAnchors(basemap),
          ground: "goat-buildings",
        });
        return map.order;
      };

      it("crossing the zoom places the layers once each way as a fresh placement there does; a zoom on one side moves nothing", () => {
        const layers = [
          hexagons,
          labelled,
          polygon("3", { entry: { position: "below_labels" } }),
          polygon("4", { entry: { position: "below_roads" } }),
        ];
        const map = atZoom(streets, 12);
        const moves: string[] = [];
        const move = map.moveLayer;
        map.moveLayer = (id: string, before?: string) => {
          moves.push(id);
          move(id, before);
        };
        const sync = (prev: ReturnType<typeof syncMapLayers> | null) =>
          syncMapLayers(map, prev, layers, { locale: "en", anchors, ground: "goat-buildings" });
        const every = [
          "1-fill",
          "1-outline",
          "2-fill",
          "2-label",
          "2-outline",
          "3-fill",
          "3-outline",
          "4-fill",
          "4-outline",
        ];
        let state = sync(null);
        const low = [...map.order];
        expect(low.slice(-5)).toEqual(["2-fill", "2-outline", "2-label", "1-fill", "1-outline"]);
        const compiles = vi.mocked(compileModule.compileLayer).mock.calls.length;

        map.zoomTo(13.5);
        state = sync(state);
        expect(moves).toEqual([]);

        // Across it every layer is placed again, as a reorder places them: the layers on top go below the buildings
        // under the ground parts of the layers below the labels, as a fresh placement at that zoom stacks them.
        map.zoomTo(14.2);
        state = sync(state);
        expect(vi.mocked(compileModule.compileLayer).mock.calls.length).toBe(compiles);
        expect([...moves].sort()).toEqual(every);
        expect(map.order).toEqual(freshAt(streets, 14.2, layers));
        expect(map.order).toEqual([
          "base-bg",
          "4-fill",
          "4-outline",
          "base-road",
          "2-fill",
          "2-outline",
          "1-fill",
          "1-outline",
          "3-fill",
          "3-outline",
          "goat-buildings",
          "base-label",
          "2-label",
        ]);

        moves.length = 0;
        map.zoomTo(18);
        state = sync(state);
        expect(moves).toEqual([]);

        const before = vi.mocked(compileModule.compileLayer).mock.calls.length;
        map.zoomTo(13.9);
        sync(state);
        expect(vi.mocked(compileModule.compileLayer).mock.calls.length).toBe(before);
        expect([...moves].sort()).toEqual(every);
        expect(map.order).toEqual(low);
        expect(map.order).toEqual(freshAt(streets, 13.9, layers));
      });

      it("positions mixed in the map document: the order after a crossing either way is that of a fresh placement", () => {
        const image: RenderLayer = {
          key: "5",
          style: { version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle,
          entry: {},
          source: {
            type: "raster",
            id: "src-5",
            tiles: "https://geo/r/{z}/{x}/{y}.webp",
            coverage: "https://geo/c",
          },
        };
        const at = (layer: RenderLayer, position?: "below_labels" | "below_roads"): RenderLayer => ({
          ...layer,
          entry: position ? { position } : {},
        });
        const layers = [
          at(polygon("1")),
          at(polygon("2", { style: labelled.style }), "below_labels"),
          at(image),
          at(polygon("3", { style: line.style, geometry: "line" }), "below_roads"),
          at(polygon("4", { style: labelled.style })),
          at(polygon("6"), "below_labels"),
          at({ ...point, key: "7", source: tiles("7") }),
        ];
        const map = atZoom(streets, 12);
        let state = syncMapLayers(map, null, layers, { locale: "en", anchors, ground: "goat-buildings" });
        for (const zoom of [15, 13, 14, 2, 16.5, 13.99]) {
          map.zoomTo(zoom);
          state = syncMapLayers(map, state, layers, { locale: "en", anchors, ground: "goat-buildings" });
          expect([zoom, map.order]).toEqual([zoom, freshAt(streets, zoom, layers)]);
        }
      });

      it("a sync with the same layers reads the building layer again: another zoom range places them again, compiles nothing", () => {
        const map = atZoom(streets, 13);
        let state = syncMapLayers(map, null, top, { locale: "en", anchors, ground: "goat-buildings" });
        expect(map.order).toEqual(onTop);
        const compiles = vi.mocked(compileModule.compileLayer).mock.calls.length;
        // The scene lowers the same layer's zoom range (its buildings now draw from 12).
        map.specs.set("goat-buildings", { id: "goat-buildings", type: "fill-extrusion", minzoom: 12 });
        state = syncMapLayers(map, state, top, { locale: "en", anchors, ground: "goat-buildings" });
        expect(state).toMatchObject({ buildingsFrom: 12, underBuildings: true });
        expect(map.order).toEqual(under);
        expect(vi.mocked(compileModule.compileLayer).mock.calls.length).toBe(compiles);
      });

      it("below the labels and below the roads place the same at every zoom", () => {
        const layers = [
          polygon("3", { entry: { position: "below_labels" } }),
          polygon("4", { entry: { position: "below_roads" } }),
        ];
        const orders = [12, 14, 17].map((zoom) => {
          const map = atZoom(streets, zoom);
          syncMapLayers(map, null, layers, { locale: "en", anchors, ground: "goat-buildings" });
          return map.order;
        });
        expect(orders[0]).toEqual([
          "base-bg",
          "4-fill",
          "4-outline",
          "base-road",
          "3-fill",
          "3-outline",
          "goat-buildings",
          "base-label",
        ]);
        expect(orders[1]).toEqual(orders[0]);
        expect(orders[2]).toEqual(orders[0]);
      });

      it("a tilted view: buildings built in far tiles below the camera's zoom draw only from the zoom their opacity shows", () => {
        // The scene's building layer reaching down to the footprints' tiles (`Reach`): built from zoom 12, drawn from
        // the camera's zoom 14.
        const reached = streets.map((l) =>
          l.id === "goat-buildings"
            ? { ...l, minzoom: 12, paint: { "fill-extrusion-opacity": ["step", ["zoom"], 0, 14, 0.6] } }
            : l
        );
        const placed = (zoom: number) => {
          const map = atZoom(reached, zoom);
          syncMapLayers(map, null, top, { locale: "en", anchors, ground: "goat-buildings" });
          return map.order;
        };
        expect(placed(13.5)).toEqual(onTop);
        expect(placed(14)).toEqual(under);
        // Drawn from zoom 12 on, by its minzoom alone: below the buildings from there.
        const drawn = streets.map((l) => (l.id === "goat-buildings" ? { ...l, minzoom: 12 } : l));
        const map = atZoom(drawn, 12.5);
        syncMapLayers(map, null, top, { locale: "en", anchors, ground: "goat-buildings" });
        expect(map.order).toEqual(under);
      });

      it("a basemap's own building layers: the lowest zoom any shown one draws from counts, a hidden one does not", () => {
        const own: Layer[] = [
          { id: "base-bg", type: "background" },
          { id: "base-road", type: "line", "source-layer": "transportation" },
          { id: "own-tall", type: "fill-extrusion", minzoom: 16 },
          { id: "own-low", type: "fill-extrusion", minzoom: 15 },
          { id: "own-hidden", type: "fill-extrusion", minzoom: 12, layout: { visibility: "none" } },
          { id: "base-label", type: "symbol" },
        ];
        const placed = (zoom: number) => {
          const map = atZoom(own, zoom);
          syncMapLayers(map, null, [hexagons], {
            locale: "en",
            anchors: basemapAnchors(own),
            ground: "own-tall",
          });
          return map.order;
        };
        expect(placed(14.9).slice(-2)).toEqual(["1-fill", "1-outline"]);
        expect(placed(15).indexOf("1-outline")).toBeLessThan(placed(15).indexOf("own-tall"));
      });

      it("a basemap of two blocks: below the zoom on top over everything, from it on above the upper land as before", () => {
        const twoBlocks: Layer[] = [
          { id: "base-bg", type: "background" },
          { id: "low-road", type: "line", "source-layer": "transportation" },
          { id: "low-buildings", type: "fill-extrusion", minzoom: 14 },
          { id: "low-label", type: "symbol" },
          { id: "high-land", type: "fill" },
          { id: "high-road", type: "line", "source-layer": "transportation" },
          { id: "high-buildings", type: "fill-extrusion", minzoom: 14 },
          { id: "high-label", type: "symbol" },
        ];
        const placed = (zoom: number) => {
          const map = atZoom(twoBlocks, zoom);
          syncMapLayers(map, null, [labelled], {
            locale: "en",
            anchors: basemapAnchors(twoBlocks),
            ground: "low-buildings",
          });
          return map.order;
        };
        const ids = twoBlocks.map((l) => l.id);
        expect(placed(12)).toEqual([...ids, "2-fill", "2-outline", "2-label"]);
        expect(placed(14)).toEqual([
          ...ids.slice(0, 6),
          "2-fill",
          "2-outline",
          "high-buildings",
          "high-label",
          "2-label",
        ]);
      });
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

  describe("the basemap's tone", () => {
    const compileLayer = () => vi.mocked(compileModule.compileLayer);
    const usesTone = vi.mocked(derivedModule.usesTone);
    const toned = {
      version: "1.0.0",
      kind: "vector",
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto" } },
    } as LayerStyle;
    const layers = () => [
      polygon("1", { version: "a:1" }),
      polygon("2", { style: toned, version: "b:1" }),
      polygon("3", { version: "c:1" }),
    ];
    const compiledKeys = () => compileLayer().mock.calls.map(([input]) => input.id);
    // Back to its own answer (vi.fn of the module's function).
    afterEach(() => {
      usesTone.mockReset();
      vi.restoreAllMocks();
    });

    it("is passed to the compiler for every layer it compiles", () => {
      compileLayer().mockClear();
      syncMapLayers(orderedMap(), null, layers(), { locale: "en", tone: "dark" });
      expect(compileLayer().mock.calls.map(([input]) => input.tone)).toEqual(["dark", "dark", "dark"]);
      compileLayer().mockClear();
      syncMapLayers(orderedMap(), null, layers(), { locale: "en" });
      expect(compileLayer().mock.calls.map(([input]) => input.tone)).toEqual(["light", "light", "light"]);
    });

    it("a switch from light to dark compiles again exactly the layers whose style uses it", () => {
      usesTone.mockImplementation((style) => style === (toned as unknown));
      // A stand-in rule that reads the tone: the Auto outline is black on a dark basemap.
      const shade = derivedModule.RULES.shade;
      vi.spyOn(derivedModule.RULES, "shade").mockImplementation((color, inputs) =>
        inputs.tone === "dark" ? "#000000" : shade(color, inputs)
      );
      const map = orderedMap();
      const state = syncMapLayers(map, null, layers(), { locale: "en", tone: "light" });
      compileLayer().mockClear();
      const touched: string[] = [];
      const record =
        (name: "addLayer" | "removeLayer" | "setPaintProperty" | "setLayoutProperty" | "setFilter") =>
        (id: unknown) =>
          touched.push(`${name} ${typeof id === "string" ? id : (id as { id: string }).id}`);
      for (const name of [
        "addLayer",
        "removeLayer",
        "setPaintProperty",
        "setLayoutProperty",
        "setFilter",
      ] as const)
        vi.spyOn(map, name).mockImplementation(record(name) as never);
      const next = syncMapLayers(map, state, layers(), { locale: "en", tone: "dark" });
      expect(compiledKeys()).toEqual(["2"]);
      expect(compileLayer().mock.calls[0][0].tone).toBe("dark");
      // The new outline color reaches the map, on that layer only.
      expect(touched).toEqual(["setPaintProperty 2-outline"]);
      // The same tone again compiles nothing.
      compileLayer().mockClear();
      syncMapLayers(map, next, layers(), { locale: "en", tone: "dark" });
      expect(compiledKeys()).toEqual([]);
    });

    it("a switch compiles again exactly the layers with a label Auto, and only their label colors change", () => {
      const labelled = {
        version: "1.0.0",
        kind: "vector",
        symbol: {
          fill: { color: "#7f3c8d" },
          label: { text: "{name}", color: "auto", halo: { color: "auto" } },
        },
      } as LayerStyle;
      const outlined = toned;
      const all = () => [
        polygon("1", { version: "a:1" }),
        polygon("2", { style: labelled, version: "b:1" }),
        polygon("3", { style: outlined, version: "c:1" }),
      ];
      const map = orderedMap();
      const state = syncMapLayers(map, null, all(), { locale: "en", tone: "light" });
      compileLayer().mockClear();
      const touched: string[] = [];
      for (const name of [
        "addLayer",
        "removeLayer",
        "setPaintProperty",
        "setLayoutProperty",
        "setFilter",
      ] as const)
        vi.spyOn(map, name).mockImplementation(((id: unknown, key?: unknown) =>
          touched.push(
            `${name} ${typeof id === "string" ? id : (id as { id: string }).id}${typeof key === "string" ? ` ${key}` : ""}`
          )) as never);
      const next = syncMapLayers(map, state, all(), { locale: "en", tone: "dark" });
      expect(compiledKeys()).toEqual(["2"]);
      expect(touched.sort()).toEqual([
        "setPaintProperty 2-label text-color",
        "setPaintProperty 2-label text-halo-color",
      ]);
      compileLayer().mockClear();
      syncMapLayers(map, next, all(), { locale: "en", tone: "dark" });
      expect(compiledKeys()).toEqual([]);
    });

    it("with no style using it, a switch compiles nothing that would not compile anyway", () => {
      const map = orderedMap();
      const state = syncMapLayers(map, null, layers(), { locale: "en", tone: "light" });
      compileLayer().mockClear();
      const addLayer = vi.spyOn(map, "addLayer");
      const removeLayer = vi.spyOn(map, "removeLayer");
      const next = syncMapLayers(map, state, layers(), { locale: "en", tone: "dark" });
      expect(compiledKeys()).toEqual([]);
      expect(addLayer).not.toHaveBeenCalled();
      expect(removeLayer).not.toHaveBeenCalled();
      // A changed style still compiles, and only that one.
      const changed = [
        polygon("1", { version: "a:2" }),
        polygon("2", { style: toned, version: "b:1" }),
        polygon("3", { version: "c:1" }),
      ];
      syncMapLayers(map, next, changed, { locale: "en", tone: "light" });
      expect(compiledKeys()).toEqual(["1"]);
    });
  });
});
