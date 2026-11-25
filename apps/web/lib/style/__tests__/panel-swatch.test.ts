import { describe, expect, it } from "vitest";

import { onColor, opaque, shade } from "@/lib/style/colors";
import { HATCH, swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";

// The panel's swatch of a derived color asks the resolver for what the map draws: in a class's or rule's record (which
// follows the record's own color, else the layer's), in a zoom stop (at that stop's zoom), for the H3 outline (each
// hexagon's color) and over a palette (switching where the map's answer switches).

const doc = (rest: object) => ({ version: "1.0.0", kind: "vector", ...rest }) as LayerStyle;

describe("the panel's swatch of a derived color", () => {
  it("in a class record follows that record's color, else the layer's", () => {
    const style = doc({
      symbol: { fill: { color: "#e68310" }, outline: { color: "auto" } },
      classify: [
        {
          field: "kind",
          classes: [{ values: ["a"], fill: { color: "#7f3c8d" } }, { values: ["b"] }],
        },
      ],
    });
    expect(swatchOf(style, "classify.0.classes.0.outline.color", "polygon", { scoped: true })).toBe(
      shade("#7f3c8d")
    );
    expect(swatchOf(style, "classify.0.classes.1.outline.color", "polygon", { scoped: true })).toBe(
      shade("#e68310")
    );
  });

  it("of an unset icon color in a class reads the layer's hollow marker", () => {
    const style = doc({
      symbol: { marker: { fill: false, color: "#e68310", icon: "goat:park" } },
      classify: [
        { field: "kind", classes: [{ values: ["a"], marker: { color: "#7f3c8d" } }, { values: ["b"] }] },
      ],
      rules: [{ when: { field: "kind", op: "eq", value: "c" }, marker: { color: "#11a5c9" } }],
    });
    expect(swatchOf(style, "classify.0.classes.0.marker.icon_color", "point", { scoped: true })).toBe(
      "#7f3c8d"
    );
    expect(swatchOf(style, "classify.0.classes.1.marker.icon_color", "point", { scoped: true })).toBe(
      "#e68310"
    );
    expect(swatchOf(style, "rules.0.marker.icon_color", "point", { scoped: true })).toBe("#11a5c9");
  });

  it("in a zoom stop is the stop's own derived color, at the zoom of the stop", () => {
    const style = doc({
      symbol: {
        fill: {
          color: {
            zoom: [
              [5, "#7f3c8d"],
              [10, "#ffffff"],
            ],
          },
        },
        outline: {
          color: {
            zoom: [
              [5, "auto"],
              [10, "fill"],
              [12, "#000000"],
            ],
          },
        },
      },
    });
    expect(swatchOf(style, "symbol.outline.color.zoom.0.1", "polygon")).toBe(shade("#7f3c8d"));
    expect(swatchOf(style, "symbol.outline.color.zoom.1.1", "polygon")).toBe("#ffffff");
    expect(swatchOf(style, "symbol.outline.color.zoom.2.1", "polygon")).toBe("#000000");
  });

  it("of an Auto H3 outline shades the hexagons' colors, never the hatch", () => {
    const style = doc({
      render: { type: "h3", palette: ["#7f3c8d", "#e68310"], outline: { color: "auto" } },
    });
    // Before the hexagons' values are computed the map draws the palette's middle color, and its shade around it.
    const swatch = swatchOf(style, "render.outline.color", "point");
    expect(swatch).not.toBe(HATCH);
    expect(swatch).toBe(shade("#e68310"));
  });

  it("over a palette switches where the map's answer switches, never blending through grey", () => {
    const palette = ["#000000", "#ffffff"];
    const style = doc({
      symbol: {
        marker: {
          color: { field: "v", palette, domain: [0, 1] },
          icon: "goat:park",
          icon_color: "auto",
        },
      },
    });
    const swatch = swatchOf(style, "symbol.marker.icon_color", "point");
    // Two answers, each held up to where it changes: hard stops at one position.
    expect(swatch).toMatch(
      /^linear-gradient\(90deg, #ffffff 0%, #ffffff ([\d.]+)%, #3a3541 \1%, #3a3541 100%\)$/
    );
    expect(onColor(palette[0])).toBe("#ffffff");
    expect(onColor(palette[1])).toBe("#3a3541");
  });

  it("of an unset follower shows the hue it draws where asked, the hatch otherwise", () => {
    const style = doc({ symbol: { fill: { color: "#7f3c8d80", pattern: "hatch_45" } } });
    expect(swatchOf(style, "symbol.fill.pattern_color", "polygon")).toBe(HATCH);
    expect(swatchOf(style, "symbol.fill.pattern_color", "polygon", { follow: true })).toBe(
      opaque("#7f3c8d80")
    );
  });

  it("of a color by zoom or by classes resolves each stop's or class's word", () => {
    const byZoom = doc({
      symbol: {
        fill: { color: "#7f3c8d" },
        outline: {
          color: {
            zoom: [
              [5, "auto"],
              [12, "#000000"],
            ],
          },
        },
      },
    });
    expect(swatchOf(byZoom, "symbol.outline.color", "polygon")).toBe(
      `linear-gradient(90deg, ${shade("#7f3c8d")}, #000000)`
    );
    const byClasses = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { width: 1 } },
      classify: [
        {
          field: "kind",
          method: "manual",
          target: "outline.color",
          classes: [
            { to: 3, outline: { color: "auto" }, fill: { color: "#e68310" } },
            { from: 3, outline: { color: "#000000" } },
          ],
        },
      ],
    });
    expect(swatchOf(byClasses, "symbol.outline.color", "polygon")).toBe(
      `linear-gradient(90deg, ${shade("#e68310")}, #000000)`
    );
  });

  it("in a class that leaves the followed color to the layer follows the layer's own, not the other classes'", () => {
    const style = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000", width: 2 } },
      classify: [
        {
          field: "t",
          method: "categories",
          classes: [
            { values: ["a"], outline: { color: "auto" } },
            { values: ["b"], outline: { color: "fill" }, fill: { color: "#11a579" } },
          ],
        },
      ],
    });
    // As the map and the legend draw it.
    expect(swatchOf(style, "classify.0.classes.0.outline.color", "polygon")).toBe(shade("#7f3c8d"));
    expect(swatchOf(style, "symbol.outline.color", "polygon")).toBe(
      `linear-gradient(90deg, ${shade("#7f3c8d")}, #11a579)`
    );
  });

  it("in a rule, or a class of another classification, follows the classes that set the followed color", () => {
    const k = {
      field: "k",
      method: "categories",
      classes: [
        { values: ["x"], fill: { color: "#11a579" } },
        { values: ["y"], fill: { color: "#e68310" } },
      ],
    };
    const classes = `linear-gradient(90deg, ${shade("#11a579")}, ${shade("#e68310")})`;
    const ruled = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000" } },
      classify: [k],
      rules: [{ when: { op: "=", args: [{ property: "t" }, "a"] }, outline: { color: "auto" } }],
    });
    expect(swatchOf(ruled, "rules.0.outline.color", "polygon")).toBe(classes);
    const two = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000" } },
      classify: [
        k,
        { field: "t", method: "categories", classes: [{ values: ["a"], outline: { color: "auto" } }] },
      ],
    });
    expect(swatchOf(two, "classify.1.classes.0.outline.color", "polygon")).toBe(classes);
  });
});
