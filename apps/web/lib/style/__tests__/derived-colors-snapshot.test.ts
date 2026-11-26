// Every color the style derives from another one (spec 3.1 to 3.3, 8.2, 18.10: an outline in the fill color or its
// darker shade, a casing's darker shade, a pattern and arrows in the color they follow, the icon on a hollow marker, a
// cluster badge's ring, a label's text and halo on Auto, an Auto icon and cluster number), with the followed color fixed,
// with its own transparency or None, by zoom, by classes, by rules, by a palette and read from a field, on a light basemap
// and, for the label pair, a dark one: what the map, the legend and the panel's swatches show, pinned in one file.
// `vitest -u` rewrites it.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput, Geometry } from "@/lib/style/compile/types";
import { swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { buildLegend } from "@/lib/style/legend";
import type { Tone } from "@/lib/style/tone";

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
  /** The basemap's tone the map draws for; light where none is given. */
  tone?: Tone;
}

const LABEL_ROWS = ["symbol.label.color", "symbol.label.halo.color"];
const label = (props: object) => ({ symbol: { label: { text: "{name}", ...props } } });
/** The label pair cases on both tones. */
const labelCases = (
  name: string,
  geometry: Geometry,
  follows: [string, string],
  props: object
): Record<string, Case> =>
  Object.fromEntries(
    (["light", "dark"] as const).map((tone) => [
      `${name}, ${tone}`,
      { geometry, follows, derived: label(props), rows: LABEL_ROWS, tone },
    ])
  );

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
  ...labelCases("polygon label text and halo auto", "polygon", ["fill", "color"], {
    color: "auto",
    halo: { color: "auto" },
  }),
  ...labelCases("polygon label text auto, halo set", "polygon", ["fill", "color"], {
    color: "auto",
    halo: { color: "#222222" },
  }),
  ...labelCases("polygon label text auto, halo absent", "polygon", ["fill", "color"], { color: "auto" }),
  ...labelCases("polygon label halo auto, text set light", "polygon", ["fill", "color"], {
    color: "#f0f0f0",
    halo: { color: "auto" },
  }),
  ...labelCases("line label text and halo auto", "line", ["line", "color"], {
    color: "auto",
    halo: { color: "auto" },
  }),
  ...labelCases("point label text and halo auto", "point", ["marker", "color"], {
    color: "auto",
    halo: { color: "auto" },
  }),
  "point icon color auto": {
    geometry: "point",
    follows: ["marker", "color"],
    derived: { symbol: { marker: { shape: "square", icon: "goat:park", icon_color: "auto" } } },
    rows: ["symbol.marker.icon_color"],
  },
  "point hollow marker icon auto": {
    geometry: "point",
    follows: ["marker", "color"],
    derived: {
      symbol: {
        marker: { fill: false, icon: "goat:park", icon_color: "auto" },
        outline: { color: "fill", width: 2 },
      },
    },
    rows: ["symbol.marker.icon_color"],
  },
};

const cat = (field: string, classes: JsonObject[]) => [{ field, method: "categories", classes }];
const when = (value: string) => ({ op: "=", args: [{ property: "t" }, value] });

