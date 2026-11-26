import { describe, expect, it } from "vitest";

import { shade } from "@/lib/style/colors";
import { compileLayer } from "@/lib/style/compile";
import { HIGHLIGHT } from "@/lib/style/compile/constants";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";

import { evaluate, maplibreErrors } from "./maplibre";

// A color's own transparency (its alpha, spec 4.6): a part whose color is one fixed color at alpha 0 ("None") is not
// drawn, so it takes no clicks; where the color varies, the features and zooms at alpha 0 draw nothing through it.

const tiles = { type: "tiles" as const, id: "s", tiles: ["https://t/{z}/{x}/{y}"] };
const style = (doc: object) => ({ version: "1.0.0", kind: "vector", ...doc }) as LayerStyle & JsonObject;
const NONE = "#cc615c00";

/** What the committed code (HEAD 39dcf1c72) compiles for a bare hollow marker, without and with highlight. */
const HEAD_HOLLOW_CIRCLE = [
  [
    {
      id: "1-marker",
      type: "circle",
      source: "s",
      "source-layer": "default",
      paint: { "circle-color": "#2bb381", "circle-radius": 4, "circle-opacity": 0 },
    },
  ],
  [
    {
      id: "1-marker",
      type: "circle",
      source: "s",
      "source-layer": "default",
      paint: {
        "circle-color": "#2bb381",
        "circle-radius": 4,
        "circle-opacity": 0,
        "circle-stroke-color": "#ffc300",
        "circle-stroke-width": [
          "case",
          [
            "any",
            ["boolean", ["feature-state", "active"], false],
            ["boolean", ["feature-state", "hover"], false],
          ],
          3,
          0,
        ],
      },
    },
  ],
];
/** The same for a hollow square marker, with highlight. */
const HEAD_HOLLOW_SQUARE = [
  {
    id: "1-ring",
    type: "circle",
    source: "s",
    "source-layer": "default",
    paint: {
      "circle-radius": 4,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#ffc300",
      "circle-stroke-width": [
        "case",
        [
          "any",
          ["boolean", ["feature-state", "active"], false],
          ["boolean", ["feature-state", "hover"], false],
        ],
        3,
        0,
      ],
    },
  },
  {
    id: "1-marker",
    type: "symbol",
    source: "s",
    "source-layer": "default",
    layout: { "icon-image": "goat-marker:square|8||||0|#2bb381", "icon-size": 1, "icon-allow-overlap": true },
    paint: {},
  },
];

type Layer = { id: string; type: string; paint: Record<string, unknown>; layout?: Record<string, unknown> };

function compile(doc: object, geometry: "point" | "line" | "polygon", highlight = false) {
  const out = compileLayer({ id: "1", style: style(doc), geometry, source: tiles, highlight });
  expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
  return { out, layers: out.layers as unknown as Layer[], ids: out.layers.map((l) => l.id) };
}
const layer = (layers: Layer[], id: string) => layers.find((l) => l.id === id)!;
/** A color as MapLibre reads it, for comparing colors written in different forms. */
const color = (expr: unknown, properties: Record<string, unknown> = {}) => String(evaluate(expr, properties));

describe("a polygon fill that is None", () => {
  it("gets no fill layer, and its Auto outline keeps a darker shade of its hue", () => {
    const { layers, ids } = compile(
      { symbol: { fill: { color: NONE }, outline: { color: "auto" } } },
      "polygon"
    );
    expect(ids).toEqual(["1-outline"]);
    expect(layer(layers, "1-outline").paint["line-color"]).toBe(shade(NONE));
  });

  it("still draws its pattern", () => {
    const { ids } = compile(
      { symbol: { fill: { color: NONE, pattern: "hatch_45", pattern_color: "#000000" } } },
      "polygon"
    );
    expect(ids).toEqual(["1-pattern"]);
  });

  it("draws a pattern whose color is not set in the fill's hue, opaque", () => {
    const { layers, ids } = compile({ symbol: { fill: { color: NONE, pattern: "hatch_45" } } }, "polygon");
    expect(ids).toEqual(["1-pattern"]);
    expect(JSON.stringify(layer(layers, "1-pattern").paint["fill-pattern"])).toContain("|#cc615c");
    expect(JSON.stringify(layer(layers, "1-pattern").paint["fill-pattern"])).not.toContain("#cc615c00");
  });

  it("draws no pattern whose own color is None", () => {
    const { ids } = compile(
      { symbol: { fill: { color: NONE, pattern: "hatch_45", pattern_color: "#00000000" } } },
      "polygon"
    );
    expect(ids).toEqual([]);
  });

  it("leaves the active feature to the outline, as a fill switched off does", () => {
    const off = compile({ symbol: { fill: false, outline: { color: "#000000" } } }, "polygon", true);
    const none = compile(
      { symbol: { fill: { color: NONE }, outline: { color: "#000000" } } },
      "polygon",
      true
    );
    expect(none.out.layers).toEqual(off.out.layers);
  });

  it("without an outline, still shows the active feature with GOAT's highlight edge", () => {
    const { layers, ids } = compile({ symbol: { fill: { color: NONE } } }, "polygon", true);
    expect(ids).toEqual(["1-outline"]);
    expect(layer(layers, "1-outline").paint["line-color"]).toBe(HIGHLIGHT.color);
  });

  it("raised: draws no volumes", () => {
    const { ids } = compile({ symbol: { fill: { color: NONE }, extrude: { height: 20 } } }, "polygon");
    expect(ids).not.toContain("1-fill");
  });

  it("an outline in the same color is None too and not drawn", () => {
    const { ids } = compile({ symbol: { fill: { color: NONE }, outline: { color: "fill" } } }, "polygon");
    expect(ids).toEqual([]);
  });
});

