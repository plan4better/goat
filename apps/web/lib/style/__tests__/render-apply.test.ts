import { renderHook } from "@testing-library/react";
import type { Map as MaplibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type PreviewMap, applyCompiled, withTileParams } from "@/lib/style/render/apply";
import { useLivePreview } from "@/lib/style/render/useLivePreview";

const loadImage = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/transformers/map-image", () => ({ loadImage: (...args: unknown[]) => loadImage(...args) }));

/** A map that records what the preview asks of it. */
function fakeMap() {
  const calls: string[] = [];
  const layers = new Map<string, unknown>();
  const sources = new Map<string, { setTiles: (t: string[]) => void; setData: (d: unknown) => void }>();
  let resolver: ((id: string) => void | Promise<void>) | null = null;
  const map = {
    calls,
    resolve: (id: string) => resolver?.(id),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => {
      calls.push(`addSource ${id}`);
      sources.set(id, {
        setTiles: (tiles: string[]) => calls.push(`setTiles ${id} ${tiles.join(",")}`),
        setData: () => calls.push(`setData ${id}`),
      });
    },
    removeSource: (id: string) => {
      calls.push(`removeSource ${id}`);
      sources.delete(id);
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: { id: string }, before?: string) => {
      calls.push(`addLayer ${layer.id}${before ? ` before ${before}` : ""}`);
      layers.set(layer.id, layer);
    },
    removeLayer: (id: string) => {
      calls.push(`removeLayer ${id}`);
      layers.delete(id);
    },
    moveLayer: (id: string, before?: string) => calls.push(`moveLayer ${id} ${before ?? ""}`),
    setPaintProperty: (id: string, key: string) => calls.push(`setPaintProperty ${id} ${key}`),
    setLayoutProperty: (id: string, key: string) => calls.push(`setLayoutProperty ${id} ${key}`),
    setFilter: (id: string) => calls.push(`setFilter ${id}`),
    setLayerZoomRange: (id: string) => calls.push(`setLayerZoomRange ${id}`),
    setGlobalStateProperty: (name: string) => calls.push(`setGlobalStateProperty ${name}`),
    setMissingStyleImageResolver: (r: typeof resolver) => {
      calls.push("setMissingStyleImageResolver");
      resolver = r;
    },
    hasImage: () => false,
  };
  return map as typeof map & PreviewMap;
}

const input = (style: object, extra: Partial<CompileInput> = {}): CompileInput => ({
  id: "9",
  style: style as LayerStyle,
  geometry: "polygon",
  fields: { name: "string" },
  source: { type: "tiles", id: "src-9", tiles: ["https://geoapi/collections/9/tiles/{z}/{x}/{y}"] },
  ...extra,
});
const compiled = (style: object, extra: Partial<CompileInput> = {}) =>
  withTileParams(compileLayer(input(style, extra)));

describe("applyCompiled", () => {
  beforeEach(() => loadImage.mockClear());

  it("a GeoJSON object source updates with setData, not a re-add", () => {
    const map = fakeMap();
    const style = { version: 1, kind: "vector", symbol: { marker: { color: "#cc0000" } } };
    const point = (x: number) => ({
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          id: 1,
          properties: {},
          geometry: { type: "Point" as const, coordinates: [x, 0] },
        },
      ],
    });
    const over = (x: number) =>
      compiled(style, { geometry: "point", source: { type: "points", id: "pending-9", data: point(x) } });
    const first = over(1);
    applyCompiled(map, null, first);
    map.calls.length = 0;
    applyCompiled(map, first, over(2));
    expect(map.calls).toEqual(["setData pending-9"]);
  });

  it("a paint change calls only setPaintProperty", () => {
    const map = fakeMap();
    const first = compiled({ version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } });
    applyCompiled(map, null, first);
    map.calls.length = 0;
    applyCompiled(
      map,
      first,
      compiled({ version: 1, kind: "vector", symbol: { fill: { color: "#ff0000" } } })
    );
    expect(map.calls).toEqual(["setPaintProperty 9-fill fill-color"]);
  });

  it("unchanged output calls nothing", () => {
    const map = fakeMap();
    const first = compiled({ version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } });
    applyCompiled(map, null, first);
    map.calls.length = 0;
    applyCompiled(
      map,
      first,
      compiled({ version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } })
    );
    expect(map.calls).toEqual([]);
  });

  it("turning labels on loads the source again with label=true, its layers with it", () => {
    const map = fakeMap();
    const first = compiled({ version: 1, kind: "vector", symbol: { fill: {} } });
    applyCompiled(map, null, first);
    map.calls.length = 0;
    const labelled = compiled({
      version: 1,
      kind: "vector",
      symbol: { fill: {}, label: { text: "{name}" } },
    });
    applyCompiled(map, first, labelled);
    // setTiles would race the new label layer's reload in MapLibre and keep the tiles without label points.
    expect(map.calls.some((c) => c.startsWith("setTiles"))).toBe(false);
    expect(map.calls).toEqual([
      "removeLayer 9-fill",
      "removeSource src-9",
      "addSource src-9",
      "addLayer 9-fill",
      "addLayer 9-label",
    ]);
  });

  it("a new part adds its layer before beforeId", () => {
    const map = fakeMap();
    const first = compiled({ version: 1, kind: "vector", symbol: { fill: {} } });
    applyCompiled(map, null, first, { beforeId: "basemap-labels" });
    expect(map.calls).toContain("addLayer 9-fill before basemap-labels");
    map.calls.length = 0;
    applyCompiled(
      map,
      first,
      compiled({ version: 1, kind: "vector", symbol: { fill: {}, outline: { width: 2 } } }),
      {
        beforeId: "basemap-labels",
      }
    );
    expect(map.calls).toContain("addLayer 9-outline before basemap-labels");
  });

  it("a layer type change re-adds it in place", () => {
    const map = fakeMap();
    const circle = withTileParams(
      compileLayer(
        input(
          { version: 1, kind: "vector", symbol: { marker: {}, label: { text: "{name}" } } },
          { geometry: "point" }
        )
      )
    );
    applyCompiled(map, null, circle);
    map.calls.length = 0;
    const icon = withTileParams(
      compileLayer(
        input(
          {
            version: 1,
            kind: "vector",
            symbol: { marker: { shape: "icon", icon: "goat:park" }, label: { text: "{name}" } },
          },
          { geometry: "point" }
        )
      )
    );
    applyCompiled(map, circle, icon);
    expect(map.calls).toContain("removeLayer 9-marker");
    expect(map.calls).toContain("addLayer 9-icon before 9-label");
  });

  it("uploads resolve to their URL through the resolver", async () => {
    const map = fakeMap();
    const style = { version: 1, kind: "vector", symbol: { marker: { shape: "icon", icon: "asset:u1" } } };
    const out = withTileParams(
      compileLayer(
        input(style, {
          geometry: "point",
          resolveIcon: (ref) => (ref === "asset:u1" ? { url: "https://assets/u1.png", sdf: false } : null),
        })
      )
    );
    applyCompiled(map, null, out);
    applyCompiled(map, out, out);
    expect(map.calls.filter((c) => c === "setMissingStyleImageResolver")).toHaveLength(1);
    await map.resolve("asset:u1");
    expect(loadImage).toHaveBeenCalledWith(map, "https://assets/u1.png", "asset:u1", false, 24, 24, 4);
  });
});

