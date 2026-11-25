import {
  type Color,
  type StylePropertySpecification,
  createPropertyExpression,
  latest,
} from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { combine, fold, fromForm, toProperty, valueAt } from "@/lib/style/compile/values";

import { paintErrors } from "./maplibre";

/** A color expression as MapLibre evaluates it in `circle-color`, for a feature at a zoom, as rgba of 0 to 255. */
function colorAt(expr: unknown, properties: Record<string, unknown>, zoom: number): number[] {
  const spec = (latest as unknown as Record<string, Record<string, StylePropertySpecification>>).paint_circle[
    "circle-color"
  ];
  const parsed = createPropertyExpression(expr, "layers[0].paint.circle-color", spec);
  if (parsed.result !== "success") throw new Error(parsed.value.map((e) => e.message).join("; "));
  const color = parsed.value.evaluate({ zoom }, { type: 1, properties } as never) as Color;
  return [color.r, color.g, color.b].map((c) => Math.round((c / (color.a || 1)) * 255)).concat(color.a);
}

describe("value forms", () => {
  it("fixed values, zoom stops, steps and exponential curves", () => {
    expect(toProperty(fromForm(3, "number", 2))).toBe(3);
    expect(toProperty(fromForm(undefined, "number", 2))).toBe(2);
    expect(
      toProperty(
        fromForm(
          {
            zoom: [
              [10, 2],
              [16, 6],
            ],
          },
          "number",
          2
        )
      )
    ).toEqual(["interpolate", ["linear"], ["zoom"], 10, 2, 16, 6]);
    expect(
      toProperty(
        fromForm(
          {
            zoom: [
              [12, "dotted"],
              [16, "solid"],
            ],
            interpolate: "step",
          },
          "choice",
          "solid"
        )
      )
    ).toEqual(["step", ["zoom"], "dotted", 16, "solid"]);
    expect(
      toProperty(
        fromForm(
          {
            zoom: [
              [9, 1],
              [17, 10],
            ],
            interpolate: "exponential",
          },
          "number",
          1
        )
      )
    ).toEqual(["interpolate", ["exponential", 1.6], ["zoom"], 9, 1, 17, 10]);
  });

  it("choices only switch at stops, whatever the form says", () => {
    expect(
      toProperty(
        fromForm(
          {
            zoom: [
              [12, "dotted"],
              [16, "solid"],
            ],
          },
          "choice",
          "solid"
        )
      )
    ).toEqual(["step", ["zoom"], "dotted", 16, "solid"]);
  });

  it("maps fixed values and stop values with `map`", () => {
    const dash = (name: unknown) => ["literal", name === "dashed" ? [2, 2] : [1, 0]];
    expect(
      toProperty(
        fromForm(
          {
            zoom: [
              [10, "dashed"],
              [14, "solid"],
            ],
            interpolate: "step",
          },
          "choice",
          "solid",
          dash
        )
      )
    ).toEqual(["step", ["zoom"], ["literal", [2, 2]], 14, ["literal", [1, 0]]]);
  });

  it("colors by attribute spread the palette over the domain and blend in Lab", () => {
    expect(
      toProperty(
        fromForm(
          { field: "density", palette: ["#ffffff", "#808080", "#000000"], domain: [0, 100] },
          "color",
          "#cccccc"
        )
      )
    ).toEqual([
      "case",
      ["!=", ["get", "density"], null],
      [
        "interpolate-lab",
        ["linear"],
        ["to-number", ["get", "density"], 0],
        0,
        "#ffffff",
        50,
        "#808080",
        100,
        "#000000",
      ],
      "#cccccc",
    ]);
    expect(
      toProperty(
        fromForm(
          { field: "d", palette: ["#ffffff", "#000000"], reverse: true, no_data: "#ff0000", domain: [0, 1] },
          "color",
          "#cccccc"
        )
      )
    ).toEqual([
      "case",
      ["!=", ["get", "d"], null],
      ["interpolate-lab", ["linear"], ["to-number", ["get", "d"], 0], 0, "#000000", 1, "#ffffff"],
      "#ff0000",
    ]);
  });

  it("colors by attribute on a sqrt or log scale spread the palette over the transformed values", () => {
    const sqrt = toProperty(
      fromForm(
        { field: "d", palette: ["#ffffff", "#808080", "#000000"], scale: "sqrt", domain: [0, 100] },
        "color",
        "#cccccc"
      )
    );
    expect(sqrt).toEqual([
      "case",
      ["all", ["!=", ["get", "d"], null], [">=", ["to-number", ["get", "d"], 0], 0]],
      [
        "interpolate-lab",
        ["linear"],
        ["sqrt", ["to-number", ["get", "d"], 0]],
        0,
        "#ffffff",
        5,
        "#808080",
        10,
        "#000000",
      ],
      "#cccccc",
    ]);
    expect(paintErrors(sqrt, "circle-color")).toEqual([]);
    const log = toProperty(
      fromForm(
        { field: "d", palette: ["#ffffff", "#000000"], scale: "log", domain: [1, 100] },
        "color",
        "#cccccc"
      )
    );
    expect(log).toEqual([
      "case",
      ["all", ["!=", ["get", "d"], null], [">", ["to-number", ["get", "d"], 0], 0]],
      [
        "interpolate-lab",
        ["linear"],
        ["ln", ["to-number", ["get", "d"], 0]],
        0,
        "#ffffff",
        Math.log(100),
        "#000000",
      ],
      "#cccccc",
    ]);
  });

  it("numbers by attribute, with sqrt and log scales and the computed domain", () => {
    expect(
      toProperty(fromForm({ field: "pupils", range: [0, 20], scale: "sqrt", domain: [0, 1600] }, "number", 8))
    ).toEqual([
      "case",
      ["all", ["!=", ["get", "pupils"], null], [">=", ["to-number", ["get", "pupils"], 0], 0]],
      ["interpolate", ["linear"], ["sqrt", ["to-number", ["get", "pupils"], 0]], 0, 0, 40, 20],
      8,
    ]);
    expect(
      toProperty(
        fromForm(
          { field: "t", range: [1, 9], scale: "log", computed: { at: "t", data: "f", domain: [1, 1000] } },
          "number",
          2
        )
      )
    ).toEqual([
      "case",
      ["all", ["!=", ["get", "t"], null], [">", ["to-number", ["get", "t"], 0], 0]],
      ["interpolate", ["linear"], ["ln", ["to-number", ["get", "t"], 0]], 0, 1, Math.log(1000), 9],
      2,
    ]);
    expect(toProperty(fromForm({ field: "w", range: [1, 4], domain: [5, 5] }, "number", 2))).toEqual([
      "case",
      ["!=", ["get", "w"], null],
      1,
      2,
    ]);
  });

  it("a value form without any domain draws the fallback (not computed yet)", () => {
    expect(toProperty(fromForm({ field: "pupils", range: [2, 12] }, "number", 8))).toBe(8);
    expect(toProperty(fromForm({ field: "d", palette: "colorbrewer:OrRd" }, "color", "#cccccc"))).toBe(
      "#cccccc"
    );
  });

  it("raw field values", () => {
    expect(toProperty(fromForm({ field: "heading" }, "number", 0))).toEqual([
      "to-number",
      ["get", "heading"],
      0,
    ]);
    expect(toProperty(fromForm({ field: "hex" }, "color", "#000000"))).toEqual([
      "to-color",
      ["get", "hex"],
      "#000000",
    ]);
  });

  it("attribute values inside zoom stops", () => {
    const v = fromForm(
      {
        zoom: [
          [11, { field: "p", range: [2, 8], domain: [0, 100] }],
          [16, { field: "p", range: [4, 16], domain: [0, 100] }],
        ],
      },
      "number",
      8
    );
    const property = toProperty(v);
    expect((property as unknown[]).slice(0, 4)).toEqual(["interpolate", ["linear"], ["zoom"], 11]);
    expect(paintErrors(property)).toEqual([]);
  });

  it("a color by attribute in zoom stops, taken between two stops, is each feature's color the stops blend to there", () => {
    const palette = (colors: string[]) => ({ field: "p", palette: colors, domain: [0, 100] });
    const form = (more: object = {}) => ({
      zoom: [
        [11, palette(["#0000ff", "#00ff00"])],
        [15, palette(["#ff0000", "#ffff00"])],
      ],
      ...more,
    });
    // As the value as a property (a top-level interpolate on the zoom) gives it at that zoom.
    for (const curve of [{}, { interpolate: "exponential", base: 2 }]) {
      const v = fromForm(form(curve), "color", "#2bb381");
      for (const zoom of [11, 12, 13.5, 15])
        for (const p of [0, 50, 100])
          expect(colorAt(valueAt(v, zoom), { p }, 0), `zoom ${zoom}, p ${p}`).toEqual(
            colorAt(toProperty(v), { p }, zoom)
          );
    }
    // A fixed color at one stop blends with the other stop's colors.
    const mixed = fromForm(
      {
        zoom: [
          [11, "#000000"],
          [15, palette(["#ff0000", "#ffff00"])],
        ],
      },
      "color",
      "#2bb381"
    );
    expect(colorAt(valueAt(mixed, 12), { p: 100 }, 0)).toEqual([64, 64, 0, 1]);
    // The same colors at both stops stay that one expression.
    const same = fromForm(
      {
        zoom: [
          [11, palette(["#0000ff", "#00ff00"])],
          [15, palette(["#0000ff", "#00ff00"])],
        ],
      },
      "color",
      "#2bb381"
    );
    expect(valueAt(same, 12)).toEqual(valueAt(same, 11));
  });
});

