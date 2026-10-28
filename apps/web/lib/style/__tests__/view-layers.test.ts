import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { syncMapLayers } from "@/lib/style/render/mapLayers";
import {
  PENDING_KEY,
  type ViewLayer,
  clusterFeatureOf,
  editorIconProps,
  editorLayerIds,
  layerOfMapLayer,
  projectGeometryLayerIds,
  renderLayersOf,
  topFeature,
  zoomToCluster,
} from "@/lib/style/render/viewLayers";

import { publicMapLayers } from "@/hooks/map/useMapLayers";

vi.mock("@/lib/transformers/map-image", () => ({ loadImage: vi.fn(async () => undefined) }));

const FILL = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
const CLUSTER = {
  version: 1,
  kind: "vector",
  render: { type: "cluster" },
  symbol: { marker: {} },
} as LayerStyle;

const layer = (id: number, extra: Partial<ViewLayer> = {}): ViewLayer => ({
  id,
  layer_id: `dataset-${id}`,
  type: "feature",
  feature_layer_geometry_type: "polygon",
  visible: true,
  entry: {},
  style: { id: `style-${id}`, revision: 1, document: FILL },
  ...extra,
});

const tileUrl = (l: { source: unknown }) => (l.source as { tiles: string[] }).tiles[0];
const filterOf = (l: { source: unknown }) => {
  const raw = new URL(tileUrl(l).replace("{z}/{x}/{y}", "0/0/0")).searchParams.get("filter");
  return raw ? JSON.parse(raw) : undefined;
};

/** A map that keeps its layers, enough for the renderer's registry. */
function fakeMap() {
  const layers = new Map<string, { id: string }>();
  const sources = new Map<string, unknown>();
  return {
    getStyle: () => ({ layers: [...layers.values()] }),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: unknown) =>
      sources.set(id, { ...(spec as object), setData: () => undefined }),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id),
    addLayer: (l: { id: string }) => layers.set(l.id, l),
    removeLayer: (id: string) => layers.delete(id),
    moveLayer: () => undefined,
    setPaintProperty: () => undefined,
    setLayoutProperty: () => undefined,
    setFilter: () => undefined,
    setLayerZoomRange: () => undefined,
    setGlobalStateProperty: () => undefined,
    setFeatureState: () => undefined,
    setMissingStyleImageResolver: () => undefined,
    hasImage: () => false,
  };
}

const feature = (layerId: string, extra: object = {}) =>
  ({ layer: { id: layerId, source: "src" }, properties: {}, ...extra }) as never;

