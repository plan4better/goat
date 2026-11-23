// Category class values written as numbers in another spelling than the one the map reads ("3.0", "0.50", goatlib's
// "1e-05"; converted styles hold a number field's values as text). The map compiles without field types and compares
// the feature value's text (MapLibre's `to-string`) with the class values, so such a class also matches the number's
// own spelling, unless another class lists that text; a text field holding "3.0" still matches "3.0". The legend's
// classifier, the popup's class and the presence counts read classes the same way. Invented data only.
import { describe, expect, it } from "vitest";

import { classTexts, mapNumberText } from "@/lib/style/categoryTexts";
import { compileLayer } from "@/lib/style/compile";
import type { CompileInput, FieldType } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { classIndexOf } from "@/lib/style/legend";
import { countPresence, presenceFromCounts } from "@/lib/style/presence";

import { evaluate, maplibreErrors } from "./maplibre";

const RED = "#ff0000";
const BLUE = "#0000ff";
const OTHER = "#00ff00";
const BASE = "#999999";

const tiles = { type: "tiles" as const, id: "s7", tiles: ["https://t/{z}/{x}/{y}"] };

const classification = (...classes: Array<{ values: unknown[]; color?: string; visible?: boolean }>) => ({
  id: "r",
  field: "r",
  method: "categories",
  classes: classes.map((k, i) => ({
    id: `c${i + 1}`,
    values: k.values,
    ...(k.visible === false ? { visible: false } : {}),
    fill: { color: k.color ?? [RED, BLUE][i] },
  })),
  other: { fill: { color: OTHER } },
});

const style = (c: object) =>
  ({
    version: "1.0.0",
    kind: "vector",
    symbol: { fill: { color: BASE } },
    classify: [c],
  }) as unknown as LayerStyle;

const compile = (c: object, fields?: Record<string, FieldType>) =>
  compileLayer({ id: "l", style: style(c), geometry: "polygon", source: tiles, fields } as CompileInput);

const fillLayer = (out: ReturnType<typeof compile>) =>
  out.layers.find((l) => l.type === "fill") as { paint: Record<string, unknown>; filter?: unknown };

/** The color the map gives a feature with these properties. */
const colorOf = (c: object, properties: Record<string, unknown>, fields?: Record<string, FieldType>) =>
  evaluate(fillLayer(compile(c, fields)).paint["fill-color"], properties);

describe("the number spelling MapLibre's to-string gives", () => {
  it("is JavaScript's text of the number, for every decimal text", () => {
    // `to-string` of a number is `String(number)` (style spec `valueToString`): it writes an exponent from 1e21 up and
    // below 1e-6, where goatlib's `as_text` writes every digit of a whole number and an exponent below 1e-4.
    for (const [text, spelled] of [
      ["3.0", "3"],
      ["0.50", "0.5"],
      ["-0.0", "0"],
      ["-2.50", "-2.5"],
      ["1e-05", "0.00001"],
      ["1e+21", "1e+21"],
      ["1.5e-07", "1.5e-7"],
      ["1000000000000000000000", "1e+21"],
      ["10000000000000000", "10000000000000000"],
      ["30745.380859375", "30745.380859375"],
      ["123456789.125", "123456789.125"],
    ] as const) {
      expect(mapNumberText(text), text).toBe(spelled);
      expect(evaluate(["to-string", ["get", "v"]], { v: Number(text) }), text).toBe(spelled);
    }
  });

  it("is nothing for a text that spells no finite number", () => {
    for (const text of ["", " ", "abc", "0x10", "1e400", "inf", "nan", "3 ", "1,5", "Infinity"])
      expect(mapNumberText(text), JSON.stringify(text)).toBeUndefined();
  });

  it("is nothing for a text no database or goatlib writes for a number: codes with leading zeros stay codes", () => {
    for (const text of ["01067", "007", "00.5", "+3", ".5", "3.", "-.5"])
      expect(mapNumberText(text), JSON.stringify(text)).toBeUndefined();
  });

  it("leaves a postcode class with a leading zero to its own text on the map", () => {
    const c = classification({ values: ["01067"] });
    expect(colorOf(c, { r: "01067" })).toBe(RED);
    expect(colorOf(c, { r: "1067" })).toBe(OTHER);
    expect(colorOf(c, { r: 1067 })).toBe(OTHER);
  });
});

