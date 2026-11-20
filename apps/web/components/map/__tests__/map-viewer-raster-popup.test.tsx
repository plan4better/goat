// A raster file's popup (spec 9.7) in the map: a click on the file opens the popup with the cell values under it, in
// a window of any width. Only a layout that shows popups in its own drawer (the published map on a phone) leaves the
// map with the marker alone. The popup asks for no fields: geoapi has none for a file, and its labels are in the map's
// language.
import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { fetchRasterPoint } from "@/lib/api/rasters";
import { featureEditorReducer } from "@/lib/store/featureEditor/slice";
import { mapReducer } from "@/lib/store/map/slice";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { ViewLayer } from "@/lib/style/render/viewLayers";

import MapViewer from "@/components/map/MapViewer";

const { recorded } = vi.hoisted(() => ({
  recorded: { map: {} as Record<string, unknown>, requests: [] as string[] },
}));

vi.mock("react-map-gl/maplibre", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Map: (props: Record<string, unknown> & { children?: ReactNode }) => {
    recorded.map = props;
    return <div>{props.children}</div>;
  },
  Popup: ({ children }: { children?: ReactNode }) => <div data-testid="map-popup">{children}</div>,
  Source: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Layer: ({ id }: { id: string }) => <div data-testid={`map-layer-${id}`} />,
  useMap: () => ({ current: undefined }),
}));
vi.mock("@/hooks/map/useScene", () => ({ useScene: () => null }));
vi.mock("@/hooks/map/useFeatureEditor", () => ({ useFeatureEditor: () => ({}) }));
vi.mock("@/hooks/map/useRenderLayers", () => ({ useRenderLayers: () => [] }));
vi.mock("@/components/map/StyledLayers", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  StyledLayers: () => null,
}));
vi.mock("@/components/map/controls/Draw", () => ({ default: () => null }));
vi.mock("@/components/map/GeocoderLayer", () => ({ default: () => null }));
vi.mock("@/components/map/UserLocationLayer", () => ({ default: () => null }));
vi.mock("@/components/map/ToolboxLayers", () => ({ default: () => null }));
vi.mock("@/components/map/FilterAreaLayer", () => ({ default: () => null }));
vi.mock("@/components/explorer/ExplorerMapLayers", () => ({ ExplorerMapLayers: () => null }));
vi.mock("@/components/map/controls/measure", () => ({ MeasureLabels: () => null }));
// Every request the map sends to the services; each answers 404, as geoapi does for a raster file's queryables.
vi.mock("@/lib/api/fetcher", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetcher: async (key: string | [string, ...unknown[]]) => {
    recorded.requests.push(Array.isArray(key) ? key[0] : key);
    throw Object.assign(new Error("Not Found"), { status: 404 });
  },
  apiRequestAuth: async (url: string) => {
    recorded.requests.push(url);
    return { ok: false, status: 404, json: async () => ({ detail: "Not Found" }) };
  },
}));
vi.mock("@/lib/api/rasters", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchRasterPoint: vi.fn(async () => ({ values: [39.164505], styled: null })),
}));

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
  recorded.map = {};
  recorded.requests = [];
  vi.mocked(fetchRasterPoint).mockClear();
});

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

/** A window narrower than MUI's `md` breakpoint (900 px): every `max-width` media query matches. */
const narrowWindow = () => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

/** A remote float COG drawn as a ramp, with the default popup (none set: on click). */
const dem: ViewLayer = {
  id: 81551,
  layer_id: "94807223-51d7-4bd4-933f-201d0af78ed4",
  name: "Copernicus DEM Berlin",
  type: "raster",
  data_type: "cog",
  url: "https://files.example/dem.tif",
  visible: true,
  style: {
    id: "s1",
    document: {
      version: 1,
      kind: "raster",
      render: { type: "continuous", domain: [32, 119], palette: "colorbrewer:OrRd", reverse: true },
      opacity: 0.8,
    } as unknown as LayerStyle,
  },
};

const fakeMap = {
  getZoom: () => 12,
  isStyleLoaded: () => false,
  on: () => undefined,
  off: () => undefined,
  once: () => undefined,
  getLayer: () => undefined,
  getStyle: () => ({ layers: [] }),
  queryRenderedFeatures: () => [],
};

