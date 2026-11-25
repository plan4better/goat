import { describe, expect, it } from "vitest";

import { CHECKER, checkerTiles, checkered, seeThrough } from "@/lib/style/checker";
import { HATCH } from "@/lib/style/editor/summaries";

// The checkerboard every swatch draws its color over (spec 4.6): a transparent color looks lighter, never darker, on
// a dark panel; a None color shows the checkerboard alone.

describe("the swatch checkerboard", () => {
  it("is faint: white and a very light grey", () => {
    expect(CHECKER.light).toBe("#ffffff");
    expect(parseInt(CHECKER.dark.slice(1, 3), 16)).toBeGreaterThanOrEqual(0xe0);
  });

  it("goes under a color that is not opaque, the color on top", () => {
    const css = checkered("#e87ab294");
    expect(css.startsWith("linear-gradient(#e87ab294, #e87ab294), ")).toBe(true);
    expect(css).toContain(CHECKER.dark);
    expect(checkered("#cc615c00")).toContain(CHECKER.dark);
  });

  it("goes under a gradient that holds a color that is not opaque", () => {
    const strip = "linear-gradient(90deg, #ff0000, #0000ff80)";
    expect(checkered(strip).startsWith(`${strip}, `)).toBe(true);
  });

  it("leaves an opaque color, an opaque gradient and the hatch as they are: it would not show", () => {
    expect(checkered("#e87ab2")).toBe("#e87ab2");
    expect(checkered("#e87ab2ff")).toBe("#e87ab2ff");
    expect(checkered("linear-gradient(90deg, #ff0000, #0000ff)")).toBe(
      "linear-gradient(90deg, #ff0000, #0000ff)"
    );
    expect(checkered(HATCH)).toBe(HATCH);
  });

  it("tells a see-through color", () => {
    expect(seeThrough("#e87ab294")).toBe(true);
    expect(seeThrough("#E87AB200")).toBe(true);
    expect(seeThrough("#e87ab2")).toBe(false);
    expect(seeThrough(undefined)).toBe(false);
  });

  it("the legend's SVG tiles are the same two squares", () => {
    const tiles = checkerTiles(3);
    expect(tiles.size).toBe(6);
    expect(tiles.rects.map((r) => r.fill)).toEqual([CHECKER.light, CHECKER.dark, CHECKER.dark]);
  });
});
