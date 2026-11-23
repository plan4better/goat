import type { TFunction } from "i18next";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { buildLegend } from "@/lib/style/legend";
import {
  FORMULA_PRESETS,
  MAX_FORMULA_LENGTH,
  checkFormula,
  formulaLabel,
  formulaProblemText,
  normalizedDifference,
  presetBands,
  presetOf,
} from "@/lib/style/raster/formula";
import type { RasterInfo } from "@/lib/style/raster/metadata";

// Shared with goatlib's tests (tests/unit/raster/test_formula.py parses every case): the panel checks a typed formula
// by the rules the raster service and the style check read it with.
const CASES = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../../packages/python/goatlib/tests/unit/raster/fixtures/formulas.json"),
    "utf8"
  )
) as Array<{ expression: string; bands?: number; used: number[] | null }>;

const preset = (id: string) => FORMULA_PRESETS.find((p) => p.id === id)!;

const stat = (index: number) => ({ index, min: 0, max: 1, p2: 0, p98: 1, values: null });
const file = (opts: { names?: string[]; colorInterp?: string[]; stats?: number[] }): RasterInfo => {
  const count = Math.max(opts.names?.length ?? 0, opts.colorInterp?.length ?? 0);
  return {
    bands: count,
    bits: Array(count).fill(16),
    colorTable: false,
    integer: true,
    names: opts.names ?? Array(count).fill(""),
    ...(opts.colorInterp ? { colorInterp: opts.colorInterp } : {}),
    stats: (opts.stats ?? Array.from({ length: count }, (_, i) => i + 1)).map(stat),
  };
};

const t = ((key: string, opts?: { n?: number }) =>
  key === "style_editor.band_n" ? `Band ${opts?.n}` : key) as unknown as TFunction;

describe("band formulas", () => {
  it("are read as goatlib reads them", () => {
    expect(CASES.length).toBeGreaterThan(20);
    for (const c of CASES) {
      const bands = c.bands ? Array.from({ length: c.bands }, (_, i) => i + 1) : undefined;
      const checked = checkFormula(c.expression, bands);
      expect(checked.ok ? checked.bands : null, c.expression.slice(0, 40)).toEqual(c.used);
    }
  });

  it("say what is wrong with a formula", () => {
    const problem = (expression: string, bands?: number[]) => {
      const checked = checkFormula(expression, bands);
      return checked.ok ? null : checked.problem;
    };
    expect(problem("  ")).toEqual({ code: "empty" });
    expect(problem("b1 +")).toEqual({ code: "ends_early" });
    expect(problem("(b1 b2")).toEqual({ code: "bracket" });
    expect(problem("5 * 2")).toEqual({ code: "no_band" });
    expect(problem("b0")).toEqual({ code: "band_from_one" });
    expect(problem("b1 % 2")).toEqual({ code: "unexpected_at", position: 3 });
    expect(problem("b1)")).toEqual({ code: "unexpected", text: ")" });
    expect(problem("(".repeat(40) + "b1" + ")".repeat(40))).toEqual({ code: "nested" });
    expect(problem("b1".padEnd(MAX_FORMULA_LENGTH + 1, " "))).toEqual({
      code: "too_long",
      max: MAX_FORMULA_LENGTH,
    });
    // An alpha band holds no values: a formula naming it is refused as one naming a band the file lacks.
    expect(problem("b4 - b1", [1, 2, 3])).toEqual({ code: "no_such_band", bands: [1, 2, 3] });
    expect(problem("b3 - b1", [1, 2, 3])).toBeNull();
  });

  it("show the typed text as it is, a slash or an ampersand too", () => {
    const checked = checkFormula("b1 * / b2");
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problem).toEqual({ code: "unexpected", text: "/" });
    expect(formulaProblemText(checked.problem, commonT("en"))).toBe('Unexpected "/"');
    expect(formulaProblemText(checked.problem, commonT("de"))).toBe('Unerwartet: "/"');
    expect(formulaProblemText({ code: "unexpected", text: "&" }, commonT("en"))).toBe('Unexpected "&"');
  });
});

