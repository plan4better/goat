import { describe, expect, it } from "vitest";

import { defaultRender, drawAsOptions, equalClasses, noDataApplies } from "@/lib/style/editor/raster";

const float = { bands: 1, bits: [32], colorTable: false, integer: false, stats: [] };
const byte = { bands: 1, bits: [8], colorTable: false, integer: true, stats: [] };
const rgb = { bands: 4, bits: [8, 8, 8, 8], colorTable: false, integer: true, stats: [] };
const landcover = { bands: 1, bits: [8], colorTable: true, integer: true, stats: [] };

describe("raster render choices", () => {
  it("offers what fits the file", () => {
    expect(drawAsOptions(float)).toEqual(["terrain", "continuous", "image"]);
    expect(drawAsOptions(byte)).toEqual(["terrain", "continuous", "categorical", "image"]);
    expect(drawAsOptions(rgb)).toEqual(["continuous", "categorical", "image"]);
    expect(drawAsOptions(landcover)).toEqual(["categorical", "image"]);
    expect(drawAsOptions(undefined)).toEqual(["terrain", "continuous", "categorical", "image"]);
  });

  it("starts each render from what is known, defaults left out", () => {
    expect(defaultRender("terrain", { info: float })).toEqual({ type: "terrain" });
    expect(defaultRender("image", { info: rgb })).toEqual({ type: "image" });
    expect(defaultRender("continuous", { info: byte })).toEqual({ type: "continuous", domain: [0, 255] });
    expect(defaultRender("continuous", { info: float })).toEqual({ type: "continuous" });
    expect(defaultRender("continuous", { info: float, sample: { min: 3.2, max: 97.5, values: [] } })).toEqual(
      {
        type: "continuous",
        domain: [3, 98],
      }
    );
    const sample = { min: 1, max: 3, values: [1, 2, 3] };
    const categories = defaultRender("categorical", { info: byte, sample });
    expect(categories.type).toBe("categorical");
    expect((categories.classes as Array<{ value: number }>).map((c) => c.value)).toEqual([1, 2, 3]);
    // A file with its own color table keeps drawing in it: no classes from the values in view.
    expect(defaultRender("categorical", { info: landcover, sample })).toEqual({ type: "categorical" });
  });

  it("equal classes over a range, breaks rounded to the range's precision", () => {
    expect(equalClasses([0, 100], 4)).toEqual([
      { to: 25 },
      { from: 25, to: 50 },
      { from: 50, to: 75 },
      { from: 75 },
    ]);
    expect(equalClasses([0, 1], 3)).toEqual([{ to: 0.33 }, { from: 0.33, to: 0.67 }, { from: 0.67 }]);
  });
});

describe("noDataApplies", () => {
  const RGB = { bands: 3, bits: [8, 8, 8], colorTable: false, integer: true, stats: [] };
  const PALETTED = { bands: 1, bits: [8], colorTable: true, integer: true, stats: [] };
  it("is false where the file draws itself: a color table, categories without classes, plain hillshade", () => {
    expect(noDataApplies({ type: "image" }, RGB)).toBe(true);
    expect(noDataApplies({ type: "image" }, PALETTED)).toBe(false);
    expect(noDataApplies({ type: "categorical" }, PALETTED)).toBe(false);
    expect(noDataApplies({ type: "categorical", classes: [{ value: 1, color: "#000000" }] }, PALETTED)).toBe(
      true
    );
    expect(noDataApplies({ type: "terrain" }, undefined)).toBe(false);
    expect(noDataApplies({ type: "terrain", palette: "goat:elevation", domain: [0, 9] }, undefined)).toBe(
      true
    );
    expect(noDataApplies({ type: "continuous", domain: [0, 1] }, undefined)).toBe(true);
  });
});
