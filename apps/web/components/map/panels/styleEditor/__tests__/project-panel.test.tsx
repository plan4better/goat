import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { layerReducer } from "@/lib/store/layer/slice";
import { mapReducer } from "@/lib/store/map/slice";
import { StyleStoresProvider, useStyleStores } from "@/lib/style/editor/StyleStores";
import type { StyleStoreRegistry } from "@/lib/style/editor/registry";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterInfo } from "@/lib/style/raster/metadata";
import type { SaveResult, StyleTransport } from "@/lib/style/save";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { ProjectStylePanel } from "@/components/map/panels/styleEditor/ProjectStylePanel";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";

import { choose, i18n, renderWithProviders } from "./renderPanel";

const { transports } = vi.hoisted(() => ({ transports: [] as StyleTransport[] }));
let loadAnswer: Promise<Awaited<ReturnType<StyleTransport["load"]>>>;
let saveAnswer: (body: { document: LayerStyle }) => Promise<SaveResult>;
vi.mock("@/lib/style/transports/core", () => ({
  createCoreTransport: () => {
    const transport: StyleTransport = { save: (body) => saveAnswer(body), load: () => loadAnswer };
    transports.push(transport);
    return transport;
  },
}));
vi.mock("@/lib/api/fetcher", () => ({ renewAccessToken: async () => true }));
const { styleData } = vi.hoisted(() => ({ styleData: vi.fn() }));
vi.mock("@/hooks/style/useStyleData", () => ({ useStyleData: styleData }));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({}) }));
const { setLayerState } = vi.hoisted(() => ({ setLayerState: vi.fn(async () => undefined) }));
vi.mock("@/lib/api/map", async (original) => ({
  ...(await original<object>()),
  useProjectMap: () => ({ setLayerState }),
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
  style: { id: "s5", name: "Default", position: 0, revision: 1, document: DOC, issues: [], stale: false },
  otherStyles: [],
} as unknown as MapLayer;

let registry: StyleStoreRegistry | null = null;
function Registry() {
  registry = useStyleStores();
  return null;
}

function renderProjectPanel(shown: MapLayer = layer) {
  const store = configureStore({ reducer: { map: mapReducer, layers: layerReducer } });
  return renderWithProviders(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <StyleStoresProvider>
          <Registry />
          <ProjectStylePanel projectId="p1" layer={shown} />
        </StyleStoresProvider>
      </SWRConfig>
    </Provider>
  );
}

describe("the style panel on the project page", () => {
  beforeEach(() => {
    styleData.mockImplementation(() => EMPTY_DATA);
    transports.length = 0;
    loadAnswer = new Promise(() => undefined);
    saveAnswer = async (body) => ({ ok: true, document: body.document, revision: 2, issues: [] });
  });

  it("the panel is interactive before the opening check answers", async () => {
    const { container } = renderProjectPanel();
    expect(await screen.findByTestId("style-panel-body")).toBeDefined();
    expect(container.querySelector("[data-style-panel]")).not.toBeNull();
    // The sections are there, with the stored document, while the check is still out.
    expect(screen.getAllByRole("button").length).toBeGreaterThan(3);
  });

  it("the opening check's issues appear and a recomputed document merges", async () => {
    let answer: (value: Awaited<ReturnType<StyleTransport["load"]>>) => void = () => undefined;
    loadAnswer = new Promise((resolve) => {
      answer = resolve;
    });
    renderProjectPanel();
    await screen.findByTestId("style-panel-body");
    // An edit made while the check is out stays on top of what the check answers.
    const store = registry?.get({ projectId: "p1", layerProjectId: 5, styleId: "s5" });
    act(() => store?.set("symbol.fill.color", "#ff0000"));
    const recomputed = { ...DOC, opacity: 0.5 } as LayerStyle;
    await act(async () =>
      answer({
        document: recomputed,
        revision: 3,
        issues: [
          {
            level: "damaged",
            code: "field_missing",
            path: "/classify/0/field",
            message: "Field density is gone.",
          },
        ],
      })
    );
    expect(await screen.findByText("style_editor.damaged_notice")).toBeDefined();
    expect(screen.getByText("Field density is gone.")).toBeDefined();
    expect(store?.document).toMatchObject({ opacity: 0.5, symbol: { fill: { color: "#ff0000" } } });
  });

  it("a 403 shows the read-only notice", async () => {
    saveAnswer = async () => ({ ok: false, status: 403 });
    renderProjectPanel();
    await screen.findByTestId("style-panel-body");
    // An edit in the panel's store, which the page's registry holds under the layer's style.
    const store = registry?.get({ projectId: "p1", layerProjectId: 5, styleId: "s5" });
    expect(store).toBeDefined();
    act(() => store?.set("opacity", 0.4));
    await waitFor(() => expect(screen.getByText("style_editor.stopped_forbidden")).toBeDefined(), {
      timeout: 3000,
    });
  });
  it("a raster file's info is asked for the class breaks of the band the edited style colors", async () => {
    const dem = {
      ...layer,
      id: 6,
      layer_id: "dataset-6",
      type: "raster",
      data_type: "cog",
      url: "https://files.example/dem.tif",
      feature_layer_geometry_type: null,
      style: {
        ...layer.style,
        id: "s6",
        document: {
          version: "1.0.0",
          kind: "raster",
          render: { type: "continuous", palette: "goat:elevation", band: 2 },
        } as LayerStyle,
      },
    } as unknown as MapLayer;
    renderProjectPanel(dem);
    await waitFor(() =>
      expect(styleData).toHaveBeenLastCalledWith(expect.objectContaining({ id: "dataset-6", breaksBand: 2 }))
    );
    // The band changed in the panel: the info is asked for the new band's breaks.
    const store = registry?.get({ projectId: "p1", layerProjectId: 6, styleId: "s6" });
    act(() => store?.set("render.band", 3));
    await waitFor(() =>
      expect(styleData).toHaveBeenLastCalledWith(expect.objectContaining({ breaksBand: 3 }))
    );
    // The edit's save is answered while the page is there.
    await waitFor(() => expect(store?.saver.pending).toBe(false), { timeout: 3000 });
  });

  it("a hillshade's info is asked for the band its colors classify, or for its formula", async () => {
    const shaded = (id: number, render: Record<string, unknown>) =>
      ({
        ...layer,
        id,
        layer_id: `dataset-${id}`,
        type: "raster",
        data_type: "cog",
        url: "https://files.example/dem.tif",
        feature_layer_geometry_type: null,
        style: {
          ...layer.style,
          id: `s${id}`,
          document: { version: "1.0.0", kind: "raster", render: { type: "hillshade", ...render } },
        },
      }) as unknown as MapLayer;
    const colored = renderProjectPanel(
      shaded(7, { band: 2, palette: "goat:elevation", classify: { method: "quantile", count: 5 } })
    );
    await waitFor(() =>
      expect(styleData).toHaveBeenLastCalledWith(expect.objectContaining({ id: "dataset-7", breaksBand: 2 }))
    );
    colored.unmount();
    renderProjectPanel(shaded(8, { band: { name: "Slope", expression: "b1 - b2" } }));
    await waitFor(() =>
      expect(styleData).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "dataset-8", breaksBand: "b1 - b2" })
      )
    );
  });

  describe("another raster layer or named style in the open panel", () => {
    const band = (index: number) => ({ index, min: 0, max: 100, p2: 0, p98: 100, values: null });
    const FOUR: RasterInfo = {
      bands: 4,
      bits: [16, 16, 16, 16],
      colorTable: false,
      integer: true,
      names: ["", "", "", ""],
      stats: [1, 2, 3, 4].map(band),
    };
    const raster = (id: number, render: Record<string, unknown>, styleId = `s${id}`, position?: string) =>
      ({
        ...layer,
        id,
        layer_id: `dataset-${id}`,
        name: `Raster ${id}`,
        type: "raster",
        data_type: "cog",
        url: `https://files.example/${id}.tif`,
        feature_layer_geometry_type: null,
        entry: { type: "layer", id, ...(position ? { position } : {}) },
        style: {
          ...layer.style,
          id: styleId,
          document: { version: "1.0.0", kind: "raster", render } as unknown as LayerStyle,
        },
      }) as unknown as MapLayer;
    /** The page with the panel open: `shown` is the layer picked in the layer list, the panel stays mounted. */
    function openPanel(first: MapLayer) {
      const redux = configureStore({ reducer: { map: mapReducer, layers: layerReducer } });
      const cache = new Map();
      const tree = (shown: MapLayer) => (
        <I18nextProvider i18n={i18n}>
          <ThemeProvider theme={createTheme()}>
            <Provider store={redux}>
              <SWRConfig value={{ provider: () => cache }}>
                <StyleStoresProvider>
                  <Registry />
                  <ProjectStylePanel projectId="p1" layer={shown} />
                </StyleStoresProvider>
              </SWRConfig>
            </Provider>
          </ThemeProvider>
        </I18nextProvider>
      );
      const view = render(tree(first));
      return { show: (next: MapLayer) => act(async () => view.rerender(tree(next))) };
    }
    const rasterData = (asked: { id: string }) => ({
      ...EMPTY_DATA,
      layerId: asked.id,
      raster: { dataset: asked.id, info: FOUR },
    });
    const row = (label: string) => screen.getByText(label).parentElement as HTMLElement;

    beforeEach(() => {
      setLayerState.mockClear();
      styleData.mockImplementation(rasterData);
    });

    it("an index half picked on one layer is not shown on the next", async () => {
      const range = { type: "continuous", palette: "goat:elevation", domain: [0, 100] };
      const panel = openPanel(raster(21, range));
      await choose("style_editor.band", "style_editor.band_n", "NDVI");
      // One of its two input bands picked: nothing is written yet.
      await userEvent.click(within(row("style_editor.band_nir")).getByRole("combobox"));
      await userEvent.click(within(screen.getByRole("listbox")).getAllByRole("option")[3]);
      expect(screen.getByText("style_editor.band_red")).toBeDefined();
      await panel.show(raster(22, range));
      await waitFor(() =>
        expect(within(row("style_editor.band")).getByRole("combobox").textContent).toBe("style_editor.band_n")
      );
      expect(screen.queryByText("style_editor.band_nir")).toBeNull();
      expect(screen.queryByText("style_editor.band_red")).toBeNull();
      expect(registry?.get({ projectId: "p1", layerProjectId: 22, styleId: "s22" })?.get("render.band")).toBe(
        undefined
      );
      // The same for another named style of one layer.
      await choose("style_editor.band", "style_editor.band_n", "NDVI");
      expect(screen.getByText("style_editor.band_nir")).toBeDefined();
      await panel.show(raster(22, range, "other"));
      await waitFor(() =>
        expect(within(row("style_editor.band")).getByRole("combobox").textContent).toBe("style_editor.band_n")
      );
      expect(screen.queryByText("style_editor.band_nir")).toBeNull();
    });

    it("a file's info is never asked with the band or formula of the layer shown before", async () => {
      const formula = { name: "NDVI", expression: "(b4 - b3) / (b4 + b3)" };
      const panel = openPanel(raster(31, { type: "continuous", palette: "goat:green", band: formula }));
      await waitFor(() =>
        expect(styleData).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: "dataset-31", breaksBand: formula.expression })
        )
      );
      await panel.show(raster(32, { type: "continuous", palette: "goat:elevation", band: 2 }));
      await waitFor(() =>
        expect(styleData).toHaveBeenLastCalledWith(expect.objectContaining({ id: "dataset-32", breaksBand: 2 }))
      );
      const asked = styleData.mock.calls
        .map(([arg]) => arg as { id: string; breaksBand?: number | string })
        .filter((arg) => arg.id === "dataset-32")
        .map((arg) => arg.breaksBand);
      expect(new Set(asked)).toEqual(new Set([2]));
    });

    it("selecting a color range layer on top after an image layer leaves it where it is", async () => {
      const panel = openPanel(raster(41, { type: "image" }));
      await screen.findByText("style_editor.raster_type_image");
      await panel.show(raster(42, { type: "continuous", palette: "goat:elevation", domain: [0, 100] }));
      await waitFor(() =>
        expect(screen.getAllByText("style_editor.raster_type_continuous").length).toBeGreaterThan(0)
      );
      // A named style switch of one layer, an image to a hillshade and back.
      await panel.show(raster(43, { type: "image" }, "photo"));
      await screen.findByText("style_editor.raster_type_image");
      await panel.show(raster(43, { type: "hillshade" }, "relief"));
      await waitFor(() =>
        expect(screen.getAllByText("style_editor.raster_type_hillshade").length).toBeGreaterThan(0)
      );
      await panel.show(raster(43, { type: "image" }, "photo"));
      await screen.findByText("style_editor.raster_type_image");
      expect(setLayerState).not.toHaveBeenCalled();
      expect(screen.queryByText("style_editor.position_hides_labels")).toBeNull();
    });
  });
});