describe("a fill that is partly transparent", () => {
  it("keeps its alpha in the fill color", () => {
    const { layers } = compile({ symbol: { fill: { color: "#ff000080" } } }, "polygon");
    expect(layer(layers, "1-fill").paint["fill-color"]).toBe("#ff000080");
  });

  it("raised: its alpha goes into the volumes' opacity, which MapLibre's extrusion color has none of", () => {
    const { layers } = compile(
      { symbol: { fill: { color: "#ff000080", opacity: 0.5 }, extrude: { height: 20 } } },
      "polygon"
    );
    expect(layer(layers, "1-fill").paint["fill-extrusion-opacity"]).toBeCloseTo(0.5 * (128 / 255), 6);
  });

  it("a pattern whose color is not set draws in the fill's hue, opaque", () => {
    const { layers } = compile({ symbol: { fill: { color: "#ff000080", pattern: "dots" } } }, "polygon");
    expect(JSON.stringify(layer(layers, "1-pattern").paint["fill-pattern"])).toContain("|#ff0000");
    expect(JSON.stringify(layer(layers, "1-pattern").paint["fill-pattern"])).not.toContain("#ff000080");
  });

  it("raised and opaque: the volumes' opacity is the fill's alone", () => {
    const { layers } = compile({ symbol: { fill: { opacity: 0.5 }, extrude: { height: 20 } } }, "polygon");
    expect(layer(layers, "1-fill").paint["fill-extrusion-opacity"]).toBe(0.5);
  });
});

describe("a class whose fill is None", () => {
  const doc = {
    symbol: { fill: { color: "#2166ac" }, outline: { color: "auto" } },
    classify: [
      {
        field: "k",
        method: "categories",
        classes: [
          { values: ["x"], fill: { color: NONE } },
          { values: ["y"], fill: { color: "#e68310" } },
        ],
      },
    ],
  };

  it("draws no fill for that class and keeps the fill layer for the others", () => {
    const { layers } = compile(doc, "polygon");
    const fill = layer(layers, "1-fill").paint["fill-color"];
    expect(color(fill, { k: "x" })).toBe(color(NONE));
    expect(color(fill, { k: "y" })).toBe(color("#e68310"));
    expect(color(fill, { k: "z" })).toBe(color("#2166ac"));
  });

  it("gives that class an outline in a darker shade of its hue; the others keep theirs", () => {
    const { layers } = compile(doc, "polygon");
    const outline = layer(layers, "1-outline").paint["line-color"];
    expect(color(outline, { k: "x" })).toBe(color(shade(NONE)));
    expect(color(outline, { k: "y" })).toBe(color(shade("#e68310")));
    expect(color(outline, { k: "z" })).toBe(color(shade("#2166ac")));
  });
});

describe("a fill None at some zooms only", () => {
  it("keeps its layer: the zooms at alpha 0 draw nothing through the color", () => {
    const { ids } = compile(
      {
        symbol: {
          fill: {
            color: {
              zoom: [
                [5, NONE],
                [10, "#2166ac"],
              ],
            },
          },
        },
      },
      "polygon"
    );
    expect(ids).toEqual(["1-fill"]);
  });
});

describe("a polygon outline that is None", () => {
  it("is not drawn", () => {
    const { ids } = compile({ symbol: { outline: { color: NONE } } }, "polygon");
    expect(ids).toEqual(["1-fill"]);
  });

  it("leaves the active feature to GOAT's highlight edge, as an outline switched off does", () => {
    const off = compile({ symbol: {} }, "polygon", true);
    const none = compile({ symbol: { outline: { color: NONE } } }, "polygon", true);
    expect(none.out.layers).toEqual(off.out.layers);
  });
});

