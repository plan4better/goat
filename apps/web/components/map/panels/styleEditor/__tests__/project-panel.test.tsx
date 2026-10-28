import { configureStore } from "@reduxjs/toolkit";
import { act, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { layerReducer } from "@/lib/store/layer/slice";
import { mapReducer } from "@/lib/store/map/slice";
import { StyleStoresProvider, useStyleStores } from "@/lib/style/editor/StyleStores";
import type { StyleStoreRegistry } from "@/lib/style/editor/registry";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { SaveResult, StyleTransport } from "@/lib/style/save";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { ProjectStylePanel } from "@/components/map/panels/styleEditor/ProjectStylePanel";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";

import { renderWithProviders } from "./renderPanel";

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
vi.mock("@/hooks/style/useStyleData", () => ({ useStyleData: () => EMPTY_DATA }));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({}) }));

const DOC = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } } as LayerStyle;
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

function renderProjectPanel() {
  const store = configureStore({ reducer: { map: mapReducer, layers: layerReducer } });
  return renderWithProviders(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <StyleStoresProvider>
          <Registry />
          <ProjectStylePanel projectId="p1" layer={layer} />
        </StyleStoresProvider>
      </SWRConfig>
    </Provider>
  );
}

describe("the style panel on the project page", () => {
  beforeEach(() => {
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
});
