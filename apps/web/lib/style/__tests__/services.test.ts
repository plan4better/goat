import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { specExamples } from "./fixtures";
import { maplibreErrors } from "./maplibre";

const example = (line: number) => specExamples().find((e) => e.line === line)!.doc;
const WMS =
  "https://wms.example/service?SERVICE=WMS&REQUEST=GetMap&LAYERS=aerial&STYLES=&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256";
const compile = (style: object, source: CompileInput["source"]) =>
  compileLayer({ id: "9", style: style as LayerStyle, source });

describe("map services and rasters", () => {
  it("a WMS layer in the service's grey style, lighter, from zoom 12 (spec 9.8)", () => {
    const out = compile(example(2102), { type: "service", id: "s9", service: "wms", tiles: WMS });
    expect(out.sources).toEqual({
      s9: { type: "raster", tiles: [WMS.replace("STYLES=&", "STYLES=grey&")], tileSize: 256 },
    });
    expect(out.layers).toEqual([
      {
        id: "9-raster",
        type: "raster",
        source: "s9",
        minzoom: 12,
        paint: { "raster-opacity": 0.9, "raster-brightness-min": 0.1, "raster-contrast": 0.1 },
      },
    ]);
    expect(maplibreErrors(out.layers, out.sources)).toEqual([]);
  });

  it("adds STYLES when the URL has none and keeps the bbox placeholder as it is", () => {
    const out = compile(example(2102), {
      type: "service",
      id: "s9",
      service: "wms",
      tiles: "https://wms.example/?LAYERS=a&BBOX={bbox-epsg-3857}",
    });
    expect((out.sources.s9 as { tiles: string[] }).tiles).toEqual([
      "https://wms.example/?LAYERS=a&BBOX={bbox-epsg-3857}&STYLES=grey",
    ]);
  });

  it("an XYZ layer, faded and less saturated", () => {
    const out = compile(example(2118), {
      type: "service",
      id: "s9",
      service: "xyz",
      tiles: "https://tiles.example/{z}/{x}/{y}.png",
      tileSize: 512,
    });
    expect(out.sources).toEqual({
      s9: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"], tileSize: 512 },
    });
    expect(out.layers[0].paint).toEqual({ "raster-opacity": 0.5, "raster-saturation": -0.6 });
  });

  it("an XYZ layer with subdomains and TMS rows: one address per subdomain, rows counted from the south", () => {
    const out = compile(example(2118), {
      type: "service",
      id: "s9",
      service: "xyz",
      tiles: "https://{s}.tiles.example/{z}/{x}/{-y}.png",
    });
    expect(out.sources).toEqual({
      s9: {
        type: "raster",
        tiles: [
          "https://a.tiles.example/{z}/{x}/{y}.png",
          "https://b.tiles.example/{z}/{x}/{y}.png",
          "https://c.tiles.example/{z}/{x}/{y}.png",
        ],
        scheme: "tms",
        tileSize: 256,
      },
    });
    expect(maplibreErrors(out.layers, out.sources)).toEqual([]);
  });

  it("darker pictures and settings by zoom", () => {
    const xyz = {
      type: "service" as const,
      id: "s9",
      service: "xyz" as const,
      tiles: "https://tiles.example/{z}/{x}/{y}.png",
    };
    expect(
      compile({ version: "1.0.0", kind: "raster", brightness: -0.2, render: { type: "image" } }, xyz)
        .layers[0].paint
    ).toEqual({ "raster-brightness-max": 0.8 });
    const zoomed = compile(
      {
        version: "1.0.0",
        kind: "raster",
        opacity: {
          zoom: [
            [10, 1],
            [16, 0.4],
          ],
        },
        render: { type: "image" },
      },
      xyz
    );
    expect(zoomed.layers[0].paint).toEqual({
      "raster-opacity": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 0.4],
    });
  });

  it("a raster file draws from its values even before its domain is computed", () => {
    const style = {
      version: "1.0.0",
      kind: "raster",
      render: { type: "continuous", palette: "goat:elevation" },
    };
    const source = {
      type: "raster" as const,
      id: "s9",
      tiles: "https://geo/collections/d/raster/tiles/{z}/{x}/{y}.webp",
      coverage: "https://geo/collections/d/coverage/tiles/WebMercatorQuad",
    };
    // Until its values are loaded it draws nothing, and nothing is missing.
    const loading = compile(style, source);
    expect(loading.unsupported).toEqual([]);
    expect(loading.layers).toEqual([]);
    const values = {
      encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 1 },
      range: [0, 255] as [number, number],
      integer: true,
      version: "1-e1",
    };
    const out = compile(style, { ...source, values });
    expect(out.unsupported).toEqual([]);
    expect(out.layers.map((l) => l.id)).toEqual(["9-relief"]);
  });
});

describe("service styles in the URL", () => {
  it("one style per service layer, since STYLES lists one for each", async () => {
    const { withServiceStyle } = await import("@/lib/style/compile/services");
    const url = "https://wms.example/?LAYERS=a,b&STYLES=&BBOX={bbox-epsg-3857}";
    expect(withServiceStyle(url, "grey", 2)).toBe(
      "https://wms.example/?LAYERS=a,b&STYLES=grey,grey&BBOX={bbox-epsg-3857}"
    );
    expect(withServiceStyle(url, "grey")).toBe(
      "https://wms.example/?LAYERS=a,b&STYLES=grey&BBOX={bbox-epsg-3857}"
    );
  });
});

describe("blend (spec 4.7)", () => {
  it("a map service takes raster-layer-blend on its raster layer; normal writes nothing", () => {
    const style = { version: "1.0.0", kind: "raster", opacity: 0.9, resampling: "nearest" };
    for (const [service, tiles] of [
      ["wms", WMS],
      ["wmts", "https://wmts.example/{z}/{x}/{y}.png"],
      ["xyz", "https://tiles.example/{z}/{x}/{y}.png"],
    ] as const) {
      const source = { type: "service" as const, id: "s9", service, tiles };
      const plain = compile(style, source);
      for (const blend of ["multiply", "screen", "overlay", "color"]) {
        const out = compile({ ...style, blend }, source);
        expect(out.layers).toEqual([
          { ...plain.layers[0], paint: { ...plain.layers[0].paint, "raster-layer-blend": blend } },
        ]);
        expect(maplibreErrors(out.layers, out.sources)).toEqual([]);
      }
      expect(compile({ ...style, blend: "normal" }, source)).toEqual(plain);
    }
  });
});
