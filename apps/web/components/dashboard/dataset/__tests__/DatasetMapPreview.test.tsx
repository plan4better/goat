import { configureStore } from "@reduxjs/toolkit";
import { render, screen } from "@testing-library/react";
import { MapProvider } from "react-map-gl/maplibre";
import { Provider } from "react-redux";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mapReducer } from "@/lib/store/map/slice";
import type { LayerStyle } from "@/lib/style/generated/types";
import { fromPopupConfig, popupConfigOf } from "@/lib/style/popup";
import type { ViewLayer } from "@/lib/style/render/viewLayers";
import type { Layer, PopupProperties } from "@/lib/validations/layer";

import DatasetMapPreview from "@/components/dashboard/dataset/DatasetMapPreview";

const { recorded, dispatchMock } = vi.hoisted(() => ({
  recorded: {
    layers: [] as ViewLayer[],
    slotLayers: [] as ViewLayer[],
    activeFeatureMarker: undefined as boolean | undefined,
  },
  dispatchMock: vi.fn(),
}));

/** The dataset's default style: a marker for features, an image for rasters. */
vi.mock("@/lib/api/map", () => ({
  useDatasetStyle: (layerId?: string | null) => ({
    style: layerId
      ? {
          id: "s1",
          name: "Default",
          position: 0,
          revision: 1,
          document: layerId.startsWith("raster")
            ? { version: 1, kind: "raster", render: { type: "image" } }
            : { version: 1, kind: "vector", symbol: { marker: {} } },
          issues: [],
          stale: false,
        }
      : undefined,
  }),
}));

vi.mock("@/components/map/MapViewer", () => ({
  default: ({
    layers,
    children,
    activeFeatureMarker,
  }: {
    layers: ViewLayer[];
    children?: React.ReactNode;
    activeFeatureMarker?: boolean;
  }) => {
    recorded.layers = layers;
    recorded.activeFeatureMarker = activeFeatureMarker;
    return <div data-testid="map-viewer">{children}</div>;
  },
}));

vi.mock("@/components/map/popover/MapFixedPopupSlot", () => ({
  MapFixedPopupSlot: ({ layers }: { layers: ViewLayer[] }) => {
    recorded.slotLayers = layers;
    return <div data-testid="fixed-popup-slot" />;
  },
}));

vi.mock("@/components/dashboard/common/DetailMapAttribution", () => ({
  default: () => <div data-testid="attribution" />,
}));

vi.mock("@/hooks/store/ContextHooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/store/ContextHooks")>()),
  useAppDispatch: () => dispatchMock,
}));

vi.mock("@/hooks/map/CommonHooks", () => ({
  default: () => ({
    layerFields: [
      { name: "name", type: "string" },
      { name: "capacity", type: "number" },
    ],
    isLoading: false,
  }),
}));

const datasetOf = (type: Layer["type"]): Layer =>
  ({
    id: type === "raster" ? "raster-1" : "layer-1",
    name: "Bus stops",
    type,
    feature_layer_geometry_type: "point",
    extent: "POLYGON((0 0,0 1,1 1,1 0,0 0))",
    properties: {},
  }) as unknown as Layer;

/** The popup the map shows for the layer: its style's, in today's configuration. */
const popupOf = (): Record<string, unknown> | undefined =>
  popupConfigOf(recorded.layers[0]?.style?.document) as Record<string, unknown> | undefined;

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

beforeEach(() => {
  recorded.layers = [];
  recorded.slotLayers = [];
  dispatchMock.mockClear();
});

describe("DatasetMapPreview", () => {
  it("gives a feature layer the pinned hover-and-click panel", () => {
    render(<DatasetMapPreview dataset={datasetOf("feature")} />);

    const popup = popupOf() as Record<string, unknown>;
    expect(popup.trigger).toBe("click_and_hover");
    expect(popup.layout).toBe("pinned");
    expect(popup.anchor).toBe("top_right");
    expect(popup.highlight_active_feature).toBe(true);
    // The highlight alone marks the feature; no pulse or dot on top of it.
    expect(recorded.activeFeatureMarker).toBe(false);
    // The fields in order; their types come from the dataset when the popover draws them (spec 7.4).
    const blocks = popup.blocks as { attributes: { name: string }[] }[];
    expect(blocks[0].attributes.map((a) => a.name)).toEqual(["name", "capacity"]);
  });

  it("mounts the host that draws a pinned panel, on the same layer the map gets", () => {
    render(<DatasetMapPreview dataset={datasetOf("feature")} />);

    expect(screen.getByTestId("fixed-popup-slot")).toBeInTheDocument();
    expect(recorded.slotLayers[0]).toBe(recorded.layers[0]);
  });

  it("keeps the map visible and leaves a raster without a feature panel", () => {
    render(<DatasetMapPreview dataset={datasetOf("raster")} />);

    expect(recorded.layers[0]?.visible).toBe(true);
    // No detail panel goes into a raster's style.
    expect((recorded.layers[0]?.style?.document as { popup?: unknown }).popup).toBeUndefined();
  });

  it("clears the shared popup state when it goes away", () => {
    const { unmount } = render(<DatasetMapPreview dataset={datasetOf("feature")} />);
    dispatchMock.mockClear();

    unmount();

    const types = dispatchMock.mock.calls.map(([action]) => (action as { type: string }).type);
    expect(types).toContain("map/setPopupInfo");
    expect(types).toContain("map/setHighlightedFeature");
  });
});

describe("MapFixedPopupSlot on a dataset layer", () => {
  it("renders the feature panel the dataset map configures", async () => {
    const { MapFixedPopupSlot } = await vi.importActual<
      typeof import("@/components/map/popover/MapFixedPopupSlot")
    >("@/components/map/popover/MapFixedPopupSlot");

    const config = {
      enabled: true,
      trigger: "click_and_hover",
      mode: "simple",
      blocks: [
        {
          id: "6f0c2b1e-4d3a-4a8e-9c1b-2e7d5f8a9b10",
          type: "fieldList",
          layout: "table",
          attributes: [{ name: "name", type: "string" }],
          collapse_after: null,
        },
      ],
      html: "",
      layout: "pinned",
      anchor: "top_right",
      header: "none",
      highlight_active_feature: true,
      width: 300,
      max_height: 400,
    } as PopupProperties;
    const layerWithPopup: ViewLayer = {
      id: "layer-1",
      name: "Bus stops",
      visible: true,
      style: {
        document: { version: 1, kind: "vector", popup: fromPopupConfig(config, undefined) } as LayerStyle,
      },
    };

    const store = configureStore({
      reducer: { map: mapReducer },
      preloadedState: {
        map: {
          popupInfo: {
            title: "Bus stops",
            layerId: "layer-1",
            lngLat: [11.5, 48.1] as [number, number],
            featureProperties: { name: "Marienplatz" },
            properties: { name: "Marienplatz" },
            onClose: () => {},
          },
        },
      } as never,
      middleware: (getDefault) => getDefault({ serializableCheck: false }),
    });

    const { container } = render(
      <Provider store={store}>
        <MapProvider>
          <MapFixedPopupSlot layers={[layerWithPopup]} />
        </MapProvider>
      </Provider>
    );

    expect(container.querySelector(".goat-feature-popup")).not.toBeNull();
    expect(screen.getByText("Marienplatz")).toBeInTheDocument();
  });
});
