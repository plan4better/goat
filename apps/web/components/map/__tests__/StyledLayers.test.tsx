import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { RenderLayer } from "@/lib/style/render/mapLayers";
import { StyleSaver, type StyleTransport } from "@/lib/style/save";

import { StyledLayers, useLiveLayer } from "@/components/map/StyledLayers";

const { syncMock, useMapMock } = vi.hoisted(() => ({ syncMock: vi.fn(), useMapMock: vi.fn() }));
vi.mock("@/lib/style/render/mapLayers", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncMapLayers: (...args: unknown[]) => {
    syncMock(...args);
    return { placed: new Map(), order: [] };
  },
}));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => useMapMock() }));
// The custom basemap's layer settings are their own hook (Redux); nothing here sets any.
vi.mock("@/hooks/map/useBasemapStacking", () => ({ useBasemapStacking: () => undefined }));

const fakeMap = {
  on: vi.fn(),
  off: vi.fn(),
  getStyle: () => ({ layers: [] }),
  isStyleLoaded: () => true,
};
const style = (color: string) => ({ version: 1, kind: "vector", symbol: { fill: { color } } }) as LayerStyle;
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
    useMapMock.mockReturnValue({ current: { getMap: () => fakeMap } });
  });

  it("an edit re-renders only the edited layer's child", async () => {
    const store = new EditorStore({
      saver: new StyleSaver({ transport, document: style("#111111"), revision: 1 }),
    });
    const layers = [layer("1", "#aaaaaa"), layer("2", "#bbbbbb")];
    render(<StyledLayers layers={layers} editing={[{ key: "2", store }]} locale="de" />);
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
    render(<StyledLayers layers={[layer("1", "#aaaaaa")]} locale="en" />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(syncMock).not.toHaveBeenCalled();
    loaded = true;
    act(() => listeners.get("styledata")?.());
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
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
