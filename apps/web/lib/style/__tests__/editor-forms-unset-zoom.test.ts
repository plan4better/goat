import { describe, expect, it } from "vitest";

import { offersZoom, switchMode, switchScopedMode } from "@/lib/style/editor/forms";
import { getIn } from "@/lib/style/editor/paths";
import type { LayerStyle } from "@/lib/style/generated/types";

const doc = (symbol: object, extra: object = {}) =>
  ({ version: "1.0.0", kind: "vector", symbol, ...extra }) as LayerStyle;
const ctx = { mapZoom: 12, geometry: "line" as const };

// "By zoom" on a value that is not set starts from what the row shows ("Same as line", "Same as fill"); where it shows
// nothing (a marker without an icon), By zoom is not offered and switching writes nothing.
describe("By zoom on a value that is not set", () => {
  it("the arrows' color starts from the line's color", () => {
    const next = switchMode(
      doc({ line: { color: "#336699" }, arrows: {} }),
      "symbol.arrows.color",
      "zoom",
      ctx
    );
    expect(getIn(next, "symbol.arrows.color")).toEqual({
      zoom: [
        [9, "#336699"],
        [15, "#336699"],
      ],
    });
  });

  it("the arrows' color starts from the line's color at the map zoom when the line's is by zoom", () => {
    const line = {
      color: {
        zoom: [
          [10, "#000000"],
          [14, "#ffffff"],
        ],
        interpolate: "step",
      },
    };
    const next = switchMode(doc({ line, arrows: {} }), "symbol.arrows.color", "zoom", ctx);
    expect((getIn(next, "symbol.arrows.color.zoom") as unknown[][]).map((s) => s[1])).toEqual([
      "#000000",
      "#000000",
    ]);
  });

  it("the pattern's color starts from the fill's color", () => {
    const next = switchMode(
      doc({ fill: { color: "#aa3300", pattern: "hatch" } }),
      "symbol.fill.pattern_color",
      "zoom",
      { mapZoom: 12, geometry: "polygon" }
    );
    expect((getIn(next, "symbol.fill.pattern_color.zoom") as unknown[][]).map((s) => s[1])).toEqual([
      "#aa3300",
      "#aa3300",
    ]);
  });

  it("a class's arrows color starts from the color the class's line shows", () => {
    const stored = doc(
      { line: { color: "#336699" }, arrows: {} },
      {
        classify: [
          { field: "kind", method: "categories", classes: [{ value: "a", line: { color: "#ff0000" } }] },
        ],
      }
    );
    const view = doc({ line: { color: "#ff0000" }, arrows: {} });
    const next = switchScopedMode(
      stored,
      view,
      "symbol.arrows.color",
      "classify.0.classes.0.arrows.color",
      "zoom",
      ctx
    );
    expect((getIn(next, "classify.0.classes.0.arrows.color.zoom") as unknown[][]).map((s) => s[1])).toEqual([
      "#ff0000",
      "#ff0000",
    ]);
  });

  it("a marker without an icon offers no By zoom and switching writes nothing", () => {
    const stored = doc({ marker: { color: "#336699" } });
    const point = { mapZoom: 12, geometry: "point" as const };
    expect(offersZoom(stored, "symbol.marker.icon", point)).toBe(false);
    expect(switchMode(stored, "symbol.marker.icon", "zoom", point)).toBe(stored);
    expect(offersZoom(doc({ marker: { icon: "goat:star" } }), "symbol.marker.icon", point)).toBe(true);
  });

  it("values that are set or have a default offer By zoom", () => {
    expect(offersZoom(doc({ line: {} }), "symbol.line.width", ctx)).toBe(true);
    expect(offersZoom(doc({ line: {}, arrows: {} }), "symbol.arrows.color", ctx)).toBe(true);
  });
});
