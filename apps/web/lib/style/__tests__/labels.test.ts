import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { formatNumber, textField } from "@/lib/style/compile/labels";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";

import { fieldTypes, goldenPairs } from "./fixtures";
import { maplibreErrors } from "./maplibre";

const tiles = (id: string) => ({ type: "tiles" as const, id: `s${id}`, tiles: ["https://t/{z}/{x}/{y}"] });
const compile = (style: object, geometry: CompileInput["geometry"], extra: Partial<CompileInput> = {}) =>
  compileLayer({ id: "9", style: style as LayerStyle, geometry, source: tiles("9"), ...extra });
const label = (out: ReturnType<typeof compileLayer>) =>
  out.layers.find((l) => l.id === "9-label") as unknown as Record<string, Record<string, unknown>>;
const valid = (out: ReturnType<typeof compileLayer>) => maplibreErrors(out.layers, out.sources, out.state);
const LOCALE = { locale: ["global-state", "locale"] };

describe("labels", () => {
  it("compiles the districts example exactly (spec 16 golden)", () => {
    const { doc, dataset, expected } = goldenPairs()[1];
    const out = compileLayer({
      id: "414",
      style: doc,
      geometry: "polygon",
      fields: fieldTypes(dataset),
      source: tiles("414"),
    });
    expect(out.layers).toEqual(expected);
    expect(out.tileParams.label).toBe(true);
    expect(out.tileParams.fields).toEqual(["area_km2", "name"]);
    expect(out.state).toEqual({ locale: { default: "en-US" } });
    expect(valid(out)).toEqual([]);
  });

  it("odd field names and literal braces", () => {
    expect(textField('{Einwohner "2020" ß} \\{x\\}', { fields: { 'Einwohner "2020" ß': "string" } })).toEqual(
      ["concat", ["to-string", ["get", 'Einwohner "2020" ß']], " {x}"]
    );
    expect(textField("{area(ha)}", { fields: {} })).toEqual(["to-string", ["get", "area(ha)"]]);
  });

  it("number formats", () => {
    const x = ["to-number", ["get", "v"], 0];
    expect(formatNumber(x, { decimals: 0 })).toEqual(["number-format", ["round", x], LOCALE]);
    expect(formatNumber(x, { decimals: 1, thousands_separator: false })).toEqual([
      "to-string",
      ["/", ["round", ["*", x, 10]], 10],
    ]);
    expect(formatNumber(x, { suffix: " km" })).toEqual(["concat", ["number-format", x, LOCALE], " km"]);
    expect(formatNumber(x, { always_show_sign: true })).toEqual([
      "case",
      [">", x, 0],
      ["concat", "+", ["number-format", x, LOCALE]],
      ["number-format", x, LOCALE],
    ]);
    const one = { ...LOCALE, "min-fraction-digits": 1, "max-fraction-digits": 1 };
    expect(formatNumber(x, { abbreviate: true })).toEqual([
      "case",
      [">=", ["abs", x], 1000000],
      ["concat", ["number-format", ["/", x, 1000000], one], " M"],
      [">=", ["abs", x], 1000],
      ["concat", ["number-format", ["/", x, 1000], one], " k"],
      ["number-format", x, LOCALE],
    ]);
  });

  it("point labels around the marker, with priority and overlap", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          marker: { size: 8 },
          label: { text: "{name}", priority: { field: "rank", top: "largest" }, allow_overlap: true },
        },
      },
      "point",
      { fields: { name: "string", rank: "integer" } }
    );
    expect(label(out).layout).toEqual({
      "text-field": ["to-string", ["get", "name"]],
      "text-size": 12,
      "text-font": ["Noto Sans Regular"],
      "text-variable-anchor-offset": [
        "top",
        [0, 0.5],
        "bottom",
        [0, -0.5],
        "right",
        [-0.5, 0],
        "left",
        [0.5, 0],
      ],
      "symbol-sort-key": ["-", ["to-number", ["get", "rank"], 0]],
      "text-allow-overlap": true,
    });
    expect(label(out)["source-layer"]).toBe("default");
    expect(valid(out)).toEqual([]);
  });

  it("labels along lines or at their centers", () => {
    const along = compile(
      { version: 1, kind: "vector", symbol: { line: {}, label: { text: "{name}", max_width: 240 } } },
      "line"
    );
    expect(label(along).layout).toMatchObject({ "symbol-placement": "line", "text-max-width": 20 });
    const center = compile(
      { version: 1, kind: "vector", symbol: { line: {}, label: { text: "{name}", placement: "center" } } },
      "line"
    );
    expect(label(center)["source-layer"]).toBe("default_decoration");
    expect(center.tileParams.decorations).toEqual(["center"]);
  });

  it("lines of a label get their own size, color and weight", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          marker: {},
          label: {
            text: "{name}\n{kind}",
            size: 12,
            lines: [{ size: 14, font: { weight: "bold" } }, { color: "#666666" }],
          },
        },
      },
      "point",
      { fields: { name: "string", kind: "string" } }
    );
    expect(label(out).layout["text-field"]).toEqual([
      "format",
      ["to-string", ["get", "name"]],
      { "font-scale": 1.1666666667, "text-font": ["literal", ["Noto Sans Bold"]] },
      "\n",
      {},
      ["to-string", ["get", "kind"]],
      { "text-color": "#666666" },
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("classes can change the text; layer opacity fades it", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        opacity: 0.5,
        symbol: { marker: {}, label: { text: "{name}" } },
        classify: [
          { field: "t", method: "categories", classes: [{ values: ["a"], label: { text: "{code}" } }] },
        ],
      },
      "point",
      { fields: { t: "string" } }
    );
    expect(label(out).layout["text-field"]).toEqual([
      "match",
      ["get", "t"],
      "a",
      ["to-string", ["get", "code"]],
      ["to-string", ["get", "name"]],
    ]);
    expect(label(out).paint["text-opacity"]).toBe(0.5);
  });
});