describe("classTexts", () => {
  it("gives a class its values' texts, then each number spelling no class lists", () => {
    expect(classTexts([{ values: ["0.50", "a"] }, { values: [7, true] }])).toEqual([
      ["0.50", "a", "0.5"],
      ["7", "true"],
    ]);
  });

  it("keeps a spelling another class lists for that class, the first class otherwise", () => {
    expect(classTexts([{ values: ["3.0"] }, { values: ["3"] }])).toEqual([["3.0"], ["3"]]);
    expect(classTexts([{ values: ["3.0"] }, { values: ["3.00"] }])).toEqual([["3.0", "3"], ["3.00"]]);
    expect(classTexts([{ values: ["x"] }, { values: ["x", "y"] }])).toEqual([["x"], ["y"]]);
  });
});

describe("on the map, a field of unknown type", () => {
  it("draws a class stored as 0.50 for the value 0.5", () => {
    expect(colorOf(classification({ values: ["0.50"] }), { r: 0.5 })).toBe(RED);
  });

  it("draws a class stored as 3.0 for the value 3", () => {
    expect(colorOf(classification({ values: ["3.0"] }), { r: 3 })).toBe(RED);
  });

  it("draws a class in goatlib's spelling 1e-05 for the value 0.00001", () => {
    expect(colorOf(classification({ values: ["1e-05"] }), { r: 1e-5 })).toBe(RED);
  });

  it("still draws a class stored as 3.0 for a text field holding 3.0", () => {
    expect(colorOf(classification({ values: ["3.0"] }), { r: "3.0" })).toBe(RED);
  });

  it("keeps two classes 3.0 and 3 apart", () => {
    const c = classification({ values: ["3.0"] }, { values: ["3"] });
    expect(colorOf(c, { r: 3 })).toBe(BLUE);
    expect(colorOf(c, { r: "3" })).toBe(BLUE);
    expect(colorOf(c, { r: "3.0" })).toBe(RED);
  });

  it("gives the number to the first of two classes that spell it differently", () => {
    const c = classification({ values: ["3.0"] }, { values: ["3.00"] });
    expect(colorOf(c, { r: 3 })).toBe(RED);
    expect(colorOf(c, { r: "3.00" })).toBe(BLUE);
  });

  it("leaves values in no class to Other", () => {
    expect(colorOf(classification({ values: ["0.50"] }), { r: 0.25 })).toBe(OTHER);
  });

  it("hides the features of a hidden class stored as 3.0 whose value is 3", () => {
    const filter = fillLayer(compile(classification({ values: ["3.0"], visible: false }))).filter;
    expect(evaluate(filter, { r: 3 })).toBe(false);
    expect(evaluate(filter, { r: "3.0" })).toBe(false);
    expect(evaluate(filter, { r: 4 })).toBe(true);
  });

  it("validates with 256 classes of several numbers each, every label once", () => {
    const classes = Array.from({ length: 256 }, (_, i) => ({
      values: [`${i}.0`, `${i}.50`, `${i}.250`, i === 0 ? "1" : `${i}`],
      color: RED,
    }));
    const out = compile(classification(...classes));
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
    const fill = fillLayer(out).paint["fill-color"];
    expect(evaluate(fill, { r: 200.5 })).toBe(RED);
    expect(evaluate(fill, { r: 200.25 })).toBe(RED);
    expect(evaluate(fill, { r: 256.5 })).toBe(OTHER);
  });
});

