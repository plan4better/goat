import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import { PALETTES } from "@/lib/style/generated/catalog";
import type { LayerStyle } from "@/lib/style/generated/types";

import { specExamples } from "./fixtures";
import { maplibreErrors } from "./maplibre";

const example = (line: number) => specExamples().find((e) => e.line === line)!.doc;
const tiles = { type: "tiles" as const, id: "s9", tiles: ["https://t/{z}/{x}/{y}"] };
const points = { type: "points" as const, id: "s9", data: "https://geoapi/collections/9/items?f=json" };
const compile = (style: object, source: CompileInput["source"] = tiles) =>
  compileLayer({ id: "9", style: style as LayerStyle, geometry: "point", source });
const byId = (out: ReturnType<typeof compileLayer>, suffix: string) =>
  out.layers.find((l) => l.id === `9-${suffix}`) as unknown as
    | Record<string, Record<string, unknown>>
    | undefined;
const valid = (out: ReturnType<typeof compileLayer>) => maplibreErrors(out.layers, out.sources, out.state);

describe("heatmaps", () => {
  it("compiles the spec 8.1 example: a heatmap, the facilities from zoom 15", () => {
    const out = compile(example(1666));
    expect(out.layers.map((l) => [l.id, l.type, l.minzoom, l.maxzoom])).toEqual([
      ["9-heatmap", "heatmap", undefined, 15],
      ["9-marker", "circle", 15, undefined],
    ]);
    const magma = PALETTES["d3:magma"].colors;
    expect(byId(out, "heatmap")?.paint).toEqual({
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 15, 14, 40],
      "heatmap-weight": ["interpolate", ["linear"], ["to-number", ["get", "visitors"], 0], 0, 0, 50000, 1],
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0, 0, 0, 0)",
        ...magma.flatMap((c, i) => [Number(((i + 1) / magma.length).toFixed(10)), c]),
      ],
    });
    expect(valid(out)).toEqual([]);
  });

  it("without points_from_zoom only the heatmap draws", () => {
    const out = compile({ version: 1, kind: "vector", render: { type: "heatmap" } });
    expect(out.layers.map((l) => l.id)).toEqual(["9-heatmap"]);
    expect(byId(out, "heatmap")?.paint["heatmap-radius"]).toBe(26);
  });
});

describe("clusters", () => {
  it("compiles the spec 8.2 example: a clustered GeoJSON source, cluster layers over the single points", () => {
    const out = compile(example(1702), points);
    expect(out.sources).toEqual({
      s9: {
        type: "geojson",
        data: points.data,
        cluster: true,
        clusterRadius: 50,
        clusterMinPoints: 3,
        clusterMaxZoom: 13,
      },
    });
    expect(out.layers.map((l) => l.id)).toEqual(["9-marker", "9-cluster-marker", "9-cluster-label"]);
    expect(byId(out, "marker")?.filter).toEqual(["!", ["has", "point_count"]]);
    expect(byId(out, "marker")?.["source-layer"]).toBeUndefined();
    expect(byId(out, "cluster-marker")?.filter).toEqual(["has", "point_count"]);
    expect(byId(out, "cluster-label")?.layout["text-field"]).toEqual(["to-string", ["get", "point_count"]]);
    expect(JSON.stringify(byId(out, "cluster-marker")?.paint["circle-radius"])).toContain('"point_count"');
    expect(valid(out)).toEqual([]);
  });
});