describe("combining values", () => {
  it("casing width is the line width plus twice the casing width at every stop (spec 16 golden)", () => {
    const w = combine(
      [
        fromForm(
          {
            zoom: [
              [10, 2],
              [16, 6],
            ],
          },
          "number",
          2
        ),
        fromForm(1.5, "number", 1),
      ],
      ([l, c]) => ["+", l, ["*", 2, c]]
    );
    expect(toProperty(w)).toEqual(["interpolate", ["linear"], ["zoom"], 10, 5, 16, 9]);
  });

  it("evaluates each value at the union of stops; mixed curves become linear", () => {
    const v = combine(
      [
        fromForm(
          {
            zoom: [
              [10, 1],
              [14, 3],
            ],
          },
          "number",
          1
        ),
        fromForm(
          {
            zoom: [
              [12, 2],
              [16, 4],
            ],
            interpolate: "exponential",
          },
          "number",
          1
        ),
      ],
      ([a, b]) => ["+", a, b]
    );
    expect(toProperty(v)).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      3,
      12,
      4,
      14,
      5.5617977528,
      16,
      7,
    ]);
  });

  it("a step value makes the combination a step", () => {
    const v = combine(
      [
        fromForm(
          {
            zoom: [
              [12, 1],
              [16, 0],
            ],
            interpolate: "step",
          },
          "number",
          1
        ),
        fromForm(0.5, "number", 1),
      ],
      ([a, b]) => ["*", a, b]
    );
    expect(toProperty(v)).toEqual(["step", ["zoom"], 0.5, 16, 0]);
  });

  it("wraps data expressions at each stop so zoom stays at the top level", () => {
    const v = combine(
      [
        fromForm(
          {
            zoom: [
              [10, 2],
              [16, 6],
            ],
          },
          "number",
          2
        ),
      ],
      ([w]) => ["case", ["boolean", ["feature-state", "active"], false], ["max", w, 3], w]
    );
    const property = toProperty(v);
    expect(property).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      ["case", ["boolean", ["feature-state", "active"], false], 3, 2],
      16,
      ["case", ["boolean", ["feature-state", "active"], false], 6, 6],
    ]);
    expect(paintErrors(property, "line-width", "line")).toEqual([]);
  });

  it("a color by attribute in zoom stops combined over other stop zooms blends there too", () => {
    const palette = (colors: string[]) => ({ field: "p", palette: colors, domain: [0, 100] });
    const color = fromForm(
      {
        zoom: [
          [11, palette(["#0000ff", "#00ff00"])],
          [15, palette(["#ff0000", "#ffff00"])],
        ],
      },
      "color",
      "#2bb381"
    );
    const width = fromForm(
      {
        zoom: [
          [12, 1],
          [14, 3],
        ],
      },
      "number",
      1
    );
    // Taken at the union of stops (11, 12, 14, 15): each feature's color as the color alone gives it.
    const v = combine([color, width], ([c]) => c, { kind: "color" });
    const property = toProperty(v);
    expect(paintErrors(property, "circle-color")).toEqual([]);
    for (const zoom of [12, 13, 14])
      for (const p of [0, 50, 100])
        expect(colorAt(property, { p }, zoom), `zoom ${zoom}, p ${p}`).toEqual(
          colorAt(toProperty(color), { p }, zoom)
        );
  });

  it("folds constant arithmetic", () => {
    expect(fold(["*", 0.1, 3])).toBe(0.3);
    expect(fold(["+", ["*", 2, 1.5], 2])).toBe(5);
    expect(fold(["max", 2, 3])).toBe(3);
    expect(fold(["+", ["get", "a"], 1])).toEqual(["+", ["get", "a"], 1]);
  });
});

