import { describe, expect, it } from "vitest";

import { MARKER_SHAPES, drawsAsImage, isPin, markerShapeOf } from "@/lib/style/markerShapes";

describe("marker shapes", () => {
  it("every pin points at the bottom centre of its box, so a bottom anchor puts the tip on the place", () => {
    const pins = Object.entries(MARKER_SHAPES).filter(([, s]) => s.pin);
    expect(pins.map(([id]) => id)).toEqual(["pin", "round_pin", "needle", "square_pin", "tag_pin", "flag"]);
    for (const [, shape] of pins) {
      const ys = [...shape.path.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
      expect(Math.max(...ys)).toBeLessThanOrEqual(24);
      expect(shape.path).toMatch(/(^|[^\d.])24(\D|$)/);
    }
  });

  it("an icon sits inside its shape's box", () => {
    for (const shape of Object.values(MARKER_SHAPES)) {
      const half = (shape.icon.share * 24) / 2;
      expect(shape.icon.cx - half).toBeGreaterThanOrEqual(0);
      expect(shape.icon.cy + half).toBeLessThanOrEqual(24);
    }
  });

  it("names the shape a style draws; circles without an icon stay circles", () => {
    expect(markerShapeOf(undefined)).toBe("circle");
    expect(markerShapeOf("pin")).toBe("pin");
    expect(markerShapeOf("nonsense")).toBe("circle");
    expect(isPin("flag")).toBe(true);
    expect(isPin("hexagon")).toBe(false);
    expect(drawsAsImage("circle", false)).toBe(false);
    expect(drawsAsImage("circle", true)).toBe(true);
    expect(drawsAsImage("hexagon", false)).toBe(true);
    expect(drawsAsImage("icon", true)).toBe(false);
  });
});
