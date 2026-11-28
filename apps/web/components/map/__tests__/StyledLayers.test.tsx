import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompiledScene } from "@/lib/scene/compile";
import { compileLayer } from "@/lib/style/compile";
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterTileset, RasterValues } from "@/lib/style/raster/values";
import type { RenderLayer } from "@/lib/style/render/mapLayers";
import { StyleSaver, type StyleTransport } from "@/lib/style/save";

import { StyledLayers, useLiveLayer } from "@/components/map/StyledLayers";

const { syncMock, useMapMock, valuesMock } = vi.hoisted(() => ({
  syncMock: vi.fn(),
  useMapMock: vi.fn(),
  valuesMock: vi.fn(),
}));
vi.mock("@/lib/style/render/mapLayers", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncMapLayers: (...args: unknown[]) => syncMock(...args) ?? { placed: new Map(), order: [] },
}));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => useMapMock() }));
vi.mock("@/lib/api/rasters", () => ({
  loadRasterValues: (url: string, onLoad: () => void) => valuesMock(url, onLoad),
}));
// The custom basemap's layer settings are their own hook (Redux); nothing here sets any.
vi.mock("@/hooks/map/useBasemapStacking", () => ({ useBasemapStacking: () => undefined }));

const fakeMap = {
  on: vi.fn(),
  off: vi.fn(),
  getStyle: () => ({ layers: [] }),
  getZoom: () => 12,
  isStyleLoaded: () => true,
};
const style = (color: string) =>
  ({ version: "1.0.0", kind: "vector", symbol: { fill: { color } } }) as LayerStyle;
const layer = (key: string, color: string): RenderLayer => ({
  key,
  style: style(color),
  geometry: "polygon",
  entry: {},
  source: { type: "tiles", id: `src-${key}`, tiles: [`https://geoapi/${key}/{z}/{x}/{y}`] },
});
const transport: StyleTransport = {
  save: () => new Promise(() => undefined),
  load: async () => ({ document: style("#000000"), revision: 1 }),
};

