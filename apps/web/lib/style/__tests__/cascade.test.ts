import { featureFilter as maplibreFilter } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { cascade, featureFilter, partUsed } from "@/lib/style/compile/cascade";
import { DASHES } from "@/lib/style/compile/constants";
import { cqlToExpression } from "@/lib/style/compile/cql";
import { toProperty } from "@/lib/style/compile/values";

import { fieldTypes, goldenPairs } from "./fixtures";
import { paintErrors } from "./maplibre";

const dash = (v: unknown) => ["literal", DASHES[v as string] ?? DASHES.solid];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (extra: object): any => ({
  version: 1,
  kind: "vector",
  symbol: { fill: { color: "#cccccc" } },
  ...extra,
});

describe("cascade", () => {
  const [routes, districts] = goldenPairs();
  const routeFields = fieldTypes(routes.dataset);

  it("categories (spec 16 golden)", () => {
    expect(toProperty(cascade(routes.doc, "casing.opacity", { fields: routeFields }))).toEqual([
      "match",
      ["get", "status"],
      "planned",
      0,
      1,
    ]);
    expect(toProperty(cascade(routes.doc, "line.opacity", { fields: routeFields }))).toEqual([
      "match",
      ["get", "status"],
      "planned",
      0.6,
      1,
    ]);
    expect(toProperty(cascade(routes.doc, "line.dash", { fields: routeFields, map: dash }))).toEqual([
      "match",
      ["get", "status"],
      "planned",
      ["literal", [2, 2]],
      ["literal", [1, 0]],
    ]);
    expect(toProperty(cascade(routes.doc, "line.width", { fields: routeFields }))).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      2,
      16,
      6,
    ]);
    expect(featureFilter(routes.doc, { fields: routeFields })).toEqual([
      "any",
      ["!=", ["get", "status"], "planned"],
      [">=", ["zoom"], 13],
    ]);
  });

  it("numeric classes (spec 16 golden)", () => {
    expect(
      toProperty(cascade(districts.doc, "fill.color", { fields: fieldTypes(districts.dataset) }))
    ).toEqual([
      "case",
      ["has", "density"],
      [
        "step",
        ["to-number", ["get", "density"], 0],
        "#fef0d9",
        2800,
        "#fdcc8a",
        3600,
        "#fc8d59",
        4300,
        "#e34a33",
        6300,
        "#b30000",
      ],
      "#cccccc",
    ]);
    expect(featureFilter(districts.doc, {})).toBeUndefined();
  });

  it("numeric classes that do not reach the ends step back to the base", () => {
    const style = doc({
      classify: [
        {
          field: "v",
          method: "manual",
          classes: [
            { from: 0, to: 10, fill: { color: "#111111" } },
            { from: 10, to: 20, fill: { color: "#222222" } },
          ],
        },
      ],
    });
    expect(toProperty(cascade(style, "fill.color", {}))).toEqual([
      "case",
      ["has", "v"],
      ["step", ["to-number", ["get", "v"], 0], "#cccccc", 0, "#111111", 10, "#222222", 20, "#cccccc"],
      "#cccccc",
    ]);
  });

  it("a computed classification without classes draws the base", () => {
    const style = doc({
      classify: [{ field: "density", method: "quantile", count: 5, palette: "colorbrewer:OrRd" }],
    });
    expect(toProperty(cascade(style, "fill.color", {}))).toBe("#cccccc");
  });

  it("categories without field types compare as text, so numbers stored as text still match", () => {
    // The map compiles without field types; converted styles hold an integer field's values as text.
    const classes = [
      { values: ["3"], fill: { color: "#111111" } },
      { values: ["6", "9"], fill: { color: "#222222" } },
    ];
    const property = toProperty(
      cascade(doc({ classify: [{ field: "travel_cost", method: "categories", classes }] }), "fill.color", {})
    );
    expect(property).toEqual([
      "match",
      ["to-string", ["get", "travel_cost"]],
      "3",
      "#111111",
      ["6", "9"],
      "#222222",
      "#cccccc",
    ]);
    const numbers = [{ values: [1, 2], fill: { color: "#111111" } }];
    expect(
      toProperty(
        cascade(doc({ classify: [{ field: "n", method: "categories", classes: numbers }] }), "fill.color", {})
      )
    ).toEqual(["match", ["to-string", ["get", "n"]], ["1", "2"], "#111111", "#cccccc"]);
  });

  it("with a field type, category labels take the field's type", () => {
    const asText = [{ values: ["3", "x"], fill: { color: "#111111" } }];
    expect(
      toProperty(
        cascade(doc({ classify: [{ field: "n", method: "categories", classes: asText }] }), "fill.color", {
          fields: { n: "integer" },
        })
      )
    ).toEqual(["match", ["get", "n"], 3, "#111111", "#cccccc"]);
    const asNumbers = [{ values: [3], fill: { color: "#111111" } }];
    expect(
      toProperty(
        cascade(doc({ classify: [{ field: "t", method: "categories", classes: asNumbers }] }), "fill.color", {
          fields: { t: "string" },
        })
      )
    ).toEqual(["match", ["get", "t"], "3", "#111111", "#cccccc"]);
  });

  it("types category labels by the field", () => {
    const classes = [
      { values: [1, 2], fill: { color: "#111111" } },
      { values: [3], fill: { color: "#222222" } },
    ];
    expect(
      toProperty(
        cascade(doc({ classify: [{ field: "n", method: "categories", classes }] }), "fill.color", {
          fields: { n: "integer" },
        })
      )
    ).toEqual(["match", ["get", "n"], [1, 2], "#111111", 3, "#222222", "#cccccc"]);
    const flags = doc({
      classify: [
        { field: "ok", method: "categories", classes: [{ values: ["true"], fill: { color: "#00ff00" } }] },
      ],
    });
    expect(toProperty(cascade(flags, "fill.color", { fields: { ok: "boolean" } }))).toEqual([
      "match",
      ["to-string", ["get", "ok"]],
      "true",
      "#00ff00",
      "#cccccc",
    ]);
  });

  it("other replaces the fallback and no_data wraps a has check", () => {
    const style = doc({
      classify: [
        {
          field: "type",
          method: "categories",
          classes: [{ values: ["park"], fill: { color: "#00ff00" } }],
          other: { fill: { color: "#999999" } },
          no_data: { fill: { color: "#ffffff" } },
        },
      ],
    });
    expect(toProperty(cascade(style, "fill.color", { fields: { type: "string" } }))).toEqual([
      "case",
      ["has", "type"],
      ["match", ["get", "type"], "park", "#00ff00", "#999999"],
      "#ffffff",
    ]);
  });

  it("numeric classes not computed yet draw only their No data value", () => {
    const style = doc({
      classify: [{ field: "share", method: "quantile", count: 5, no_data: { fill: { color: "#ffffff" } } }],
    });
    expect(toProperty(cascade(style, "fill.color", { fields: { share: "number" } }))).toEqual([
      "case",
      ["has", "share"],
      "#cccccc",
      "#ffffff",
    ]);
  });

  it("later rules win and a hiding rule goes into the filter", () => {
    const style = doc({
      rules: [
        { when: { op: "=", args: [{ property: "type" }, "a"] }, fill: { color: "#ff0000" } },
        { when: { op: "=", args: [{ property: "type" }, "b"] }, fill: { color: "#0000ff" } },
        { when: { op: "=", args: [{ property: "kind" }, "x"] }, visible: false },
      ],
    });
    expect(toProperty(cascade(style, "fill.color", {}))).toEqual([
      "case",
      ["==", ["get", "type"], "b"],
      "#0000ff",
      ["==", ["get", "type"], "a"],
      "#ff0000",
      "#cccccc",
    ]);
    expect(featureFilter(style, {})).toEqual(["!", ["==", ["get", "kind"], "x"]]);
  });

  it("several hiding records cascade in order", () => {
    const style = doc({
      classify: [{ field: "t", method: "categories", classes: [{ values: ["a"], visible: false }] }],
      rules: [{ when: { op: "=", args: [{ property: "big" }, true] }, visible: true }],
    });
    expect(featureFilter(style, { fields: { t: "string" } })).toEqual([
      "case",
      ["==", ["get", "big"], true],
      true,
      ["==", ["get", "t"], "a"],
      false,
      true,
    ]);
  });

  it("a zoom value under classes stays at the top level", () => {
    const style = doc({
      symbol: {
        fill: {
          color: "#cccccc",
          opacity: {
            zoom: [
              [10, 0.2],
              [14, 0.8],
            ],
          },
        },
      },
      classify: [{ field: "t", method: "categories", classes: [{ values: ["a"], fill: { opacity: 1 } }] }],
    });
    const property = toProperty(cascade(style, "fill.opacity", { fields: { t: "string" } }));
    expect(property).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      ["match", ["get", "t"], "a", 1, 0.2],
      14,
      ["match", ["get", "t"], "a", 1, 0.8],
    ]);
    expect(paintErrors(property, "fill-opacity", "fill")).toEqual([]);
  });

  it("other takes values in no class; features without a value keep the base (spec 5.1)", () => {
    const style = doc({
      classify: [
        {
          field: "type",
          method: "categories",
          classes: [{ values: ["park"], fill: { color: "#00ff00" } }],
          other: { fill: { color: "#999999" } },
        },
      ],
    });
    expect(toProperty(cascade(style, "fill.color", { fields: { type: "string" } }))).toEqual([
      "case",
      ["has", "type"],
      ["match", ["get", "type"], "park", "#00ff00", "#999999"],
      "#cccccc",
    ]);
  });

  it("numeric classes whose bounds do not ascend are left out, keeping the step valid", () => {
    const classes = [
      { from: 0, to: 10, fill: { color: "#111111" } },
      { from: 10, to: 20, fill: { color: "#222222" } },
      { from: 10, to: 30, fill: { color: "#333333" } },
      { fill: { color: "#444444" } },
    ];
    expect(
      paintErrors(
        toProperty(cascade(doc({ classify: [{ field: "v", method: "manual", classes }] }), "fill.color", {})),
        "fill-color",
        "fill"
      )
    ).toEqual([]);
    const backwards = doc({
      classify: [
        {
          field: "v",
          method: "manual",
          classes: [
            { from: 0, to: 10, fill: { color: "#111111" } },
            { from: 10, to: 5, fill: { color: "#222222" } },
          ],
        },
      ],
    });
    expect(paintErrors(toProperty(cascade(backwards, "fill.color", {})), "fill-color", "fill")).toEqual([]);
  });

  it("category labels that look like operators stay as written", () => {
    const style = doc({
      classify: [
        {
          field: "stars",
          method: "categories",
          classes: [{ values: ["*", "**"], fill: { color: "#111111" } }],
        },
      ],
    });
    expect(toProperty(cascade(style, "fill.color", { fields: { stars: "string" } }))).toEqual([
      "match",
      ["get", "stars"],
      ["*", "**"],
      "#111111",
      "#cccccc",
    ]);
  });

  it("knows which parts are used", () => {
    expect(partUsed(doc({}), "fill", "polygon")).toBe(true);
    expect(partUsed(doc({}), "outline", "polygon")).toBe(false);
    expect(
      partUsed(
        doc({ rules: [{ when: { op: "isNull", args: [{ property: "a" }] }, outline: { width: 2 } }] }),
        "outline",
        "polygon"
      )
    ).toBe(true);
    expect(partUsed(doc({ symbol: { line: { color: "#000000" } } }), "line", "line")).toBe(true);
  });
});

