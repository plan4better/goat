import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { fieldTypes, goldenPairs, specExamples } from "./fixtures";
import { maplibreErrors } from "./maplibre";

const tiles = (id: string) => ({ type: "tiles" as const, id: `s${id}`, tiles: ["https://t/{z}/{x}/{y}"] });

const compile = (style: object, geometry: CompileInput["geometry"], extra: Partial<CompileInput> = {}) =>
  compileLayer({ id: "9", style: style as LayerStyle, geometry, source: tiles("9"), ...extra });

const valid = (out: ReturnType<typeof compileLayer>) => maplibreErrors(out.layers, out.sources);

describe("polygons and lines", () => {
  it("compiles the routes example exactly (spec 16 golden)", () => {
    const { doc, dataset, expected } = goldenPairs()[0];
    const out = compileLayer({
      id: "413",
      style: doc,
      geometry: "line",
      fields: fieldTypes(dataset),
      source: tiles("413"),
    });
    expect(out.layers).toEqual(expected);
    expect(out.tileParams.decorations).toEqual(["center"]);
    expect(out.images).toEqual([
      { name: "goat:arrow", url: "/sprites/goat-arrow.svg", sdf: true, height: 24, pixelRatio: 4 },
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("compiles the districts fill and outline (spec 16 golden, without the label)", () => {
    const { doc, dataset, expected } = goldenPairs()[1];
    const { label: _label, ...symbol } = doc.symbol;
    const out = compileLayer({
      id: "414",
      style: { ...doc, symbol },
      geometry: "polygon",
      fields: fieldTypes(dataset),
      source: tiles("414"),
    });
    expect(out.layers).toEqual((expected as Array<{ id: string }>).filter((l) => l.id !== "414-label"));
  });

  it("fill, hatching, an outline in the fill color and the layer opacity", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        opacity: 0.5,
        symbol: {
          fill: { color: "#cccccc", opacity: 0.8, pattern: "hatch_45", pattern_color: "#333333" },
          outline: { color: "fill" },
        },
      },
      "polygon"
    );
    expect(out.layers.map((l) => l.id)).toEqual(["9-fill", "9-pattern", "9-outline"]);
    expect(out.layers[0].paint).toEqual({
      "fill-color": "#cccccc",
      "fill-opacity": 0.8,
      "fill-layer-opacity": 0.5,
    });
    // The pattern draws at full opacity (spec 3.1); only the layer opacity fades it. Its image is named after
    // its look (kind, spacing, line width, color) and drawn on demand.
    expect(out.layers[1].paint).toEqual({
      "fill-pattern": "goat-pattern:hatch_45|10|2|#333333",
      "fill-layer-opacity": 0.5,
    });
    expect(out.layers[2].paint).toEqual({ "line-color": "#cccccc", "line-layer-opacity": 0.5 });
    expect(out.images).toEqual([]);
    expect(valid(out)).toEqual([]);
  });

  it("hatching only for some classes draws no pattern for the others", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { fill: { color: "#cccccc" } },
        classify: [
          {
            field: "use",
            method: "categories",
            classes: [{ values: ["green"], fill: { pattern: "cross" } }],
          },
        ],
      },
      "polygon",
      { fields: { use: "string" } }
    );
    const pattern = out.layers.find((l) => l.id === "9-pattern");
    // Lines in the fill color unless the pattern says otherwise.
    expect(pattern?.paint).toMatchObject({
      "fill-pattern": [
        "case",
        ["==", ["match", ["get", "use"], "green", "cross", "none"], "none"],
        "",
        ["concat", "goat-pattern:", ["match", ["get", "use"], "green", "cross", "none"], "|10|2|#cccccc"],
      ],
      "fill-opacity": ["match", ["get", "use"], "green", 1, 0],
    });
    expect(valid(out)).toEqual([]);
  });

  it("spacing and line width switch at zoom stops and per class, the color follows the fill", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          fill: {
            color: "#cccccc",
            pattern: "vertical",
            pattern_spacing: {
              zoom: [
                [10, 6],
                [14, 12],
              ],
              interpolate: "step",
            },
          },
        },
        classify: [
          {
            field: "use",
            method: "categories",
            target: "fill.pattern_width",
            classes: [{ values: ["green"], fill: { pattern_width: 4 } }],
          },
        ],
      },
      "polygon",
      { fields: { use: "string" } }
    );
    const pattern = out.layers.find((l) => l.id === "9-pattern");
    const width = ["to-string", ["match", ["get", "use"], "green", 4, 2]];
    expect(pattern?.paint?.["fill-pattern"]).toEqual([
      "step",
      ["zoom"],
      ["concat", "goat-pattern:vertical|6|", width, "|#cccccc"],
      14,
      ["concat", "goat-pattern:vertical|12|", width, "|#cccccc"],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("arrows repeating in both directions", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { line: { color: "#2166ac" }, arrows: { placement: "repeat", direction: "both" } },
      },
      "line"
    );
    expect(out.layers.map((l) => l.id)).toEqual(["9-line", "9-arrows", "9-arrows-back"]);
    expect(out.layers[1].layout).toEqual({
      "symbol-placement": "line",
      "symbol-spacing": 100,
      "icon-image": "goat:arrow",
      "icon-size": 0.4166666667,
      "icon-rotate": 90,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
    });
    expect((out.layers[2].layout as Record<string, unknown>)["icon-rotate"]).toBe(270);
    expect(out.tileParams.decorations).toBeUndefined();
    expect(valid(out)).toEqual([]);
  });

  it("decoration arrows at both ends, backwards", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { line: {}, arrows: { placement: "both_ends", direction: "backward" } },
      },
      "line"
    );
    expect((out.layers[1].layout as Record<string, unknown>)["icon-rotate"]).toEqual([
      "+",
      ["get", "bearing"],
      180,
    ]);
    expect(out.tileParams.decorations).toEqual(["start", "end"]);
  });

  it("layer and part zooms, line defaults and the casing following the line", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        min_zoom: 8,
        symbol: { line: { width: 3, max_zoom: 16 }, casing: { color: "#000000" } },
      },
      "line"
    );
    expect(out.layers.map((l) => [l.id, l.minzoom, l.maxzoom])).toEqual([
      ["9-casing", 8, 16],
      ["9-line", 8, 16],
    ]);
    expect(out.layers[1].layout).toEqual({ "line-join": "round" });
    expect(out.layers[1].paint).toEqual({ "line-color": "#2166ac", "line-width": 3 });
    expect(out.layers[0].paint).toEqual({ "line-color": "#000000", "line-width": 5 });
    expect(valid(out)).toEqual([]);
  });
});