describe("renderLayersOf", () => {
  it("temporary filters of the layer and its additional targets reach its tiles; click to filter keeps its own", () => {
    const cql = { op: "=", args: [{ property: "kind" }, "park"] };
    const own = { op: ">", args: [{ property: "area" }, 10] };
    const target = { op: "=", args: [{ property: "district" }, "Mitte"] };
    const [first, second] = renderLayersOf([layer(1, { query: { cql } }), layer(2)], {
      temporaryFilters: [
        { id: "a", layer_id: 1, filter: own, additional_targets: [{ layer_id: 2, filter: target }] },
        { id: "b", layer_id: 2, filter: own, excludeFromSourceLayer: true },
      ],
    });
    expect(filterOf(first)).toEqual({ op: "and", args: [own, cql] });
    expect(filterOf(second)).toEqual({ op: "and", args: [target] });
  });

  it("the edited dataset's tiles are dynamic, its edited features hidden and drawn on top from its style", () => {
    const pending: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: 7, geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
      ],
    };
    const out = renderLayersOf([layer(1), layer(2)], {
      editing: { dataset: "dataset-2", exclude: [7, 8], pending },
    });
    expect(out.map((l) => l.key)).toEqual([`${PENDING_KEY}-mark`, PENDING_KEY, "1", "2"]);
    const edited = out.find((l) => l.key === "2")!;
    expect(tileUrl(edited)).toContain("dynamic=true");
    expect(edited.filter).toEqual({ exclude: [7, 8] });
    expect(tileUrl(out.find((l) => l.key === "1")!)).not.toContain("dynamic");
    const overlay = out.find((l) => l.key === PENDING_KEY)!;
    expect(overlay.style).toEqual(FILL);
    expect(overlay.source).toEqual({ type: "points", id: `src-${PENDING_KEY}`, data: pending });
  });

  it("every project layer of the edited dataset has dynamic tiles and hides the edited features", () => {
    const pending: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: 7, geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
      ],
    };
    // The same dataset added twice to the project (a twin with another style).
    const twin = layer(3, { layer_id: "dataset-2" });
    const out = renderLayersOf([layer(1), layer(2), twin], {
      editing: { dataset: "dataset-2", exclude: [7], pending },
    });
    for (const key of ["2", "3"]) {
      const edited = out.find((l) => l.key === key)!;
      expect(tileUrl(edited)).toContain("dynamic=true");
      expect(edited.filter).toEqual({ exclude: [7] });
    }
    expect(tileUrl(out.find((l) => l.key === "1")!)).not.toContain("dynamic");
    // One overlay of the pending features.
    expect(out.filter((l) => l.key === PENDING_KEY)).toHaveLength(1);
  });

  it("a layer without a style draws nothing", () => {
    expect(renderLayersOf([layer(1, { style: null }), layer(2)]).map((l) => l.key)).toEqual(["2"]);
  });

  it("a snapshot without styles draws nothing for that layer", () => {
    const rows = [layer(1), layer(2)].map(({ style: _s, visible: _v, entry: _e, ...row }) => row);
    const published = publicMapLayers({
      layers: rows as never,
      map: {
        version: 1,
        layers: [
          { type: "layer", id: 1, style: "style-1" },
          { type: "layer", id: 2 },
        ],
      } as never,
      styles: {
        "1": [
          {
            id: "style-1",
            name: "Default",
            position: 0,
            revision: 1,
            document: FILL,
            issues: [],
            stale: false,
          },
        ],
      },
    });
    expect(renderLayersOf(published).map((l) => l.key)).toEqual(["1"]);
    const legacy = publicMapLayers({ layers: rows as never });
    expect(renderLayersOf(legacy)).toEqual([]);
  });

  it("a clustered layer loads its points only once it was shown", () => {
    const clustered = layer(1, { visible: false, feature_layer_geometry_type: "point" });
    clustered.style = { id: "s", revision: 1, document: CLUSTER };
    expect(renderLayersOf([clustered])).toEqual([]);
    const [shown] = renderLayersOf([clustered], { revealed: new Set(["1"]) });
    expect(shown.source.type).toBe("points");
    expect(shown.entry.visible).toBe(false);
  });

  it("the version follows the style's id and revision, v= the dataset's data change", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const [l] = renderLayersOf([layer(1, { dataset_updated_at: recent })]);
    expect(l.version).toBe("style-1:1");
    expect(tileUrl(l)).toContain(`v=${Math.floor(new Date(recent).getTime() / 1000)}`);
  });

  it("highlight and atlas filters reach their layer only", () => {
    const [one, two] = renderLayersOf([layer(1), layer(2)], {
      highlight: { key: "2", id: 9 },
      atlas: { key: "1", feature: 4 },
    });
    expect([one.highlight, two.highlight]).toEqual([undefined, 9]);
    expect([one.filter, two.filter]).toEqual([{ atlas: 4 }, undefined]);
  });
});