describe("folding and degenerate domains", () => {
  it("never folds category labels, even ones that look like operators", () => {
    const expr = ["match", ["get", "stars"], ["*", "**"], "#111111", ["+", "-"], "#222222", "#000000"];
    expect(fold(expr)).toEqual(expr);
  });

  it("a sqrt scale over a domain reaching below 0 starts at 0 (values below 0 are no data)", () => {
    const property = toProperty(
      fromForm({ field: "v", range: [0, 24], scale: "sqrt", domain: [-10, 100] }, "number", 4)
    );
    expect(property).toEqual([
      "case",
      ["all", ["!=", ["get", "v"], null], [">=", ["to-number", ["get", "v"], 0], 0]],
      ["interpolate", ["linear"], ["sqrt", ["to-number", ["get", "v"], 0]], 0, 0, 10, 24],
      4,
    ]);
    expect(paintErrors(property)).toEqual([]);
  });

  it("a log scale whose domain starts at 0 or below gives every feature the start value", () => {
    expect(
      toProperty(fromForm({ field: "v", range: [2, 8], scale: "log", domain: [0, 100] }, "number", 4))
    ).toEqual(["case", ["!=", ["get", "v"], null], 2, 4]);
  });

  it("a reversed domain still compiles to ascending stops", () => {
    expect(toProperty(fromForm({ field: "v", range: [2, 8], domain: [100, 0] }, "number", 4))).toEqual([
      "case",
      ["!=", ["get", "v"], null],
      ["interpolate", ["linear"], ["to-number", ["get", "v"], 0], 0, 8, 100, 2],
      4,
    ]);
    const ramp = toProperty(
      fromForm({ field: "v", palette: ["#000000", "#ffffff"], domain: [10, 0] }, "color", "#cccccc")
    );
    expect(paintErrors(ramp, "circle-color")).toEqual([]);
  });
});

describe("raw fields", () => {
  it("a raw field goes through the raw hook", () => {
    const v = fromForm({ field: "levels" }, "number", 0, undefined, (get) => ["*", get, 3]);
    expect(v).toEqual({ expr: ["*", ["to-number", ["get", "levels"], 0], 3] });
  });

  it("fixed values, zoom stops and ranges stay as they are", () => {
    const raw = (get: unknown) => ["*", get, 3];
    expect(fromForm(12, "number", 0, undefined, raw)).toEqual({ expr: 12 });
    expect(
      toProperty(
        fromForm(
          {
            zoom: [
              [10, 2],
              [16, 6],
            ],
          },
          "number",
          0,
          undefined,
          raw
        )
      )
    ).toEqual(["interpolate", ["linear"], ["zoom"], 10, 2, 16, 6]);
    expect(
      JSON.stringify(fromForm({ field: "h", range: [0, 50], domain: [0, 10] }, "number", 0, undefined, raw))
    ).not.toContain('"*"');
  });
});
