import { describe, expect, it, vi } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type RasterColorSpec, rasterColorSpec } from "@/lib/style/raster/color";
import { rasterToken } from "@/lib/style/raster/token";
import {
  type RasterTileset,
  type RasterValues,
  type ReliefStop,
  reliefColor,
  reliefStops,
  valueTilesUrl,
  verticalScale,
} from "@/lib/style/raster/values";

import { maplibreErrors } from "./maplibre";

const { stopLimit } = vi.hoisted(() => ({ stopLimit: { reached: false } }));

vi.mock("@/lib/style/raster/values", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/style/raster/values")>();
  return {
    ...actual,
    reliefStops: (...args: Parameters<typeof actual.reliefStops>) =>
      stopLimit.reached ? null : actual.reliefStops(...args),
  };
});

const ROOT = "https://geo/collections/d1/raster";
const COVERAGE = "https://geo/collections/d1/coverage/tiles/WebMercatorQuad";
const SOURCE: Extract<CompileInput["source"], { type: "raster" }> = {
  type: "raster",
  id: "s",
  tiles: `${ROOT}/tiles/{z}/{x}/{y}.webp`,
  coverage: COVERAGE,
  version: "7",
};
/** The tileset description of a float band of 181 to 440 m. */
const STEP = 2 ** -12;
const VALUES: RasterValues = {
  encoding: { redFactor: 65536 * STEP, greenFactor: 256 * STEP, blueFactor: STEP, baseShift: -(150 - STEP) },
  range: [181, 440],
  integer: false,
  version: "7-e1",
  maxzoom: 12,
};
const LOADED = { ...SOURCE, values: VALUES };
/** The file's west, south, east and north in degrees. */
const BOUNDS: [number, number, number, number] = [13.08, 52.33, 13.77, 52.68];
const compile = (style: object, source: CompileInput["source"] = LOADED) =>
  compileLayer({ id: "9", style: { version: "1.0.0", kind: "raster", ...style } as LayerStyle, source });
const valid = (out: ReturnType<typeof compileLayer>) =>
  expect(maplibreErrors(out.layers, out.sources)).toEqual([]);

/** The coloring a compiled layer's tile URL carries. */
function coloringOf(out: ReturnType<typeof compileLayer>, id = "s"): Record<string, unknown> {
  const url = new URL((out.sources[id] as { tiles: string[] }).tiles[0].replace("{z}/{x}/{y}", "0/0/0"));
  const token = url.searchParams.get("style") ?? "";
  const json = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as Record<string, unknown>;
}

/** The query of a compiled layer's value tiles. */
const queryOf = (out: ReturnType<typeof compileLayer>, id = "s") =>
  new URL((out.sources[id] as { tiles: string[] }).tiles[0].replace("{z}/{y}/{x}", "0/0/0")).searchParams;

const paintOf = (out: ReturnType<typeof compileLayer>, id: string) =>
  out.layers.find((l) => l.id === id)?.paint as Record<string, unknown>;

const valueRender = (render: object) =>
  rasterColorSpec(render as never) as Exclude<RasterColorSpec, { kind: "rgb" }>;

