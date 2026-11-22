import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  breakCounts,
  classesFromBreaks,
  defaultRender,
  drawAsOptions,
  equalClasses,
  equalIntervalClasses,
  geometricRefused,
  noDataApplies,
  rasterClassesRender,
  setOuterEnd,
} from "@/lib/style/editor/raster";
import type { RasterInfo } from "@/lib/style/raster/metadata";

const float = { bands: 1, bits: [32], colorTable: false, integer: false, stats: [] };
const byte = { bands: 1, bits: [8], colorTable: false, integer: true, stats: [] };
const rgb = { bands: 4, bits: [8, 8, 8, 8], colorTable: false, integer: true, stats: [] };
const landcover = { bands: 1, bits: [8], colorTable: true, integer: true, stats: [] };

describe("raster render choices", () => {
  it("offers what fits the file", () => {
    expect(drawAsOptions(float)).toEqual(["hillshade", "continuous", "image"]);
    expect(drawAsOptions(byte)).toEqual(["hillshade", "continuous", "categorical", "image"]);
    expect(drawAsOptions(rgb)).toEqual(["continuous", "categorical", "image"]);
    expect(drawAsOptions(landcover)).toEqual(["categorical", "image"]);
    // Nothing until the file's info answered: the list does not change under the pointer.
    expect(drawAsOptions(undefined)).toEqual([]);
  });

  it("hillshade is offered on one band of values, an alpha band besides it not counted", () => {
    const stats = (index: number) => ({ index, min: 0, max: 9, p2: 0, p98: 9, values: null });
    // Elevation with a transparency band: the service gives statistics for band 1 only.
    expect(drawAsOptions({ ...byte, bands: 2, stats: [stats(1)] })).toContain("hillshade");
    expect(drawAsOptions({ ...rgb, stats: [stats(1), stats(2), stats(3)] })).not.toContain("hillshade");
  });

  it("starts each render from what is known, defaults left out", () => {
    expect(defaultRender("hillshade", { info: float })).toEqual({ type: "hillshade" });
    expect(defaultRender("image", { info: rgb })).toEqual({ type: "image" });
    expect(defaultRender("continuous", { info: byte })).toEqual({ type: "continuous", domain: [0, 255] });
    expect(defaultRender("continuous", { info: float })).toEqual({ type: "continuous" });
    expect(defaultRender("continuous", { info: float, sample: { min: 3.2, max: 97.5, values: [] } })).toEqual(
      {
        type: "continuous",
        domain: [3, 98],
      }
    );
  });

  it("categories start with one class per code the band holds, in the file's colors where it has a table", () => {
    const codes = (values: number[] | null) => [{ index: 1, min: 0, max: 9, p2: 0, p98: 9, values }];
    const categories = defaultRender("categorical", { info: { ...byte, stats: codes([1, 2, 3]) } });
    expect(categories.type).toBe("categorical");
    const classes = categories.classes as Array<{ value: number; color: string; name?: string }>;
    expect(classes.map((c) => c.value)).toEqual([1, 2, 3]);
    // Without a table, the palette's colors in order; named by nothing but their code.
    expect(new Set(classes.map((c) => c.color)).size).toBe(3);
    expect(classes.every((c) => c.name === undefined)).toBe(true);
    const table: RasterInfo = {
      ...landcover,
      tableColors: { 0: "#000000", 1: "#ff0000", 3: "#0000ff" },
      stats: codes([0, 1, 3, 7]),
    };
    const fromTable = defaultRender("categorical", { info: table }).classes as Array<{
      value: number;
      color: string;
    }>;
    expect(fromTable.slice(0, 3)).toEqual([
      { value: 0, color: "#000000" },
      { value: 1, color: "#ff0000" },
      { value: 3, color: "#0000ff" },
    ]);
    // A code the table has no color for takes the palette's.
    expect(fromTable[3].value).toBe(7);
    expect(fromTable[3].color).toMatch(/^#[0-9a-f]{6}$/);
    // The band's codes, not the first band's.
    expect(
      (
        defaultRender("categorical", {
          info: { ...byte, bands: 2, stats: [...codes([1]), { ...codes([5, 6])[0], index: 2 }] },
          band: 2,
        }).classes as Array<{ value: number }>
      ).map((c) => c.value)
    ).toEqual([5, 6]);
    // Codes not known (too many, or float cells): no classes; the file draws as stored.
    expect(defaultRender("categorical", { info: { ...byte, stats: codes(null) } })).toEqual({
      type: "categorical",
    });
    // At most 100 classes, as a classification's All values.
    const many = defaultRender("categorical", {
      info: { ...byte, stats: codes(Array.from({ length: 300 }, (_, i) => i)) },
    });
    expect((many.classes as unknown[]).length).toBe(100);
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

  it("equal intervals split the range as a style check does: exact to twelve digits", () => {
    expect(equalIntervalClasses([0, 1], 3)).toEqual([
      { to: 0.333333333333 },
      { from: 0.333333333333, to: 0.666666666667 },
      { from: 0.666666666667 },
    ]);
    expect(equalIntervalClasses([181, 440], 4)).toEqual([
      { to: 245.75 },
      { from: 245.75, to: 310.5 },
      { from: 310.5, to: 375.25 },
      { from: 375.25 },
    ]);
  });

  it("classes from inner breaks: the first open below, the last open above", () => {
    expect(classesFromBreaks([10, 20])).toEqual([{ to: 10 }, { from: 10, to: 20 }, { from: 20 }]);
    // Values all alike: one class.
    expect(classesFromBreaks([])).toEqual([{}]);
  });
});

/** Shared with goatlib (test_raster_compute.py): the check splits a range into these classes. */
const EQUAL_INTERVAL_CASES = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../../packages/python/goatlib/tests/unit/style/fixtures/equal_interval_cases.json"
    ),
    "utf8"
  )
) as Array<{ about: string; domain: [number, number]; count: number; whole: boolean; breaks: number[] }>;

