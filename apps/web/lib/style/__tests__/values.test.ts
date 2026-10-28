import { describe, expect, it } from "vitest";

import { combine, fold, fromForm, toProperty } from "@/lib/style/compile/values";

import { paintErrors } from "./maplibre";

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
      ["has", "density"],
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
      ["has", "d"],
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
      ["all", ["has", "d"], [">=", ["to-number", ["get", "d"], 0], 0]],
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
      ["all", ["has", "d"], [">", ["to-number", ["get", "d"], 0], 0]],
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
      ["all", ["has", "pupils"], [">=", ["to-number", ["get", "pupils"], 0], 0]],
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
      ["all", ["has", "t"], [">", ["to-number", ["get", "t"], 0], 0]],
      ["interpolate", ["linear"], ["ln", ["to-number", ["get", "t"], 0]], 0, 1, Math.log(1000), 9],
      2,
    ]);
    expect(toProperty(fromForm({ field: "w", range: [1, 4], domain: [5, 5] }, "number", 2))).toEqual([
      "case",
      ["has", "w"],
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
      ["all", ["has", "v"], [">=", ["to-number", ["get", "v"], 0], 0]],
      ["interpolate", ["linear"], ["sqrt", ["to-number", ["get", "v"], 0]], 0, 0, 10, 24],
      4,
    ]);
    expect(paintErrors(property)).toEqual([]);
  });

  it("a log scale whose domain starts at 0 or below gives every feature the start value", () => {
    expect(
      toProperty(fromForm({ field: "v", range: [2, 8], scale: "log", domain: [0, 100] }, "number", 4))
    ).toEqual(["case", ["has", "v"], 2, 4]);
  });

  it("a reversed domain still compiles to ascending stops", () => {
    expect(toProperty(fromForm({ field: "v", range: [2, 8], domain: [100, 0] }, "number", 4))).toEqual([
      "case",
      ["has", "v"],
      ["interpolate", ["linear"], ["to-number", ["get", "v"], 0], 0, 8, 100, 2],
      4,
    ]);
    const ramp = toProperty(
      fromForm({ field: "v", palette: ["#000000", "#ffffff"], domain: [10, 0] }, "color", "#cccccc")
    );
    expect(paintErrors(ramp, "circle-color")).toEqual([]);
  });
});
