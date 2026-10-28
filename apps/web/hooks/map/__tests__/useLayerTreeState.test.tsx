import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type MapResponse, useProjectMap } from "@/lib/api/map";
import { layerReducer } from "@/lib/store/layer/slice";
import type { LayerStyle } from "@/lib/style/generated/types";
import { syncMapLayers } from "@/lib/style/render/mapLayers";
import { renderLayersOf } from "@/lib/style/render/viewLayers";
import type { ProjectLayer } from "@/lib/validations/project";

import { useLayerTreeState } from "@/hooks/map/useLayerTreeState";
import { foldVisibility, joinMapLayers, publicMapLayers } from "@/hooks/map/useMapLayers";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: vi.fn() }));
vi.mock("@/lib/providers/PublicProjectProvider", () => ({ useIsPublicProject: () => false }));
vi.mock("@/lib/transformers/map-image", () => ({ loadImage: vi.fn(async () => undefined) }));

const PROJECT = "00000000-0000-0000-0000-000000000001";
const FILL = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
const style = (id: string) => ({
  id,
  name: "Default",
  position: 0,
  revision: 1,
  document: FILL,
  issues: [],
  stale: false,
});
const body: MapResponse = {
  map: {
    version: 1,
    layers: [
      { type: "layer", id: 5, visible: true, style: "s5" },
      {
        type: "group",
        id: 9,
        name: "G",
        visible: true,
        children: [{ type: "layer", id: 6, visible: true, style: "s6" }],
      },
    ],
  },
  styles: { "5": { active: style("s5"), others: [] }, "6": { active: style("s6"), others: [] } },
  unpublished: [],
};
const row = (id: number, group: number | null = null) =>
  ({
    id,
    layer_id: `dataset-${id}`,
    name: `L${id}`,
    type: "feature",
    feature_layer_geometry_type: "polygon",
    order: 0,
    layer_project_group_id: group,
  }) as unknown as ProjectLayer;
const rows = [row(5), row(6, 9)];

const reply = (status: number, json?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: () => Promise.resolve(json),
});

/** A map that keeps its layers' layout, enough to read what the renderer hid. */
function fakeMap() {
  const layers = new Map<string, { id: string; layout?: Record<string, unknown> }>();
  return {
    layers,
    getStyle: () => ({ layers: [...layers.values()] }),
    getSource: () => undefined,
    addSource: () => undefined,
    removeSource: () => undefined,
    getLayer: (id: string) => layers.get(id),
    addLayer: (l: { id: string; layout?: Record<string, unknown> }) => layers.set(l.id, l),
    removeLayer: (id: string) => layers.delete(id),
    moveLayer: () => undefined,
    setPaintProperty: () => undefined,
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout = { ...layer.layout, [name]: value };
    },
    setFilter: () => undefined,
    setLayerZoomRange: () => undefined,
    setGlobalStateProperty: () => undefined,
    setFeatureState: () => undefined,
    setMissingStyleImageResolver: () => undefined,
    hasImage: () => false,
  };
}