describe("equal intervals as the style check writes them (with goatlib)", () => {
  it.each(EQUAL_INTERVAL_CASES.map((c) => [c.about, c] as const))("%s", (_, c) => {
    const classes = equalIntervalClasses(c.domain, c.count, c.whole);
    expect(classes.slice(1).map((k) => k.from)).toEqual(c.breaks);
  });

  it("a whole-number band's equal intervals break at whole numbers; a formula's and a scaled band's do not", () => {
    const byte: RasterInfo = {
      bands: 1,
      bits: [8],
      colorTable: false,
      integer: true,
      scaled: false,
      stats: [{ index: 1, min: 7, max: 255, p2: 7, p98: 255, values: null }],
    };
    const render = { type: "continuous", palette: "goat:elevation", domain: [0.5, 100.3] };
    const breaksOf = (r: JsonLike, info: RasterInfo) =>
      (
        (rasterClassesRender(r, "equal_interval", 5, info).classify as JsonLike).classes as Array<{
          to?: number;
        }>
      )
        .slice(0, -1)
        .map((k) => k.to);
    expect(breaksOf(render, byte)).toEqual([20, 40, 60, 80]);
    expect(breaksOf({ ...render, band: { name: "Half", expression: "b1 / 2" } }, byte)).toEqual([
      20.46, 40.42, 60.38, 80.34,
    ]);
    expect(breaksOf(render, { ...byte, scaled: true })).toEqual([20.46, 40.42, 60.38, 80.34]);
  });
});