describe("H3", () => {
  const VALUE = ["to-number", ["get", "value"], 0];
  const STAMP = { at: "2026-10-26T00:00:00Z", data: "ducklake:1", scope: "dataset" };
  const h3 = (render: object) => compile({ version: 1, kind: "vector", render: { type: "h3", ...render } });

  it("compiles the spec 8.3 example: hexagon tiles from geoapi, the schools from zoom 15", () => {
    const out = compile(example(1736));
    expect(out.unsupported).toEqual([]);
    expect(out.sources["s9-h3"]).toEqual({
      type: "vector",
      tiles: ["https://t/{z}/{x}/{y}?h3=auto&h3_value=sum&h3_field=pupils"],
      maxzoom: 14,
    });
    expect(out.layers.map((l) => [l.id, l.type, l.minzoom, l.maxzoom])).toEqual([
      ["9-h3-fill", "fill", undefined, 15],
      ["9-h3-outline", "line", undefined, 15],
      ["9-marker", "circle", 15, undefined],
    ]);
    expect(byId(out, "h3-fill")?.source).toBe("s9-h3");
    expect(byId(out, "h3-fill")?.["source-layer"]).toBe("h3");
    expect(byId(out, "h3-fill")?.paint["fill-opacity"]).toBe(0.85);
    expect(byId(out, "h3-outline")?.paint).toEqual({ "line-color": "#ffffff", "line-width": 1 });
    expect(valid(out)).toEqual([]);
  });

  it("counts by default and asks for a fixed resolution", () => {
    const out = h3({ resolution: 8 });
    expect((out.sources["s9-h3"] as { tiles: string[] }).tiles).toEqual([
      "https://t/{z}/{x}/{y}?h3=8&h3_value=count",
    ]);
    expect(out.layers.map((l) => l.id)).toEqual(["9-h3-fill", "9-h3-outline"]);
  });

  it("colors classes per resolution from the computed breaks", () => {
    const pal = ["#000001", "#000002", "#000003"];
    const out = h3({
      palette: pal,
      classify: { method: "quantile", count: 3 },
      computed: {
        ...STAMP,
        resolutions: { "7": { min: 1, max: 9, breaks: [3, 6] }, "8": { min: 1, max: 4, breaks: [2] } },
      },
    });
    expect(byId(out, "h3-fill")?.paint["fill-color"]).toEqual([
      "match",
      ["get", "resolution"],
      7,
      ["step", VALUE, "#000001", 3, "#000002", 6, "#000003"],
      8,
      ["step", VALUE, "#000001", 2, "#000003"],
      "#000002",
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("spreads the palette over each resolution's range without classes", () => {
    const pal = ["#000001", "#000002", "#000003"];
    const out = h3({
      resolution: 8,
      palette: pal,
      reverse: true,
      computed: { ...STAMP, resolutions: { "8": { min: 0, max: 10 } } },
    });
    expect(byId(out, "h3-fill")?.paint["fill-color"]).toEqual([
      "interpolate",
      ["linear"],
      VALUE,
      0,
      "#000003",
      5,
      "#000002",
      10,
      "#000001",
    ]);
  });

  it("draws the palette's middle color until the values are computed", () => {
    const out = h3({ palette: ["#000001", "#000002", "#000003"] });
    expect(byId(out, "h3-fill")?.paint["fill-color"]).toBe("#000002");
  });

  it("manual classes and an author's class color apply at every resolution", () => {
    const out = h3({
      palette: ["#000001", "#000002"],
      classify: { method: "manual", classes: [{ to: 10 }, { from: 10, color: "#ff0000" }] },
    });
    expect(byId(out, "h3-fill")?.paint["fill-color"]).toEqual(["step", VALUE, "#000001", 10, "#ff0000"]);
  });

  it("an outline of width 0 draws no outline layer; the layer opacity multiplies in", () => {
    const out = compileLayer({
      id: "9",
      style: {
        version: 1,
        kind: "vector",
        opacity: 0.5,
        render: { type: "h3", outline: { width: 0 }, opacity: 0.8 },
      } as LayerStyle,
      geometry: "point",
      source: tiles,
    });
    expect(out.layers.map((l) => l.id)).toEqual(["9-h3-fill"]);
    expect(byId(out, "h3-fill")?.paint["fill-opacity"]).toBeCloseTo(0.4);
  });
});

describe("heatmap weights over a single value", () => {
  it("a weight domain with d0 = d1 weighs every feature with the value the same", () => {
    const out = compile({
      version: 1,
      kind: "vector",
      render: { type: "heatmap", weight: { field: "v", domain: [5, 5] } },
    });
    expect(byId(out, "heatmap")?.paint["heatmap-weight"]).toEqual(["case", ["has", "v"], 1, 0]);
    expect(valid(out)).toEqual([]);
  });
});
