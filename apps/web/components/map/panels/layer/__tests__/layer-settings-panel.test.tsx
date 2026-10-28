import { configureStore } from "@reduxjs/toolkit";
import { screen, within } from "@testing-library/react";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import { layerReducer, setSelectedLayers } from "@/lib/store/layer/slice";
import { mapReducer, setActiveRightPanel } from "@/lib/store/map/slice";
import { StyleStoresProvider } from "@/lib/style/editor/StyleStores";
import type { LayerStyle } from "@/lib/style/generated/types";

import { MapSidebarItemID } from "@/types/map/common";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import LayerSettingsPanel from "@/components/map/panels/layer/LayerSettingsPanel";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";

import { renderWithProviders } from "../../styleEditor/__tests__/renderPanel";

vi.mock("@/lib/style/transports/core", () => ({
  createCoreTransport: () => ({
    save: async () => ({ ok: false }),
    load: () => new Promise(() => undefined),
  }),
}));
vi.mock("@/lib/api/fetcher", () => ({ renewAccessToken: async () => true }));
vi.mock("@/hooks/style/useStyleData", () => ({ useStyleData: () => EMPTY_DATA }));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({}) }));
vi.mock("@/components/map/panels/filter/Filter", () => ({ default: () => null }));
vi.mock("@/components/map/panels/properties/Properties", () => ({ default: () => null }));
vi.mock("@/lib/api/map", async (original) => ({
  ...(await original<object>()),
  useProjectMap: () => ({ setLayerState: async () => undefined, mutate: async () => undefined }),
}));

const DOC = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
const layer = {
  id: 5,
  layer_id: "dataset-5",
  name: "Districts",
  type: "feature",
  feature_layer_geometry_type: "polygon",
  visible: true,
  entry: { type: "layer", id: 5 },
  style: { id: "s5", name: "Density", position: 0, revision: 1, document: DOC, issues: [], stale: false },
  otherStyles: [{ id: "s6", name: "Plain" }],
} as unknown as MapLayer;

function renderPanel(shown: MapLayer = layer) {
  const store = configureStore({ reducer: { map: mapReducer, layers: layerReducer } });
  store.dispatch(setSelectedLayers([5]));
  store.dispatch(setActiveRightPanel(MapSidebarItemID.STYLE));
  return renderWithProviders(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <StyleStoresProvider>
          <LayerSettingsPanel projectId="p1" projectLayers={[shown]} />
        </StyleStoresProvider>
      </SWRConfig>
    </Provider>
  );
}

describe("the layer settings panel", () => {
  it("shows the layer's name once beside the close button; undo and redo sit with the style picker", async () => {
    renderPanel();
    expect(await screen.findAllByText("Districts")).toHaveLength(1);
    const header = screen.getByTestId("layer-settings-header");
    const pickerRow = (await screen.findByRole("button", { name: /Density/ })).parentElement
      ?.parentElement as HTMLElement;
    expect(within(pickerRow).getByRole("button", { name: "style_editor.undo" })).toBeDefined();
    expect(within(pickerRow).getByRole("button", { name: "style_editor.redo" })).toBeDefined();
    // The panel Container's header row holds the close button beside the layer's header.
    expect(within(header.parentElement as HTMLElement).getByRole("button", { name: "close" })).toBeDefined();
  });

  it("the style picker heads the style tab as a pill with the active style", async () => {
    renderPanel();
    const pill = await screen.findByRole("button", { name: /Density/ });
    const tabs = screen.getByRole("tablist");
    // Only the style changes with it: it sits in the style tab, under the tabs.
    expect(pill.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.getByTestId("style-panel-body").contains(pill)).toBe(true);
  });

  it("a table's header names no geometry or layer kind", async () => {
    renderPanel({ ...layer, type: "table", feature_layer_geometry_type: null } as unknown as MapLayer);
    const header = await screen.findByTestId("layer-settings-header");
    expect(within(header).getByText("Districts")).toBeDefined();
    expect(within(header).queryByText(/style_editor\.(kind|geometry)_/)).toBeNull();
  });

  it("the style body is transparent, so the floating panel's glass shows", async () => {
    renderPanel();
    const body = await screen.findByTestId("style-panel-body");
    expect(getComputedStyle(body).backgroundColor).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent|)$/);
  });
});