describe("raster files drawn as images by the raster service", () => {
  it("an image is drawn from the service's tiles, with the image adjustments", () => {
    const out = compile({ opacity: 0.8, brightness: 0.1, saturation: 0.2, render: { type: "image" } });
    const tiles = (out.sources.s as { tiles: string[] }).tiles;
    // 512 px tiles: a quarter of the requests of 256 px ones for the same view.
    expect(out.sources.s).toEqual({ type: "raster", tiles, tileSize: 512 });
    expect(tiles[0]).toMatch(
      /^https:\/\/geo\/collections\/d1\/raster\/tiles\/\{z\}\/\{x\}\/\{y\}\.webp\?style=[\w-]+&v=7&tilesize=512$/
    );
    expect(coloringOf(out)).toEqual({ v: 1, kind: "rgb", bands: null, noData: [] });
    expect(out.layers).toEqual([
      {
        id: "9-raster",
        type: "raster",
        source: "s",
        paint: { "raster-opacity": 0.8, "raster-brightness-min": 0.1, "raster-saturation": 0.2 },
      },
    ]);
    expect(out.unsupported).toEqual([]);
    valid(out);
  });

  it("other bands as red, green and blue travel in the token", () => {
    expect(coloringOf(compile({ render: { type: "image", bands: [4, 1, 2] } }))).toEqual({
      v: 1,
      kind: "rgb",
      bands: [4, 1, 2],
      noData: [],
    });
  });

  it("categories without classes draw the file's own colors as an image, sharp", () => {
    const out = compile({ render: { type: "categorical" } });
    expect(coloringOf(out)).toMatchObject({ kind: "rgb", bands: null });
    expect(out.layers[0].paint).toEqual({ "raster-resampling": "nearest" });
  });

  it("the token is canonical: the same coloring gives the same tile URL", () => {
    const a = compile({ render: { type: "image", bands: [3, 1, 2], no_data: { values: [0] } } });
    const b = compile({ render: { no_data: { values: [0] }, bands: [3, 1, 2], type: "image" } });
    expect((a.sources.s as { tiles: string[] }).tiles).toEqual((b.sources.s as { tiles: string[] }).tiles);
  });

  it("an image never waits for values, nor for a description its source does not name", () => {
    expect(compile({ render: { type: "image" } }, SOURCE).layers.map((l) => l.id)).toEqual(["9-raster"]);
  });

  it("an image whose source names its colored tiles' description draws once that has answered", () => {
    const named = { ...SOURCE, tileset: `${ROOT}/tiles`, bounds: BOUNDS };
    // Not answered yet: no source, no tile asked for, nothing unsupported.
    const waiting = compile({ render: { type: "image" } }, named);
    expect(waiting.sources).toEqual({});
    expect(waiting.layers).toEqual([]);
    expect(waiting.unsupported).toEqual([]);
    // None (it failed): drawn as before, with the layer's own extent and no native zoom.
    const failed = compile({ render: { type: "image" } }, { ...named, image: null });
    expect(failed.sources.s).toMatchObject({ type: "raster", bounds: BOUNDS });
    expect(failed.sources.s).not.toHaveProperty("maxzoom");
    expect(failed.layers.map((l) => l.id)).toEqual(["9-raster"]);
    // A value render over image tiles waits for its values, not for this description.
    const unknown: RasterValues = { ...VALUES, range: null };
    const colors = compile(
      { render: { type: "continuous", palette: "goat:elevation", domain: [200, 450] } },
      { ...named, values: unknown }
    );
    expect(colors.sources.s).toMatchObject({ type: "raster", maxzoom: 12 });
  });

  it("an image asks only for the tiles that touch the file's bounds, when its source knows them", () => {
    const out = compile({ render: { type: "image" } }, { ...SOURCE, bounds: BOUNDS });
    expect(out.sources.s).toMatchObject({ type: "raster", tileSize: 512, bounds: BOUNDS });
    valid(out);
  });

  it("an image stops at the file's native zoom and takes its edges and version from the colored tiles' description", () => {
    const image: RasterTileset = { version: "7-0a1b2c3d-e3", maxzoom: 16, bounds: BOUNDS };
    const style = { resampling: "nearest", render: { type: "image" } };
    const out = compile(style, { ...SOURCE, bounds: [0, 0, 1, 1], image });
    const tiles = (out.sources.s as { tiles: string[] }).tiles;
    // Past zoom 16 MapLibre magnifies the deepest tiles with the layer's resampling; the version lets caches keep them.
    expect(out.sources.s).toEqual({ type: "raster", tiles, tileSize: 512, maxzoom: 16, bounds: BOUNDS });
    expect(tiles[0]).toMatch(/\.webp\?style=[\w-]+&v=7-0a1b2c3d-e3&tilesize=512$/);
    expect(out.layers[0].paint).toEqual({ "raster-resampling": "nearest" });
    valid(out);
    // A description without bounds (none on earth) is a statement: the stored extent does not stand in.
    const across = compile(style, { ...SOURCE, bounds: BOUNDS, image: { version: "7-e3", maxzoom: 16 } });
    expect(across.sources.s).not.toHaveProperty("bounds");
    expect(across.sources.s).toMatchObject({ maxzoom: 16 });
    // Until it is loaded the image draws as before: the stored extent, no native zoom, the source's version.
    const before = compile(style, { ...SOURCE, bounds: BOUNDS });
    expect(before.sources.s).not.toHaveProperty("maxzoom");
    expect((before.sources.s as { tiles: string[] }).tiles[0]).toContain("&v=7&");
  });
});

