import { describe, expect, it } from "vitest";

import { isPatternImage, parsePatternImage, patternTile } from "@/lib/style/compile/patternImage";

describe("pattern images", () => {
  it("a name carries the kind, the spacing, the line width and the color", () => {
    expect(parsePatternImage("goat-pattern:vertical|12|1.5|#333333")).toEqual({
      kind: "vertical",
      spacing: 12,
      width: 1.5,
      color: "#333333",
    });
    expect(isPatternImage("goat-marker:circle|8||#fff||0|")).toBe(false);
    expect(parsePatternImage("goat-pattern:zigzag|12|1|#333333")).toBeNull();
    expect(parsePatternImage("goat-pattern:vertical|0|1|#333333")).toBeNull();
    expect(parsePatternImage("goat-pattern:vertical|12|1")).toBeNull();
  });

  it("tiles repeat seamlessly: straight lines span the tile, diagonals lie `spacing` apart", () => {
    expect(patternTile("vertical", 10, 2)).toEqual({ size: 10, path: "M5 0V10", dots: false });
    expect(patternTile("grid", 10, 2).path).toBe("M5 0V10M0 5H10");
    // √2 × 10, rounded to whole pixels.
    expect(patternTile("hatch_45", 10, 2).size).toBe(14);
    expect(patternTile("dots", 10, 4)).toMatchObject({ size: 10, dots: true });
    // Never closer than the line is wide.
    expect(patternTile("horizontal", 1, 3).size).toBe(4);
  });
});