const viewer = (
  props: Partial<React.ComponentProps<typeof MapViewer>> = {},
  language: "en" | "de" = "en"
) => {
  const store = configureStore({ reducer: { map: mapReducer, featureEditor: featureEditorReducer } });
  const mapRef = { current: { getMap: () => fakeMap } };
  render(
    <I18nextProvider i18n={commonI18n(language)}>
      <ThemeProvider theme={createTheme()}>
        <Provider store={store}>
          <SWRConfig value={{ provider: () => new Map() }}>
            <MapViewer
              mapRef={mapRef as never}
              layers={[dem]}
              mapStyle="https://tiles.example/style.json"
              mode="2d"
              {...props}
            />
          </SWRConfig>
        </Provider>
      </ThemeProvider>
    </I18nextProvider>
  );
  return store;
};

/** Clicks the map over the file and waits for the click's popup state. */
const clickTheFile = async (store: ReturnType<typeof viewer>) => {
  const onClick = recorded.map.onClick as (e: unknown) => void;
  await act(async () => {
    onClick({ features: [], point: { x: 10, y: 10 }, lngLat: { lng: 13.4, lat: 52.52 } });
  });
  expect(fetchRasterPoint).toHaveBeenCalledWith(dem.layer_id, { lng: 13.4, lat: 52.52 }, undefined);
  await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
};

describe("MapViewer raster popup", () => {
  it("a click on a COG layer opens its popup with the cell value", async () => {
    const store = viewer();
    await clickTheFile(store);
    // The click marker and the popup with the value.
    expect(screen.getByTestId("map-layer-popup-active-feature-pulse")).toBeInTheDocument();
    const popup = await screen.findByTestId("map-popup");
    expect(popup.textContent).toContain("Band 1");
    expect(popup.textContent).toContain("39.164505");
  });

  it("a raster popup asks for no queryables and no feature count", async () => {
    const store = viewer();
    await clickTheFile(store);
    expect((await screen.findByTestId("map-popup")).textContent).toContain("39.164505");
    expect(recorded.requests.filter((url) => /\/queryables|\/processes\/feature-count\//.test(url))).toEqual(
      []
    );
  });

  it("a German map's popup shows no English label", async () => {
    // A band formula without a name: its value is labeled "Value", in German "Wert".
    const formula: ViewLayer = {
      ...dem,
      style: {
        id: "s2",
        document: {
          version: 1,
          kind: "raster",
          render: {
            type: "continuous",
            band: { expression: "b1 / 2" },
            palette: "goat:green",
            domain: [0, 60],
          },
        } as unknown as LayerStyle,
      },
    };
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [39.164505], styled: 19.58 });
    const store = viewer({ layers: [formula] }, "de");
    const onClick = recorded.map.onClick as (e: unknown) => void;
    await act(async () => {
      onClick({ features: [], point: { x: 10, y: 10 }, lngLat: { lng: 13.4, lat: 52.52 } });
    });
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    const popup = await screen.findByTestId("map-popup");
    expect(popup.textContent).toContain("Wert");
    expect(popup.textContent).not.toContain("Value");
  });

  it("in a window narrower than 900 px the map still opens the popup", async () => {
    // MapViewer reads no window width: only its host says when a drawer shows the popup. A narrow window here keeps a
    // width check from coming back (the editor has no drawer, so it would hide every popup).
    narrowWindow();
    const store = viewer();
    await clickTheFile(store);
    expect(screen.getByTestId("map-layer-popup-active-feature-pulse")).toBeInTheDocument();
    const popup = await screen.findByTestId("map-popup");
    expect(popup.textContent).toContain("Band 1");
  });

  it("a layout that shows the popup in its own drawer gets the marker only", async () => {
    narrowWindow();
    const store = viewer({ popupInDrawer: true });
    await clickTheFile(store);
    expect(screen.getByTestId("map-layer-popup-active-feature-pulse")).toBeInTheDocument();
    expect(screen.queryByTestId("map-popup")).toBeNull();
  });
});
