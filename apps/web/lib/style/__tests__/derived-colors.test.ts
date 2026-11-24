import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { shade } from "@/lib/style/colors";
import { compileLayer } from "@/lib/style/compile";
import { DERIVED, derivedColor, followedKey, ruleOf } from "@/lib/style/compile/derived";
import { HATCH, swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import { buildLegend } from "@/lib/style/legend";

import { paintValue } from "./legend/mapSwatch";
import { evaluate, maplibreErrors } from "./maplibre";

// Colors one part takes from another (spec 3.1 to 3.3, 8.2), the same on the map and in the legend.

const tiles = { type: "tiles" as const, id: "s", tiles: ["https://t/{z}/{x}/{y}"] };
const points = { type: "points" as const, id: "s", data: "https://geoapi/collections/9/items?f=json" };
const style = (doc: object) => ({ version: "1.0.0", kind: "vector", ...doc }) as LayerStyle & JsonObject;

describe("arrows colored only in a class", () => {
  const doc = style({
    symbol: { line: { color: "#ff0000" }, arrows: { icon: "goat:triangle" } },
    classify: [
      { field: "k", method: "categories", classes: [{ values: ["x"], arrows: { color: "#00ff00" } }] },
    ],
  });

  it("give the other features the line's color", () => {
    const out = compileLayer({ id: "1", style: doc, geometry: "line", source: tiles });
    const arrows = out.layers.find((l) => l.id === "1-arrows") as { paint: Record<string, unknown> };
    const color = arrows.paint["icon-color"];
    expect(String(evaluate(color, { k: "x" }))).toBe(String(evaluate("#00ff00")));
    expect(String(evaluate(color, { k: "y" }))).toBe(String(evaluate("#ff0000")));
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
  });
});

describe("a cluster badge's ring in the legend", () => {
  const badge = (outline: object) =>
    buildLegend(
      style({
        render: {
          type: "cluster",
          count: "badge",
          symbol: { marker: { color: "#e68310" }, outline: { width: 2, ...outline } },
        },
      }),
      { geometry: "point", zoom: 10 }
    )!.sections.flatMap((s) => (s.kind === "entries" ? s.entries : []))[0].swatch.badge;

  it('in "Same as fill" is the cluster marker\'s color', () => {
    expect(badge({ color: "fill" })?.ring).toBe("#e68310");
  });

  it("in its own color is that color", () => {
    expect(badge({ color: "#000000" })?.ring).toBe("#000000");
  });

  it("draws as on the map", () => {
    const out = compileLayer({
      id: "1",
      style: style({
        render: {
          type: "cluster",
          count: "badge",
          symbol: { marker: { color: "#e68310" }, outline: { color: "fill", width: 2 } },
        },
      }),
      geometry: "point",
      source: points,
    });
    const layer = out.layers.find((l) => l.id === "1-cluster-badge") as { layout: Record<string, unknown> };
    expect(JSON.stringify(layer.layout["icon-image"])).toContain("|#e68310|#e68310|2|");
  });
});

describe("derivedColor", () => {
  it("follows by the word's rule: the color as it is, or its opaque darker shade", () => {
    expect(derivedColor("outline.color", "fill", "#7f3c8dcc")).toBe("#7f3c8dcc");
    expect(derivedColor("outline.color", "auto", "#7f3c8dcc")).toBe("#592a63");
    expect(derivedColor("casing.color", "auto", "#7f3c8d")).toBe("#592a63");
    expect(derivedColor("outline.color", "#000000", "#7f3c8d")).toBe("#000000");
  });

  it("follows while unset where the key does, the icon on a hollow marker only", () => {
    expect(derivedColor("fill.pattern_color", undefined, "#7f3c8d")).toBe("#7f3c8d");
    expect(derivedColor("arrows.color", undefined, "#2166ac")).toBe("#2166ac");
    expect(derivedColor("marker.icon_color", undefined, "#1a6b4d")).toBeUndefined();
    expect(derivedColor("marker.icon_color", undefined, "#1a6b4d", { hollow: true })).toBe("#1a6b4d");
    expect(derivedColor("outline.color", undefined, "#7f3c8d")).toBeUndefined();
    expect(derivedColor("line.color", "auto", "#7f3c8d")).toBe("auto");
  });

  it("names the color each key follows", () => {
    expect(followedKey("outline.color", "polygon")).toBe("fill.color");
    expect(followedKey("outline.color", "point")).toBe("marker.color");
    expect(followedKey("casing.color", "line")).toBe("line.color");
    expect(followedKey("outline.color", "line")).toBeUndefined();
  });
});

describe("the panel's swatch of a color that follows while unset", () => {
  const marker = (own: object) =>
    style({ symbol: { marker: { color: "#1a6b4d", icon: "goat:park", ...own } } });

  it("shows the marker color for the icon of a hollow marker, as the map and the legend draw it", () => {
    expect(swatchOf(marker({ fill: false }), "symbol.marker.icon_color", "point")).toBe("#1a6b4d");
  });

  it("shows the reference icon color on a filled marker and an own icon color as it is", () => {
    expect(swatchOf(marker({}), "symbol.marker.icon_color", "point")).toBe("#ffffff");
    expect(
      swatchOf(marker({ fill: false, icon_color: "#000000" }), "symbol.marker.icon_color", "point")
    ).toBe("#000000");
  });

  it("keeps the hatch of an unset pattern color (the row reads Same as fill)", () => {
    const doc = style({ symbol: { fill: { color: "#7f3c8d", pattern: "dots" } } });
    expect(swatchOf(doc, "symbol.fill.pattern_color", "polygon")).toBe(HATCH);
  });
});

describe("an Auto outline on H3 hexagons (spec 8.3)", () => {
  const STAMP = { at: "2026-10-26T00:00:00Z", data: "ducklake:1", scope: "dataset" };
  const VALUE = ["to-number", ["get", "value"], 0];
  const pal = ["#7f3c8d", "#11a579", "#3969ac"];
  const h3 = (render: object) =>
    style({ render: { type: "h3", resolution: 6, palette: pal, outline: { color: "auto" }, ...render } });
  const outlineOf = (doc: LayerStyle & JsonObject) => {
    const out = compileLayer({ id: "1", style: doc, geometry: "point", source: tiles });
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
    return (
      out.layers.find((l) => l.id === "1-h3-outline") as { paint?: Record<string, unknown> } | undefined
    )?.paint;
  };
  const entries = (doc: LayerStyle & JsonObject) =>
    buildLegend(doc, { geometry: "point", zoom: 10 })!.sections.flatMap((s) =>
      s.kind === "entries" && s.id === "h3" ? s.entries : []
    );

  it("is a darker shade of each class's color", () => {
    const doc = h3({
      classify: { method: "quantile", count: 2 },
      computed: { ...STAMP, resolutions: { "6": { min: 0, max: 10, breaks: [5] } } },
    });
    expect(outlineOf(doc)?.["line-color"]).toEqual(["step", VALUE, shade("#7f3c8d"), 5, shade("#3969ac")]);
    expect(entries(doc).map((e) => e.swatch.outline?.color)).toEqual([shade("#7f3c8d"), shade("#3969ac")]);
  });

  it("is a darker shade of each palette stop over the cell values", () => {
    const doc = h3({ computed: { ...STAMP, resolutions: { "6": { min: 0, max: 10 } } } });
    expect(outlineOf(doc)?.["line-color"]).toEqual([
      "interpolate",
      ["linear"],
      VALUE,
      0,
      shade("#7f3c8d"),
      5,
      shade("#11a579"),
      10,
      shade("#3969ac"),
    ]);
  });

  it("is a darker shade of the one color drawn while nothing is computed, in the legend too", () => {
    const doc = h3({ outline: { color: "auto", width: 2 } });
    expect(outlineOf(doc)).toEqual({ "line-color": shade("#11a579"), "line-width": 2 });
    expect(entries(doc).map((e) => e.swatch.outline)).toEqual([{ color: shade("#11a579"), width: 2 }]);
  });

  it("leaves the legend of a hexagon outline in its own color, of no outline and of columns as it is", () => {
    for (const render of [
      { outline: { color: "#000000" } },
      { outline: { color: "auto", width: 0 } },
      { extrude: { tallest: 1000 } },
    ])
      expect(entries(h3(render)).map((e) => e.swatch.outline)).toEqual([undefined]);
  });
});

describe("a color read from a field with an Auto outline or casing (spec 4.5)", () => {
  const raw = { field: "c" };
  const paint = (doc: LayerStyle & JsonObject, geometry: "point" | "line" | "polygon", id: string) => {
    const out = compileLayer({ id: "1", style: doc, geometry, source: tiles });
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
    return (out.layers.find((l) => l.id === `1-${id}`) as { paint: Record<string, unknown> }).paint;
  };
  const base = (doc: LayerStyle & JsonObject, geometry: "point" | "line" | "polygon") =>
    buildLegend(doc, { geometry, zoom: 10 })!.sections.flatMap((s) =>
      s.kind === "entries" ? s.entries : []
    )[0].swatch;
  const colorAt = (expr: unknown, properties: Record<string, unknown> = {}, zoom?: number) => {
    const value = evaluate(expr, properties, zoom);
    return String(typeof value === "string" ? evaluate(["to-color", value]) : value);
  };

  // The data's color cannot be darkened when the layer is compiled, so it is drawn as it is; the read's fallback (for
  // a feature without a valid color) is a color known then, darkened like any fixed color.
  it("draws the outline in the data's color itself, and in the shade of the fallback where the data has none", () => {
    const doc = style({ symbol: { fill: { color: raw }, outline: { color: "auto", width: 2 } } });
    expect(paint(doc, "polygon", "fill")["fill-color"]).toEqual(["to-color", ["get", "c"], "#2bb381"]);
    const outline = paint(doc, "polygon", "outline")["line-color"];
    expect(outline).toEqual(["to-color", ["get", "c"], shade("#2bb381")]);
    expect(colorAt(outline, { c: "#00ff00" })).toBe(colorAt("#00ff00"));
    expect(colorAt(outline, { c: "not a color" })).toBe(colorAt(shade("#2bb381")));
    // The legend's neutral grey stands for the data's colors: the outline shows it as it is.
    const swatch = base(doc, "polygon");
    expect(swatch.outline?.color).toBe(swatch.fill?.color);
  });

  it("draws the casing in the line's data color, and in the shade of its fallback", () => {
    const doc = style({ symbol: { line: { color: raw }, casing: { color: "auto" } } });
    expect(paint(doc, "line", "casing")["line-color"]).toEqual(["to-color", ["get", "c"], shade("#2166ac")]);
    const swatch = base(doc, "line");
    expect(swatch.casing?.color).toBe(swatch.line?.color);
  });

  it("draws a circle's outline in the marker's data color, and in the shade of its fallback", () => {
    const doc = style({ symbol: { marker: { color: raw }, outline: { color: "auto", width: 2 } } });
    expect(paint(doc, "point", "marker")["circle-stroke-color"]).toEqual([
      "to-color",
      ["get", "c"],
      shade("#2bb381"),
    ]);
  });

  it("draws the data's color in a class over a fixed base and in a zoom stop beside a fixed one", () => {
    const inClass = style({
      symbol: { fill: { color: "#ff0000" }, outline: { color: "auto" } },
      classify: [{ field: "k", method: "categories", classes: [{ values: ["a"], fill: { color: raw } }] }],
    });
    const color = paint(inClass, "polygon", "outline")["line-color"];
    expect(colorAt(color, { k: "a", c: "#00ff00" })).toBe(colorAt("#00ff00"));
    // A feature of the class without a valid color has the base's fill, and the outline every such feature has.
    expect(colorAt(color, { k: "a" })).toBe(colorAt(shade("#ff0000")));
    expect(colorAt(color, { k: "b", c: "#00ff00" })).toBe(colorAt(shade("#ff0000")));

    const byZoom = style({
      symbol: {
        fill: {
          color: {
            zoom: [
              [5, raw],
              [10, "#ff0000"],
            ],
            interpolate: "step",
          },
        },
        outline: { color: "auto" },
      },
    });
    const zoomed = paint(byZoom, "polygon", "outline")["line-color"];
    expect(colorAt(zoomed, { c: "#00ff00" }, 6)).toBe(colorAt("#00ff00"));
    expect(colorAt(zoomed, { c: "#00ff00" }, 12)).toBe(colorAt(shade("#ff0000")));
  });

  it("blends a base by zoom under a class by zoom at other stops, as before", () => {
    const doc = style({
      symbol: {
        fill: {
          color: {
            zoom: [
              [5, "#000000"],
              [15, "#ffffff"],
            ],
          },
        },
        outline: { color: "auto" },
      },
      classify: [
        {
          field: "k",
          method: "categories",
          classes: [
            {
              values: ["a"],
              fill: {
                color: {
                  zoom: [
                    [8, "#ff0000"],
                    [12, "#00ff00"],
                  ],
                },
              },
            },
          ],
        },
      ],
    });
    const out = compileLayer({ id: "1", style: doc, geometry: "polygon", source: tiles });
    const at = (k: string) => String(paintValue(out, "1-outline", "line-color", { k }, 8));
    // The base at zoom 8 is #4d4d4d, its shade #363636.
    expect(at("b")).toBe(colorAt("#363636"));
    expect(at("a")).toBe(colorAt(shade("#ff0000")));
  });

  it("still darkens a palette over a field, stop by stop", () => {
    const doc = style({
      symbol: {
        fill: { color: { field: "v", palette: ["#7f3c8d", "#11a579"], domain: [0, 1] } },
        outline: { color: "auto" },
      },
    });
    const color = paint(doc, "polygon", "outline")["line-color"];
    expect(colorAt(color, { v: 0 })).toBe(colorAt(shade("#7f3c8d")));
    expect(colorAt(color, { v: 1 })).toBe(colorAt(shade("#11a579")));
  });
});

describe("the table of color keys (goatlib data/color_keys.json, spec 18.10)", () => {
  const table = JSON.parse(
    readFileSync(
      resolve(__dirname, "../../../../../packages/python/goatlib/src/goatlib/style/data/color_keys.json"),
      "utf8"
    )
  ) as Record<string, { auto: string | null; accepted?: boolean }>;
  // The cluster symbol draws its parts with the parts' own derivations.
  const derivedKey = (key: string) => key.replace(/^cluster\.symbol\./, "");

  it("offers Auto exactly where the resolver derives it", () => {
    const accepted = Object.entries(table)
      .filter(([, row]) => row.accepted)
      .map(([key, row]) => [derivedKey(key), row.auto]);
    for (const [key, rule] of accepted) expect(ruleOf(key as string, "auto"), key as string).toBe(rule);
    const derivesAuto = Object.keys(DERIVED).filter((key) => ruleOf(key, "auto") !== undefined);
    expect(derivesAuto.sort()).toEqual([...new Set(accepted.map(([key]) => key as string))].sort());
  });
});
