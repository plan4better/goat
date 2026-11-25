// Every color the style derives from another one (spec 3.1 to 3.3, 8.2: an outline in the fill color or its darker
// shade, a casing's darker shade, a pattern and arrows in the color they follow, the icon on a hollow marker, a cluster
// badge's ring), with the followed color fixed, with its own transparency or None, by zoom, by classes, by rules, by a
// palette and read from a field: what the map, the legend and the panel's swatches show, pinned in one file. `vitest -u`
// rewrites it.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput, Geometry } from "@/lib/style/compile/types";
import { swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { buildLegend } from "@/lib/style/legend";

import { maplibreErrors } from "./maplibre";

const GOLDEN = resolve(__dirname, "golden/derived-colors.json");

const tiles = { type: "tiles" as const, id: "s", tiles: ["https://t/{z}/{x}/{y}"] };
const points = { type: "points" as const, id: "s", data: "https://geoapi/collections/9/items?f=json" };

/** The forms of the followed color, each as the part of a style that sets it at `key` of `part`. */
const FORMS: Record<string, (part: string, key: string) => JsonObject> = {
  fixed: (part, key) => ({ symbol: { [part]: { [key]: "#7f3c8d" } } }),
  alpha: (part, key) => ({ symbol: { [part]: { [key]: "#7f3c8dcc" } } }),
  none: (part, key) => ({ symbol: { [part]: { [key]: "#7f3c8d00" } } }),
  absent: () => ({ symbol: {} }),
  zoom: (part, key) => ({
    symbol: {
      [part]: {
        [key]: {
          zoom: [
            [8, "#ff0000"],
            [14, "#0000ff"],
          ],
        },
      },
    },
  }),
  palette: (part, key) => ({
    symbol: { [part]: { [key]: { field: "v", palette: ["#fee8c8", "#e34a33"], domain: [0, 10] } } },
  }),
  raw: (part, key) => ({ symbol: { [part]: { [key]: { field: "c" } } } }),
  classes: (part, key) => ({
    symbol: { [part]: { [key]: "#cccccc" } },
    classify: [
      {
        field: "t",
        method: "categories",
        classes: [
          { values: ["a"], [part]: { [key]: "#11a579" } },
          { values: ["b"], [part]: { [key]: "#e73f74" } },
        ],
      },
    ],
  }),
  rules: (part, key) => ({
    symbol: { [part]: { [key]: "#cccccc" } },
    rules: [{ name: "A", when: { op: "=", args: [{ property: "t" }, "a"] }, [part]: { [key]: "#3969ac" } }],
  }),
};

/** Deep merge of style fragments: objects key by key, lists (classifications, rules) one after the other, anything
 * else replaced. */
function merge(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = { ...a };
  for (const [k, v] of Object.entries(b))
    out[k] =
      isObject(v) && isObject(out[k])
        ? merge(out[k] as JsonObject, v)
        : Array.isArray(v) && Array.isArray(out[k])
          ? [...(out[k] as unknown[]), ...v]
          : v;
  return out;
}

interface Case {
  geometry: Geometry;
  /** The part and key whose color is followed. */
  follows: [string, string];
  /** What makes the derived color (merged over the followed color's form). */
  derived: JsonObject;
  /** The panel rows whose swatches show the derived color. */
  rows: string[];
  source?: CompileInput["source"];
}

const CASES: Record<string, Case> = {
  "polygon outline fill": {
    geometry: "polygon",
    follows: ["fill", "color"],
    derived: { symbol: { outline: { color: "fill", width: 2 } } },
    rows: ["symbol.outline.color"],
  },
  "polygon outline auto": {
    geometry: "polygon",
    follows: ["fill", "color"],
    derived: { symbol: { outline: { color: "auto", width: 2 } } },
    rows: ["symbol.outline.color"],
  },
  "polygon outline fill in zoom stops": {
    geometry: "polygon",
    follows: ["fill", "color"],
    derived: {
      symbol: {
        outline: {
          color: {
            zoom: [
              [10, "fill"],
              [14, "#000000"],
            ],
          },
          width: 2,
        },
      },
    },
    rows: ["symbol.outline.color"],
  },
  "polygon fill off, outline fill": {
    geometry: "polygon",
    follows: ["fill", "color"],
    derived: { symbol: { fill: false, outline: { color: "fill", width: 2 } } },
    rows: ["symbol.outline.color"],
  },
  "polygon fill off, outline auto": {
    geometry: "polygon",
    follows: ["fill", "color"],
    derived: { symbol: { fill: false, outline: { color: "auto", width: 2 } } },
    rows: ["symbol.outline.color"],
  },
  "polygon pattern color absent": {
    geometry: "polygon",
    follows: ["fill", "color"],
    derived: { symbol: { fill: { pattern: "hatch_45" } } },
    rows: ["symbol.fill.pattern_color"],
  },
  "line casing auto": {
    geometry: "line",
    follows: ["line", "color"],
    derived: { symbol: { casing: { color: "auto", width: 1 } } },
    rows: ["symbol.casing.color"],
  },
  "line arrows color absent": {
    geometry: "line",
    follows: ["line", "color"],
    derived: { symbol: { arrows: { icon: "goat:triangle" } } },
    rows: ["symbol.arrows.color"],
  },
  "line arrows colored only in a class": {
    geometry: "line",
    follows: ["line", "color"],
    derived: {
      symbol: { arrows: { icon: "goat:triangle" } },
      classify: [
        { field: "k", method: "categories", classes: [{ values: ["x"], arrows: { color: "#00ff00" } }] },
      ],
    },
    rows: ["symbol.arrows.color"],
  },
  "point circle outline fill": {
    geometry: "point",
    follows: ["marker", "color"],
    derived: { symbol: { outline: { color: "fill", width: 2 } } },
    rows: ["symbol.outline.color"],
  },
  "point circle outline auto": {
    geometry: "point",
    follows: ["marker", "color"],
    derived: { symbol: { outline: { color: "auto", width: 2 } } },
    rows: ["symbol.outline.color"],
  },
  "point image outline auto": {
    geometry: "point",
    follows: ["marker", "color"],
    derived: {
      symbol: { marker: { shape: "square", icon: "goat:park" }, outline: { color: "auto", width: 2 } },
    },
    rows: ["symbol.outline.color"],
  },
  "point hollow marker icon": {
    geometry: "point",
    follows: ["marker", "color"],
    derived: { symbol: { marker: { fill: false, icon: "goat:park" }, outline: { color: "fill", width: 2 } } },
    rows: ["symbol.marker.icon_color", "symbol.outline.color"],
  },
};

const cat = (field: string, classes: JsonObject[]) => [{ field, method: "categories", classes }];
const when = (value: string) => ({ op: "=", args: [{ property: "t" }, value] });

/** Whole styles: words in class and rule records, parts switched in classes, clusters drawn like their points. */
const EXTRAS: Record<
  string,
  { geometry: Geometry; style: JsonObject; rows: string[]; source?: CompileInput["source"] }
> = {
  "outline words in classes over a hex base": {
    geometry: "polygon",
    style: {
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000", width: 2 } },
      classify: cat("t", [
        { values: ["a"], outline: { color: "auto" } },
        { values: ["b"], outline: { color: "fill" }, fill: { color: "#11a579" } },
      ]),
    },
    rows: ["symbol.outline.color"],
  },
  "hex outline in a class and a rule over an auto base": {
    geometry: "polygon",
    style: {
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto", width: 2 } },
      classify: cat("t", [{ values: ["a"], outline: { color: "#000000" } }]),
      rules: [{ name: "B", when: when("b"), outline: { color: "fill" }, fill: { color: "#f2b701" } }],
    },
    rows: ["symbol.outline.color"],
  },
  "casing words in a class and a rule": {
    geometry: "line",
    style: {
      symbol: { line: { color: "#3969ac" }, casing: { color: "#ffffff", width: 1 } },
      classify: cat("t", [{ values: ["a"], casing: { color: "auto" }, line: { color: "#e73f74" } }]),
      rules: [{ name: "B", when: when("b"), casing: { color: "auto" } }],
    },
    rows: ["symbol.casing.color"],
  },
  "pattern only in a class": {
    geometry: "polygon",
    style: {
      symbol: { fill: { color: "#7f3c8d" } },
      classify: cat("t", [{ values: ["a"], fill: { pattern: "hatch_45", color: "#11a579" } }]),
    },
    rows: ["symbol.fill.pattern_color"],
  },
  "pattern color only in a class": {
    geometry: "polygon",
    style: {
      symbol: { fill: { color: "#7f3c8d", pattern: "dots" } },
      classify: cat("t", [
        { values: ["a"], fill: { pattern_color: "#000000" } },
        { values: ["b"], fill: { color: "#11a579" } },
      ]),
    },
    rows: ["symbol.fill.pattern_color"],
  },
  "hollow marker only in a class": {
    geometry: "point",
    style: {
      symbol: { marker: { icon: "goat:park", color: "#1a6b4d" }, outline: { color: "fill", width: 2 } },
      classify: cat("t", [
        { values: ["a"], marker: { fill: false } },
        { values: ["b"], marker: { fill: false, color: "#e68310", icon_color: "#000000" } },
      ]),
    },
    rows: ["symbol.marker.icon_color", "symbol.outline.color"],
  },
  "clusters like the points, outline fill": {
    geometry: "point",
    source: points,
    style: {
      symbol: { marker: { color: "#5a1846" }, outline: { color: "fill", width: 2 } },
      classify: cat("kind", [
        { values: ["bakery"], marker: { color: "#ffd92f" } },
        { values: ["cafe"], marker: { color: "#11a579" } },
      ]),
      render: { type: "cluster", look: "points" },
    },
    rows: ["symbol.outline.color"],
  },
  "clusters like the points, outline auto": {
    geometry: "point",
    source: points,
    style: {
      symbol: { marker: { color: "#5a1846" }, outline: { color: "auto", width: 2 } },
      classify: cat("kind", [
        { values: ["bakery"], marker: { color: "#ffd92f" } },
        { values: ["cafe"], marker: { color: "#11a579" } },
      ]),
      render: { type: "cluster", look: "points", count: "badge" },
    },
    rows: ["symbol.outline.color"],
  },
  "arrows in a class over a line colored by classes of another field": {
    geometry: "line",
    style: {
      symbol: { line: { color: "#cccccc" }, arrows: { icon: "goat:triangle" } },
      classify: [
        ...cat("t", [{ values: ["a"], line: { color: "#11a579" } }]),
        ...cat("k", [{ values: ["x"], arrows: { color: "#00ff00" } }]),
      ],
    },
    rows: ["symbol.arrows.color"],
  },
  "arrows only in a rule": {
    geometry: "line",
    style: {
      symbol: { line: { color: "#3969ac" }, arrows: { icon: "goat:triangle" } },
      rules: [{ name: "A", when: when("a"), arrows: { color: "#00ff00" } }],
    },
    rows: ["symbol.arrows.color"],
  },
  "arrows by their own palette": {
    geometry: "line",
    style: {
      symbol: {
        line: { color: "#3969ac" },
        arrows: {
          icon: "goat:triangle",
          color: { field: "v", palette: ["#000000", "#ffffff"], domain: [0, 10] },
        },
      },
    },
    rows: ["symbol.arrows.color"],
  },
  "a class with a None fill under an auto outline": {
    geometry: "polygon",
    style: {
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto", width: 2 } },
      classify: cat("t", [
        { values: ["a"], fill: { color: "#11a57900" } },
        { values: ["b"], fill: { color: "#e73f7480" } },
      ]),
    },
    rows: ["symbol.fill.color", "symbol.outline.color"],
  },
  "a fill None at a zoom stop under an auto outline": {
    geometry: "polygon",
    style: {
      symbol: {
        fill: {
          color: {
            zoom: [
              [8, "#7f3c8d00"],
              [14, "#7f3c8d"],
            ],
          },
        },
        outline: { color: "auto", width: 2 },
      },
    },
    rows: ["symbol.fill.color", "symbol.outline.color"],
  },
  "a fill by a palette from None under an auto outline": {
    geometry: "polygon",
    style: {
      symbol: {
        fill: { color: { field: "v", palette: ["#fee8c800", "#e34a33"], domain: [0, 10] } },
        outline: { color: "auto", width: 2 },
      },
    },
    rows: ["symbol.fill.color", "symbol.outline.color"],
  },
  "a None line with an auto casing and arrows": {
    geometry: "line",
    style: {
      symbol: {
        line: { color: "#3969ac00" },
        casing: { color: "auto", width: 1 },
        arrows: { icon: "goat:triangle" },
      },
    },
    rows: ["symbol.line.color", "symbol.casing.color", "symbol.arrows.color"],
  },
  "arrows read from a field": {
    geometry: "line",
    style: {
      symbol: { line: { color: "#3969ac" }, arrows: { icon: "goat:triangle", color: { field: "c" } } },
    },
    rows: ["symbol.arrows.color"],
  },
};

/** Cluster badges: a ring in the marker color, its darker shade, or none set. */
const BADGES: Record<string, JsonObject> = {
  "badge ring fill": { marker: { color: "#e68310" }, outline: { color: "fill", width: 2 } },
  "badge ring auto": { marker: { color: "#e68310" }, outline: { color: "auto", width: 2 } },
  "badge ring absent": { marker: { color: "#e68310" } },
  "badge ring own": { marker: { color: "#e68310" }, outline: { color: "#000000", width: 2 } },
  "badge ring by zoom": {
    marker: { color: "#e68310" },
    outline: {
      color: {
        zoom: [
          [8, "fill"],
          [14, "#000000"],
        ],
      },
      width: 2,
    },
  },
  "badge marker by zoom, ring fill": {
    marker: {
      color: {
        zoom: [
          [8, "#ff0000"],
          [14, "#0000ff"],
        ],
      },
    },
    outline: { color: "fill", width: 2 },
  },
  "badge marker by zoom, ring auto": {
    marker: {
      color: {
        zoom: [
          [8, "#ff0000"],
          [14, "#0000ff"],
        ],
      },
    },
    outline: { color: "auto", width: 2 },
  },
  "badge ring fill over a marker by a count palette": {
    marker: { color: { field: "count", palette: ["#000000", "#ffffff"] } },
    outline: { color: "fill", width: 2 },
  },
};

const COLOR_KEY = /color|image|pattern/;

/** The color-bearing paint and layout properties of each compiled layer. */
function drawn(layers: Array<Record<string, unknown>>): JsonObject {
  return Object.fromEntries(
    layers.map((l) => {
      const props = { ...(l.layout as JsonObject | undefined), ...(l.paint as JsonObject | undefined) };
      return [l.id as string, Object.fromEntries(Object.entries(props).filter(([k]) => COLOR_KEY.test(k)))];
    })
  );
}

/** The swatches of every legend entry, at a zoom between stops (image colors are read at the whole zoom below). */
function legendSwatches(style: JsonObject, geometry: Geometry): unknown {
  const legend = buildLegend(style, { geometry, zoom: 10.5 });
  return (legend?.sections ?? []).flatMap((s) =>
    s.kind === "entries" ? s.entries.map((e) => ({ id: e.id, swatch: e.swatch })) : []
  );
}

function record(c: Pick<Case, "geometry" | "rows" | "source">, doc: JsonObject) {
  const style = merge({ version: "1.0.0", kind: "vector" }, doc) as unknown as LayerStyle;
  const out = compileLayer({ id: "1", style, geometry: c.geometry, source: c.source ?? tiles });
  return {
    valid: maplibreErrors(out.layers, out.sources, out.state).length === 0,
    map: drawn(out.layers as unknown as Array<Record<string, unknown>>),
    legend: legendSwatches(style as unknown as JsonObject, c.geometry),
    panel: Object.fromEntries(c.rows.map((row) => [row, swatchOf(style, row, c.geometry)])),
  };
}

function badge(symbol: JsonObject) {
  const style = {
    version: "1.0.0",
    kind: "vector",
    render: { type: "cluster", count: "badge", symbol },
  } as unknown as LayerStyle;
  const out = compileLayer({ id: "1", style, geometry: "point", source: points });
  return {
    valid: maplibreErrors(out.layers, out.sources, out.state).length === 0,
    map: drawn(out.layers as unknown as Array<Record<string, unknown>>),
    legend: legendSwatches(style as unknown as JsonObject, "point"),
  };
}

function snapshot(): JsonObject {
  const out: JsonObject = {};
  for (const [name, c] of Object.entries(CASES))
    for (const form of Object.keys(FORMS))
      out[`${name} / ${form}`] = record(c, merge(FORMS[form](...c.follows), c.derived));
  for (const [name, c] of Object.entries(EXTRAS)) out[name] = record(c, c.style);
  for (const [name, symbol] of Object.entries(BADGES)) out[name] = badge(symbol);
  return out;
}

describe("derived colors", () => {
  it("draw as pinned on the map, in the legend and in the panel", async () => {
    await expect(`${JSON.stringify(snapshot(), null, 1)}\n`).toMatchFileSnapshot(GOLDEN);
  });
});