describe("cqlToExpression", () => {
  it("comparisons, lists, logic and empty values", () => {
    expect(cqlToExpression({ op: "<=", args: [{ property: "v" }, 5] })).toEqual([
      "all",
      ["==", ["typeof", ["get", "v"]], "number"],
      ["<=", ["get", "v"], 5],
    ]);
    expect(cqlToExpression({ op: "<>", args: [{ property: "v" }, "x"] })).toEqual(["!=", ["get", "v"], "x"]);
    expect(cqlToExpression({ op: "in", args: [{ property: "type" }, ["a", "b"]] })).toEqual([
      "in",
      ["get", "type"],
      ["literal", ["a", "b"]],
    ]);
    expect(cqlToExpression({ op: "isNull", args: [{ property: "name" }] })).toEqual(["!", ["has", "name"]]);
    expect(
      cqlToExpression({
        op: "and",
        args: [
          { op: "not", args: [{ op: "isNull", args: [{ property: "a" }] }] },
          { op: "or", args: [{ op: "=", args: [{ property: "b" }, 1] }] },
        ],
      })
    ).toEqual(["all", ["!", ["!", ["has", "a"]]], ["any", ["==", ["get", "b"], 1]]]);
  });

  it("order comparisons are false for features without the value, never an evaluation error", () => {
    const quiet = cqlToExpression({ op: "<", args: [{ property: "traffic" }, 1500] });
    expect(quiet).toEqual([
      "all",
      ["==", ["typeof", ["get", "traffic"]], "number"],
      ["<", ["get", "traffic"], 1500],
    ]);
    // The spec 6 example hides quiet routes below zoom 14: a route without traffic stays visible at zoom 15.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter = maplibreFilter(["any", ["!", quiet], [">=", ["zoom"], 14]] as any, "layers[0].filter");
    const feature = (properties: Record<string, unknown>) => ({ type: 2 as const, properties, geometry: [] });
    expect(filter.filter({ zoom: 15 }, feature({}))).toBe(true);
    expect(filter.filter({ zoom: 12 }, feature({ traffic: 900 }))).toBe(false);
    expect(cqlToExpression({ op: ">=", args: [{ property: "name" }, "M"] })).toEqual([
      "all",
      ["==", ["typeof", ["get", "name"]], "string"],
      [">=", ["get", "name"], "M"],
    ]);
    expect(cqlToExpression({ op: "<", args: [{ property: "ok" }, true] })).toBe(false);
  });

  it("like as contains, starts with and ends with", () => {
    const s = ["to-string", ["get", "name"]];
    expect(cqlToExpression({ op: "like", args: [{ property: "name" }, "%park%"] })).toEqual([
      "in",
      "park",
      s,
    ]);
    expect(cqlToExpression({ op: "like", args: [{ property: "name" }, "Am %"] })).toEqual([
      "==",
      ["slice", s, 0, 3],
      "Am ",
    ]);
    expect(cqlToExpression({ op: "like", args: [{ property: "name" }, "%weg"] })).toEqual([
      "==",
      ["slice", s, ["-", ["length", s], 3]],
      "weg",
    ]);
  });
});