describe("useLivePreview", () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("three changes in one frame apply once", () => {
    const map = fakeMap();
    const doc = (color: string) => input({ version: 1, kind: "vector", symbol: { fill: { color } } });
    const { rerender } = renderHook(({ value }) => useLivePreview(map as unknown as MaplibreMap, value), {
      initialProps: { value: doc("#111111") },
    });
    rerender({ value: doc("#222222") });
    rerender({ value: doc("#333333") });
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(map.calls.filter((c) => c.startsWith("addLayer"))).toEqual(["addLayer 9-fill"]);
    expect(map.calls.filter((c) => c.startsWith("setPaintProperty"))).toEqual([]);
  });
});

describe("raster tiles on the map", () => {
  const source = (id = "9"): CompileInput["source"] => ({
    type: "raster",
    id: `src-${id}`,
    tiles: `https://geo/collections/${id}/raster/tiles/{z}/{x}/{y}.webp`,
    dem: `https://geo/collections/${id}/raster/dem/{z}/{x}/{y}.webp`,
  });
  const raster = (palette: string, opacity = 1, id = "9") =>
    compileLayer({
      id,
      style: {
        version: 1,
        kind: "raster",
        opacity,
        render: { type: "continuous", palette, domain: [0, 9] },
      } as LayerStyle,
      source: source(id),
    });
  const tilesOf = (out: ReturnType<typeof compileLayer>, id = "src-9") =>
    (out.sources[id] as { tiles: string[] }).tiles.join(",");

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an unchanged coloring changes nothing; a paint change still goes through its setter", () => {
    const map = fakeMap();
    const first = raster("goat:elevation");
    applyCompiled(map, null, first);
    map.calls.length = 0;
    applyCompiled(map, first, raster("goat:elevation", 0.5));
    vi.advanceTimersByTime(500);
    expect(map.calls).toEqual(["setPaintProperty 9-raster raster-opacity"]);
  });

  it("changed colorings set the tiles once, after a quiet moment, with the last coloring", () => {
    const map = fakeMap();
    let prev = raster("goat:elevation");
    applyCompiled(map, null, prev);
    map.calls.length = 0;
    for (const palette of ["d3:viridis", "goat:green", "colorbrewer:BuGn"]) {
      const next = raster(palette);
      applyCompiled(map, prev, next);
      prev = next;
      vi.advanceTimersByTime(50);
    }
    expect(map.calls).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(map.calls).toEqual([`setTiles src-9 ${tilesOf(prev)}`]);
  });

  it("a layer taken off before the quiet moment sets no tiles", async () => {
    const { removeCompiled } = await import("@/lib/style/render/apply");
    const map = fakeMap();
    const first = raster("goat:elevation");
    applyCompiled(map, null, first);
    const next = raster("d3:viridis");
    applyCompiled(map, first, next);
    removeCompiled(map, next);
    map.calls.length = 0;
    vi.advanceTimersByTime(500);
    expect(map.calls).toEqual([]);
  });

  it("two raster layers set their own tiles", () => {
    const map = fakeMap();
    const a1 = raster("goat:elevation", 1, "a");
    const b1 = raster("goat:elevation", 1, "b");
    applyCompiled(map, null, a1);
    applyCompiled(map, null, b1);
    map.calls.length = 0;
    const a2 = raster("d3:viridis", 1, "a");
    const b2 = raster("goat:green", 1, "b");
    applyCompiled(map, a1, a2);
    applyCompiled(map, b1, b2);
    vi.advanceTimersByTime(250);
    expect(map.calls.sort()).toEqual(
      [`setTiles src-a ${tilesOf(a2, "src-a")}`, `setTiles src-b ${tilesOf(b2, "src-b")}`].sort()
    );
  });
});
