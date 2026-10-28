import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { maplibreErrors } from "./maplibre";

const ROOT = "https://geo/collections/d1/raster";
const SOURCE: CompileInput["source"] = {
  type: "raster",
  id: "s",
  tiles: `${ROOT}/tiles/{z}/{x}/{y}.webp`,
  dem: `${ROOT}/dem/{z}/{x}/{y}.webp`,
  version: "7",
};
const compile = (style: object, source: CompileInput["source"] = SOURCE) =>
  compileLayer({ id: "9", style: { version: 1, kind: "raster", ...style } as LayerStyle, source });
const valid = (out: ReturnType<typeof compileLayer>) =>
  expect(maplibreErrors(out.layers, out.sources)).toEqual([]);

/** The coloring a compiled layer's tile URL carries. */
function coloringOf(out: ReturnType<typeof compileLayer>, id = "s"): Record<string, unknown> {
  const url = new URL((out.sources[id] as { tiles: string[] }).tiles[0].replace("{z}/{x}/{y}", "0/0/0"));
  const token = url.searchParams.get("style") ?? "";
  const json = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as Record<string, unknown>;
}

describe("raster files from the raster service", () => {
  it("an image is drawn from the service's tiles, with the image adjustments", () => {
    const out = compile({ opacity: 0.8, brightness: 0.1, saturation: 0.2, render: { type: "image" } });
    const tiles = (out.sources.s as { tiles: string[] }).tiles;
    expect(out.sources.s).toMatchObject({ type: "raster", tileSize: 256 });
    expect(tiles[0]).toMatch(
      /^https:\/\/geo\/collections\/d1\/raster\/tiles\/\{z\}\/\{x\}\/\{y\}\.webp\?style=[\w-]+&v=7$/
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

  it("a continuous raster draws from the service with its coloring in the tile URL; categories draw sharp cells", () => {
    const out = compile({
      render: { type: "continuous", band: 1, palette: "goat:elevation", domain: [200, 450] },
    });
    expect(coloringOf(out)).toMatchObject({ kind: "ramp", band: 1, domain: [200, 450], outside: "clamp" });
    expect(out.layers[0].paint).toEqual({});
    valid(out);
    const categories = compile({
      render: { type: "categorical", classes: [{ value: 1, color: "#4a90c2" }] },
    });
    expect(categories.layers[0].paint).toEqual({ "raster-resampling": "nearest" });
    expect(coloringOf(categories)).toMatchObject({
      kind: "categories",
      classes: [{ value: 1, color: "#4a90c2" }],
    });
    expect(coloringOf(compile({ render: { type: "categorical" } }))).toMatchObject({
      kind: "rgb",
      bands: null,
    });
  });

  it("the token is canonical: the same coloring gives the same tile URL", () => {
    const a = compile({ render: { type: "continuous", palette: "goat:elevation", domain: [1, 2] } });
    const b = compile({ render: { domain: [1, 2], palette: "goat:elevation", type: "continuous" } });
    expect((a.sources.s as { tiles: string[] }).tiles).toEqual((b.sources.s as { tiles: string[] }).tiles);
  });

  it("a palette without a domain colors over the computed domain, or the band's range until it is computed", () => {
    const computed = compile({
      render: {
        type: "continuous",
        palette: "goat:elevation",
        computed: { at: "t", data: "url:x", domain: [181, 440] },
      },
    });
    expect(coloringOf(computed)).toMatchObject({ kind: "ramp", domain: [181, 440] });
    expect(coloringOf(compile({ render: { type: "continuous" } }))).toMatchObject({
      kind: "ramp",
      domain: null,
    });
    expect(compile({ render: { type: "continuous" } }).unsupported).toEqual([]);
  });

  it("a formula and computed classes are drawn, no longer unsupported", () => {
    const formula = compile({
      render: {
        type: "continuous",
        band: { name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" },
        palette: "goat:green",
        domain: [-1, 1],
      },
    });
    expect(formula.unsupported).toEqual([]);
    expect(coloringOf(formula)).toMatchObject({ kind: "ramp", band: "(b4 - b1) / (b4 + b1)" });
    const quantiles = compile({
      render: {
        type: "continuous",
        palette: "goat:elevation",
        classify: {
          method: "quantile",
          count: 2,
          classes: [
            { id: "a", to: 300, color: "#111111" },
            { id: "b", from: 300, color: "#222222" },
          ],
        },
      },
    });
    expect(quantiles.unsupported).toEqual([]);
    expect(coloringOf(quantiles)).toMatchObject({
      kind: "classes",
      classes: [
        { to: 300, color: "#111111" },
        { from: 300, color: "#222222" },
      ],
    });
  });

  it("computed classes without their bounds yet draw the color range meanwhile", () => {
    const out = compile({
      render: {
        type: "continuous",
        palette: "goat:elevation",
        domain: [0, 9],
        classify: { method: "quantile", count: 5 },
      },
    });
    expect(coloringOf(out)).toMatchObject({ kind: "ramp", domain: [0, 9] });
  });

  it("classes without a color take the classification's own palette, else the render's", () => {
    const own = compile({
      render: {
        type: "continuous",
        palette: "goat:elevation",
        domain: [0, 9],
        classify: { method: "manual", palette: ["#000000", "#ffffff"], classes: [{ to: 3 }, { from: 3 }] },
      },
    });
    expect(coloringOf(own)).toMatchObject({ classes: [{ color: "#000000" }, { color: "#ffffff" }] });
  });

  it("a token over 6 KB is not sent: the style needs the raster service's stored styles", () => {
    const classes = Array.from({ length: 400 }, (_, i) => ({
      value: i,
      color: "#123456",
      name: `Class ${i}`,
    }));
    const out = compile({ render: { type: "categorical", classes } });
    expect(out.unsupported).toEqual(["raster_service"]);
    expect(out.layers).toEqual([]);
  });

  it("terrain is MapLibre's hillshade over an elevation source; several lights are GDAL's four", () => {
    const out = compile({
      opacity: 0.6,
      render: {
        type: "terrain",
        method: "multidirectional",
        direction: 315,
        altitude: 45,
        exaggeration: 0.6,
      },
    });
    expect(out.sources).toEqual({
      "s-dem": {
        type: "raster-dem",
        tiles: ["https://geo/collections/d1/raster/dem/{z}/{x}/{y}.webp?v=7"],
        tileSize: 256,
        encoding: "terrarium",
      },
    });
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0]).toMatchObject({
      id: "9-hillshade",
      type: "hillshade",
      source: "s-dem",
      paint: {
        "hillshade-method": "multidirectional",
        "hillshade-illumination-direction": [225, 270, 315, 0],
        "hillshade-illumination-altitude": [45, 45, 45, 45],
        "hillshade-exaggeration": 0.6,
        "hillshade-shadow-color": Array(4).fill("rgba(0, 0, 0, 0.6)"),
        "hillshade-highlight-color": Array(4).fill("rgba(255, 255, 255, 0.6)"),
      },
    });
    expect(out.layers[0].paint).not.toHaveProperty("hillshade-accent-color");
    valid(out);
  });

  it("standard terrain takes the reference defaults and its accent; opacity by zoom fades the shading", () => {
    const out = compile({
      opacity: {
        zoom: [
          [8, 0.2],
          [12, 1],
        ],
      },
      render: { type: "terrain" },
    });
    const paint = out.layers[0].paint as Record<string, unknown>;
    expect(paint["hillshade-method"]).toBe("standard");
    expect(paint["hillshade-illumination-direction"]).toBe(315);
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

  it("terrain over colors: the color layer under the shading, an elevation source of its own", () => {
    const out = compile({
      render: {
        type: "terrain",
        palette: "goat:elevation",
        domain: [181, 440],
        classify: { method: "manual", classes: [{ to: 300 }, { from: 300 }] },
      },
    });
    expect(out.layers.map((l) => l.id)).toEqual(["9-raster", "9-hillshade"]);
    expect(Object.keys(out.sources).sort()).toEqual(["s", "s-dem"]);
    expect(coloringOf(out)).toMatchObject({ kind: "classes" });
    valid(out);
  });

  it("terrain without a palette has no color layer", () => {
    expect(compile({ render: { type: "terrain" } }).layers.map((l) => l.id)).toEqual(["9-hillshade"]);
  });

  it("zooms go on every layer", () => {
    const out = compile({
      min_zoom: 10,
      max_zoom: 18,
      render: { type: "terrain", palette: "goat:elevation", domain: [0, 9] },
    });
    for (const layer of out.layers) expect(layer).toMatchObject({ minzoom: 10, maxzoom: 18 });
  });
});
