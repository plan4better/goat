// A raster file's popup (spec 9.7) in the map: hovering reads the cell's value from the value tiles the map has
// loaded (no request); a click shows that value at once, then the exact value and every band from the raster
// service; the pointer shows over cells whose click opens a popup. The popup opens in a window of any width; only a
// layout that shows popups in its own drawer (the published map on a phone) leaves the map with the marker alone.
// The popup asks for no fields: geoapi has none for a file, and its labels are in the map's language.
import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { getFeature } from "@/lib/api/layers";
import {
  type RasterPoint,
  fetchRasterPoint,
  loadedRasterTileset,
  loadedRasterValues,
} from "@/lib/api/rasters";
import { featureEditorReducer } from "@/lib/store/featureEditor/slice";
import { mapReducer, setMapCursor, setPopupInfo } from "@/lib/store/map/slice";
import type { LayerStyle } from "@/lib/style/generated/types";
import { coverageUrl } from "@/lib/style/layerSource";
import { tilePixelAt, tileValueAt } from "@/lib/style/raster/tileValues";
import { type RasterValues, valueQuery, valueTilesUrl } from "@/lib/style/raster/values";
import { type ViewLayer, topFeature } from "@/lib/style/render/viewLayers";

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
  Popup: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div data-testid="map-popup" className={className}>
      {children}
    </div>
  ),
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
// A clustered layer's feature properties, asked of geoapi by the feature's id; a test may hold the answer.
vi.mock("@/lib/api/layers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/layers")>();
  return { ...actual, getFeature: vi.fn(actual.getFeature) };
});
vi.mock("@/lib/api/rasters", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchRasterPoint: vi.fn(async () => ({ values: [39.164505], styled: null })),
  loadedRasterValues: vi.fn(),
  loadedRasterTileset: vi.fn(),
}));
// Which layer's feature is under the pointer: the renderer's own lookup, but where a test gives a feature of its own.
vi.mock("@/lib/style/render/viewLayers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/style/render/viewLayers")>();
  return { ...actual, topFeature: vi.fn(actual.topFeature) };
});
// The value tiles the map loaded: the tile under the pointer and the cell's value on it.
vi.mock("@/lib/style/raster/tileValues", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tileUnder: vi.fn(() => ({ z: 12, x: 2200, y: 1343 })),
  tileValueAt: vi.fn(),
  tilePixelAt: vi.fn(),
}));

/** The DEM's value tiles: float codes of 1/8192. */
const VALUES: RasterValues = {
  encoding: { redFactor: 8, greenFactor: 256 / 8192, blueFactor: 1 / 8192, baseShift: -20 },
  range: [32, 119],
  integer: false,
  version: "v1",
  maxzoom: 14,
};

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
  canvas.style.cursor = "";
  vi.mocked(fetchRasterPoint)
    .mockReset()
    .mockResolvedValue({ values: [39.164505], styled: null });
  vi.mocked(loadedRasterValues).mockReset().mockReturnValue(VALUES);
  vi.mocked(tileValueAt).mockReset().mockResolvedValue(39.2);
  vi.mocked(tilePixelAt).mockReset().mockResolvedValue([200, 120, 40, 255]);
  vi.mocked(loadedRasterTileset).mockReset().mockReturnValue(undefined);
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
      version: "1.0.0",
      kind: "raster",
      render: { type: "continuous", domain: [32, 119], palette: "colorbrewer:OrRd", reverse: true },
      opacity: 0.8,
    } as unknown as LayerStyle,
  },
};

/** The DEM with `doc` merged into its style. */
const demWith = (doc: object): ViewLayer => ({
  ...dem,
  style: { id: "s2", document: { ...dem.style!.document, ...doc } as LayerStyle },
});

const image: ViewLayer = {
  ...dem,
  style: {
    id: "s3",
    document: {
      version: "1.0.0",
      kind: "raster",
      render: { type: "image" },
      popup: { trigger: "click_and_hover" },
    } as unknown as LayerStyle,
  },
};

