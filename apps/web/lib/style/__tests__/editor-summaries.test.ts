import i18next from "i18next";
import { describe, expect, it } from "vitest";

import en from "@/i18n/locales/en/common.json";

import { scopedView } from "@/lib/style/editor/classify";
import { colorsIn, summarize, swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";

const i18n = i18next.createInstance();
void i18n.init({ lng: "en", resources: { en: { common: en } }, defaultNS: "common", initImmediate: false });
const t = i18n.t.bind(i18n);

const doc = (symbol: object, extra: object = {}) =>
  ({ version: 1, kind: "vector", symbol, ...extra }) as LayerStyle;
const fields = [{ name: "visitors", type: "integer" as const, label: "Visitors per year" }];
const ctx = { fields, mapZoom: 12, geometry: "polygon" as const };

describe("row summaries", () => {
  it("fixed values", () => {
    expect(summarize(doc({ fill: { color: "#c7e9b4", opacity: 0.72 } }), "symbol.fill.color", t, ctx)).toBe(
      "#C7E9B4 · 72%"
    );
    expect(summarize(doc({ line: { width: 3 } }), "symbol.line.width", t, ctx)).toBe("3 px");
    expect(summarize(doc({ line: {} }), "symbol.line.width", t, ctx)).toBe("2 px");
    expect(summarize(doc({ line: { dash: "dash_dot" } }), "symbol.line.dash", t, ctx)).toBe("Dash dot");
  });

  it("values by zoom", () => {
    expect(
      summarize(
        doc({
          line: {
            width: {
              zoom: [
                [10, 2],
                [16, 6],
              ],
            },
          },
        }),
        "symbol.line.width",
        t,
        ctx
      )
    ).toBe("2 → 6 px");
    const dashes = {
      zoom: [
        [10, "dotted"],
        [13, "dashed"],
        [16, "solid"],
      ],
      interpolate: "step",
    };
    expect(summarize(doc({ line: { dash: dashes } }), "symbol.line.dash", t, ctx)).toBe(
      "Dotted → Dashed → Solid"
    );
    expect(
      summarize(
        doc({
          fill: {
            color: {
              zoom: [
                [10, "#000000"],
                [16, "#ffffff"],
              ],
            },
          },
        }),
        "symbol.fill.color",
        t,
        ctx
      )
    ).toBe("By zoom · 2 stops");
  });

  it("values by attribute and by classes", () => {
    expect(
      summarize(
        doc({ fill: { color: { field: "visitors", palette: "goat:green" } } }),
        "symbol.fill.color",
        t,
        ctx
      )
    ).toBe("By Visitors per year");
    const classified = doc({ fill: {} }, { classify: [{ field: "use", method: "categories" }] });
    expect(summarize(classified, "symbol.fill.color", t, ctx)).toBe("By use");
  });
});

describe("swatches", () => {
  it("the fixed color, the fill color for the sentinel, the default when unset", () => {
    const d = doc({ fill: { color: "#a1d99b" }, outline: { color: "fill" } });
    expect(swatchOf(d, "symbol.fill.color", "polygon")).toBe("#a1d99b");
    expect(swatchOf(d, "symbol.outline.color", "polygon")).toBe("#a1d99b");
    expect(swatchOf(doc({}), "symbol.line.color", "line")).toBe("#2166ac");
  });

  it("in one class's scope the fill shows that class's color, not the classes' ramp", () => {
    const d = doc(
      { fill: { color: "#cccccc" } },
      {
        classify: [
          {
            field: "use",
            method: "categories",
            classes: [{ fill: { color: "#ff0000" } }, { fill: { color: "#00ff00" } }],
          },
        ],
      }
    );
    const view = scopedView(d, { classify: 0, key: 0 }).view;
    expect(swatchOf(view, "symbol.fill.color", "polygon", { scoped: true })).toBe("#ff0000");
  });

  it("a fill colored by classes shows the classes' colors, not the color under them", () => {
    const d = doc(
      { fill: { color: "#cccccc" } },
      {
        classify: [
          {
            field: "density",
            method: "quantile",
            classes: [
              { fill: { color: "#ffffcc" } },
              { fill: { color: "#41b6c4" } },
              { fill: { color: "#253494" } },
            ],
          },
        ],
      }
    );
    expect(swatchOf(d, "symbol.fill.color", "polygon")).toBe(
      "linear-gradient(90deg, #ffffcc, #41b6c4, #253494)"
    );
    // A classification of another part leaves the fill's own color.
    const outlined = doc(
      { fill: { color: "#cccccc" } },
      {
        classify: [
          {
            field: "d",
            method: "quantile",
            target: "outline.color",
            classes: [{ outline: { color: "#111111" } }],
          },
        ],
      }
    );
    expect(swatchOf(outlined, "symbol.fill.color", "polygon")).toBe("#cccccc");
  });

  it("a gradient for colors by zoom and by attribute", () => {
    const d = doc({
      fill: {
        color: {
          zoom: [
            [8, "#ff0000"],
            [14, "#0000ff"],
          ],
        },
      },
      line: { color: { field: "v", palette: ["#000000", "#ffffff"], reverse: true } },
    });
    expect(swatchOf(d, "symbol.fill.color", "polygon")).toBe("linear-gradient(90deg, #ff0000, #0000ff)");
    expect(swatchOf(d, "symbol.line.color", "line")).toBe("linear-gradient(90deg, #ffffff, #000000)");
  });
});

describe("colors in a style", () => {
  it("lists each color once, in document order", () => {
    const d = doc(
      { fill: { color: "#A1D99B" }, outline: { color: "fill" } },
      {
        classify: [{ field: "x", classes: [{ fill: { color: "#a1d99b" } }, { fill: { color: "#e6ab02" } }] }],
      }
    );
    expect(colorsIn(d)).toEqual(["#a1d99b", "#e6ab02"]);
  });
});
