import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStyleData } from "@/hooks/style/useStyleData";

const getLayerUniqueValues = vi.fn(async () => ({
  items: [
    { value: "park", count: 3 },
    { value: "school", count: 2 },
  ],
  total: 2,
}));
const getLayerClassBreaks = vi.fn(async () => ({ min: 12, max: 9800, mean: 400, breaks: [9800] }));

// The vector requests by the dataset they ask about ("" asks nothing).
const asked = { queryables: [] as string[], count: [] as Array<string | undefined>, sample: [] as string[] };
vi.mock("@/lib/api/layers", () => ({
  useLayerQueryables: (layerId: string) => {
    asked.queryables.push(layerId);
    return {
      queryables: {
        properties: {
          geometry: { type: "geometry" },
          id: { type: "integer" },
          count: { type: "integer" },
          name: { type: "string" },
          area: { type: "number" },
          ok: { type: "boolean" },
          day: { type: "string", format: "date" },
          ts: { type: "string", format: "date-time" },
        },
      },
      isLoading: false,
    };
  },
  getLayerUniqueValues: (...args: unknown[]) => getLayerUniqueValues(...(args as [])),
  getLayerClassBreaks: (...args: unknown[]) => getLayerClassBreaks(...(args as [])),
}));
const useRasterInfo = vi.fn((datasetId?: string) => ({
  info: datasetId
    ? { bands: 1, bits: [32], noData: -9999, colorTable: false, integer: false, stats: [] }
    : undefined,
}));
vi.mock("@/lib/api/rasters", () => ({
  useRasterInfo: (datasetId?: string) => useRasterInfo(datasetId),
}));
vi.mock("@/lib/api/assets", () => ({
  useAssets: () => ({ assets: [{ id: "u1", url: "https://assets.example/u1.png", file_name: "u1.png" }] }),
}));
vi.mock("@/lib/api/processes", () => ({
  useFeatureCount: (layerId?: string) => {
    asked.count.push(layerId);
    return { featureCount: 375 };
  },
}));
vi.mock("@/components/map/popover/sampleFeature", () => ({
  useSampleFeature: (layerId: string) => {
    asked.sample.push(layerId);
    return { feature: { properties: { name: "Park", count: 3 } } };
  },
}));

beforeEach(() => {
  getLayerUniqueValues.mockClear();
  getLayerClassBreaks.mockClear();
  asked.queryables = [];
  asked.count = [];
  asked.sample = [];
});

describe("useStyleData", () => {
  it("field types map for the compiler", () => {
    const { result } = renderHook(() => useStyleData({ id: "layer-1", geometry: "polygon" }));
    expect(result.current.fieldTypes).toEqual({
      count: "integer",
      name: "string",
      area: "number",
      ok: "boolean",
      day: "date",
      ts: "datetime",
    });
    expect(result.current.fields.map((f) => [f.name, f.label])).toContainEqual(["count", "count"]);
    expect(result.current.sample).toEqual({ name: "Park", count: 3 });
    expect(result.current.featureCount).toBe(375);
  });

  it("profiles load only when asked", async () => {
    const { result } = renderHook(() => useStyleData({ id: "layer-1" }));
    expect(getLayerUniqueValues).not.toHaveBeenCalled();
    expect(getLayerClassBreaks).not.toHaveBeenCalled();
    act(() => void result.current.profile("name"));
    await waitFor(() =>
      expect(result.current.profile("name")).toEqual({ values: ["park", "school"], count: 2 })
    );
    expect(getLayerUniqueValues).toHaveBeenCalledTimes(1);
    act(() => void result.current.profile("area"));
    await waitFor(() => expect(result.current.profile("area")).toEqual({ min: 12, max: 9800 }));
    expect(getLayerClassBreaks).toHaveBeenCalledTimes(1);
    expect(getLayerUniqueValues).toHaveBeenCalledTimes(1);
  });

  it("a profile arriving changes neither the data nor its profile function", async () => {
    const { result } = renderHook(() => useStyleData({ id: "layer-1" }));
    const before = result.current;
    const seen = vi.fn();
    const unsubscribe = result.current.profiles.subscribe(seen);
    act(() => void result.current.profile("area"));
    await waitFor(() => expect(result.current.profiles.get("area")).toEqual({ min: 12, max: 9800 }));
    expect(seen).toHaveBeenCalled();
    expect(result.current).toBe(before);
    unsubscribe();
  });

  it("the panel's raster data come from the raster service's info of the dataset; no fields are asked", async () => {
    const { result } = renderHook(() =>
      useStyleData({ id: "layer-r", source: { kind: "cog", url: "https://x/dem.tif" } })
    );
    expect(result.current.raster?.dataset).toBe("layer-r");
    await waitFor(() => expect(result.current.raster?.info?.bands).toBe(1));
    expect(useRasterInfo).toHaveBeenCalledWith("layer-r");
    expect(result.current.service).toBeUndefined();
  });

  it("a raster file's fields are its cell's: the value, its class and every band", async () => {
    useRasterInfo.mockReturnValueOnce({
      info: { bands: 2, bits: [8, 8], noData: undefined, colorTable: false, integer: true, stats: [] },
    } as never);
    const { result } = renderHook(() =>
      useStyleData({ id: "layer-r", source: { kind: "cog", url: "https://x/rgb.tif" } })
    );
    expect(result.current.fields.map((f) => [f.name, f.type])).toEqual([
      ["value", "number"],
      ["class", "string"],
      ["band_1", "number"],
      ["band_2", "number"],
    ]);
    expect(result.current.fieldTypes).toEqual({
      value: "number",
      class: "string",
      band_1: "number",
      band_2: "number",
    });
  });

  it("a map service gives how many layers it draws and its first legend", () => {
    const { result } = renderHook(() =>
      useStyleData({
        id: "layer-w",
        source: {
          kind: "wms",
          url: "https://wms.example/?bbox={bbox-epsg-3857}",
          layers: ["a", "b"],
          legendUrls: ["https://wms.example/legend-a.png", "https://wms.example/legend-b.png"],
        },
      })
    );
    expect(result.current.service).toEqual({
      kind: "wms",
      url: "https://wms.example/?bbox={bbox-epsg-3857}",
      layers: 2,
      layerNames: ["a", "b"],
      styles: [],
      legendUrl: "https://wms.example/legend-a.png",
    });
    expect(result.current.raster).toBeUndefined();
  });

  it("a raster layer asks for no queryables and no feature count", () => {
    renderHook(() => useStyleData({ id: "layer-r", source: { kind: "cog", url: "https://x/dem.tif" } }));
    renderHook(() =>
      useStyleData({
        id: "layer-w",
        source: { kind: "wms", url: "https://wms.example/?bbox={bbox-epsg-3857}" },
      })
    );
    expect(asked.queryables.filter(Boolean)).toEqual([]);
    expect(asked.count.filter(Boolean)).toEqual([]);
    expect(asked.sample.filter(Boolean)).toEqual([]);
    // A vector layer asks for all three.
    renderHook(() => useStyleData({ id: "layer-1" }));
    expect(asked.queryables).toContain("layer-1");
    expect(asked.count).toContain("layer-1");
    expect(asked.sample).toContain("layer-1");
  });

  it("a vector layer has neither", () => {
    const { result } = renderHook(() => useStyleData({ id: "layer-1" }));
    expect(result.current.raster).toBeUndefined();
    expect(result.current.service).toBeUndefined();
  });
});