describe("label offsets", () => {
  it("an offset by zoom compiles per stop, in ems of the label size", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          line: {},
          label: {
            text: "{name}",
            offset: {
              zoom: [
                [10, [0, 2]],
                [16, [0, 6]],
              ],
            },
          },
        },
      },
      "line",
      { fields: { name: "string" } }
    );
    expect(label(out).layout["text-offset"]).toEqual([
      "step",
      ["zoom"],
      ["literal", [0, 0.1666666667]],
      16,
      ["literal", [0, 0.5]],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("an offset a class sets moves only that class's labels", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: { line: {}, label: { text: "{name}" } },
        classify: [
          { field: "t", method: "categories", classes: [{ values: ["a"], label: { offset: [0, 12] } }] },
        ],
      },
      "line",
      { fields: { t: "string", name: "string" } }
    );
    expect(label(out).layout["text-offset"]).toEqual([
      "match",
      ["get", "t"],
      "a",
      ["literal", [0, 1]],
      ["literal", [0, 0]],
    ]);
    expect(valid(out)).toEqual([]);
  });

  it("labels around markers that grow by zoom keep their distance at every stop (spec 16)", () => {
    const out = compile(
      {
        version: 1,
        kind: "vector",
        symbol: {
          marker: {
            size: {
              zoom: [
                [10, 6],
                [16, 14],
              ],
            },
          },
          label: { text: "{name}" },
        },
      },
      "point",
      { fields: { name: "string" } }
    );
    // (size / 2 + 2) / label size: 5 / 12 at zoom 10, 9 / 12 at zoom 16
    const at = (d: number) => [
      "literal",
      ["top", [0, d], "bottom", [0, -d], "right", [-d, 0], "left", [d, 0]],
    ];
    expect(label(out).layout["text-variable-anchor-offset"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      at(0.4166666667),
      16,
      at(0.75),
    ]);
    expect(valid(out)).toEqual([]);
  });
});