describe("raster files colored in the browser over value tiles", () => {
  it("a continuous raster draws color-relief over value tiles: one raster-dem source with the custom encoding", () => {
    const render = { type: "continuous", band: 1, palette: "goat:elevation", domain: [200, 450] };
    const out = compile({ render });
    expect(out.sources).toEqual({
      s: {
        type: "raster-dem",
        tiles: [valueTilesUrl(COVERAGE, { band: 1, resampling: "nearest" }, VALUES)],
        tileSize: 512,
        encoding: "custom",
        ...VALUES.encoding,
        maxzoom: 12,
      },
    });
    expect((out.sources.s as { tiles: string[] }).tiles[0]).toBe(
      `${COVERAGE}/{z}/{y}/{x}?f=webp&band=1&resampling=nearest&tilesize=512&base=${150 - STEP}&step=${STEP}&v=7-e1`
    );
    const stops = reliefStops(valueRender(render), VALUES) as ReliefStop[];
    expect(out.layers).toEqual([
      {
        id: "9-relief",
        type: "color-relief",
        source: "s",
        paint: { "color-relief-color": reliefColor(stops, VALUES), resampling: "nearest" },
      },
    ]);
    expect(out.unsupported).toEqual([]);
    valid(out);
  });

  it("value tiles ask only for the tiles that touch the file's bounds, from their description", () => {
    const render = { type: "continuous", band: 1, palette: "goat:elevation", domain: [200, 450] };
    const out = compile({ render }, { ...SOURCE, values: { ...VALUES, bounds: BOUNDS } });
    expect(out.sources.s).toMatchObject({ type: "raster-dem", tileSize: 512, bounds: BOUNDS });
    valid(out);
    // Without known bounds the source is drawn as before: no bounds at all.
    expect(compile({ render }).sources.s).not.toHaveProperty("bounds");
    // The description's bounds, read from the file's header, win over those the layer holds.
    const both = compile(
      { render },
      { ...SOURCE, bounds: [0, 0, 1, 1], values: { ...VALUES, bounds: BOUNDS } }
    );
    expect(both.sources.s).toMatchObject({ bounds: BOUNDS });
    // A description without bounds (none on earth, across the antimeridian) is a statement: the stored extent does not
    // stand in for it.
    expect(compile({ render }, { ...LOADED, bounds: BOUNDS }).sources.s).not.toHaveProperty("bounds");
    // A hillshade over image tiles: both sources take the description's bounds.
    stopLimit.reached = true;
    try {
      const shaded = compile(
        { render: { ...render, type: "hillshade" } },
        { ...SOURCE, values: { ...VALUES, bounds: BOUNDS } }
      );
      expect(shaded.sources.s).toMatchObject({ type: "raster", tileSize: 512, bounds: BOUNDS });
      expect(shaded.sources["s-values"]).toMatchObject({ type: "raster-dem", tileSize: 512, bounds: BOUNDS });
      expect((shaded.sources.s as { tiles: string[] }).tiles[0]).toMatch(/&tilesize=512$/);
      valid(shaded);
    } finally {
      stopLimit.reached = false;
    }
  });

  it("stops, classes, categories and formulas draw color-relief, and a ramp without a domain spreads over the range", () => {
    for (const render of [
      { type: "continuous" },
      {
        type: "continuous",
        palette: "goat:elevation",
        computed: { at: "t", data: "url:x", domain: [181, 440] },
      },
      {
        type: "continuous",
        stops: [
          { value: 200, color: "#000000" },
          { value: 400, color: "#ffffff" },
        ],
        interpolate: "nearest",
      },
      {
        type: "continuous",
        palette: "goat:elevation",
        classify: { method: "quantile", count: 2, classes: [{ to: 300 }, { from: 300 }] },
      },
      { type: "categorical", classes: [{ value: 200, color: "#4a90c2" }], other_color: "#cccccc" },
      {
        type: "continuous",
        band: { name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" },
        palette: "goat:green",
        domain: [-1, 1],
      },
    ]) {
      const out = compile({ render });
      expect([render, out.layers.map((l) => l.type), out.unsupported]).toEqual([
        render,
        ["color-relief"],
        [],
      ]);
      valid(out);
    }
    expect(
      queryOf(compile({ render: { type: "continuous", band: { expression: "b2 - b1" } } })).get("formula")
    ).toBe("b2 - b1");
    // Without a domain the ramp spreads over the band's range: its first color at 181, its last at 440.
    const colors = reliefStops(valueRender({ type: "continuous", palette: ["#000000", "#ffffff"] }), VALUES);
    expect(colors?.slice(1)).toEqual([
      [1, "rgba(0, 0, 0, 1)"],
      [(181 - 150 + STEP) / STEP, "rgba(0, 0, 0, 1)"],
      [(440 - 150 + STEP) / STEP, "rgba(255, 255, 255, 1)"],
      [16_777_215, "rgba(255, 255, 255, 1)"],
    ]);
  });

  it("without its values yet a value render draws nothing and is not unsupported", () => {
    for (const render of [
      { type: "continuous", palette: "goat:elevation" },
      { type: "categorical", classes: [{ value: 1, color: "#4a90c2" }] },
      { type: "hillshade" },
      { type: "hillshade", palette: "goat:elevation" },
    ]) {
      const out = compile({ render }, SOURCE);
      expect([render, out.sources, out.layers, out.unsupported]).toEqual([render, {}, [], []]);
    }
  });

  it("a color edit changes only paint, a band edit the source", () => {
    const render = { type: "continuous", band: 1, palette: "goat:elevation", domain: [200, 450] };
    const before = compile({ render });
    const recolored = compile({ render: { ...render, palette: "d3:viridis", domain: [190, 420] } });
    expect(recolored.sources).toEqual(before.sources);
    expect(recolored.layers.map((l) => ({ ...l, paint: undefined }))).toEqual(
      before.layers.map((l) => ({ ...l, paint: undefined }))
    );
    expect(paintOf(recolored, "9-relief")["color-relief-color"]).not.toEqual(
      paintOf(before, "9-relief")["color-relief-color"]
    );
    const band = compile({ render: { ...render, band: 2 } });
    expect(band.sources).not.toEqual(before.sources);
    expect(queryOf(band).get("band")).toBe("2");
  });

  it("color scales draw crisp cells by default, the style's resampling wins", () => {
    for (const render of [
      { type: "categorical", classes: [{ value: 200, color: "#4a90c2" }] },
      { type: "continuous" },
      { type: "continuous", stops: [{ value: 200, color: "#000000" }] },
      { type: "continuous", classify: { method: "manual", classes: [{ to: 300 }, { from: 300 }] } },
    ]) {
      const crisp = compile({ render });
      expect([render, paintOf(crisp, "9-relief").resampling, queryOf(crisp).get("resampling")]).toEqual([
        render,
        "nearest",
        "nearest",
      ]);
      valid(crisp);
      const smooth = compile({ resampling: "linear", render });
      expect([render, paintOf(smooth, "9-relief").resampling, queryOf(smooth).get("resampling")]).toEqual([
        render,
        undefined,
        "bilinear",
      ]);
    }
    // Images and shading alone stay smooth.
    expect(compile({ render: { type: "image" } }).layers[0].paint).toEqual({});
    const shading = compile({ render: { type: "hillshade" } });
    expect(paintOf(shading, "9-hillshade")).not.toHaveProperty("resampling");
    expect(queryOf(shading).get("resampling")).toBe("bilinear");
    const sharpShading = compile({ resampling: "nearest", render: { type: "hillshade" } });
    expect(paintOf(sharpShading, "9-hillshade").resampling).toBe("nearest");
    expect(queryOf(sharpShading).get("resampling")).toBe("nearest");
  });

  it("a hillshade's colors are crisp over the smooth values the shading reads, unless the style says linear", () => {
    const render = { type: "hillshade", palette: "goat:elevation", domain: [181, 440] };
    const colored = compile({ render });
    expect(queryOf(colored).get("resampling")).toBe("bilinear");
    expect(paintOf(colored, "9-relief").resampling).toBe("nearest");
    expect(paintOf(colored, "9-hillshade")).not.toHaveProperty("resampling");
    const smooth = compile({ resampling: "linear", render });
    expect(queryOf(smooth).get("resampling")).toBe("bilinear");
    expect(paintOf(smooth, "9-relief")).not.toHaveProperty("resampling");
    const sharp = compile({ resampling: "nearest", render });
    expect(queryOf(sharp).get("resampling")).toBe("nearest");
    expect(paintOf(sharp, "9-relief").resampling).toBe("nearest");
    expect(paintOf(sharp, "9-hillshade").resampling).toBe("nearest");
  });

  it("opacity is color-relief-opacity, by zoom too", () => {
    expect(paintOf(compile({ opacity: 0.6, render: { type: "continuous" } }), "9-relief")).toMatchObject({
      "color-relief-opacity": 0.6,
    });
    expect(paintOf(compile({ render: { type: "continuous" } }), "9-relief")).not.toHaveProperty(
      "color-relief-opacity"
    );
    const zoomed = compile({
      opacity: {
        zoom: [
          [8, 0.2],
          [12, 1],
        ],
      },
      render: { type: "continuous" },
    });
    expect(paintOf(zoomed, "9-relief")["color-relief-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      8,
      0.2,
      12,
      1,
    ]);
    valid(zoomed);
  });

  it("hillshade draws on the value source; with colors the color-relief layer is under it on the same source", () => {
    const shading = compile({ render: { type: "hillshade" } });
    expect(Object.keys(shading.sources)).toEqual(["s"]);
    expect(shading.sources.s).toMatchObject({ type: "raster-dem", encoding: "custom" });
    expect(queryOf(shading).get("resampling")).toBe("bilinear");
    expect(shading.layers.map((l) => [l.id, l.type, (l as { source?: string }).source])).toEqual([
      ["9-hillshade", "hillshade", "s"],
    ]);
    valid(shading);
    const colored = compile({
      render: {
        type: "hillshade",
        palette: "goat:elevation",
        domain: [181, 440],
        classify: { method: "manual", classes: [{ to: 300 }, { from: 300 }] },
      },
    });
    expect(Object.keys(colored.sources)).toEqual(["s"]);
    expect(colored.layers.map((l) => [l.id, l.type, (l as { source?: string }).source])).toEqual([
      ["9-relief", "color-relief", "s"],
      ["9-hillshade", "hillshade", "s"],
    ]);
    valid(colored);
  });

  it("several lights are GDAL's four; the layer opacity goes into the shading's colors", () => {
    const out = compile({
      opacity: 0.6,
      render: {
        type: "hillshade",
        method: "multidirectional",
        direction: 315,
        altitude: 45,
        exaggeration: 0.6,
      },
    });
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0]).toMatchObject({
      id: "9-hillshade",
      type: "hillshade",
      source: "s",
      paint: {
        "hillshade-method": "multidirectional",
        "hillshade-illumination-direction": [225, 270, 315, 0],
        "hillshade-illumination-altitude": [45, 45, 45, 45],
        "hillshade-exaggeration": 0.6,
        "hillshade-shadow-color": Array(4).fill("rgba(0, 0, 0, 0.6)"),
        "hillshade-highlight-color": Array(4).fill("rgba(255, 255, 255, 0.6)"),
        "hillshade-illumination-anchor": "map",
      },
    });
    expect(out.layers[0].paint).not.toHaveProperty("hillshade-accent-color");
    valid(out);
  });

  it("standard hillshade takes the reference defaults and its accent; opacity by zoom fades the shading", () => {
    const out = compile({
      opacity: {
        zoom: [
          [8, 0.2],
          [12, 1],
        ],
      },
      render: { type: "hillshade" },
    });
    const paint = out.layers[0].paint as Record<string, unknown>;
    expect(paint["hillshade-method"]).toBe("standard");
    // The scene's light moves the shading through the global state; without it the hillshade's own light.
    expect(paint["hillshade-illumination-direction"]).toEqual([
      "coalesce",
      ["global-state", "sunAzimuth"],
      315,
    ]);
    expect(paint["hillshade-illumination-altitude"]).toEqual([
      "coalesce",
      ["global-state", "sunAltitude"],
      45,
    ]);
    expect(paint["hillshade-illumination-anchor"]).toBe("map");
    expect(paint["hillshade-shadow-color"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      8,
      "rgba(0, 0, 0, 0.2)",
      12,
      "rgba(0, 0, 0, 1)",
    ]);
    expect(paint).toHaveProperty("hillshade-accent-color");
    valid(out);
  });

  it("a hillshade raises a low relief by the largest power of two that keeps it within 1000, at most 16", () => {
    // The relief is the band's minimum to maximum, as the values' description gives it.
    const cases: Array<[[number, number] | null, number]> = [
      [null, 1],
      [[0, 0], 1],
      [[0, 3000], 1],
      [[0, 1000], 1],
      [[0, 999], 1],
      [[0, 500], 2],
      // A DEM of Berlin and its surroundings (Copernicus, 30 m): raised 4 times.
      [[-38.9, 189.1], 4],
      [[0, 125], 8],
      [[0, 50], 16],
      [[0, 0.5], 16],
    ];
    for (const [range, k] of cases) expect([range, verticalScale(range)]).toEqual([range, k]);
  });

  it("a hillshade raises flat terrain on its source alone: colors and tile addresses keep the file's values", () => {
    // 181 to 440 m: low relief, raised for the shading.
    const k = verticalScale(VALUES.range);
    expect(k).toBeGreaterThan(1);
    const scaled = Object.fromEntries(Object.entries(VALUES.encoding).map(([key, v]) => [key, v * k]));
    const render = { type: "hillshade", palette: "goat:elevation", domain: [181, 440] };
    const out = compile({ render });
    expect(out.sources.s).toMatchObject({ type: "raster-dem", encoding: "custom", ...scaled });
    // The tiles are asked for with the file's own encoding.
    expect(queryOf(out).get("base")).toBe(String(-VALUES.encoding.baseShift));
    expect(queryOf(out).get("step")).toBe(String(VALUES.encoding.blueFactor));
    // The colors sit on the raised values: each stop k times the value of its code.
    const stops = reliefStops(valueRender(render), VALUES) as ReliefStop[];
    expect(paintOf(out, "9-relief")["color-relief-color"]).toEqual(reliefColor(stops, VALUES, k));
    expect(reliefColor(stops, VALUES, k).slice(3)).toEqual(
      reliefColor(stops, VALUES)
        .slice(3)
        .map((v) => (typeof v === "number" ? v * k : v))
    );
    valid(out);
    // A color scale alone, and a hillshade of a file of unknown range, keep the file's heights.
    expect(
      compile({ render: { type: "continuous", palette: "goat:elevation", domain: [181, 440] } }).sources.s
    ).toMatchObject(VALUES.encoding);
    expect(
      compile({ render: { type: "hillshade" } }, { ...SOURCE, values: { ...VALUES, range: null } }).sources.s
    ).toMatchObject(VALUES.encoding);
  });

  it("zooms go on every layer", () => {
    const out = compile({
      min_zoom: 10,
      max_zoom: 18,
      render: { type: "hillshade", palette: "goat:elevation", domain: [0, 9] },
    });
    expect(out.layers).toHaveLength(2);
    for (const layer of out.layers) expect(layer).toMatchObject({ minzoom: 10, maxzoom: 18 });
  });

  it("past the stop limit the token tiles draw instead", () => {
    // No coloring short enough for a URL needs that many stops: the limit is lowered for this test.
    const render = { type: "continuous", palette: ["#000000", "#ffffff"], domain: [200, 400] };
    stopLimit.reached = true;
    try {
      const out = compile({ opacity: 0.5, render });
      expect(out.unsupported).toEqual([]);
      // The value tiles' description stands for the colored tiles': native zoom and version.
      expect(out.sources).toEqual({
        s: {
          type: "raster",
          tiles: [
            `${ROOT}/tiles/{z}/{x}/{y}.webp?style=${rasterToken(valueRender(render))}&v=7-e1&tilesize=512`,
          ],
          tileSize: 512,
          maxzoom: 12,
        },
      });
      expect(out.layers).toEqual([
        {
          id: "9-raster",
          type: "raster",
          source: "s",
          paint: { "raster-opacity": 0.5, "raster-resampling": "nearest" },
        },
      ]);
      valid(out);
      // A hillshade over such colors keeps its value source next to the token tiles.
      const shaded = compile({ render: { ...render, type: "hillshade" } });
      expect(Object.keys(shaded.sources)).toEqual(["s", "s-values"]);
      expect(shaded.sources["s-values"]).toMatchObject({ type: "raster-dem", encoding: "custom" });
      expect(shaded.layers.map((l) => [l.id, (l as { source?: string }).source])).toEqual([
        ["9-raster", "s"],
        ["9-hillshade", "s-values"],
      ]);
      valid(shaded);
    } finally {
      stopLimit.reached = false;
    }
  });

  it("colors over float values of an unknown range draw the service's image tiles; whole numbers stay values", () => {
    // Without a range geoapi's codes cover only a stand-in span, so they cannot place the colors.
    const unknown: RasterValues = { ...VALUES, range: null };
    for (const render of [
      { type: "continuous", palette: "goat:elevation", domain: [200, 450] },
      { type: "continuous", classify: { method: "manual", classes: [{ to: 300 }, { from: 300 }] } },
      { type: "categorical", classes: [{ value: 200, color: "#4a90c2" }] },
    ]) {
      const out = compile({ render }, { ...SOURCE, values: unknown });
      expect([render, out.layers.map((l) => l.id), out.unsupported]).toEqual([render, ["9-raster"], []]);
      expect((out.sources.s as { tiles: string[] }).tiles[0]).toContain(
        `${ROOT}/tiles/{z}/{x}/{y}.webp?style=`
      );
      valid(out);
    }
    // A hillshade's colors too; its shading stays on the values.
    const shaded = compile(
      { render: { type: "hillshade", palette: "goat:elevation", domain: [200, 450] } },
      { ...SOURCE, values: unknown }
    );
    expect(shaded.layers.map((l) => [l.id, (l as { source?: string }).source])).toEqual([
      ["9-raster", "s"],
      ["9-hillshade", "s-values"],
    ]);
    expect(
      compile({ render: { type: "hillshade" } }, { ...SOURCE, values: unknown }).layers.map((l) => [
        l.id,
        (l as { source?: string }).source,
      ])
    ).toEqual([["9-hillshade", "s"]]);
    // Whole numbers are stored exactly, range or not.
    const whole: RasterValues = {
      ...VALUES,
      encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 1 },
      range: null,
      integer: true,
    };
    expect(
      compile({ render: { type: "continuous", domain: [0, 255] } }, { ...SOURCE, values: whole }).layers.map(
        (l) => l.id
      )
    ).toEqual(["9-relief"]);
  });

  it("past the stop limit a token over 6 KB is not sent: the style needs the raster service's stored styles", () => {
    // Categories apart from each other take four stops each on a float band.
    const classes = Array.from({ length: 1100 }, (_, i) => ({
      value: 2 * i,
      color: "#123456",
      name: `Class ${i}`,
    }));
    const wide: RasterValues = {
      ...VALUES,
      encoding: {
        redFactor: 65536 * 2 ** -10,
        greenFactor: 256 * 2 ** -10,
        blueFactor: 2 ** -10,
        baseShift: 1,
      },
      range: [0, 2200],
    };
    const out = compile({ render: { type: "categorical", classes } }, { ...SOURCE, values: wide });
    expect(out.unsupported).toEqual(["raster_service"]);
    expect(out.layers).toEqual([]);
    // Four hundred categories fit in color-relief.
    const fewer = compile(
      { render: { type: "categorical", classes: classes.slice(0, 400) } },
      { ...SOURCE, values: wide }
    );
    expect(fewer.unsupported).toEqual([]);
    expect(fewer.layers.map((l) => l.id)).toEqual(["9-relief"]);
  });
});
