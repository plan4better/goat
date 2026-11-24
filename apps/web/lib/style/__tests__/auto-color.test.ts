import { Color } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import { darkerShade } from "@/lib/style/compile/values";
import type { LayerStyle } from "@/lib/style/generated/types";

import { evaluate, maplibreErrors } from "./maplibre";

// The outline's and the casing's `"auto"` (spec 3.1, 3.2): a darker shade of the color the fill, the marker or the line
// draws, feature by feature, worked out at compile time class by class and stop by stop.

const tiles = { type: "tiles" as const, id: "s9", tiles: ["https://t/{z}/{x}/{y}"] };
const compile = (style: object, geometry: CompileInput["geometry"], extra: Partial<CompileInput> = {}) =>
  compileLayer({
    id: "9",
    style: { version: "1.0.0", kind: "vector", ...style } as LayerStyle,
    geometry,
    source: tiles,
    ...extra,
  });
const paintOf = (out: ReturnType<typeof compileLayer>, suffix: string) =>
  (out.layers.find((l) => l.id === `9-${suffix}`) as { paint: Record<string, unknown> } | undefined)?.paint ??
  {};
const valid = (out: ReturnType<typeof compileLayer>) => maplibreErrors(out.layers, out.sources, out.state);
const hex = (value: unknown) => {
  const c = value instanceof Color ? value : Color.parse(String(value))!;
  return `#${[c.r, c.g, c.b]
    .map((x) =>
      Math.round((x / (c.a || 1)) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
};
const categories = (field: string, classes: object[], other?: object) => ({
  field,
  method: "categories",
  classes,
  ...(other ? { other } : {}),
});

describe('outline color "auto"', () => {
  it("is the fixed fill color, darkened", () => {
    const out = compile(
      { symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto", width: 1 } } },
      "polygon"
    );
    expect(paintOf(out, "outline")["line-color"]).toBe("#592a63");
    expect(valid(out)).toEqual([]);
  });

  it("is the reference fill color, darkened, where the fill sets none", () => {
    const out = compile({ symbol: { outline: { color: "auto" } } }, "polygon");
    expect(paintOf(out, "outline")["line-color"]).toBe(darkerShade("#2bb381"));
  });

  it("takes each class's fill color, darkened, and the base's for the others", () => {
    const out = compile(
      {
        symbol: { fill: { color: "#cccccc" }, outline: { color: "auto", width: 1 } },
        classify: [
          categories("use", [
            { values: ["green"], fill: { color: "#11a579" } },
            { values: ["home"], fill: { color: "#e73f74" } },
          ]),
        ],
      },
      "polygon",
      { fields: { use: "string" } }
    );
    const color = paintOf(out, "outline")["line-color"];
    expect(hex(evaluate(color, { use: "green" }))).toBe("#0c7455");
    expect(hex(evaluate(color, { use: "home" }))).toBe("#a22c51");
    expect(hex(evaluate(color, { use: "shop" }))).toBe("#8f8f8f");
    // The fill keeps its own colors.
    expect(hex(evaluate(paintOf(out, "fill")["fill-color"], { use: "green" }))).toBe("#11a579");
    expect(valid(out)).toEqual([]);
  });

  it("darkens a fill color by zoom stop by stop", () => {
    const out = compile(
      {
        symbol: {
          fill: {
            color: {
              zoom: [
                [10, "#ff0000"],
                [16, "#0000ff"],
              ],
            },
          },
          outline: { color: "auto", width: 1 },
        },
      },
      "polygon"
    );
    expect(paintOf(out, "outline")["line-color"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      "#b30000",
      16,
      "#0000b3",
    ]);
  });

  it("darkens each color of a continuous ramp and its no-data color", () => {
    const out = compile(
      {
        symbol: {
          fill: {
            color: { field: "amount", palette: ["#ffffff", "#ff0000"], domain: [0, 100], no_data: "#0f0f0f" },
          },
          outline: { color: "auto", width: 1 },
        },
      },
      "polygon",
      { fields: { amount: "number" } }
    );
    const color = paintOf(out, "outline")["line-color"];
    expect(hex(evaluate(color, { amount: 0 }))).toBe("#b3b3b3");
    expect(hex(evaluate(color, { amount: 100 }))).toBe("#b30000");
    expect(hex(evaluate(color, {}))).toBe("#0b0b0b");
    expect(hex(evaluate(paintOf(out, "fill")["fill-color"], { amount: 100 }))).toBe("#ff0000");
    expect(valid(out)).toEqual([]);
  });

  it('follows the color a switched-off fill would have, as "fill" does', () => {
    const style = (color: string) => ({
      symbol: { fill: false, outline: { color, width: 2 } },
      classify: [
        { ...categories("use", [{ values: ["green"], fill: { color: "#11a579" } }]), target: "fill.color" },
      ],
    });
    const auto = compile(style("auto"), "polygon", { fields: { use: "string" } });
    const fill = compile(style("fill"), "polygon", { fields: { use: "string" } });
    expect(auto.layers.map((l) => l.id)).toEqual(["9-outline"]);
    for (const use of ["green", "shop"])
      expect(hex(evaluate(paintOf(auto, "outline")["line-color"], { use }))).toBe(
        darkerShade(hex(evaluate(paintOf(fill, "outline")["line-color"], { use })))
      );
    // Without a class color both follow the reference fill color.
    const plain = compile({ symbol: { fill: false, outline: { color: "auto" } } }, "polygon");
    expect(paintOf(plain, "outline")["line-color"]).toBe(darkerShade("#2bb381"));
  });

  it("can be the color of one class or one zoom stop", () => {
    const out = compile(
      {
        symbol: {
          fill: { color: "#e68310" },
          outline: {
            color: {
              zoom: [
                [10, "#ffffff"],
                [14, "auto"],
              ],
            },
            width: 1,
          },
        },
        classify: [categories("use", [{ values: ["a"], outline: { color: "#000000" } }])],
      },
      "polygon",
      { fields: { use: "string" } }
    );
    const color = paintOf(out, "outline")["line-color"] as unknown[];
    expect(color.slice(0, 3)).toEqual(["interpolate", ["linear"], ["zoom"]]);
    const [z10, at10, z14, at14] = color.slice(3);
    expect([z10, z14]).toEqual([10, 14]);
    expect(hex(evaluate(at14, { use: "b" }))).toBe("#a15c0b");
    expect(hex(evaluate(at10, { use: "b" }))).toBe("#ffffff");
    expect(hex(evaluate(at14, { use: "a" }))).toBe("#000000");
    expect(valid(out)).toEqual([]);
  });

  it("on points is the marker color, darkened, class by class", () => {
    const out = compile(
      {
        symbol: { marker: { color: "#3969ac" }, outline: { color: "auto", width: 2 } },
        classify: [categories("kind", [{ values: ["a"], marker: { color: "#f2b701" } }])],
      },
      "point",
      { fields: { kind: "string" } }
    );
    const stroke = paintOf(out, "marker")["circle-stroke-color"];
    expect(hex(evaluate(stroke, { kind: "a" }))).toBe("#a98001");
    expect(hex(evaluate(stroke, { kind: "b" }))).toBe("#284a78");
    expect(valid(out)).toEqual([]);
  });

  it("rings a cluster badge in the darker cluster marker color", () => {
    const out = compileLayer({
      id: "9",
      style: {
        version: "1.0.0",
        kind: "vector",
        render: {
          type: "cluster",
          count: "badge",
          symbol: { marker: { color: "#cf1c90", size: 20 }, outline: { color: "auto", width: 2 } },
        },
      } as LayerStyle,
      geometry: "point",
      source: { type: "points", id: "s9", data: "https://geoapi/collections/9/items?f=json" },
    });
    const badge = out.layers.find((l) => l.id === "9-cluster-badge") as { layout: Record<string, unknown> };
    expect(JSON.stringify(badge.layout["icon-image"])).toContain("911465");
    expect(valid(out)).toEqual([]);
  });

  it("on clusters drawn like their points is the darker color of the category most points have", () => {
    const out = compileLayer({
      id: "9",
      style: {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { color: "#3969ac" }, outline: { color: "auto", width: 2 } },
        classify: [categories("kind", [{ values: ["a"], marker: { color: "#f2b701" } }])],
        render: { type: "cluster", look: "points" },
      } as LayerStyle,
      geometry: "point",
      source: { type: "points", id: "s9", data: "https://geoapi/collections/9/items?f=json" },
    });
    const stroke = paintOf(out, "cluster-marker")["circle-stroke-color"];
    const mostly = (a: number, other: number) =>
      hex(evaluate(stroke, { point_count: a + other, goat_cluster_0: a, goat_cluster_other: other }));
    expect(mostly(5, 1)).toBe("#a98001");
    expect(mostly(1, 5)).toBe("#284a78");
    expect(valid(out)).toEqual([]);
  });
});

describe('casing color "auto"', () => {
  it("is the fixed line color, darkened", () => {
    const out = compile(
      { symbol: { line: { color: "#f97b72" }, casing: { color: "auto", width: 1 } } },
      "line"
    );
    expect(paintOf(out, "casing")["line-color"]).toBe("#ae5650");
    expect(valid(out)).toEqual([]);
  });

  it("takes each class's line color, darkened", () => {
    const out = compile(
      {
        symbol: { line: { color: "#cccccc" }, casing: { color: "auto", width: 1 } },
        classify: [categories("kind", [{ values: ["a"], line: { color: "#008695" } }])],
      },
      "line",
      { fields: { kind: "string" } }
    );
    const color = paintOf(out, "casing")["line-color"];
    expect(hex(evaluate(color, { kind: "a" }))).toBe("#005e68");
    expect(hex(evaluate(color, { kind: "b" }))).toBe("#8f8f8f");
    expect(valid(out)).toEqual([]);
  });

  it("darkens a line color by zoom stop by stop", () => {
    const out = compile(
      {
        symbol: {
          line: {
            color: {
              zoom: [
                [10, "#ff0000"],
                [16, "#0000ff"],
              ],
            },
          },
          casing: { color: "auto", width: 1 },
        },
      },
      "line"
    );
    expect(paintOf(out, "casing")["line-color"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      "#b30000",
      16,
      "#0000b3",
    ]);
  });
});