describe("on the map, clusters", () => {
  it("count a point whose value is 3 in the category stored as 3.0, the text 3 in the class 3", () => {
    const out = compileLayer({
      id: "9",
      style: {
        version: "1.0.0",
        kind: "vector",
        render: { type: "cluster", look: "points" },
        symbol: { marker: { shape: "icon", icon: "goat:shop" } },
        classify: [
          {
            id: "k",
            field: "r",
            method: "categories",
            classes: [
              { id: "a", values: ["3.0"], marker: { icon: "goat:bakery" } },
              { id: "b", values: ["0.50", "3"], marker: { icon: "goat:restaurant" } },
            ],
          },
        ],
      } as unknown as LayerStyle,
      geometry: "point",
      source: { type: "points", id: "s9", data: "https://geoapi/collections/9/items?f=json" },
    });
    const counters = (out.sources.s9 as { clusterProperties: Record<string, [string, unknown]> })
      .clusterProperties;
    const count = (name: string, properties: Record<string, unknown>) =>
      evaluate(counters[name][1], properties);
    expect(count("goat_cluster_0", { r: "3.0" })).toBe(1);
    expect(count("goat_cluster_0", { r: 3 })).toBe(0);
    expect(count("goat_cluster_1", { r: 3 })).toBe(1);
    expect(count("goat_cluster_1", { r: 0.5 })).toBe(1);
    expect(count("goat_cluster_other", { r: 0.5 })).toBe(0);
    expect(count("goat_cluster_other", { r: 4 })).toBe(1);
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
  });

  it("count a point whose value is 0.5 in the category stored as 0.50", () => {
    const out = compileLayer({
      id: "9",
      style: {
        version: "1.0.0",
        kind: "vector",
        render: { type: "cluster", look: "points" },
        symbol: { marker: { shape: "icon", icon: "goat:shop" } },
        classify: [
          {
            id: "k",
            field: "r",
            method: "categories",
            classes: [{ id: "a", values: ["0.50"], marker: { icon: "goat:bakery" } }],
          },
        ],
      } as unknown as LayerStyle,
      geometry: "point",
      source: { type: "points", id: "s9", data: "https://geoapi/collections/9/items?f=json" },
    });
    const counters = (out.sources.s9 as { clusterProperties: Record<string, [string, unknown]> })
      .clusterProperties;
    expect(evaluate(counters.goat_cluster_0[1], { r: 0.5 })).toBe(1);
    expect(evaluate(counters.goat_cluster_other[1], { r: 0.5 })).toBe(0);
  });
});

describe("on the map, a field of known type", () => {
  it("text matches the class values as written", () => {
    const c = classification({ values: ["3.0"] });
    expect(colorOf(c, { r: "3" }, { r: "string" })).toBe(OTHER);
    expect(colorOf(c, { r: "3.0" }, { r: "string" })).toBe(RED);
  });

  it("whole numbers match the class values as numbers", () => {
    const c = classification({ values: ["3.0"] });
    expect(colorOf(c, { r: 3 }, { r: "integer" })).toBe(RED);
  });

  it("a number field matches the number's spelling too", () => {
    expect(colorOf(classification({ values: ["0.50"] }), { r: 0.5 }, { r: "number" })).toBe(RED);
  });
});

describe("the legend, the popup and the presence counts agree with the map", () => {
  it("place a tile's value in the class the map draws it in", () => {
    const c = classification({ values: ["0.50"] }, { values: ["3.0"] });
    expect(classIndexOf(c, 0.5)).toBe(0);
    expect(classIndexOf(c, 3)).toBe(1);
    expect(classIndexOf(c, "3.0")).toBe(1);
    expect(classIndexOf(c, 0.25)).toBe("other");
    const apart = classification({ values: ["3.0"] }, { values: ["3"] });
    expect(classIndexOf(apart, 3)).toBe(1);
    expect(classIndexOf(apart, "3.0")).toBe(0);
  });

  it("count the classes drawn in the view", () => {
    const c = { ...classification({ values: ["0.50"] }, { values: ["3.0"] }), computed: { other: true } };
    const counter = countPresence(style(c) as never);
    counter.add([{ properties: { r: 0.5 } }, { properties: { r: 3 } }]);
    expect(counter.result().r).toEqual({ classes: new Set(["c1", "c2"]), other: false, no_data: false });
  });

  it("count the server's values, which the database writes as text (3.0, 0.50), in the class the map draws them in", () => {
    const c = { ...classification({ values: ["3"] }, { values: ["0.5"] }), computed: { other: true } };
    const presence = presenceFromCounts(style(c) as never, {
      r: {
        kind: "values",
        values: [
          { value: "3.0", count: 2 },
          { value: "0.50", count: 1 },
        ],
        total: 2,
        missing: 0,
      },
    });
    expect(presence.r).toEqual({ classes: new Set(["c1", "c2"]), other: false, no_data: false });
  });

  it("count a server value that is a class's own text in that class, and in the class of its number too", () => {
    const c = { ...classification({ values: ["3.0"] }, { values: ["3"] }), computed: { other: true } };
    const count = (value: string) =>
      presenceFromCounts(style(c) as never, {
        r: { kind: "values", values: [{ value, count: 1 }], total: 1, missing: 0 },
      }).r;
    // A field the server writes "3.0" for may be text (the first class) or a number (the second): both are listed.
    expect(count("3.0")).toEqual({ classes: new Set(["c1", "c2"]), other: false, no_data: false });
    expect(count("3")).toEqual({ classes: new Set(["c2"]), other: false, no_data: false });
    expect(count("4.0")).toEqual({ classes: new Set(), other: true, no_data: false });
  });
});