/** Whole styles: words in class and rule records, parts switched in classes, clusters drawn like their points. */
const EXTRAS: Record<
  string,
  { geometry: Geometry; style: JsonObject; rows: string[]; source?: CompileInput["source"]; tone?: Tone }
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
  ...Object.fromEntries(
    (["light", "dark"] as const).flatMap((tone) => [
      [
        `label halo auto over a text auto in one class and set in another, ${tone}`,
        {
          geometry: "polygon" as const,
          tone,
          style: {
            symbol: {
              fill: { color: "#7f3c8d" },
              label: { text: "{name}", color: "auto", halo: { color: "auto" } },
            },
            classify: cat("t", [
              { values: ["a"], label: { color: "#f0f0f0" } },
              { values: ["b"], fill: { color: "#11a579" } },
            ]),
          },
          rows: LABEL_ROWS,
        },
      ],
      [
        `label text auto only in a rule, ${tone}`,
        {
          geometry: "polygon" as const,
          tone,
          style: {
            symbol: { fill: { color: "#7f3c8d" }, label: { text: "{name}", halo: { color: "auto" } } },
            rules: [{ name: "A", when: when("a"), label: { color: "auto" } }],
          },
          rows: LABEL_ROWS,
        },
      ],
      [
        `label halo auto beside a text by zoom, ${tone}`,
        {
          geometry: "polygon" as const,
          tone,
          style: {
            symbol: {
              fill: { color: "#7f3c8d" },
              label: {
                text: "{name}",
                color: {
                  zoom: [
                    [8, "#ffffff"],
                    [14, "auto"],
                  ],
                },
                halo: { color: "auto" },
              },
            },
          },
          rows: LABEL_ROWS,
        },
      ],
      [
        `label halo auto beside a text read from a field, ${tone}`,
        {
          geometry: "polygon" as const,
          tone,
          style: {
            symbol: {
              fill: { color: "#7f3c8d" },
              label: { text: "{name}", color: { field: "c" }, halo: { color: "auto" } },
            },
          },
          rows: LABEL_ROWS,
        },
      ],
      [
        `cluster number and halo auto, ${tone}`,
        {
          geometry: "point" as const,
          tone,
          source: points,
          style: {
            render: {
              type: "cluster",
              symbol: {
                marker: { color: "#f2b701", size: 20 },
                label: { text: "{count}", color: "auto", halo: { color: "auto", width: 1 } },
              },
            },
          },
          rows: ["render.symbol.label.color", "render.symbol.label.halo.color"],
        },
      ],
    ])
  ),
  "an auto icon on a marker hollow in one class": {
    geometry: "point",
    style: {
      symbol: { marker: { shape: "square", color: "#f2b701", icon: "goat:park", icon_color: "auto" } },
      classify: cat("t", [{ values: ["h"], marker: { fill: false } }]),
    },
    rows: ["symbol.marker.icon_color"],
  },
  "cluster icon auto": {
    geometry: "point",
    source: points,
    style: {
      render: {
        type: "cluster",
        symbol: { marker: { shape: "square", color: "#f2b701", icon: "goat:park", icon_color: "auto" } },
      },
    },
    rows: ["render.symbol.marker.icon_color"],
  },
  "cluster icon auto, drawn like the points": {
    geometry: "point",
    source: points,
    style: {
      symbol: { marker: { shape: "square", color: "#000000", icon: "goat:park", icon_color: "auto" } },
      render: { type: "cluster", look: "points" },
    },
    rows: ["symbol.marker.icon_color"],
  },
  "cluster number auto, drawn like the points": {
    geometry: "point",
    source: points,
    style: {
      symbol: { marker: { color: "#f2b701" } },
      render: { type: "cluster", look: "points", symbol: { label: { text: "{count}", color: "auto" } } },
    },
    rows: ["render.symbol.label.color"],
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
  "badge number auto": { marker: { color: "#f2b701" }, label: { text: "{count}", color: "auto" } },
  "badge number auto over a marker by a count palette": {
    marker: { color: { field: "count", palette: ["#000000", "#ffffff"] } },
    label: { text: "{count}", color: "auto" },
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

function record(c: Pick<Case, "geometry" | "rows" | "source" | "tone">, doc: JsonObject) {
  const style = merge({ version: "1.0.0", kind: "vector" }, doc) as unknown as LayerStyle;
  const out = compileLayer({ id: "1", style, geometry: c.geometry, source: c.source ?? tiles, tone: c.tone });
  return {
    valid: maplibreErrors(out.layers, out.sources, out.state).length === 0,
    map: drawn(out.layers as unknown as Array<Record<string, unknown>>),
    legend: legendSwatches(style as unknown as JsonObject, c.geometry),
    panel: Object.fromEntries(c.rows.map((row) => [row, swatchOf(style, row, c.geometry, { tone: c.tone })])),
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
