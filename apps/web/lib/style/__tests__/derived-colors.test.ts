import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { derivedColor, followedKey } from "@/lib/style/compile/derived";
import { HATCH, swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import { buildLegend } from "@/lib/style/legend";

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
