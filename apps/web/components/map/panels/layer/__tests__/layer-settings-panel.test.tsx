import { configureStore } from "@reduxjs/toolkit";
import { act, screen, waitFor, within } from "@testing-library/react";
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

import { layerSwatchIcon } from "@/components/map/legend/StyleLegend";
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
// Each layer icon drawn from a layer's style, with the geometry it is drawn as.
const { swatches } = vi.hoisted(() => ({ swatches: [] as Array<{ document: unknown; geometry: string }> }));
vi.mock("@/lib/style/legend", async (original) => {
  const legend = await original<typeof import("@/lib/style/legend")>();
  return {
    ...legend,
    iconSwatch: (
      document: Parameters<typeof legend.iconSwatch>[0],
      ctx: Parameters<typeof legend.iconSwatch>[1]
    ) => {
      swatches.push({ document, geometry: ctx.geometry });
      return legend.iconSwatch(document, ctx);
    },
  };
});
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({}) }));
// The filter tab shows whether it is told it is on screen: its popovers close and its area leaves the map when not.
vi.mock("@/components/map/panels/filter/LayerFilterPanel", () => ({
  default: ({ visible = true }: { visible?: boolean }) => (
    <div data-testid="filter-tab" data-visible={String(visible)} />
  ),
}));
// The metadata tab shows what it is told about the edit right: an editor sees a layer's address whole.
vi.mock("@/components/map/panels/properties/Properties", () => ({
  default: ({ canEdit }: { canEdit?: boolean }) => (
    <div data-testid="metadata-tab" data-can-edit={String(canEdit)} />
  ),
}));
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

function renderPanel(shown: MapLayer = layer, { others = [] as MapLayer[], registry = true } = {}) {
  const store = configureStore({ reducer: { map: mapReducer, layers: layerReducer } });
  store.dispatch(setSelectedLayers([5]));
  store.dispatch(setActiveRightPanel(MapSidebarItemID.STYLE));
  const panel = <LayerSettingsPanel projectId="p1" projectLayers={[shown, ...others]} />;
  const result = renderWithProviders(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map() }}>
        {registry ? <StyleStoresProvider>{panel}</StyleStoresProvider> : panel}
      </SWRConfig>
    </Provider>
  );
  return { ...result, store };
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

  it("a catchment polygon layer's header shows its area swatch, as the layer list draws it", async () => {
    const catchment = {
      version: "1.0.0",
      kind: "vector",
      symbol: { fill: { color: "#78c679", opacity: 0.8 }, outline: false },
      classify: [
        {
          field: "travel_cost",
          method: "categories",
          classes: [
            { id: "c1", values: [5], fill: { color: "#006837" } },
            { id: "c2", values: [10], fill: { color: "#ffffcc" } },
          ],
        },
      ],
    } as unknown as LayerStyle;
    renderPanel({
      ...layer,
      name: "Catchment area",
      style: { ...layer.style, document: catchment },
    } as unknown as MapLayer);
    const header = await screen.findByTestId("layer-settings-header");
    await waitFor(() => expect(header.querySelector("svg rect")).not.toBeNull());
    const shared = renderWithProviders(
      <>{layerSwatchIcon({ style: { document: catchment }, feature_layer_geometry_type: "polygon" })}</>
    );
    const area = header.querySelector("svg rect:not([data-checker-under])");
    expect(area?.getAttribute("fill-opacity")).toBe("0.8");
    expect(area?.getAttribute("stroke")).toBe("none");
    // Its classes' colors side by side, as the map draws the areas.
    expect(header.querySelector("[data-stripes]")?.getAttribute("data-stripes")).toBe("#006837 #ffffcc");
    // The same drawing; only the ids of its gradient differ between the two renders.
    const withoutIds = (svg: Element | null | undefined) => svg?.outerHTML.replace(/_r_\w+_/g, "id");
    expect(withoutIds(header.querySelector("svg"))).toBe(withoutIds(shared.container.querySelector("svg")));
  });

  it("switching to a line layer never draws the polygon layer's style as its swatch", async () => {
    const line = {
      ...layer,
      id: 7,
      layer_id: "dataset-7",
      name: "Roads",
      feature_layer_geometry_type: "line",
      entry: { type: "layer", id: 7 },
      style: {
        ...layer.style,
        id: "s7",
        document: { version: "1.0.0", kind: "vector", symbol: { line: { color: "#ff0000" } } },
      },
    } as unknown as MapLayer;
    const { store } = renderPanel(layer, { others: [line] });
    const header = await screen.findByTestId("layer-settings-header");
    await waitFor(() => expect(header.querySelector("svg rect")).not.toBeNull());
    swatches.length = 0;
    act(() => {
      store.dispatch(setSelectedLayers([7]));
    });
    const drawnAsLine = swatches.filter((s) => s.geometry === "line");
    // From the first render after the switch on, a line swatch draws the line layer's style.
    expect(drawnAsLine.length).toBeGreaterThan(0);
    for (const { document } of drawnAsLine)
      expect((document as { symbol: Record<string, unknown> }).symbol).toEqual({
        line: { color: "#ff0000" },
      });
    expect(within(screen.getByTestId("layer-settings-header")).getByText("Roads")).toBeDefined();
  });

  it("a vector layer's header shows its swatch from its stored style before its store is there", async () => {
    // Without the page's store registry the panel never gets a store.
    renderPanel(layer, { registry: false });
    const header = await screen.findByTestId("layer-settings-header");
    expect(header.querySelector("svg rect:not([data-checker-under])")?.getAttribute("fill")).toBe("#cccccc");
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
    // The table icon, as the layer list shows it: no swatch and no raster icon.
    expect(header.querySelector("svg path")).not.toBeNull();
    expect(header.querySelector("svg rect")).toBeNull();
    expect(within(header).queryByTestId("raster-layer-icon")).toBeNull();
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
      const header = await screen.findByTestId("layer-settings-header");
      expect(requested.filter((url) => url.includes("/feature-count/"))).toEqual([]);
      // The raster icon, as the layer list shows it.
      expect(within(header).getByTestId("raster-layer-icon")).toBeDefined();
      unmount();
    }
  });

  it("a table asks for no feature count: its header shows none", async () => {
    renderPanel({ ...layer, type: "table", feature_layer_geometry_type: null } as unknown as MapLayer);
    await screen.findByTestId("filter-tab");
    expect(requested.filter((url) => url.includes("/feature-count/"))).toEqual([]);
  });

  it("tells the metadata tab whether the user may edit the dataset", async () => {
    // The project's owner (u1) is signed in: the dataset is theirs, or someone else's they may not edit.
    for (const [owner, canEdit] of [
      ["u1", "true"],
      ["u2", "false"],
    ]) {
      const { unmount } = renderPanel({
        ...layer,
        type: "raster",
        data_type: "cog",
        url: "https://files.example/dem.tif?sig=x",
        user_id: owner,
        feature_layer_geometry_type: null,
        style: null,
      } as unknown as MapLayer);
      await userEvent.click(await screen.findByRole("tab", { name: "metadata.title" }));
      expect((await screen.findByTestId("metadata-tab")).dataset.canEdit).toBe(canEdit);
      unmount();
    }
  });

  it("a table's filter tab knows it is off screen once its metadata is open", async () => {
    renderPanel({ ...layer, type: "table", feature_layer_geometry_type: null } as unknown as MapLayer);
    expect((await screen.findByTestId("filter-tab")).dataset.visible).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "metadata.title" }));
    expect(screen.getByTestId("filter-tab").dataset.visible).toBe("false");
  });
});