function setup(mode: "edit" | "view" | "public", layers: ProjectLayer[] = []) {
  const store = configureStore({
    reducer: { layers: layerReducer },
    preloadedState: {
      layers: {
        projectLayers: layers,
        projectLayerGroups: [{ id: 9, name: "G", project_id: PROJECT, visible: true }],
      },
    } as never,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </Provider>
  );
  const hook = renderHook(
    () => ({
      tree: useLayerTreeState(PROJECT, mode),
      map: useProjectMap(mode === "public" ? undefined : PROJECT),
    }),
    { wrapper }
  );
  return { ...hook, store };
}

const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");

describe("useLayerTreeState", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "PATCH" ? reply(200, {}) : reply(200, body))
    );
  });

  it("hiding a layer sends one PATCH and hides only that layer's map layers", async () => {
    const { result } = setup("edit");
    await waitFor(() => expect(result.current.map.map).toBeDefined());
    await act(async () => {
      await result.current.tree.onLayerStateChange(5, { visible: false });
    });
    expect(patches()).toHaveLength(1);
    expect(patches()[0][0]).toMatch(/\/layer\/5\/map-state$/);
    expect(JSON.parse(patches()[0][1].body)).toEqual({ visible: false });
    const map = fakeMap();
    syncMapLayers(map, null, renderLayersOf(joinMapLayers(rows, result.current.map.map)), { locale: "en" });
    const hidden = (key: string) =>
      [...map.layers.values()]
        .filter((l) => l.id.startsWith(`${key}-`))
        .map((l) => l.layout?.visibility ?? "visible");
    expect(new Set(hidden("5"))).toEqual(new Set(["none"]));
    expect(new Set(hidden("6"))).toEqual(new Set(["visible"]));
  });

  it("collapsing a legend sends legend_expanded false; a group's visibility its own PATCH", async () => {
    const { result } = setup("edit");
    await waitFor(() => expect(result.current.map.map).toBeDefined());
    await act(async () => {
      await result.current.tree.onLayerStateChange(5, { legend_expanded: false });
      await result.current.tree.onGroupStateChange(9, { visible: false });
    });
    expect(
      patches().map(([url, init]) => [String(url).replace(/^.*\/project\/[^/]+/, ""), JSON.parse(init.body)])
    ).toEqual([
      ["/layer/5/map-state", { legend_expanded: false }],
      ["/group/9/map-state", { visible: false }],
    ]);
  });

  it("a viewer's changes are view state: no request, the rows in the store change", async () => {
    const published = publicMapLayers({
      layers: rows,
      map: body.map,
      styles: { "5": [style("s5")], "6": [style("s6")] },
    });
    const { result, store } = setup("public", published);
    await act(async () => {
      await result.current.tree.onLayerStateChange(5, { visible: false, legend_expanded: false });
      await result.current.tree.onGroupStateChange(9, { visible: false });
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const state = store.getState().layers;
    const drawn = foldVisibility(state.projectLayers as typeof published, state.projectLayerGroups);
    expect(drawn.map((l) => [l.id, l.visible, l.entry.legend?.expanded])).toEqual([
      [5, false, false],
      [6, false, undefined],
    ]);
  });

  it("an editor's time slider moves the map while dragging and writes time_value once released", async () => {
    const { result } = setup("edit");
    await waitFor(() => expect(result.current.map.map).toBeDefined());
    await act(async () => {
      await result.current.tree.onLayerTimeChange(5, 2016, false);
      await result.current.tree.onLayerTimeChange(5, 2017, false);
    });
    expect(patches()).toHaveLength(0);
    expect(joinMapLayers(rows, result.current.map.map)[0].entry?.time).toEqual({ value: 2017 });
    await act(async () => {
      await result.current.tree.onLayerTimeChange(5, 2018, true);
    });
    expect(patches().map(([, init]) => JSON.parse(init.body))).toEqual([{ time_value: 2018 }]);
    expect(joinMapLayers(rows, result.current.map.map)[0].entry?.time).toEqual({ value: 2018 });
  });

  it("a project viewer's changes stay on the page: the cached map changes, nothing is written", async () => {
    const { result } = setup("view");
    await waitFor(() => expect(result.current.map.map).toBeDefined());
    await act(async () => {
      await result.current.tree.onLayerStateChange(5, { visible: false });
      await result.current.tree.onGroupStateChange(9, { visible: false });
    });
    expect(patches()).toHaveLength(0);
    const drawn = joinMapLayers(rows, result.current.map.map);
    expect(drawn.map((l) => [l.id, l.visible])).toEqual([
      [5, false],
      [6, false],
    ]);
  });

  it("a project viewer's view state survives another component mounting the map", async () => {
    const store = configureStore({ reducer: { layers: layerReducer } });
    const cache = new Map();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
      </Provider>
    );
    const first = renderHook(
      () => ({ tree: useLayerTreeState(PROJECT, "view"), map: useProjectMap(PROJECT) }),
      { wrapper }
    );
    await waitFor(() => expect(first.result.current.map.map).toBeDefined());
    await act(async () => {
      await first.result.current.tree.onLayerStateChange(5, { visible: false });
    });
    const fetches = fetchMock.mock.calls.length;
    // A panel or dialog that reads the map mounts later in the same page.
    const { result } = renderHook(() => useProjectMap(PROJECT), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBe(fetches);
    expect(joinMapLayers(rows, result.current.map)[0].visible).toBe(false);
  });
});
