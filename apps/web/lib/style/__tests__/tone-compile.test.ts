import { afterEach, describe, expect, it, vi } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { RULES, TONE_KEYS, usesTone } from "@/lib/style/compile/derived";
import type { CompileInput } from "@/lib/style/compile/types";
import { swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";

// The basemap's tone reaches every rule the compiler asks for a derived color (`inputs.tone`).

const tiles = { type: "tiles" as const, id: "s", tiles: ["https://t/{z}/{x}/{y}"] };
const points = { type: "points" as const, id: "s", data: "https://geoapi/collections/9/items?f=json" };
const style = (doc: object) => ({ version: "1.0.0", kind: "vector", ...doc }) as LayerStyle;

const CASES: Array<{ name: string; rule: "shade" | "hue"; input: Omit<CompileInput, "id"> }> = [
  {
    name: "an Auto outline on a polygon",
    rule: "shade",
    input: {
      style: style({ symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto" } } }),
      geometry: "polygon",
      source: tiles,
    },
  },
  {
    name: "an unset pattern color",
    rule: "hue",
    input: {
      style: style({ symbol: { fill: { color: "#7f3c8d", pattern: "dots" } } }),
      geometry: "polygon",
      source: tiles,
    },
  },
  {
    name: "an Auto outline on a marker",
    rule: "shade",
    input: {
      style: style({ symbol: { marker: { color: "#1a6b4d" }, outline: { color: "auto" } } }),
      geometry: "point",
      source: tiles,
    },
  },
  {
    name: "the icon of a hollow marker",
    rule: "hue",
    input: {
      style: style({ symbol: { marker: { color: "#1a6b4d", icon: "goat:park", fill: false } } }),
      geometry: "point",
      source: tiles,
    },
  },
  {
    name: "an Auto casing",
    rule: "shade",
    input: {
      style: style({ symbol: { line: { color: "#2166ac" }, casing: { color: "auto", width: 1 } } }),
      geometry: "line",
      source: tiles,
    },
  },
  {
    name: "unset arrows",
    rule: "hue",
    input: {
      style: style({ symbol: { line: { color: "#2166ac" }, arrows: { icon: "goat:triangle" } } }),
      geometry: "line",
      source: tiles,
    },
  },
  {
    name: "an Auto ring on a cluster badge",
    rule: "shade",
    input: {
      style: style({
        render: {
          type: "cluster",
          count: "badge",
          symbol: { marker: { color: "#e68310" }, outline: { color: "auto", width: 2 } },
        },
      }),
      geometry: "point",
      source: points,
    },
  },
  {
    name: "an Auto outline on H3 hexagons",
    rule: "shade",
    input: {
      style: style({
        render: { type: "h3", resolution: 6, palette: ["#7f3c8d", "#11a579"], outline: { color: "auto" } },
      }),
      geometry: "point",
      source: tiles,
    },
  },
];

describe("the basemap's tone in the compiler", () => {
  afterEach(() => vi.restoreAllMocks());

  for (const { name, rule, input } of CASES) {
    it(`reaches the rule of ${name}`, () => {
      const spy = vi.spyOn(RULES, rule);
      compileLayer({ id: "1", ...input, tone: "dark" });
      expect(spy).toHaveBeenCalled();
      for (const [, inputs] of spy.mock.calls) expect(inputs).toMatchObject({ tone: "dark" });
    });
  }

  it("is light where the caller gives none", () => {
    const spy = vi.spyOn(RULES, "shade");
    compileLayer({ id: "1", ...CASES[0].input });
    expect(spy).toHaveBeenCalled();
    for (const [, inputs] of spy.mock.calls) expect(inputs).toMatchObject({ tone: "light" });
  });

  it("changes nothing these styles draw: none of their rules reads it", () => {
    for (const { input } of CASES)
      expect(compileLayer({ id: "1", ...input, tone: "dark" })).toEqual(
        compileLayer({ id: "1", ...input, tone: "light" })
      );
  });
});

describe("usesTone", () => {
  const json = (doc: object) => style(doc) as unknown as JsonObject;
  const outlined = (where: object) => json(where);
  const KEY = ["outline.color"];
  const auto = { outline: { color: "auto" } };
  const places = {
    "the base symbol": { symbol: auto },
    "a class": { classify: [{ field: "k", method: "categories", classes: [{ values: ["x"], ...auto }] }] },
    "the other class": { classify: [{ field: "k", method: "categories", classes: [], other: auto }] },
    "the no-data class": { classify: [{ field: "k", method: "categories", classes: [], no_data: auto }] },
    "a rule": { rules: [{ when: { op: "=", field: "k", value: 1 }, ...auto }] },
    "a zoom stop": {
      symbol: {
        outline: {
          color: {
            zoom: [
              [5, "#000000"],
              [10, "auto"],
            ],
          },
        },
      },
    },
  };

  it("answers no for every style without a label's color on Auto: only the label pair reads the tone", () => {
    expect(TONE_KEYS).toEqual(["label.color", "label.halo.color"]);
    for (const doc of Object.values(places)) expect(usesTone(outlined(doc))).toBe(false);
    for (const { input } of CASES) expect(usesTone(input.style as unknown as JsonObject)).toBe(false);
  });

  it("looks for a cluster symbol's key in a cluster's own symbol only, and for a part key everywhere else", () => {
    const cluster = json({ render: { type: "cluster", symbol: auto } });
    expect(usesTone(cluster, ["cluster.symbol.outline.color"])).toBe(true);
    expect(usesTone(cluster, KEY)).toBe(false);
    expect(usesTone(json({ symbol: auto }), ["cluster.symbol.outline.color"])).toBe(false);
  });

  for (const [name, doc] of Object.entries(places)) {
    it(`finds a word of a named key in ${name}`, () => {
      expect(usesTone(outlined(doc), KEY)).toBe(true);
    });
  }

  it("finds no word where the named key holds a color or nothing, or another key holds the word", () => {
    expect(usesTone(json({ symbol: { outline: { color: "#000000" } } }), KEY)).toBe(false);
    expect(usesTone(json({ symbol: { fill: { color: "#000000" } } }), KEY)).toBe(false);
    expect(usesTone(json({ symbol: { casing: { color: "auto" } } }), KEY)).toBe(false);
    expect(usesTone(json({ symbol: { outline: { color: { zoom: [[5, "#000000"]] } } } }), KEY)).toBe(false);
  });
});

describe("the basemap's tone in the panel's swatches", () => {
  afterEach(() => vi.restoreAllMocks());
  const doc = style({ symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto" } } });

  it("reaches the rule of a derived color's swatch", () => {
    const spy = vi.spyOn(RULES, "shade");
    swatchOf(doc, "symbol.outline.color", "polygon", { tone: "dark" });
    expect(spy).toHaveBeenCalled();
    for (const [, inputs] of spy.mock.calls) expect(inputs).toMatchObject({ tone: "dark" });
  });

  it("is light where the caller gives none, and changes no swatch today", () => {
    const spy = vi.spyOn(RULES, "shade");
    const light = swatchOf(doc, "symbol.outline.color", "polygon");
    for (const [, inputs] of spy.mock.calls) expect(inputs).toMatchObject({ tone: "light" });
    expect(swatchOf(doc, "symbol.outline.color", "polygon", { tone: "dark" })).toBe(light);
  });
});