describe("raster classes by method", () => {
  const BREAKS = {
    quantile: { "3": [20, 60], "5": [10, 30, 50, 70] },
    natural_breaks: { "5": [15, 35, 55, 75] },
    // Standard deviation can give fewer breaks than asked for.
    std_dev: { "5": [40, 60] },
  };
  const INFO: RasterInfo = {
    bands: 1,
    bits: [32],
    colorTable: false,
    integer: false,
    stats: [{ index: 1, min: 0, max: 100, p2: 2, p98: 98, values: null, breaks: BREAKS }],
  };
  const render = (extra: object = {}) => ({
    type: "continuous",
    palette: "goat:elevation",
    domain: [2, 98],
    ...extra,
  });

  it("quantiles take the service's breaks and leave the range out, so the check classifies all values as they did", () => {
    expect(rasterClassesRender(render(), "quantile", 5, INFO)).toEqual({
      type: "continuous",
      palette: "goat:elevation",
      classify: {
        method: "quantile",
        count: 5,
        classes: [{ to: 10 }, { from: 10, to: 30 }, { from: 30, to: 50 }, { from: 50, to: 70 }, { from: 70 }],
      },
    });
    expect(
      (rasterClassesRender(render(), "std_dev", 5, INFO).classify as { classes: unknown[] }).classes
    ).toEqual([{ to: 40 }, { from: 40, to: 60 }, { from: 60 }]);
  });

  it("what the author set on a class stays by position; a color the server wrote goes", () => {
    const before = render({
      classify: {
        method: "quantile",
        count: 3,
        palette: "colorbrewer:Blues",
        classes: [
          { id: "a", to: 20, name: "Low", color: "#111111" },
          { id: "b", from: 20, to: 60, color: "#222222", visible: false },
          { id: "c", from: 60, color: "#333333" },
        ],
        computed: { generated: { target: "color", values: { a: "#111111", b: "#999999", c: "#333333" } } },
      },
    });
    const next = rasterClassesRender(before, "natural_breaks", 5, INFO).classify as JsonLike;
    expect(next).toEqual({
      method: "natural_breaks",
      count: 5,
      palette: "colorbrewer:Blues",
      classes: [
        { to: 15, name: "Low" },
        { from: 15, to: 35, color: "#222222", visible: false },
        { from: 35, to: 55 },
        { from: 55, to: 75 },
        { from: 75 },
      ],
    });
  });

  it("equal intervals split the range; without one, the band's 2nd to 98th percentile, written as the range", () => {
    expect(rasterClassesRender(render({ domain: [0, 100] }), "equal_interval", 4, INFO)).toMatchObject({
      domain: [0, 100],
      classify: {
        method: "equal_interval",
        count: 4,
        classes: [{ to: 25 }, { from: 25, to: 50 }, { from: 50, to: 75 }, { from: 75 }],
      },
    });
    const open = rasterClassesRender(render({ domain: undefined }), "equal_interval", 2, INFO);
    expect(open.domain).toEqual([2, 98]);
    expect((open.classify as JsonLike).classes).toEqual([{ to: 50 }, { from: 50 }]);
  });

  it("back from a computed method, a range starts from the band's 2nd to 98th percentile, as Draw as Color range does", () => {
    // Quantiles left the range out; the check then wrote the band's minimum and maximum.
    const quantiles: JsonLike = {
      ...rasterClassesRender(render(), "quantile", 5, INFO),
      computed: { domain: [0, 100] },
    };
    expect(quantiles.domain).toBeUndefined();
    const continuous = rasterClassesRender(quantiles, "continuous", 5, INFO);
    expect(continuous.domain).toEqual([2, 98]);
    expect(continuous.classify).toBeUndefined();
    expect(rasterClassesRender(quantiles, "equal_interval", 2, INFO)).toMatchObject({
      domain: [2, 98],
      classify: { classes: [{ to: 50 }, { from: 50 }] },
    });
    // Manual breaks keep the quantile classes and get a range to type over.
    expect(rasterClassesRender(quantiles, "manual", 5, INFO).domain).toEqual([2, 98]);
    // A band without percentiles: the range the check computed.
    const none: RasterInfo = { ...INFO, stats: [{ ...INFO.stats[0], p2: null, p98: null }] };
    expect(rasterClassesRender(quantiles, "continuous", 5, none).domain).toEqual([0, 100]);
    // A written range stays.
    expect(rasterClassesRender(render({ domain: [10, 20] }), "continuous", 5, INFO).domain).toEqual([10, 20]);
  });

  it("manual breaks keep the classes there are, else start as equal classes over the range", () => {
    const quantiles = rasterClassesRender(render(), "quantile", 3, INFO);
    expect(rasterClassesRender(quantiles, "manual", 3, INFO).classify).toEqual({
      method: "manual",
      classes: [{ to: 20 }, { from: 20, to: 60 }, { from: 60 }],
    });
    expect(rasterClassesRender(render({ domain: [0, 100] }), "manual", 4, INFO).classify).toEqual({
      method: "manual",
      classes: [{ to: 25 }, { from: 25, to: 50 }, { from: 50, to: 75 }, { from: 75 }],
    });
  });

  it("continuous drops the classes", () => {
    const quantiles = rasterClassesRender(render(), "quantile", 3, INFO);
    expect(rasterClassesRender(quantiles, "continuous", 3, INFO).classify).toBeUndefined();
  });

  it("the counts a method offers: those the service computed breaks for, else 2 to 13", () => {
    expect(breakCounts(INFO, 1, "quantile")).toEqual([3, 5]);
    expect(breakCounts(INFO, 1, "natural_breaks")).toEqual([5]);
    expect(breakCounts(INFO, 1, "equal_interval")).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(breakCounts(INFO, 2, "quantile")).toEqual([]);
    expect(breakCounts(INFO, { expression: "b1 * 2" }, "quantile")).toEqual([]);
  });

  it("geometric intervals come from the service's breaks, for bands whose values all lie above 0", () => {
    const positive: RasterInfo = {
      ...INFO,
      stats: [
        {
          ...INFO.stats[0],
          min: 1,
          breaks: { ...BREAKS, geometric_interval: { "3": [4.6, 21.5], "13": [] } },
        },
      ],
    };
    expect(breakCounts(positive, 1, "geometric_interval")).toEqual([3, 13]);
    expect(geometricRefused(positive, 1)).toBe(false);
    expect(rasterClassesRender(render(), "geometric_interval", 3, positive)).toMatchObject({
      classify: {
        method: "geometric_interval",
        count: 3,
        classes: [{ to: 4.6 }, { from: 4.6, to: 21.5 }, { from: 21.5 }],
      },
    });
    // A band reaching 0 or below has none: the service leaves them out.
    const dem: RasterInfo = {
      ...INFO,
      stats: [{ ...INFO.stats[0], min: -38.9, breaks: { ...BREAKS, geometric_interval: {} } }],
    };
    expect(breakCounts(dem, 1, "geometric_interval")).toEqual([]);
    expect(geometricRefused(dem, 1)).toBe(true);
    expect(geometricRefused({ ...INFO, stats: [{ ...INFO.stats[0], min: 0 }] }, 1)).toBe(true);
    // Not known yet, or a formula: no values to refuse them for (the breaks are missing there instead).
    expect(geometricRefused(undefined, 1)).toBe(false);
    expect(geometricRefused(positive, { expression: "b1 * 2" })).toBe(false);
    expect(breakCounts(positive, { expression: "b1 * 2" }, "geometric_interval")).toEqual([]);
  });

  it("an outer end typed with values outside left out makes the classes manual and keeps the inner breaks", () => {
    const quantiles = render({
      domain: undefined,
      outside: "hide",
      classify: {
        method: "quantile",
        count: 3,
        classes: [
          { id: "c1", to: 20, name: "Low", color: "#111111" },
          { id: "c2", from: 20, to: 60 },
          { id: "c3", from: 60, color: "#333333" },
        ],
        computed: { generated: { target: "color", values: { c1: "#111111", c3: "#333333" } } },
      },
    });
    const lower = setOuterEnd(quantiles, "from", 5);
    expect(lower).toEqual({
      ...quantiles,
      classify: {
        method: "manual",
        classes: [{ from: 5, to: 20, name: "Low" }, { from: 20, to: 60 }, { from: 60 }],
      },
    });
    expect((setOuterEnd(lower, "to", 90).classify as JsonLike).classes).toEqual([
      { from: 5, to: 20, name: "Low" },
      { from: 20, to: 60 },
      { from: 60, to: 90 },
    ]);
    // An end on the wrong side of the class's other bound would make no class: nothing changes.
    expect(setOuterEnd(quantiles, "from", 20)).toBe(quantiles);
    expect(setOuterEnd(quantiles, "to", 50)).toBe(quantiles);
  });
});

type JsonLike = Record<string, unknown>;

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
    expect(noDataApplies({ type: "hillshade" }, undefined)).toBe(false);
    expect(noDataApplies({ type: "hillshade", palette: "goat:elevation", domain: [0, 9] }, undefined)).toBe(
      true
    );
    expect(noDataApplies({ type: "continuous", domain: [0, 1] }, undefined)).toBe(true);
  });
});
