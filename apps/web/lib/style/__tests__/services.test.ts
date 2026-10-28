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

  it("darker pictures and settings by zoom", () => {
    const xyz = {
      type: "service" as const,
      id: "s9",
      service: "xyz" as const,
      tiles: "https://tiles.example/{z}/{x}/{y}.png",
    };
    expect(
      compile({ version: 1, kind: "raster", brightness: -0.2, render: { type: "image" } }, xyz).layers[0]
        .paint
    ).toEqual({ "raster-brightness-max": 0.8 });
    const zoomed = compile(
      {
        version: 1,
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

  it("a raster file draws from the raster service even before its domain is computed", () => {
    const out = compile(
      { version: 1, kind: "raster", render: { type: "continuous", palette: "goat:elevation" } },
      {
        type: "raster",
        id: "s9",
        tiles: "https://geo/collections/d/raster/tiles/{z}/{x}/{y}.webp",
        dem: "https://geo/collections/d/raster/dem/{z}/{x}/{y}.webp",
      }
    );
    expect(out.unsupported).toEqual([]);
    expect(out.layers.map((l) => l.id)).toEqual(["9-raster"]);
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