describe("map events through the renderer's registry", () => {
  const drawn = () => {
    const map = fakeMap();
    const clustered = layer(2, { feature_layer_geometry_type: "point" });
    clustered.style = { id: "s", revision: 1, document: CLUSTER };
    const layers = [layer(1), clustered];
    syncMapLayers(map, null, renderLayersOf(layers), { locale: "en" });
    return { map, layers };
  };

  it("a click on <id>-fill opens that layer's popup", () => {
    const { map, layers } = drawn();
    expect(layerOfMapLayer(map, "1-fill", layers)?.id).toBe(1);
    const hit = topFeature(map, [feature("background"), feature("1-fill")], layers, () => true);
    expect(hit?.layer.id).toBe(1);
  });

  it("hover popups follow the trigger", () => {
    const { map, layers } = drawn();
    const hoverOnly = (l: ViewLayer) => l.id === 2;
    expect(topFeature(map, [feature("1-fill")], layers, hoverOnly)).toBeUndefined();
    const bubble = map.getStyle().layers.find((l) => (l as { id: string }).id.startsWith("2-cluster-")) as {
      id: string;
    };
    expect(topFeature(map, [feature("1-fill"), feature(bubble.id)], layers, hoverOnly)?.layer.id).toBe(2);
  });

  it("a cluster click zooms", async () => {
    const { map } = drawn();
    const bubble = (map.getStyle().layers as Array<{ id: string }>).find((l) =>
      l.id.startsWith("2-cluster-")
    )!;
    const point = { type: "Point", coordinates: [11, 48] };
    const hit = clusterFeatureOf(map, [
      feature("1-fill"),
      feature(bubble.id, { properties: { cluster_id: 3 }, geometry: point }),
    ]);
    expect(hit).toBeDefined();
    expect(clusterFeatureOf(map, [feature("1-fill", { properties: { cluster_id: 3 } })])).toBeUndefined();
    const easeTo = vi.fn();
    const zoomMap = {
      getSource: () => ({ getClusterExpansionZoom: async (id: number) => (id === 3 ? 12 : 0) }),
      easeTo,
    };
    await zoomToCluster(zoomMap, hit!);
    expect(easeTo).toHaveBeenCalledWith({ center: [11, 48], zoom: 12, duration: 500 });
  });

  it("click and snap on compiled ids", () => {
    const map = fakeMap();
    const pending: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", id: 7, geometry: { type: "Polygon", coordinates: [] }, properties: {} }],
    };
    const labelled = layer(1);
    labelled.style = {
      id: "s",
      revision: 1,
      document: {
        version: 1,
        kind: "vector",
        symbol: { fill: { color: "#cccccc" }, outline: { color: "#000000" }, label: { text: "{name}" } },
      } as LayerStyle,
    };
    syncMapLayers(
      map,
      null,
      renderLayersOf([labelled], { editing: { dataset: "dataset-1", exclude: [7], pending } }),
      { locale: "en" }
    );
    expect(editorLayerIds(map, "1", { snap: true })).toEqual(["1-fill", "1-outline"]);
    expect(editorLayerIds(map, "1")).toEqual([
      "1-fill",
      "1-outline",
      "1-label",
      "pending-features-fill",
      "pending-features-outline",
      "pending-features-label",
      "pending-features-mark-outline",
    ]);
  });

  it("the edited layer's icon goes onto the features being drawn", () => {
    const icon = (marker: object) => ({ version: 1, kind: "vector", symbol: { marker } }) as LayerStyle;
    expect(
      editorIconProps(
        icon({ shape: "icon", icon: "goat:park", size: 24, anchor: "bottom_left", color: "#ff0000" })
      )
    ).toEqual({
      _iconImage: "goat:park",
      _iconSize: 1,
      _iconAnchor: "bottom-left",
      _iconOpacity: 1,
      _iconColor: "#ff0000",
      _iconRadius: 16,
    });
    expect(editorIconProps(icon({ shape: "icon" }))?._iconImage).toBe("goat:marker");
    expect(editorIconProps(icon({ shape: "circle", icon: "goat:park" }))).toBeNull();
    expect(editorIconProps(null)).toBeNull();
  });

  it("measuring snaps to every project layer's geometry, not to labels, pending edits or the basemap", () => {
    const map = fakeMap();
    map.addLayer({ id: "basemap-road" });
    const labelled = layer(1);
    labelled.style = {
      id: "s",
      revision: 1,
      document: {
        version: 1,
        kind: "vector",
        symbol: { fill: { color: "#cccccc" }, outline: { color: "#000000" }, label: { text: "{name}" } },
      } as LayerStyle,
    };
    const pending: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: 7, geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
      ],
    };
    syncMapLayers(
      map,
      null,
      renderLayersOf([labelled, layer(2)], { editing: { dataset: "dataset-2", exclude: [], pending } }),
      { locale: "en" }
    );
    expect(projectGeometryLayerIds(map)).toEqual(["1-fill", "1-outline", "2-fill", "2-outline"]);
  });
});