describe("StyledLayers", () => {
  beforeEach(() => {
    syncMock.mockReset();
    useMapMock.mockReset();
    valuesMock.mockReset();
    useMapMock.mockReturnValue({ current: { getMap: () => fakeMap } });
  });

  it("an edit re-renders only the edited layer's child", async () => {
    const store = new EditorStore({
      saver: new StyleSaver({ transport, document: style("#111111"), revision: 1 }),
    });
    const layers = [layer("1", "#aaaaaa"), layer("2", "#bbbbbb")];
    render(<StyledLayers layers={layers} editing={[{ key: "2", store }]} locale="de" tone="light" />);
    await waitFor(() => expect(syncMock).toHaveBeenCalled());
    const drawn = (call: unknown[]) =>
      (call[2] as RenderLayer[]).map((l) => (l.style as { symbol?: { fill?: unknown } }).symbol?.fill);
    expect(drawn(syncMock.mock.calls.at(-1) as unknown[])).toEqual([
      { color: "#aaaaaa" },
      { color: "#111111" },
    ]);
    const parentRenders = useMapMock.mock.calls.length;

    act(() => store.set("symbol.fill.color", "#222222"));
    await waitFor(() =>
      expect(drawn(syncMock.mock.calls.at(-1) as unknown[])).toEqual([
        { color: "#aaaaaa" },
        { color: "#222222" },
      ])
    );
    expect(useMapMock.mock.calls.length).toBe(parentRenders);
    expect((syncMock.mock.calls.at(-1) as unknown[])[3]).toMatchObject({ locale: "de" });
  });

  it("keeps the project layers below the map's overlays: drawing, measuring, the filter's area", async () => {
    useMapMock.mockReturnValue({
      current: {
        getMap: () => ({
          ...fakeMap,
          getStyle: () => ({
            layers: [
              { id: "background" },
              { id: "gl-draw-polygon-fill-inactive.cold" },
              { id: "filter-area-line" },
            ],
          }),
        }),
      },
    });
    render(<StyledLayers layers={[layer("1", "#aaaaaa")]} locale="de" tone="light" />);
    await waitFor(() => expect(syncMock).toHaveBeenCalled());
    expect((syncMock.mock.calls.at(-1) as unknown[])[3]).toMatchObject({
      overlay: "gl-draw-polygon-fill-inactive.cold",
    });
  });

  it("draws with the basemap's tone, and again when the basemap's tone changes", async () => {
    const layers = [layer("1", "#aaaaaa")];
    const { rerender } = render(<StyledLayers layers={layers} locale="en" tone="light" />);
    await waitFor(() => expect(syncMock).toHaveBeenCalled());
    expect((syncMock.mock.calls.at(-1) as unknown[])[3]).toMatchObject({ tone: "light" });
    const draws = syncMock.mock.calls.length;
    rerender(<StyledLayers layers={layers} locale="en" tone="dark" />);
    await waitFor(() => expect(syncMock.mock.calls.length).toBeGreaterThan(draws));
    expect((syncMock.mock.calls.at(-1) as unknown[])[3]).toMatchObject({ tone: "dark" });
  });

  it("waits for the map's style before it draws", async () => {
    const listeners = new Map<string, () => void>();
    let loaded = false;
    const loadingMap = {
      ...fakeMap,
      getStyle: () => (loaded ? { layers: [] } : undefined),
      once: (type: string, listener: () => void) => listeners.set(type, listener),
      on: vi.fn(),
      off: vi.fn(),
    };
    useMapMock.mockReturnValue({ current: { getMap: () => loadingMap } });
    render(<StyledLayers layers={[layer("1", "#aaaaaa")]} locale="en" tone="light" />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(syncMock).not.toHaveBeenCalled();
    loaded = true;
    act(() => listeners.get("styledata")?.());
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
  });

  it("draws a raster layer once its values arrive and reports pending until then", async () => {
    const values: RasterValues = {
      encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 1 },
      range: [0, 255],
      integer: true,
      version: "1-e1",
    };
    const loaded: { values?: RasterValues } = {};
    let onLoad: (() => void) | undefined;
    valuesMock.mockImplementation((_url: string, callback: () => void) => {
      if (!loaded.values) onLoad = callback;
      return loaded.values;
    });
    const coverage = "https://geoapi/collections/r1/coverage/tiles/WebMercatorQuad";
    const raster: RenderLayer = {
      key: "r",
      style: { version: "1.0.0", kind: "raster", render: { type: "continuous" } } as unknown as LayerStyle,
      entry: {},
      source: {
        type: "raster",
        id: "src-r",
        tiles: "https://geoapi/collections/r1/raster/tiles/{z}/{x}/{y}.webp",
        coverage,
      },
    };
    const pending = vi.fn();
    render(
      <StyledLayers
        layers={[layer("1", "#aaaaaa"), raster]}
        locale="en"
        tone="light"
        onValuesPending={pending}
      />
    );
    await waitFor(() => expect(pending).toHaveBeenCalledWith(true));
    expect(valuesMock).toHaveBeenCalledWith(
      `${coverage}?band=1&resampling=nearest&tilesize=512`,
      expect.any(Function)
    );
    const drawnSource = () => ((syncMock.mock.calls.at(-1) as unknown[])[2] as RenderLayer[])[1].source;
    expect(drawnSource()).not.toHaveProperty("values");

    loaded.values = values;
    act(() => onLoad?.());
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    expect(drawnSource()).toMatchObject({ type: "raster", coverage, values });
    expect(pending.mock.calls).toEqual([[true], [false]]);
  });

  it("draws an image raster layer once its colored tiles' description arrives, pending until then", async () => {
    const image: RasterTileset = {
      version: "1-0a1b2c3d-e3",
      maxzoom: 16,
      bounds: [11.39, 47.25, 11.41, 47.27],
    };
    const loaded: { image?: RasterTileset } = {};
    let onLoad: (() => void) | undefined;
    valuesMock.mockImplementation((_url: string, callback: () => void) => {
      if (!loaded.image) onLoad = callback;
      return loaded.image;
    });
    const tileset = "https://geoapi/collections/r1/raster/tiles";
    const raster: RenderLayer = {
      key: "r",
      style: { version: "1.0.0", kind: "raster", render: { type: "image" } } as unknown as LayerStyle,
      entry: {},
      source: {
        type: "raster",
        id: "src-r",
        tiles: `${tileset}/{z}/{x}/{y}.webp`,
        tileset,
        coverage: "https://geoapi/collections/r1/coverage/tiles/WebMercatorQuad",
        bounds: [11, 47, 12, 48],
      },
    };
    const pending = vi.fn();
    render(<StyledLayers layers={[raster]} locale="en" tone="light" onValuesPending={pending} />);
    await waitFor(() => expect(pending).toHaveBeenCalledWith(true));
    expect(valuesMock).toHaveBeenCalledWith(`${tileset}?tilesize=512`, expect.any(Function));
    const drawn = () => ((syncMock.mock.calls.at(-1) as unknown[])[2] as RenderLayer[])[0];
    const drawnSource = () => drawn().source;
    // While the description loads the layer compiles to nothing: no tile is asked for.
    const compiled = () => compileLayer({ id: "r", style: drawn().style, source: drawnSource() });
    expect(compiled().sources).toEqual({});

    loaded.image = image;
    act(() => onLoad?.());
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    expect(drawnSource()).toMatchObject({ type: "raster", tileset, image });
    expect(compiled().sources["src-r"]).toMatchObject({ maxzoom: 16, bounds: image.bounds });
  });

  /**
   * A map whose camera is at `zoom` (`zoomTo` moves it without an event, `fire` fires one), with the renderer
   * answering that the buildings draw from zoom 14 and whether the layers on top went below them.
   */
  const withBuildingsFrom14 = (start: number) => {
    let zoom = start;
    const listeners = new Map<string, () => void>();
    const map = {
      ...fakeMap,
      getZoom: () => zoom,
      on: (type: string, listener: () => void) => listeners.set(type, listener),
      off: vi.fn(),
    };
    useMapMock.mockReturnValue({ current: { getMap: () => map } });
    syncMock.mockImplementation(() => ({
      placed: new Map(),
      order: [],
      buildingsFrom: 14,
      underBuildings: zoom >= 14,
    }));
    return {
      zoomTo: (next: number) => {
        zoom = next;
      },
      fire: (type: string) => listeners.get(type)?.(),
    };
  };

  it("places the layers again at once when the camera crosses the zoom at which the buildings draw, only then", async () => {
    const camera = withBuildingsFrom14(12);
    render(
      <StyledLayers layers={[layer("1", "#aaaaaa")]} locale="en" tone="light" ground="goat-buildings" />
    );
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    expect((syncMock.mock.calls.at(-1) as unknown[])[3]).toMatchObject({ ground: "goat-buildings" });
    // Every frame of a movement fires `move`, a zoom's frames too.
    const zoomTo = (next: number) => {
      camera.zoomTo(next);
      camera.fire("move");
    };
    zoomTo(13.5);
    expect(syncMock).toHaveBeenCalledTimes(1);
    // Across it: placed in the same event, before the map draws the frame.
    zoomTo(14.1);
    expect(syncMock).toHaveBeenCalledTimes(2);
    zoomTo(17);
    expect(syncMock).toHaveBeenCalledTimes(2);
    zoomTo(13.9);
    expect(syncMock).toHaveBeenCalledTimes(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(syncMock).toHaveBeenCalledTimes(3);
  });

  it("a camera landing exactly on that zoom (zoom buttons, setZoom) counts as at it", async () => {
    const camera = withBuildingsFrom14(13);
    render(
      <StyledLayers layers={[layer("1", "#aaaaaa")]} locale="en" tone="light" ground="goat-buildings" />
    );
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    camera.zoomTo(14);
    camera.fire("move");
    expect(syncMock).toHaveBeenCalledTimes(2);
    camera.fire("move");
    expect(syncMock).toHaveBeenCalledTimes(2);
    camera.zoomTo(13.999);
    camera.fire("move");
    expect(syncMock).toHaveBeenCalledTimes(3);
  });

  it("a zoom changed with only `move` events (the inertia of a drag over terrain) is caught", async () => {
    const camera = withBuildingsFrom14(13.8);
    render(
      <StyledLayers layers={[layer("1", "#aaaaaa")]} locale="en" tone="light" ground="goat-buildings" />
    );
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    // The drag's end puts the center back onto the terrain with the camera in place, which changes the zoom; the
    // inertia that follows moves the camera without a zoom axis.
    camera.zoomTo(14.05);
    camera.fire("move");
    expect(syncMock).toHaveBeenCalledTimes(2);
  });

  it("a zoom changed without any frame event is caught at the movement's end", async () => {
    const camera = withBuildingsFrom14(13.8);
    render(
      <StyledLayers layers={[layer("1", "#aaaaaa")]} locale="en" tone="light" ground="goat-buildings" />
    );
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    camera.fire("moveend");
    expect(syncMock).toHaveBeenCalledTimes(1);
    camera.zoomTo(14.05);
    camera.fire("moveend");
    expect(syncMock).toHaveBeenCalledTimes(2);
  });

  it("draws once more when the scene was applied again, so a changed building layer is read again", async () => {
    const layers = [layer("1", "#aaaaaa")];
    const scene = { layers: [] } as unknown as CompiledScene;
    const { rerender } = render(
      <StyledLayers layers={layers} locale="en" tone="light" ground="goat-buildings" scene={scene} />
    );
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    // The same building layer with another zoom range or opacity: the same `ground`, a new applied scene.
    rerender(
      <StyledLayers
        layers={layers}
        locale="en"
        tone="light"
        ground="goat-buildings"
        scene={{ layers: [] } as unknown as CompiledScene}
      />
    );
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(2));
    expect((syncMock.mock.calls.at(-1) as unknown[])[2]).toEqual((syncMock.mock.calls[0] as unknown[])[2]);
  });

  it("a map without buildings does not place the layers again on a move", async () => {
    let zoom = 12;
    const listeners = new Map<string, () => void>();
    const zoomingMap = {
      ...fakeMap,
      getZoom: () => zoom,
      on: (type: string, listener: () => void) => listeners.set(type, listener),
      off: vi.fn(),
    };
    useMapMock.mockReturnValue({ current: { getMap: () => zoomingMap } });
    syncMock.mockImplementation(() => ({ placed: new Map(), order: [], underBuildings: false }));
    render(<StyledLayers layers={[layer("1", "#aaaaaa")]} locale="en" tone="light" />);
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    zoom = 16;
    listeners.get("move")?.();
    listeners.get("moveend")?.();
    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it("popups follow the edited style: a layer's document comes from its open store", () => {
    const store = new EditorStore({
      saver: new StyleSaver({ transport, document: style("#111111"), revision: 1 }),
    });
    const mapLayer = { id: 2, visible: true, style: { id: "s", revision: 1, document: style("#aaaaaa") } };
    const { result } = renderHook(() => useLiveLayer(mapLayer, [{ key: "2", store }]));
    expect((result.current?.style?.document as { symbol?: { fill?: unknown } }).symbol?.fill).toEqual({
      color: "#111111",
    });
    act(() => store.set("symbol.fill.color", "#222222"));
    expect((result.current?.style?.document as { symbol?: { fill?: unknown } }).symbol?.fill).toEqual({
      color: "#222222",
    });
    const { result: other } = renderHook(() => useLiveLayer(mapLayer, []));
    expect(other.current).toBe(mapLayer);
  });
});