describe("band math presets", () => {
  it("start with diverging palettes centred on 0", () => {
    expect(Object.fromEntries(FORMULA_PRESETS.map((p) => [p.id, p.palette]))).toEqual({
      ndvi: "colorbrewer:RdYlGn",
      ndmi: "colorbrewer:RdYlBu",
      ndwi: "colorbrewer:BrBG",
    });
  });

  it("write a normalized difference and are told apart by their name", () => {
    expect(normalizedDifference(8, 4)).toBe("(b8 - b4) / (b8 + b4)");
    expect(presetOf({ name: "NDVI", expression: "(b8 - b4) / (b8 + b4)" })).toEqual({
      preset: preset("ndvi"),
      bands: [8, 4],
    });
    // The same shape: the name says which index it is; spaces and the order of the sum do not matter.
    expect(presetOf({ name: "NDMI", expression: "(b8-b11)/(b11+b8)" })).toEqual({
      preset: preset("ndmi"),
      bands: [8, 11],
    });
    expect(presetOf({ name: "ndwi", expression: "(b3 - b8) / (b3 + b8)" })?.preset.id).toBe("ndwi");
    expect(presetOf({ name: "Vegetation", expression: "(b8 - b4) / (b8 + b4)" })).toBeNull();
    expect(presetOf({ name: "NDVI", expression: "b8 / b4" })).toBeNull();
    expect(presetOf({ name: "NDVI", expression: "(b8 - b4) / (b8 + b3)" })).toBeNull();
    expect(presetOf(4)).toBeNull();
    expect(presetOf(undefined)).toBeNull();
  });

  it("take their input bands from the file's color interpretation, else its band names", () => {
    const sentinel = file({ names: ["B2", "B3", "B4", "B8", "B11", "B12"] });
    expect(presetBands(sentinel, preset("ndvi"))).toEqual([4, 3]);
    expect(presetBands(sentinel, preset("ndmi"))).toEqual([4, 5]);
    expect(presetBands(sentinel, preset("ndwi"))).toEqual([2, 4]);
    expect(
      presetBands(file({ names: ["B02", "B03", "B04", "B08", "B8A", "B11", "B12"] }), preset("ndvi"))
    ).toEqual([4, 3]);

    const marked = file({ colorInterp: ["red", "green", "blue", "nir"] });
    expect(presetBands(marked, preset("ndvi"))).toEqual([4, 1]);
    expect(presetBands(marked, preset("ndwi"))).toEqual([2, 4]);
    expect(presetBands(marked, preset("ndmi"))).toEqual([4, undefined]);

    // The color interpretation wins over a name.
    const both = file({ colorInterp: ["undefined", "red", "undefined"], names: ["Red", "", "NIR"] });
    expect(presetBands(both, preset("ndvi"))).toEqual([3, 2]);

    const words = file({ names: ["Near infrared", "Red edge", "Red", "Green", "SWIR 2", "SWIR 1"] });
    expect(presetBands(words, preset("ndvi"))).toEqual([1, 3]);
    expect(presetBands(words, preset("ndmi"))).toEqual([1, 6]);
    expect(presetBands(words, preset("ndwi"))).toEqual([4, 1]);
    expect(presetBands(file({ names: ["rot", "grün", "nir"] }), preset("ndwi"))).toEqual([2, 3]);

    // Unnamed bands stay to be picked; an alpha band (no statistics) is never an input.
    expect(presetBands(file({ names: ["", "", "", ""] }), preset("ndvi"))).toEqual([undefined, undefined]);
    const alpha = file({ colorInterp: ["red", "green", "blue", "nir"], stats: [1, 2, 3] });
    expect(presetBands(alpha, preset("ndvi"))).toEqual([undefined, 1]);
    expect(presetBands(undefined, preset("ndvi"))).toEqual([undefined, undefined]);
  });

  it("read bare band codes as roles only on a file with the Sentinel-2 set (a band B8A or B12)", () => {
    // A Landsat 8 or 9 stack: B8 is its panchromatic band and B11 a thermal one.
    const landsat = file({ names: Array.from({ length: 11 }, (_, i) => `B${i + 1}`) });
    for (const id of ["ndvi", "ndmi", "ndwi"] as const)
      expect(presetBands(landsat, preset(id)), id).toEqual([undefined, undefined]);
    // Four bands named by code alone say no sensor.
    expect(presetBands(file({ names: ["B2", "B3", "B4", "B8"] }), preset("ndvi"))).toEqual([
      undefined,
      undefined,
    ]);
    const twenty = file({ names: ["B2", "B3", "B4", "B5", "B6", "B7", "B8", "B8A", "B11", "B12"] });
    expect(presetBands(twenty, preset("ndvi"))).toEqual([7, 3]);
    expect(presetBands(twenty, preset("ndmi"))).toEqual([7, 9]);
    expect(presetBands(twenty, preset("ndwi"))).toEqual([2, 7]);
    expect(presetBands(file({ names: ["b03", "b04", "b8a"] }), preset("ndvi"))).toEqual([3, 2]);
    // Words name a role on any file, beside codes that do not.
    const mixed = file({ names: ["B1", "B2", "B3", "B4 Red", "B5 NIR", "B8"] });
    expect(presetBands(mixed, preset("ndvi"))).toEqual([5, 4]);
  });

  it("name a formula by its preset and bands, else by the formula", () => {
    const named = file({ names: ["B2", "B3", "B4", "B8"] });
    expect(formulaLabel({ name: "NDVI", expression: "(b4 - b3) / (b4 + b3)" }, named, t)).toBe(
      "NDVI (B8, B4)"
    );
    expect(
      formulaLabel(
        { name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" },
        file({ names: ["", "", "", ""] }),
        t
      )
    ).toBe("NDVI (Band 4, Band 1)");
    expect(formulaLabel({ name: "Ratio", expression: " b1 / b2 " }, named, t)).toBe("b1 / b2");
    expect(formulaLabel(2, named, t)).toBeUndefined();
  });

  it("a formula's legend names no band", () => {
    const legend = buildLegend(
      {
        version: "1.0.0",
        kind: "raster",
        render: {
          type: "continuous",
          band: { name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" },
          palette: "colorbrewer:RdYlGn",
          domain: [-1, 1],
        },
      },
      { zoom: 10 }
    );
    expect(legend?.sections).toHaveLength(1);
    expect(JSON.stringify(legend)).not.toMatch(/band/i);
  });
});