const canvas = { style: { cursor: "" }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
/** The layers whose value tiles the map draws (StyledLayers puts them on the map as `src-<key>`). */
let drawn: ViewLayer[] = [];
const fakeMap = {
  getZoom: () => 12,
  isStyleLoaded: () => false,
  on: () => undefined,
  off: () => undefined,
  once: () => undefined,
  getLayer: () => undefined,
  getStyle: () => ({ layers: [] }),
  getCanvas: () => canvas,
  queryRenderedFeatures: () => [],
  unproject: ([x, y]: [number, number]) => ({ lng: 13.4 + x / 1000, lat: 52.52 - y / 1000 }),
  getSource: (id: string) => {
    const layer = drawn.find((l) => id === `src-${l.id}`);
    if (!layer) return undefined;
    // An image drawn with its color table draws its table band's value tiles (the band facts the map loaded).
    const query = valueQuery(layer.style!.document as never, vi.mocked(loadedRasterTileset)("")?.bands);
    return query
      ? { type: "raster-dem", tiles: [valueTilesUrl(coverageUrl(String(layer.layer_id)), query, VALUES)] }
      : // An image's colored tiles.
        {
          type: "raster",
          tiles: [`https://geoapi.test/collections/${layer.layer_id}/raster/tiles/{z}/{x}/{y}.webp?style=t`],
          tileSize: 512,
          minzoom: 0,
          maxzoom: 14,
        };
  },
};

const viewer = (
  props: Partial<React.ComponentProps<typeof MapViewer>> = {},
  language: "en" | "de" = "en"
) => {
  const store = configureStore({ reducer: { map: mapReducer, featureEditor: featureEditorReducer } });
  const mapRef = { current: { getMap: () => fakeMap } };
  drawn = props.layers ?? [dem];
  render(
    <I18nextProvider i18n={commonI18n(language)}>
      <ThemeProvider theme={createTheme()}>
        <Provider store={store}>
          <SWRConfig value={{ provider: () => new Map() }}>
            <MapViewer
              mapRef={mapRef as never}
              layers={[dem]}
              mapStyle="https://tiles.example/style.json"
              layerTone="light"
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

const here = { lng: 13.4, lat: 52.52 };
const click = async (lngLat = here) => {
  const onClick = recorded.map.onClick as (e: unknown) => void;
  await act(async () => {
    onClick({ features: [], point: { x: 10, y: 10 }, lngLat });
  });
};
const move = async (lngLat = here) => {
  const onMouseMove = recorded.map.onMouseMove as (e: unknown) => void;
  await act(async () => {
    onMouseMove({ features: [], point: { x: 10, y: 10 }, lngLat });
  });
};
/** The point query's next answers, held until the test gives them. */
const heldAnswers = () => {
  const answers: Array<(point: RasterPoint) => void> = [];
  vi.mocked(fetchRasterPoint).mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
  return answers;
};
const answer = async (give: (point: RasterPoint) => void, value: number) => {
  await act(async () => give({ values: [value, 7], styled: null }));
};
const popupText = () => screen.getByTestId("map-popup").textContent ?? "";

/** Clicks the map over the file and waits for the click's exact values. */
const clickTheFile = async (store: ReturnType<typeof viewer>) => {
  await click();
  await waitFor(() =>
    expect(fetchRasterPoint).toHaveBeenCalledWith(dem.layer_id, { lng: 13.4, lat: 52.52 }, undefined)
  );
  await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
};

describe("MapViewer raster popup", () => {
  it("a click on a COG layer opens its popup with the cell value", async () => {
    const store = viewer();
    await clickTheFile(store);
    // The click marker and the popup with the value.
    expect(screen.getByTestId("map-layer-popup-active-feature-pulse")).toBeInTheDocument();
    await waitFor(() => expect(popupText()).toContain("39.165"));
    expect(popupText()).toContain("Band 1");
  });

  it("the hover popup follows the pointer over cells of one value, and closes where none is known", async () => {
    // A classified file holds one value over wide areas (wind comfort classes 1 to 5).
    const store = viewer({ layers: [demWith({ popup: { trigger: "hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.lngLat).toEqual([here.lng, here.lat]));
    const shown = screen.getByTestId("map-popup");
    const next = { lng: 13.43, lat: 52.51 };
    await move(next);
    await waitFor(() => expect(store.getState().map.popupInfo?.lngLat).toEqual([next.lng, next.lat]));
    expect(popupText()).toContain("39.2");
    // One popup moved with the pointer, not a new one per move.
    expect(screen.getByTestId("map-popup")).toBe(shown);
    vi.mocked(tileValueAt).mockResolvedValueOnce(null);
    await move({ lng: 13.45, lat: 52.5 });
    await waitFor(() => expect(store.getState().map.popupInfo).toBeUndefined());
  });

  it("the popup shows the cell's color beside its value", async () => {
    const store = viewer({ layers: [demWith({ popup: { trigger: "hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    const swatch = screen.getByTestId("popup-swatch");
    // The DEM's reversed OrRd ramp at 39.2 m of 32 to 119 m: a dark red.
    expect(swatch.style.backgroundColor).toMatch(/^rgb\(/);
    expect(swatch.closest("tr")?.textContent).toContain("39.2");
  });

  it("a hover popup never stays at an old place while a slow read is on its way", async () => {
    // A tile not read yet (its first read, or the browser cache disabled): the read takes long.
    const store = viewer({ layers: [demWith({ popup: { trigger: "hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.lngLat).toEqual([here.lng, here.lat]));
    let answer: (value: number | null) => void = () => undefined;
    vi.mocked(tileValueAt).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await move({ lng: 13.43, lat: 52.51 });
    // The popup leaves the old place rather than show its value there.
    await waitFor(() => expect(store.getState().map.popupInfo).toBeUndefined());
    await act(async () => answer(40.5));
    await waitFor(() => expect(store.getState().map.popupInfo?.lngLat).toEqual([13.43, 52.51]));
    expect(popupText()).toContain("40.5");
  });

  it("the hover popup hides while the map moves and shows again on the next pointer move", async () => {
    const store = viewer({ layers: [demWith({ popup: { trigger: "click_and_hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    const onMoveStart = recorded.map.onMoveStart as (e: unknown) => void;
    const onMoveEnd = recorded.map.onMoveEnd as (e: unknown) => void;
    await act(async () => onMoveStart({}));
    expect(store.getState().map.popupInfo).toBeUndefined();
    // The pointer moves with the map while it pans: no popup, no read.
    vi.mocked(tileValueAt).mockClear();
    await move({ lng: 13.41, lat: 52.52 });
    expect(store.getState().map.popupInfo).toBeUndefined();
    expect(tileValueAt).not.toHaveBeenCalled();
    await act(async () => onMoveEnd({}));
    await move({ lng: 13.42, lat: 52.52 });
    await waitFor(() => expect(store.getState().map.popupInfo?.lngLat).toEqual([13.42, 52.52]));
    // A click's popup stays where it is.
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("click"));
    await act(async () => onMoveStart({}));
    expect(store.getState().map.popupInfo?.triggeredBy).toBe("click");
  });

  it("a hover popup closes when the pointer leaves the map; a click popup stays", async () => {
    // Onto a panel or control over the map: the map's canvas is left.
    const store = viewer({ layers: [demWith({ popup: { trigger: "click_and_hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    const onMouseOut = recorded.map.onMouseOut as (e: unknown) => void;
    await act(async () => onMouseOut({}));
    expect(store.getState().map.popupInfo).toBeUndefined();
    // A read still on its way when the pointer left opens nothing.
    let answer: (value: number | null) => void = () => undefined;
    vi.mocked(tileValueAt).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await move({ lng: 13.41, lat: 52.52 });
    await act(async () => onMouseOut({}));
    await act(async () => answer(40));
    expect(store.getState().map.popupInfo).toBeUndefined();
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("click"));
    await act(async () => onMouseOut({}));
    expect(store.getState().map.popupInfo?.triggeredBy).toBe("click");
  });

  it("no pointer while the map is dragged; after it, the pointer for what is under it", async () => {
    // MapLibre shows its grabbing cursor while the map is dragged, panned, rotated or tilted.
    const store = viewer();
    await move();
    await waitFor(() => expect(canvas.style.cursor).toBe("pointer"));
    const onMoveStart = recorded.map.onMoveStart as (e: unknown) => void;
    const onMoveEnd = recorded.map.onMoveEnd as (e: unknown) => void;
    await act(async () => onMoveStart({}));
    expect(canvas.style.cursor).toBe("");
    // Over a feature or a cell during the drag: still none of ours.
    const onMouseMove = recorded.map.onMouseMove as (e: unknown) => void;
    await act(async () => {
      onMouseMove({
        features: [{ id: 1, layer: { id: "x" }, properties: {} }],
        point: { x: 5, y: 5 },
        lngLat: here,
      });
    });
    expect(canvas.style.cursor).toBe("");
    // The drag ends over a cell with a value: the pointer, without a pointer move.
    await act(async () => onMoveEnd({ originalEvent: { clientX: 10, clientY: 10 } }));
    await waitFor(() => expect(canvas.style.cursor).toBe("pointer"));
    // A drawing or measuring tool keeps its own cursor.
    await act(async () => store.dispatch(setMapCursor("crosshair")));
    await move();
    expect(canvas.style.cursor).toBe("crosshair");
    await act(async () => (recorded.map.onMoveStart as (e: unknown) => void)({}));
    expect(canvas.style.cursor).toBe("crosshair");
  });

  it("a feature's hover popup takes the pointer, as before; moving into it does not close it", async () => {
    // Its buttons and links stay usable: only a raster's hover popup lets the pointer through.
    const road: ViewLayer = {
      id: 7,
      layer_id: "roads",
      name: "Roads",
      type: "feature",
      visible: true,
      style: {
        id: "s9",
        document: {
          version: "1.0.0",
          kind: "vector",
          popup: { trigger: "hover", blocks: [{ type: "field_list", attributes: [{ field: "name" }] }] },
        } as unknown as LayerStyle,
      },
    } as unknown as ViewLayer;
    const feature = { id: 1, layer: { id: "7-line" }, properties: { name: "A" }, geometry: null };
    const actual = await vi.importActual<typeof import("@/lib/style/render/viewLayers")>(
      "@/lib/style/render/viewLayers"
    );
    vi.mocked(topFeature).mockImplementation(((
      _map: unknown,
      features: Array<{ layer: { id: string } }> | undefined
    ) => (features?.some((f) => f.layer.id === "7-line") ? { feature, layer: road } : undefined)) as never);
    try {
      const store = viewer({ layers: [road] });
      const onMouseMove = recorded.map.onMouseMove as (e: unknown) => void;
      await act(async () => onMouseMove({ features: [feature], point: { x: 10, y: 10 }, lngLat: here }));
      await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
      const popup = screen.getByTestId("map-popup");
      expect(popup.classList).not.toContain("goat-popup-passive");
      // The pointer moves from the feature into the popup: the map's canvas is left for the popup, which stays.
      const onMouseOut = recorded.map.onMouseOut as (e: unknown) => void;
      await act(async () =>
        onMouseOut({ originalEvent: { relatedTarget: popup.firstElementChild ?? popup } })
      );
      expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover");
      // Off the map, onto a panel: it closes.
      await act(async () => onMouseOut({ originalEvent: { relatedTarget: document.body } }));
      expect(store.getState().map.popupInfo).toBeUndefined();
    } finally {
      vi.mocked(topFeature).mockImplementation(actual.topFeature);
    }
  });

  it("a hover popup lets the pointer through to the map; a click popup takes it", async () => {
    // A move over the hover popup's box is a move on the map: the popup follows and shows the new value, it does not
    // catch the pointer and stay with the old one.
    const store = viewer({ layers: [demWith({ popup: { trigger: "click_and_hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    expect(screen.getByTestId("map-popup").classList).toContain("goat-popup-passive");
    // Its close button and links stay usable on a click popup.
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("click"));
    expect(screen.getByTestId("map-popup").classList).not.toContain("goat-popup-passive");
  });

  it("a raster popup's header shows the layer list's raster icon", async () => {
    const store = viewer();
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    expect(within(screen.getByTestId("map-popup")).getByTestId("raster-layer-icon")).toBeInTheDocument();
  });

  it("hover reads the tile and never asks geoapi", async () => {
    const store = viewer({ layers: [demWith({ popup: { trigger: "hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    expect(popupText()).toContain("39.2");
    expect(tileValueAt).toHaveBeenCalled();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(recorded.requests).toEqual([]);
  });

  it("click shows the tile value, then the exact one", async () => {
    let answer: (point: RasterPoint) => void = () => undefined;
    vi.mocked(fetchRasterPoint).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const store = viewer({ layers: [demWith({ popup: { bands: "all" } })] });
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    expect(popupText()).toContain("39.2");
    expect(popupText()).not.toContain("Band 2");
    await act(async () => answer({ values: [39.164505, 7], styled: null }));
    await waitFor(() => expect(popupText()).toContain("39.165"));
    expect(popupText()).toContain("Band 2");
    expect(popupText()).not.toContain("39.2");
  });

  it("an image render opens on click only, from geoapi", async () => {
    vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [10, 250, 30], styled: null });
    const store = viewer({ layers: [image] });
    await move();
    expect(store.getState().map.popupInfo).toBeUndefined();
    expect(tileValueAt).not.toHaveBeenCalled();
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    expect(fetchRasterPoint).toHaveBeenCalledTimes(1);
    expect(popupText()).toContain("Band 3");
    expect(popupText()).toContain("250");
  });

  it("no popup where no value is known", async () => {
    const both = demWith({ popup: { trigger: "click_and_hover" } });
    // No data, outside the file or no tile under the pointer.
    vi.mocked(tileValueAt).mockResolvedValue(null);
    const store = viewer({ layers: [both] });
    await move();
    await click();
    expect(store.getState().map.popupInfo).toBeUndefined();
    // The values' description not loaded (or failed): the map draws nothing there.
    vi.mocked(loadedRasterValues).mockReturnValue(undefined);
    vi.mocked(tileValueAt).mockResolvedValue(39.2);
    await move();
    await click();
    expect(store.getState().map.popupInfo).toBeUndefined();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(recorded.requests).toEqual([]);
  });

  it("no popup and the default pointer over cells the map does not draw", async () => {
    const hidden = demWith({
      popup: { trigger: "click_and_hover" },
      render: {
        type: "continuous",
        palette: "colorbrewer:OrRd",
        domain: [32, 119],
        classify: {
          method: "manual",
          classes: [{ to: 60 }, { from: 60, to: 90, visible: false }, { from: 90 }],
        },
      },
    });
    const beyond = demWith({
      popup: { trigger: "click_and_hover" },
      render: { ...dem.style!.document.render, outside: "hide" },
    });
    for (const [layer, value] of [
      [hidden, 70],
      [beyond, 150],
    ] as const) {
      vi.mocked(tileValueAt).mockResolvedValue(value);
      const store = viewer({ layers: [layer] });
      canvas.style.cursor = "pointer";
      await move();
      await waitFor(() => expect(canvas.style.cursor).toBe(""));
      expect(store.getState().map.popupInfo).toBeUndefined();
      await click();
      expect(store.getState().map.popupInfo).toBeUndefined();
      expect(fetchRasterPoint).not.toHaveBeenCalled();
      cleanup();
    }
    // A drawn cell of the same layer: the hand and the popup.
    vi.mocked(tileValueAt).mockResolvedValue(39.2);
    const store = viewer({ layers: [beyond] });
    await move();
    await waitFor(() => expect(canvas.style.cursor).toBe("pointer"));
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
  });

  it("a read that fails is no value: no popup, the default pointer", async () => {
    vi.mocked(tileValueAt).mockRejectedValue(new Error("no tile"));
    const store = viewer({ layers: [demWith({ popup: { trigger: "click_and_hover" } })] });
    canvas.style.cursor = "pointer";
    await move();
    await waitFor(() => expect(canvas.style.cursor).toBe(""));
    await click();
    expect(store.getState().map.popupInfo).toBeUndefined();
  });

  it("shows the pointer over a cell with a value when its popup opens on click", async () => {
    viewer();
    await move();
    await waitFor(() => expect(canvas.style.cursor).toBe("pointer"));
    // No data: the default pointer.
    vi.mocked(tileValueAt).mockResolvedValue(null);
    await move();
    await waitFor(() => expect(canvas.style.cursor).toBe(""));
    expect(fetchRasterPoint).not.toHaveBeenCalled();
  });

  it("the pointer stays the default where the popup is off", async () => {
    const off = viewer({ layers: [demWith({ popup: false })] });
    canvas.style.cursor = "pointer";
    await move();
    expect(canvas.style.cursor).toBe("");
    expect(tileValueAt).not.toHaveBeenCalled();
    expect(tilePixelAt).not.toHaveBeenCalled();
    expect(off.getState().map.popupInfo).toBeUndefined();
  });

  it("shows the pointer over a cell whatever the popup opens on, as over a feature", async () => {
    for (const trigger of ["hover", "click_and_hover"]) {
      canvas.style.cursor = "";
      const store = viewer({ layers: [demWith({ popup: { trigger } })] });
      await move();
      await waitFor(() => expect(canvas.style.cursor, trigger).toBe("pointer"));
      expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover");
      // No data, outside the file: the default pointer.
      vi.mocked(tileValueAt).mockResolvedValueOnce(null);
      await move({ lng: 13.41, lat: 52.52 });
      await waitFor(() => expect(canvas.style.cursor, trigger).toBe(""));
      cleanup();
    }
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(recorded.requests).toEqual([]);
  });

  it("a hover over an 8 bit image shows its pixels' values, with no request", async () => {
    // An RGB file of 8 bit bands drawn as they are: its pixels are its values.
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { count: 3, dtype: "uint8", scaled: false, colorTable: false, names: ["Rot", "", ""] },
    });
    vi.mocked(tilePixelAt).mockResolvedValue([142, 143, 138, 255]);
    const photo: ViewLayer = {
      ...image,
      style: { id: "s4", document: { ...image.style!.document, popup: { trigger: "hover" } } as LayerStyle },
    };
    const store = viewer({ layers: [photo] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    // One row: the file names only its first band, so "Color"; the values in the bands' order, and the swatch.
    expect(popupText()).toContain("Color");
    expect(popupText()).toContain("142, 143, 138");
    expect(screen.getByTestId("popup-swatch").closest("tr")?.textContent).toContain("142, 143, 138");
    expect(canvas.style.cursor).toBe("pointer");
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(recorded.requests).toEqual([]);
  });

  it("a hover over an image drawn with its color table shows the cell's code and its color", async () => {
    // One 8 bit band colored by the file's table: the map draws its codes (value tiles) in the table's colors.
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { ...facts, palette: { band: 1, colors: { 3: "#ff0000", 17: "#008000" } } },
    });
    vi.mocked(tileValueAt).mockResolvedValue(17);
    const roadMap: ViewLayer = {
      ...image,
      style: { id: "s6", document: { ...image.style!.document, popup: { trigger: "hover" } } as LayerStyle },
    };
    const store = viewer({ layers: [roadMap] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    const swatch = screen.getByTestId("popup-swatch");
    expect(swatch.closest("tr")?.textContent).toContain("17");
    expect(swatch).toHaveStyle({ backgroundColor: "#008000" });
    expect(canvas.style.cursor).toBe("pointer");
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(tilePixelAt).not.toHaveBeenCalled();
    expect(recorded.requests).toEqual([]);
  });

  it("over a color two entries of the color table share, the hover answers each cell's own code", async () => {
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: { ...facts, palette: { band: 1, colors: { 3: "#ff0000", 17: "#ff0000", 20: "#008000" } } },
    });
    const roadMap: ViewLayer = {
      ...image,
      style: {
        id: "s7",
        document: { ...image.style!.document, popup: { trigger: "click_and_hover" } } as LayerStyle,
      },
    };
    const store = viewer({ layers: [roadMap] });
    for (const [code, lng] of [
      [17, 13.4],
      [3, 13.41],
    ] as const) {
      vi.mocked(tileValueAt).mockResolvedValue(code);
      await move({ lng, lat: 52.52 });
      await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
      await waitFor(() =>
        expect(screen.getByTestId("popup-swatch").closest("tr")?.textContent).toContain(String(code))
      );
      expect(canvas.style.cursor).toBe("pointer");
    }
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(recorded.requests).toEqual([]);
  });

  it("no pointer over an image that only hovers but cannot be read on hover", async () => {
    // Not its values in its pixels (no band facts here): a hover opens nothing, and a click is not its trigger.
    const hoverOnly: ViewLayer = {
      ...image,
      style: { id: "s5", document: { ...image.style!.document, popup: { trigger: "hover" } } as LayerStyle },
    };
    const store = viewer({ layers: [hoverOnly] });
    await move();
    await waitFor(() => expect(tileValueAt).not.toHaveBeenCalled());
    expect(canvas.style.cursor).toBe("");
    expect(tilePixelAt).not.toHaveBeenCalled();
    expect(store.getState().map.popupInfo).toBeUndefined();
  });

  it("an image whose popup opens on click shows the pointer where the map paints it", async () => {
    viewer({ layers: [image] });
    await move();
    await waitFor(() => expect(canvas.style.cursor).toBe("pointer"));
    expect(vi.mocked(tilePixelAt).mock.calls[0][0]).toEqual(expect.objectContaining({ type: "raster" }));
    // Transparent there (no data, outside the file).
    vi.mocked(tilePixelAt).mockResolvedValueOnce(null);
    await move({ lng: 13.41, lat: 52.52 });
    await waitFor(() => expect(canvas.style.cursor).toBe(""));
    expect(tileValueAt).not.toHaveBeenCalled();
    expect(fetchRasterPoint).not.toHaveBeenCalled();
    expect(recorded.requests).toEqual([]);
  });

  it("one tile read per move serves the pointer and the hover popup", async () => {
    const store = viewer({ layers: [demWith({ popup: { trigger: "click_and_hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    expect(canvas.style.cursor).toBe("pointer");
    expect(tileValueAt).toHaveBeenCalledTimes(1);
  });

  it("a mouse move after a click keeps the click's exact answer", async () => {
    const answers = heldAnswers();
    const store = viewer({ layers: [demWith({ popup: { trigger: "click_and_hover", bands: "all" } })] });
    await click();
    await waitFor(() => expect(answers).toHaveLength(1));
    await move({ lng: 13.41, lat: 52.52 });
    await move({ lng: 13.42, lat: 52.52 });
    await answer(answers[0], 39.164505);
    await waitFor(() => expect(popupText()).toContain("39.165"));
    expect(popupText()).toContain("Band 2");
    expect(store.getState().map.popupInfo?.triggeredBy).toBe("click");
    expect(store.getState().map.popupInfo?.lngLat).toEqual([here.lng, here.lat]);
  });

  it("a click on a hovered image pins its popup: it stays while the mouse moves on, leaves the map or the map moves", async () => {
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: {
        ...facts,
        palette: { band: 1, colors: { 3: "#ff0000", 17: "#008000", 0: "#ffffff", 1: "#ffffff" } },
      },
    });
    vi.mocked(tileValueAt).mockResolvedValue(17);
    vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [17], styled: null });
    const roadMap: ViewLayer = {
      ...image,
      style: {
        id: "s10",
        document: { ...image.style!.document, popup: { trigger: "click_and_hover" } } as LayerStyle,
      },
    };
    const store = viewer({ layers: [roadMap] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("click"));
    const placed = store.getState().map.popupInfo?.lngLat;
    for (const [code, lng] of [
      [17, 13.41],
      [1, 13.42],
      [3, 13.43],
      [null, 13.44],
    ] as const) {
      vi.mocked(tileValueAt).mockResolvedValue(code);
      await move({ lng, lat: 52.52 });
      await act(async () => new Promise((r) => setTimeout(r, 150)));
      expect(store.getState().map.popupInfo?.triggeredBy, String(lng)).toBe("click");
      expect(store.getState().map.popupInfo?.lngLat).toEqual(placed);
    }
    // The pointer leaves the map and comes back: still the click's.
    await act(async () => (recorded.map.onMouseOut as (e: unknown) => void)({}));
    await act(async () => (recorded.map.onMoveStart as (e: unknown) => void)({}));
    await act(async () => (recorded.map.onMoveEnd as (e: unknown) => void)({}));
    expect(store.getState().map.popupInfo?.triggeredBy).toBe("click");
  });

  it("a click opens the popup of the file below while another file's hover popup shows", async () => {
    // A hover-only file on top (a wind map) over a color range that opens on click: the click pins the lower file's
    // popup, it does not just close the hover popup.
    const wind: ViewLayer = { ...demWith({ popup: { trigger: "hover" } }), id: 3, layer_id: "wind" };
    const terrain: ViewLayer = demWith({ popup: { trigger: "click" } });
    const store = viewer({ layers: [wind, terrain] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.layerId).toBe("wind"));
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("click"));
    expect(store.getState().map.popupInfo?.layerId).toBe(String(terrain.layer_id));
  });

  it("a click opens the popup of the feature under it while a hover popup of another layer shows", async () => {
    // A raster's hover popup covers an area, a feature's hover popup is another layer's: neither keeps a click from
    // opening the clicked feature's popup.
    const actual = await vi.importActual<typeof import("@/lib/style/render/viewLayers")>(
      "@/lib/style/render/viewLayers"
    );
    const vector = (id: number, trigger: string): ViewLayer =>
      ({
        id,
        layer_id: `dataset-${id}`,
        name: `Layer ${id}`,
        type: "feature",
        visible: true,
        style: {
          id: `s${id}`,
          document: {
            version: "1.0.0",
            kind: "vector",
            popup: { trigger, blocks: [{ type: "field_list", attributes: [{ field: "name" }] }] },
          } as unknown as LayerStyle,
        },
      }) as unknown as ViewLayer;
    const roads = vector(7, "click");
    const parks = vector(8, "hover");
    const paths = vector(9, "click");
    const featureOf = (layer: ViewLayer) => ({
      id: Number(layer.id) * 10,
      layer: { id: `${layer.id}-fill` },
      properties: { name: String(layer.name) },
      geometry: { type: "Polygon" },
    });
    vi.mocked(topFeature).mockImplementation(((
      _map: unknown,
      features: Array<{ layer: { id: string } }> | undefined,
      _layers: unknown,
      accept: (layer: ViewLayer) => boolean
    ) => {
      for (const layer of [parks, roads, paths]) {
        const f = features?.find((x) => x.layer.id === `${layer.id}-fill`);
        if (f && accept(layer)) return { feature: f, layer };
      }
      return undefined;
    }) as never);
    try {
      // A raster's hover popup shows; the click lands on a road.
      const store = viewer({ layers: [roads, demWith({ popup: { trigger: "hover" } })] });
      await move();
      await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
      const onClick = recorded.map.onClick as (e: unknown) => void;
      await act(async () => onClick({ features: [featureOf(roads)], point: { x: 10, y: 10 }, lngLat: here }));
      await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("click"));
      expect(store.getState().map.popupInfo?.layerId).toBe("dataset-7");
      cleanup();
      // A park's hover popup shows; the click lands on a road.
      const second = viewer({ layers: [parks, roads] });
      const onMove = recorded.map.onMouseMove as (e: unknown) => void;
      await act(async () => onMove({ features: [featureOf(parks)], point: { x: 10, y: 10 }, lngLat: here }));
      await waitFor(() => expect(second.getState().map.popupInfo?.layerId).toBe("dataset-8"));
      await act(async () =>
        (recorded.map.onClick as (e: unknown) => void)({
          features: [featureOf(roads)],
          point: { x: 10, y: 10 },
          lngLat: here,
        })
      );
      await waitFor(() => expect(second.getState().map.popupInfo?.triggeredBy).toBe("click"));
      expect(second.getState().map.popupInfo?.layerId).toBe("dataset-7");
      cleanup();
      // An open click popup still keeps clicks to its layer, as before: a click on another layer's feature does
      // not open that layer's popup.
      const third = viewer({ layers: [roads, paths] });
      const clickOn = async (layer: ViewLayer) =>
        act(async () =>
          (recorded.map.onClick as (e: unknown) => void)({
            features: [featureOf(layer)],
            point: { x: 10, y: 10 },
            lngLat: here,
          })
        );
      await clickOn(roads);
      await waitFor(() => expect(third.getState().map.popupInfo?.layerId).toBe("dataset-7"));
      await clickOn(paths);
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(third.getState().map.popupInfo?.layerId).not.toBe("dataset-9");
    } finally {
      vi.mocked(topFeature).mockImplementation(actual.topFeature);
    }
  });

  it("a click-only image keeps its click popup while the mouse moves", async () => {
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: {
        ...facts,
        palette: { band: 1, colors: { 3: "#ff0000", 17: "#008000", 0: "#ffffff", 1: "#ffffff" } },
      },
    });
    vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [1], styled: null });
    const roadMap: ViewLayer = {
      ...image,
      style: { id: "s11", document: { ...image.style!.document, popup: { trigger: "click" } } as LayerStyle },
    };
    const store = viewer({ layers: [roadMap] });
    vi.mocked(tileValueAt).mockResolvedValue(1);
    await move({ lng: 13.401, lat: 52.52 });
    await click({ lng: 13.401, lat: 52.52 });
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("click"));
    for (const [code, lng] of [
      [0, 13.402],
      [17, 13.403],
      [null, 13.404],
    ] as const) {
      vi.mocked(tileValueAt).mockResolvedValue(code);
      await move({ lng, lat: 52.52 });
      await act(async () => new Promise((r) => setTimeout(r, 150)));
      expect(store.getState().map.popupInfo?.triggeredBy, String(lng)).toBe("click");
    }
    await act(async () => (recorded.map.onMouseOut as (e: unknown) => void)({}));
    expect(store.getState().map.popupInfo?.triggeredBy).toBe("click");
  });

  it("a click on a color two table entries share, after the hover popup moved there, pins that cell's popup", async () => {
    const facts = { count: 1, dtype: "uint8", scaled: false, colorTable: true, colorInterp: ["palette"] };
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: {
        ...facts,
        palette: { band: 1, colors: { 3: "#ff0000", 17: "#008000", 0: "#ffffff", 1: "#ffffff" } },
      },
    });
    vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [1], styled: null });
    const roadMap: ViewLayer = {
      ...image,
      style: {
        id: "s10",
        document: { ...image.style!.document, popup: { trigger: "click_and_hover" } } as LayerStyle,
      },
    };
    const store = viewer({ layers: [roadMap] });
    vi.mocked(tileValueAt).mockResolvedValue(17);
    await move({ lng: 13.4, lat: 52.52 });
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    // White, which codes 0 and 1 share: the hover popup moves there with the cell's own code.
    vi.mocked(tileValueAt).mockResolvedValue(1);
    await move({ lng: 13.401, lat: 52.52 });
    await waitFor(() => expect(store.getState().map.popupInfo?.lngLat).toEqual([13.401, 52.52]));
    expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover");
    await click({ lng: 13.401, lat: 52.52 });
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("click"));
    expect(popupText()).toContain("1");
    for (const [code, lng] of [
      [0, 13.402],
      [17, 13.403],
      [1, 13.404],
    ] as const) {
      vi.mocked(tileValueAt).mockResolvedValue(code);
      await move({ lng, lat: 52.52 });
      await act(async () => new Promise((r) => setTimeout(r, 150)));
      expect(store.getState().map.popupInfo?.triggeredBy, String(lng)).toBe("click");
    }
  });

  it("a feature's click popup stays while the pointer moves off and on, for click and click and hover", async () => {
    const actual = await vi.importActual<typeof import("@/lib/style/render/viewLayers")>(
      "@/lib/style/render/viewLayers"
    );
    for (const trigger of ["click", "click_and_hover"] as const) {
      const road = {
        id: 7,
        layer_id: "roads",
        name: "Roads",
        type: "feature",
        visible: true,
        style: {
          id: "s9",
          document: {
            version: "1.0.0",
            kind: "vector",
            popup: { trigger, blocks: [{ type: "field_list", attributes: [{ field: "name" }] }] },
          } as unknown as LayerStyle,
        },
      } as unknown as ViewLayer;
      const feature = {
        id: 1,
        layer: { id: "7-line" },
        properties: { name: "A" },
        geometry: { type: "LineString" },
      };
      vi.mocked(topFeature).mockImplementation(((
        _map: unknown,
        features: Array<{ layer: { id: string } }> | undefined,
        _layers: unknown,
        accept: (layer: ViewLayer) => boolean
      ) =>
        features?.some((f) => f.layer.id === "7-line") && accept(road)
          ? { feature, layer: road }
          : undefined) as never);
      try {
        const store = viewer({ layers: [road] });
        const onMouseMove = recorded.map.onMouseMove as (e: unknown) => void;
        const onClick = recorded.map.onClick as (e: unknown) => void;
        const over = { features: [feature], point: { x: 10, y: 10 }, lngLat: here };
        const off = { features: [], point: { x: 90, y: 90 }, lngLat: { lng: 13.5, lat: 52.5 } };
        await act(async () => onMouseMove(over));
        await act(async () => onClick(over));
        await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy, trigger).toBe("click"));
        for (const e of [off, over, off]) {
          await act(async () => (recorded.map.onMouseMove as (e: unknown) => void)(e));
          await act(async () => new Promise((r) => setTimeout(r, 150)));
          expect(store.getState().map.popupInfo?.triggeredBy, trigger).toBe("click");
        }
        await act(async () => (recorded.map.onMouseOut as (e: unknown) => void)({}));
        expect(store.getState().map.popupInfo?.triggeredBy, trigger).toBe("click");
        cleanup();
      } finally {
        vi.mocked(topFeature).mockImplementation(actual.topFeature);
      }
    }
  });

  it("an image's click answer opens its popup though the mouse moved", async () => {
    const answers = heldAnswers();
    const store = viewer({ layers: [image] });
    await click();
    await waitFor(() => expect(answers).toHaveLength(1));
    await move({ lng: 13.41, lat: 52.52 });
    await act(async () => answers[0]({ values: [10, 250, 30], styled: null }));
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    expect(popupText()).toContain("250");
  });

  it("a closed popup stays closed when its click's answer comes late", async () => {
    const answers = heldAnswers();
    const store = viewer({ layers: [demWith({ popup: { bands: "all" } })] });
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    // Closed with its button: no mouse move (a tap on a phone).
    await act(async () => store.getState().map.popupInfo?.onClose());
    await answer(answers[0], 39.164505);
    expect(store.getState().map.popupInfo).toBeUndefined();
    // Closed after the mouse moved.
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    await move({ lng: 13.41, lat: 52.52 });
    await act(async () => store.getState().map.popupInfo?.onClose());
    await move({ lng: 13.42, lat: 52.52 });
    await answer(answers[1], 39.164505);
    expect(store.getState().map.popupInfo).toBeUndefined();
  });

  it("the popup stays one element while its answers arrive, so its close button keeps a press", async () => {
    // A popup put in place anew drops a press on its close button that falls between the two renders.
    const answers = heldAnswers();
    const store = viewer();
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    const shown = screen.getByTestId("map-popup");
    await answer(answers[0], 39.164505);
    await waitFor(() => expect(popupText()).toContain("39.165"));
    expect(screen.getByTestId("map-popup")).toBe(shown);
  });

  it("a popup closed from elsewhere stays closed when its click's answer comes late", async () => {
    // The feature editor, the data table and a dataset preview close the popup through the store.
    const answers = heldAnswers();
    const store = viewer();
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    await act(async () => store.dispatch(setPopupInfo(undefined)));
    await answer(answers[0], 39.164505);
    expect(store.getState().map.popupInfo).toBeUndefined();
  });

  it("a move right after a click leaves the click's popup open", async () => {
    const answers = heldAnswers();
    const store = viewer({ layers: [demWith({ popup: { trigger: "click_and_hover" } })] });
    await move();
    await waitFor(() => expect(store.getState().map.popupInfo?.triggeredBy).toBe("hover"));
    // The click's tile value is in the store, the map has not drawn it yet when the pointer moves.
    const onClick = recorded.map.onClick as (e: unknown) => void;
    const onMouseMove = recorded.map.onMouseMove as (e: unknown) => void;
    await act(async () => {
      onClick({ features: [], point: { x: 10, y: 10 }, lngLat: here });
      await new Promise((resolve) => setTimeout(resolve, 0));
      onMouseMove({ features: [], point: { x: 12, y: 10 }, lngLat: { lng: 13.41, lat: 52.52 } });
    });
    expect(store.getState().map.popupInfo?.triggeredBy).toBe("click");
    await answer(answers[0], 39.164505);
    await waitFor(() => expect(popupText()).toContain("39.165"));
  });

  it("a newer click wins over an older click's late answer", async () => {
    const answers = heldAnswers();
    const store = viewer();
    const there = { lng: 13.5, lat: 52.5 };
    await click();
    await click(there);
    await waitFor(() => expect(answers).toHaveLength(2));
    await answer(answers[1], 50.5);
    await answer(answers[0], 39.164505);
    await waitFor(() => expect(popupText()).toContain("50.5"));
    expect(popupText()).not.toContain("39.165");
    expect(store.getState().map.popupInfo?.lngLat).toEqual([there.lng, there.lat]);
  });

  it("default content shows the value with label and unit, and the class", async () => {
    const classified = demWith({
      render: {
        type: "continuous",
        palette: "goat:elevation",
        domain: [32, 119],
        classify: {
          method: "manual",
          classes: [
            { to: 39, name: "Niederung" },
            { from: 39, name: "Wald", color: "#2e7d32" },
          ],
        },
      },
      legend: { unit: "m" },
    });
    const store = viewer({ layers: [classified] }, "de");
    await clickTheFile(store);
    await waitFor(() => expect(popupText()).toContain("39,165 m"));
    expect(popupText()).toContain("Band 1");
    expect(popupText()).toContain("Wald");
  });

  it("blocks written in the style render for rasters", async () => {
    vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [39.164505, 250], styled: null });
    const store = viewer({
      layers: [
        demWith({
          popup: { blocks: [{ type: "field_list", attributes: [{ field: "band_2", label: "Rot" }] }] },
        }),
      ],
    });
    await clickTheFile(store);
    await waitFor(() => expect(popupText()).toContain("250"));
    expect(popupText()).toContain("Rot");
  });

  it("a raster popup asks for no queryables and no feature count", async () => {
    const store = viewer();
    await clickTheFile(store);
    await waitFor(() => expect(popupText()).toContain("39.165"));
    expect(recorded.requests.filter((url) => /\/queryables|\/processes\/feature-count\//.test(url))).toEqual(
      []
    );
  });

  it("a German map's popup shows no English label", async () => {
    // A band formula without a name: its value is labeled "Value", in German "Wert".
    const formula: ViewLayer = demWith({
      render: {
        type: "continuous",
        band: { expression: "b1 / 2" },
        palette: "goat:green",
        domain: [0, 60],
      },
    });
    vi.mocked(fetchRasterPoint).mockResolvedValueOnce({ values: [39.164505], styled: 19.58 });
    const store = viewer({ layers: [formula] }, "de");
    await click();
    await waitFor(() => expect(store.getState().map.popupInfo).toBeDefined());
    await waitFor(() => expect(popupText()).toContain("19,58"));
    expect(popupText()).toContain("Wert");
    expect(popupText()).not.toContain("Value");
  });

  it("a German map writes the cell's values as German numbers; a configured format wins", async () => {
    // As the legend writes its classes ("58,544 bis 71,913 m"): the reader's decimal comma, at most three decimals.
    vi.mocked(fetchRasterPoint).mockResolvedValue({ values: [65.93717, 2], styled: null });
    viewer({ layers: [demWith({ popup: { bands: "all" } })] }, "de");
    await click();
    await waitFor(() => expect(popupText()).toContain("65,937"));
    expect(popupText()).not.toContain("65.93717");
    cleanup();
    // In a template's tokens too.
    viewer(
      { layers: [demWith({ popup: { mode: "html", html: "<p>Höhe {{value}} / {{band_1}}</p>" } })] },
      "de"
    );
    await click();
    await waitFor(() => expect(popupText()).toContain("Höhe 65,937 / 65,937"));
    cleanup();
    // A format set in the popup panel wins, as for a feature's number field.
    const formatted = demWith({
      popup: { blocks: [{ type: "field_list", attributes: [{ field: "value", format: { decimals: 1 } }] }] },
    });
    viewer({ layers: [formatted] }, "de");
    await click();
    await waitFor(() => expect(popupText()).toContain("65.9"));
    expect(popupText()).not.toContain("65,937");
    cleanup();
    // An image's joined row of whole numbers stays as it is.
    vi.mocked(loadedRasterTileset).mockReturnValue({
      version: "v1",
      bands: {
        count: 3,
        dtype: "uint8",
        scaled: false,
        colorTable: false,
        colorInterp: ["red", "green", "blue"],
      },
    });
    vi.mocked(tilePixelAt).mockResolvedValue([144, 135, 116, 255]);
    const photo: ViewLayer = {
      ...image,
      style: { id: "s8", document: { ...image.style!.document, popup: { trigger: "hover" } } as LayerStyle },
    };
    viewer({ layers: [photo] }, "de");
    await move();
    await waitFor(() => expect(popupText()).toContain("Rot, Grün, Blau"));
    expect(popupText()).toContain("144, 135, 116");
  });

  it("in a window narrower than 900 px the map still opens the popup", async () => {
    // MapViewer reads no window width: only its host says when a drawer shows the popup. A narrow window here keeps a
    // width check from coming back (the editor has no drawer, so it would hide every popup).
    narrowWindow();
    const store = viewer();
    await clickTheFile(store);
    expect(screen.getByTestId("map-layer-popup-active-feature-pulse")).toBeInTheDocument();
    expect(popupText()).toContain("Band 1");
  });

  it("a layout that shows the popup in its own drawer gets the marker only", async () => {
    narrowWindow();
    const store = viewer({ popupInDrawer: true });
    await clickTheFile(store);
    expect(screen.getByTestId("map-layer-popup-active-feature-pulse")).toBeInTheDocument();
    expect(screen.queryByTestId("map-popup")).toBeNull();
  });
});

describe("MapViewer: a click under a hover popup", () => {
  const vector = (id: number, trigger: string, render?: object): ViewLayer =>
    ({
      id,
      layer_id: `dataset-${id}`,
      name: `Layer ${id}`,
      type: "feature",
      visible: true,
      style: {
        id: `s${id}`,
        document: {
          version: "1.0.0",
          kind: "vector",
          ...(render ? { render } : {}),
          popup: { trigger, blocks: [{ type: "field_list", attributes: [{ field: "name" }] }] },
        } as unknown as LayerStyle,
      },
    }) as unknown as ViewLayer;
  const featureOf = (layer: ViewLayer) => ({
    id: Number(layer.id) * 10,
    layer: { id: `${layer.id}-fill` },
    properties: { name: String(layer.name) },
    geometry: { type: "Polygon" },
  });
  /** A pointer event over the features of `layers` (top first). */
  const over = (...layers: ViewLayer[]) => ({
    features: layers.map(featureOf),
    point: { x: 10, y: 10 },
    lngLat: here,
  });
  const moveOver = (...layers: ViewLayer[]) =>
    act(async () => (recorded.map.onMouseMove as (e: unknown) => void)(over(...layers)));
  const clickOn = (...layers: ViewLayer[]) =>
    act(async () => (recorded.map.onClick as (e: unknown) => void)(over(...layers)));
  /** Runs `run` with `stack` (top first) as the layers the map finds features of. */
  const withStack = async (stack: ViewLayer[], run: () => Promise<void>) => {
    const actual = await vi.importActual<typeof import("@/lib/style/render/viewLayers")>(
      "@/lib/style/render/viewLayers"
    );
    vi.mocked(topFeature).mockImplementation(((
      _map: unknown,
      features: Array<{ layer: { id: string } }> | undefined,
      _layers: unknown,
      accept: (layer: ViewLayer) => boolean
    ) => {
      for (const layer of stack) {
        const feature = features?.find((f) => f.layer.id === `${layer.id}-fill`);
        if (feature && accept(layer)) return { feature, layer };
      }
      return undefined;
    }) as never);
    try {
      await run();
    } finally {
      vi.mocked(topFeature).mockImplementation(actual.topFeature);
    }
  };
  const popupOf = (store: ReturnType<typeof viewer>) => store.getState().map.popupInfo;

  it("pins the popup being read: its layer's feature comes before a layer drawn above it", async () => {
    // Roads drawn above districts; both open on click and on hover.
    const roads = vector(7, "click_and_hover");
    const districts = vector(8, "click_and_hover");
    await withStack([roads, districts], async () => {
      const store = viewer({ layers: [roads, districts] });
      await moveOver(districts);
      await waitFor(() => expect(popupOf(store)?.layerId).toBe("dataset-8"));
      // The pointer moves on within the district, onto a road crossing it: the hover popup stays the district's.
      await moveOver(roads, districts);
      expect(popupOf(store)).toMatchObject({ layerId: "dataset-8", triggeredBy: "hover" });
      await clickOn(roads, districts);
      await waitFor(() => expect(popupOf(store)?.triggeredBy).toBe("click"));
      expect(popupOf(store)?.layerId).toBe("dataset-8");
      expect(store.getState().map.highlightedFeature?.id).toBe(80);
      cleanup();
      // Without a district under the click, the topmost layer's popup opens.
      const second = viewer({ layers: [roads, districts] });
      await moveOver(districts);
      await waitFor(() => expect(popupOf(second)?.layerId).toBe("dataset-8"));
      await clickOn(roads);
      await waitFor(() => expect(popupOf(second)?.triggeredBy).toBe("click"));
      expect(popupOf(second)?.layerId).toBe("dataset-7");
      cleanup();
      // Without a hover popup, the topmost layer's.
      const third = viewer({ layers: [roads, districts] });
      await clickOn(roads, districts);
      await waitFor(() => expect(popupOf(third)?.triggeredBy).toBe("click"));
      expect(popupOf(third)?.layerId).toBe("dataset-7");
    });
  });

  it("a hover popup of a layer that opens on hover only gives way to the clicked feature's popup", async () => {
    const parks = vector(8, "hover");
    const roads = vector(7, "click_and_hover");
    await withStack([parks, roads], async () => {
      const store = viewer({ layers: [parks, roads] });
      await moveOver(parks, roads);
      await waitFor(() => expect(popupOf(store)?.layerId).toBe("dataset-8"));
      await clickOn(parks, roads);
      await waitFor(() => expect(popupOf(store)?.triggeredBy).toBe("click"));
      expect(popupOf(store)?.layerId).toBe("dataset-7");
    });
  });

  it("pins a file's hover popup where the file has a value, though a feature that opens on click lies above", async () => {
    const roads = vector(7, "click");
    const terrain = demWith({ popup: { trigger: "click_and_hover" } });
    await withStack([roads], async () => {
      const store = viewer({ layers: [roads, terrain] });
      await moveOver(roads);
      await waitFor(() => expect(popupOf(store)?.triggeredBy).toBe("hover"));
      expect(popupOf(store)?.layerId).toBe(String(terrain.layer_id));
      await clickOn(roads);
      await waitFor(() => expect(popupOf(store)?.triggeredBy).toBe("click"));
      expect(popupOf(store)?.layerId).toBe(String(terrain.layer_id));
      await waitFor(() => expect(popupText()).toContain("39.165"));
      expect(store.getState().map.highlightedFeature).toBeUndefined();
      cleanup();
      // Without a value of the file under the click, the feature's popup opens.
      const second = viewer({ layers: [roads, terrain] });
      await moveOver(roads);
      await waitFor(() => expect(popupOf(second)?.triggeredBy).toBe("hover"));
      vi.mocked(tileValueAt).mockResolvedValue(null);
      await clickOn(roads);
      await waitFor(() => expect(popupOf(second)?.triggeredBy).toBe("click"));
      expect(popupOf(second)?.layerId).toBe("dataset-7");
      expect(second.getState().map.highlightedFeature?.id).toBe(70);
    });
  });

  it("pins the hover popup of the file below a file that opens on click", async () => {
    const slope: ViewLayer = { ...demWith({ popup: { trigger: "click" } }), id: 3, layer_id: "slope" };
    const terrain = demWith({ popup: { trigger: "click_and_hover" } });
    const store = viewer({ layers: [slope, terrain] });
    await move();
    await waitFor(() => expect(popupOf(store)?.layerId).toBe(String(terrain.layer_id)));
    await click();
    await waitFor(() => expect(popupOf(store)?.triggeredBy).toBe("click"));
    expect(popupOf(store)?.layerId).toBe(String(terrain.layer_id));
    cleanup();
    // Without a value of that file under the click, the topmost file with one.
    const second = viewer({ layers: [slope, terrain] });
    await move();
    await waitFor(() => expect(popupOf(second)?.layerId).toBe(String(terrain.layer_id)));
    vi.mocked(tileValueAt).mockImplementation(async (_values, tiles) =>
      tiles.includes("slope") ? 12 : null
    );
    await click();
    await waitFor(() => expect(popupOf(second)?.triggeredBy).toBe("click"));
    expect(popupOf(second)?.layerId).toBe("slope");
  });

  it("the clicked feature is the highlighted one once its late popup opens, though the mouse moved meanwhile", async () => {
    // Stops drawn as clusters open on click, their properties come from geoapi; parks below open on hover.
    const stops = vector(7, "click", { type: "cluster" });
    const parks = vector(8, "hover");
    const answers: Array<(feature: unknown) => void> = [];
    vi.mocked(getFeature).mockImplementationOnce(
      () => new Promise((resolve) => answers.push(resolve as never))
    );
    await withStack([stops, parks], async () => {
      const store = viewer({ layers: [stops, parks] });
      await moveOver(stops, parks);
      await waitFor(() => expect(popupOf(store)?.layerId).toBe("dataset-8"));
      await clickOn(stops, parks);
      expect(store.getState().map.highlightedFeature?.id).toBe(70);
      // The mouse moves a pixel before geoapi answers.
      await moveOver(stops, parks);
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      await act(async () => answers.forEach((give) => give({ properties: { name: "Stop from geoapi" } })));
      await waitFor(() => expect(popupOf(store)?.triggeredBy).toBe("click"));
      expect(popupOf(store)?.layerId).toBe("dataset-7");
      expect(store.getState().map.highlightedFeature?.id).toBe(70);
      // A later move leaves the click's popup and its feature as they are.
      await moveOver(parks);
      expect(popupOf(store)).toMatchObject({ layerId: "dataset-7", triggeredBy: "click" });
      expect(store.getState().map.highlightedFeature?.id).toBe(70);
    });
  });
});
