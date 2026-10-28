import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StyleRead } from "@/lib/api/map";
import { layerReducer } from "@/lib/store/layer/slice";
import { StyleStoresProvider } from "@/lib/style/editor/StyleStores";
import type { LayerStyle } from "@/lib/style/generated/types";
import { renderLayersOf } from "@/lib/style/render/viewLayers";
import type { StyleTransport } from "@/lib/style/save";

import { useLayerStyleChange } from "@/hooks/map/LayerStyleHooks";
import type { MapLayer } from "@/hooks/map/useMapLayers";

const { saves } = vi.hoisted(() => ({ saves: [] as Array<{ key: unknown; document: LayerStyle }> }));
vi.mock("@/lib/style/transports/core", () => ({
  createCoreTransport: (key: unknown): StyleTransport => ({
    save: async (body) => {
      saves.push({ key, document: body.document });
      return { ok: true, document: body.document, revision: 2, issues: [] };
    },
    load: () => new Promise(() => undefined),
  }),
}));
vi.mock("@/lib/api/fetcher", () => ({ renewAccessToken: async () => true }));

const FILL = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
const NIGHT = { version: 1, kind: "vector", symbol: { fill: { color: "#111111" } } } as LayerStyle;
const read = (id: string, name: string, document: LayerStyle): StyleRead => ({
  id,
  name,
  position: 0,
  revision: 1,
  document,
  issues: [],
  stale: false,
});
const published = [read("day", "Day", FILL), read("night", "Night", NIGHT)];
const layer = {
  id: 5,
  layer_id: "d5",
  name: "Districts",
  type: "feature",
  feature_layer_geometry_type: "polygon",
  visible: true,
  entry: { type: "layer", id: 5 },
  style: published[0],
  otherStyles: [{ id: "night", name: "Night" }],
  publishedStyles: published,
} as unknown as MapLayer;

function setup(viewOnly: boolean) {
  const store = configureStore({
    reducer: { layers: layerReducer },
    preloadedState: { layers: { projectLayers: [layer] } } as never,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <StyleStoresProvider>{children}</StyleStoresProvider>
      </SWRConfig>
    </Provider>
  );
  const hook = renderHook(() => useLayerStyleChange("p1", viewOnly), { wrapper });
  return { ...hook, store };
}

const row = (store: ReturnType<typeof setup>["store"]) =>
  store.getState().layers.projectLayers[0] as MapLayer;

describe("opacity and style choice on mobile and public maps", () => {
  beforeEach(() => {
    saves.length = 0;
    window.history.replaceState(null, "", "/map/public/p1");
  });

  it("a viewer's opacity is view state, applied to the style before compiling", () => {
    const { result, store } = setup(true);
    act(() => result.current.onOpacityChange(layer, 0.4));
    expect(saves).toHaveLength(0);
    const changed = row(store);
    expect(changed.opacity).toBe(0.4);
    const [before] = renderLayersOf([layer]);
    const [after] = renderLayersOf([changed]);
    expect(after.style.opacity).toBe(0.4);
    // A new version: the renderer compiles the layer again.
    expect(after.version).not.toBe(before.version);
  });

  it("an editor's opacity saves the layer's style through the page's stores", async () => {
    const { result } = setup(false);
    act(() => result.current.onOpacityChange(layer, 0.4));
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 });
    expect(saves[0].key).toEqual({ projectId: "p1", layerProjectId: 5, styleId: "day" });
    expect(saves[0].document).toMatchObject({ opacity: 0.4, symbol: { fill: { color: "#cccccc" } } });
  });

  it("a public viewer's style choice is view state and travels with the link", () => {
    const { result, store } = setup(true);
    expect(result.current.onStyleChange).toBeDefined();
    act(() => result.current.onStyleChange?.(layer, "night"));
    expect(row(store).style?.id).toBe("night");
    expect(row(store).style?.document).toEqual(NIGHT);
    expect(row(store).otherStyles).toEqual([{ id: "day", name: "Day" }]);
    expect(new URLSearchParams(window.location.search).get("styles")).toBe("5:night");
    // Editors switch styles in the style panel, which writes map state.
    expect(setup(false).result.current.onStyleChange).toBeUndefined();
  });
});