const part = (out: ReturnType<typeof compileLayer>, suffix: string) =>
  out.layers.find((l) => l.id === `9-${suffix}`) as unknown as Record<string, Record<string, unknown>> & {
    filter?: unknown;
  };
const example = (line: number) => specExamples().find((e) => e.line === line)!.doc;

describe("parts switched on by classes and rules (spec 3)", () => {
  it("arrows only a rule sets draw only on that rule's features", () => {
    const out = compile(example(1261), "line", {
      fields: { oneway: "boolean", traffic: "integer", name: "string" },
    });
    expect(part(out, "arrows").paint["icon-opacity"]).toEqual([
      "case",
      ["==", ["get", "oneway"], true],
      1,
      0,
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("arrows a class switches off leave that class's features", () => {
    const style = {
      version: 1,
      kind: "vector",
      symbol: { line: {}, arrows: { size: 12 } },
      classify: [{ field: "t", method: "categories", classes: [{ values: ["a"], arrows: false }] }],
    };
    expect(part(compile(style, "line", { fields: { t: "string" } }), "arrows").paint["icon-opacity"]).toEqual(
      ["match", ["get", "t"], "a", 0, 1]
    );
  });

  it("arrows fade with the layer opacity, having none of their own (spec 4.6)", () => {
    const out = compile(
      { version: 1, kind: "vector", opacity: 0.5, symbol: { line: {}, arrows: { size: 12 } } },
      "line"
    );
    expect(part(out, "arrows").paint["icon-opacity"]).toBe(0.5);
  });

  it("a casing only a class sets draws only for that class", () => {
    const style = {
      version: 1,
      kind: "vector",
      symbol: { line: { width: 3 } },
      classify: [
        { field: "t", method: "categories", classes: [{ values: ["a"], casing: { color: "#ff0000" } }] },
      ],
    };
    expect(part(compile(style, "line", { fields: { t: "string" } }), "casing").paint["line-opacity"]).toEqual(
      ["match", ["get", "t"], "a", 1, 0]
    );
  });

  it("a polygon outline only a rule sets draws only where the rule holds", () => {
    const style = {
      version: 1,
      kind: "vector",
      symbol: { fill: {} },
      rules: [
        { when: { op: "=", args: [{ property: "big" }, true] }, outline: { color: "#ff0000", width: 2 } },
      ],
    };
    expect(part(compile(style, "polygon"), "outline").paint["line-opacity"]).toEqual([
      "case",
      ["==", ["get", "big"], true],
      1,
      0,
    ]);
  });

  it("a part zoom range inside a class narrows that part for the class's features (spec 3.5)", () => {
    const style = {
      version: 1,
      kind: "vector",
      symbol: { fill: {}, label: { text: "{name}" } },
      classify: [{ field: "t", method: "categories", classes: [{ values: ["a"], label: { min_zoom: 15 } }] }],
    };
    const out = compile(style, "polygon", { fields: { t: "string", name: "string" } });
    expect(part(out, "label").filter).toEqual(["any", ["!=", ["get", "t"], "a"], [">=", ["zoom"], 15]]);
    expect(part(out, "fill").filter).toBeUndefined();
  });
});

describe("patterns and the fill color (spec 3.1)", () => {
  it("patterns draw at full opacity, whatever the fill opacity", () => {
    const out = compile(example(246), "polygon", { fields: { land_use: "string" } });
    expect(part(out, "pattern").paint["fill-opacity"]).toEqual([
      "match",
      ["get", "land_use"],
      "mixed",
      1,
      "green",
      1,
      0,
    ]);
  });

  it("a hatch without a tint: the fill at opacity 0, the pattern still drawn", () => {
    const out = compile(
      { version: 1, kind: "vector", symbol: { fill: { opacity: 0, pattern: "hatch_45" } } },
      "polygon"
    );
    expect(part(out, "fill").paint["fill-opacity"]).toBe(0);
    expect(part(out, "pattern").paint["fill-opacity"]).toBeUndefined();
  });

  it("a class switching the fill off takes its pattern with it", () => {
    const style = {
      version: 1,
      kind: "vector",
      symbol: { fill: { pattern: "dots" } },
      classify: [{ field: "t", method: "categories", classes: [{ values: ["a"], fill: false }] }],
    };
    expect(
      part(compile(style, "polygon", { fields: { t: "string" } }), "pattern").paint["fill-opacity"]
    ).toEqual(["match", ["get", "t"], "a", 0, 1]);
  });

  it("an outline in the fill color follows a fill color that varies by zoom", () => {
    const style = {
      version: 1,
      kind: "vector",
      symbol: {
        fill: {
          color: {
            zoom: [
              [10, "#ff0000"],
              [16, "#0000ff"],
            ],
          },
        },
        outline: { color: "fill", width: 1 },
      },
    };
    const out = compile(style, "polygon");
    expect(part(out, "outline").paint["line-color"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      "#ff0000",
      16,
      "#0000ff",
    ]);
    expect(part(out, "pattern")).toBeUndefined();
  });
});
