import { configureStore } from "@reduxjs/toolkit";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const { requested } = vi.hoisted(() => ({ requested: [] as string[] }));
vi.mock("@/lib/api/fetcher", () => ({
  renewAccessToken: async () => true,
  // The processes requests the panel sends (the feature count).
  apiRequestAuth: async (url: string) => {
    requested.push(url);
    return { ok: true, json: async () => ({ count: 375 }) };
  },
}));
vi.mock("@/hooks/style/useStyleData", () => ({ useStyleData: () => EMPTY_DATA }));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({}) }));
// The filter tab shows whether it is told it is on screen: its popovers close and its area leaves the map when not.
vi.mock("@/components/map/panels/filter/LayerFilterPanel", () => ({
  default: ({ visible = true }: { visible?: boolean }) => (
    <div data-testid="filter-tab" data-visible={String(visible)} />
  ),
}));
vi.mock("@/components/map/panels/properties/Properties", () => ({ default: () => null }));
vi.mock("@/lib/api/projects", async (original) => ({
  ...(await original<object>()),
  useProject: () => ({ project: { owned_by: { id: "u1" }, my_role: "project-owner" } }),
}));
vi.mock("@/lib/api/users", async (original) => ({
  ...(await original<object>()),
  useUserProfile: () => ({ userProfile: { id: "u1" } }),
}));
vi.mock("@/lib/api/map", async (original) => ({
  ...(await original<object>()),
  useProjectMap: () => ({ setLayerState: async () => undefined, mutate: async () => undefined }),
}));

const DOC = { version: "1.0.0", kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
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

beforeEach(() => {
  requested.length = 0;
});

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

  it("a layer's filter tab knows it is off screen once another tab is open", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("tab", { name: "filter" }));
    expect(screen.getByTestId("filter-tab").dataset.visible).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "style" }));
    expect(screen.getByTestId("filter-tab").dataset.visible).toBe("false");
  });

  it("a vector layer's header counts its features", async () => {
    renderPanel();
    await waitFor(() => expect(requested.some((url) => url.includes("/feature-count/"))).toBe(true));
  });

  it("a raster layer asks for no feature count: a file or a map service has no features", async () => {
    for (const data_type of ["cog", "wms"]) {
      requested.length = 0;
      const { unmount } = renderPanel({
        ...layer,
        type: "raster",
        data_type,
        url: "https://files.example/dem.tif",
        feature_layer_geometry_type: null,
        style: null,
      } as unknown as MapLayer);
      await screen.findByTestId("layer-settings-header");
      expect(requested.filter((url) => url.includes("/feature-count/"))).toEqual([]);
      unmount();
    }
  });

  it("a table asks for no feature count: its header shows none", async () => {
    renderPanel({ ...layer, type: "table", feature_layer_geometry_type: null } as unknown as MapLayer);
    await screen.findByTestId("filter-tab");
    expect(requested.filter((url) => url.includes("/feature-count/"))).toEqual([]);
  });

  it("a table's filter tab knows it is off screen once its metadata is open", async () => {
    renderPanel({ ...layer, type: "table", feature_layer_geometry_type: null } as unknown as MapLayer);
    expect((await screen.findByTestId("filter-tab")).dataset.visible).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "metadata.title" }));
    expect(screen.getByTestId("filter-tab").dataset.visible).toBe("false");
  });
});