describe("lines", () => {
  it("a line that is None is not drawn; its Auto casing keeps a darker shade of its hue", () => {
    const { layers, ids } = compile(
      { symbol: { line: { color: NONE }, casing: { color: "auto", width: 1 } } },
      "line"
    );
    expect(ids).toEqual(["1-casing"]);
    expect(layer(layers, "1-casing").paint["line-color"]).toBe(shade(NONE));
  });

  it("arrows whose color is not set draw in the hue of a None line, opaque", () => {
    const { layers, ids } = compile(
      { symbol: { line: { color: NONE }, arrows: { icon: "goat:triangle" } } },
      "line"
    );
    expect(ids).toEqual(["1-arrows"]);
    expect(layer(layers, "1-arrows").paint["icon-color"]).toBe("#cc615c");
  });

  it("arrows whose own color is None are not drawn", () => {
    const { ids } = compile(
      { symbol: { line: { color: "#000000" }, arrows: { icon: "goat:triangle", color: NONE } } },
      "line"
    );
    expect(ids).toEqual(["1-line"]);
  });

  it("arrows in their own color still draw on a None line", () => {
    const { ids } = compile(
      { symbol: { line: { color: NONE }, arrows: { icon: "goat:triangle", color: "#000000" } } },
      "line"
    );
    expect(ids).toEqual(["1-arrows"]);
  });

  it("a casing that is None is not drawn", () => {
    const { ids } = compile({ symbol: { casing: { color: NONE, width: 1 } } }, "line");
    expect(ids).toEqual(["1-line"]);
  });
});

describe("points", () => {
  it("a circle that is None with no outline is not drawn", () => {
    const { ids } = compile({ symbol: { marker: { color: NONE } } }, "point");
    expect(ids).toEqual([]);
  });

  it("a circle that is None with an outline keeps its layer for the outline", () => {
    const { layers, ids } = compile(
      { symbol: { marker: { color: NONE }, outline: { color: "auto", width: 2 } } },
      "point"
    );
    expect(ids).toEqual(["1-marker"]);
    expect(layer(layers, "1-marker").paint["circle-stroke-color"]).toBe(shade(NONE));
  });

  it("an outline that is None draws as an outline switched off does", () => {
    const off = compile({ symbol: { marker: { color: "#2166ac" } } }, "point", true);
    const none = compile(
      { symbol: { marker: { color: "#2166ac" }, outline: { color: NONE, width: 2 } } },
      "point",
      true
    );
    expect(none.out.layers).toEqual(off.out.layers);
  });

  it("a marker with a shape that is None, with no outline or icon, is not drawn, nor its highlight ring", () => {
    const { ids } = compile({ symbol: { marker: { color: NONE, shape: "square" } } }, "point", true);
    expect(ids).toEqual([]);
  });

  it("a marker with a shape that is None keeps its image where it has an icon", () => {
    const { ids } = compile(
      { symbol: { marker: { color: NONE, shape: "square", icon: "goat:marker" } } },
      "point"
    );
    expect(ids).toEqual(["1-marker"]);
  });

  it("the icon of a hollow None marker draws in the marker's hue, opaque", () => {
    const { layers, ids } = compile(
      { symbol: { marker: { color: NONE, fill: false, icon: "goat:park" } } },
      "point",
      true
    );
    expect(ids).toEqual(["1-ring", "1-marker"]);
    const image = JSON.stringify(layer(layers, "1-marker").layout!["icon-image"]);
    expect(image).toContain("|#cc615c");
    expect(image).not.toContain("#cc615c00");
  });

  it("a None marker with nothing left to draw gets no layer and no highlight ring", () => {
    expect(compile({ symbol: { marker: { color: NONE, shape: "square" } } }, "point", true).ids).toEqual([]);
    // A library icon whose own color is None draws nothing either.
    expect(
      compile(
        { symbol: { marker: { color: NONE, shape: "square", icon: "goat:park", icon_color: "#00000000" } } },
        "point",
        true
      ).ids
    ).toEqual([]);
  });

  it("a marker hollow by `fill: false`, with an opaque color, no outline and no icon, compiles as the committed code does", () => {
    // The committed code's output (HEAD 39dcf1c72): an empty layer that still takes clicks, with its highlight.
    const circle = HEAD_HOLLOW_CIRCLE;
    expect(compile({ symbol: { marker: { fill: false } } }, "point").out.layers).toEqual(circle[0]);
    expect(compile({ symbol: { marker: { fill: false } } }, "point", true).out.layers).toEqual(circle[1]);
    expect(
      compile({ symbol: { marker: { shape: "square", fill: false } } }, "point", true).out.layers
    ).toEqual(HEAD_HOLLOW_SQUARE);
  });

  it("an icon alone tinted None, with no outline, is not drawn", () => {
    const { ids } = compile(
      { symbol: { marker: { color: NONE, shape: "icon", icon: "goat:marker" } } },
      "point"
    );
    expect(ids).toEqual([]);
  });
});

describe("H3 hexagons", () => {
  const h3 = (outline: object) =>
    compileLayer({
      id: "1",
      style: style({ render: { type: "h3", resolution: 7, outline } }),
      geometry: "point",
      source: tiles,
    }).layers.map((l) => l.id);

  it("an outline that is None is not drawn, as an outline of width 0", () => {
    expect(h3({ color: NONE })).toEqual(h3({ width: 0 }));
    expect(h3({ color: "#000000" })).toContain("1-h3-outline");
  });
});
