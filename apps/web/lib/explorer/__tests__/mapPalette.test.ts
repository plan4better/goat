import { describe, expect, it } from "vitest";

import { DARK_MAP, LIGHT_MAP, mapColor, mapPalette } from "@/lib/explorer/mapPalette";
import { luminance, tint } from "@/lib/explorer/modes";
import { type NetworkShape, shapeColorExpression } from "@/lib/explorer/network";

/** WCAG contrast between two colours. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("the Explorer's map colours", () => {
  it("are the dark ones on the Dark basemap only", () => {
    expect(mapPalette("dark")).toBe(DARK_MAP);
    for (const basemap of ["light", "streets", "satellite", undefined])
      expect(mapPalette(basemap)).toBe(LIGHT_MAP);
  });

  it("fade a colour into the ground it is drawn on", () => {
    expect(tint("#204080", 0.5)).toBe("#90a0c0");
    expect(tint("#204080", 0.5, "#000000")).toBe("#102040");
    expect(tint("#204080", 1, "#0C0C0C")).toBe("#204080");
  });

  it("keep a route's colour on the light map, and any that shows on the dark one", () => {
    expect(mapColor("#000000", LIGHT_MAP)).toBe("#000000");
    expect(mapColor("#FFCC00", DARK_MAP)).toBe("#FFCC00");
    // A mid blue already shows at 3:1.
    expect(mapColor("#1565C0", DARK_MAP)).toBe("#1565C0");
  });

  it("lift a colour too dark for the dark map just to 3:1 against its ground", () => {
    for (const color of ["#000000", "#0D1B4C", "#424242", "#6A1B9A"]) {
      const drawn = mapColor(color, DARK_MAP);
      expect(drawn).not.toBe(color);
      expect(contrast(drawn, DARK_MAP.ground)).toBeGreaterThanOrEqual(3);
      // No lighter than it needs to be.
      expect(contrast(drawn, DARK_MAP.ground)).toBeLessThan(3.2);
    }
  });

  it("draw each shape in the map's colour for its route", () => {
    const shapes = new Map<string, NetworkShape>([
      ["a", { color: "#000000" } as NetworkShape],
      ["b", { color: "#FFCC00" } as NetworkShape],
    ]);
    const lifted = mapColor("#000000", DARK_MAP);
    expect(shapeColorExpression(shapes, "#999", (c) => mapColor(c, DARK_MAP))).toEqual([
      "match",
      ["to-string", ["get", "shape_id"]],
      ["a"],
      lifted,
      ["b"],
      "#FFCC00",
      "#999",
    ]);
  });
});
