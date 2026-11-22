import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import {
  type RasterInfoResponse,
  bandBreaks,
  bandFactsOf,
  bandHistogram,
  bandLabel,
  bandRange,
  breaksBandOf,
  codeShare,
  rangeShare,
  rasterInfoOf,
  sampleOf,
  seedDomain,
  shortNumber,
  valueShare,
} from "@/lib/style/raster/metadata";

const band = (index: number, extra: object = {}) => ({
  index,
  min: 100,
  max: 400,
  mean: 250,
  std: 80,
  p2: 106.4,
  p98: 393.2,
  histogram: { counts: [1], edges: [100, 400] },
  values: null,
  approximate: true,
  ...extra,
});
const INFO: RasterInfoResponse = {
  width: 512,
  height: 512,
  bounds: [11.5, 48.1, 11.6, 48.2],
  count: 1,
  dtype: "float32",
  nodata: -9999,
  bits: [32],
  color_table: null,
  names: ["Band 1"],
  scales: [1],
  offsets: [0],
  bands: [band(1)],
};

describe("raster facts from the raster service", () => {
  it("bands, bits, no data and whether the cells are whole numbers come from the service's info", () => {
    expect(rasterInfoOf(INFO)).toMatchObject({
      bands: 1,
      bits: [32],
      noData: -9999,
      colorTable: false,
      integer: false,
    });
    const codes = rasterInfoOf({
      ...INFO,
      dtype: "uint8",
      nodata: null,
      bits: [8],
      color_table: { "1": [255, 0, 0, 255], "3": [0, 0, 255, 255] },
      bands: [band(1, { values: [1, 2, 3] })],
    });
    expect(codes).toMatchObject({
      colorTable: true,
      integer: true,
      noData: undefined,
      dtype: "uint8",
      scaled: false,
    });
    expect(rasterInfoOf({ ...INFO, scales: [0.01], offsets: [0] }).scaled).toBe(true);
    expect(rasterInfoOf({ ...INFO, scales: [1], offsets: [-100] }).scaled).toBe(true);
    expect(codes.tableColors).toEqual({ 1: "#ff0000", 3: "#0000ff" });
  });

  it("the band facts carry the file's color interpretation and its color table's entries", () => {
    const info = rasterInfoOf({
      ...INFO,
      dtype: "uint8",
      nodata: null,
      bits: [8],
      color_table: { "1": [255, 0, 0, 255], "3": [0, 0, 255, 255] },
      color_interp: ["palette"],
      palette: { band: 1, colors: { "1": [255, 0, 0, 255], "3": [0, 0, 255, 255] } },
      bands: [band(1, { values: [1, 3] })],
    });
    expect(bandFactsOf(info)).toEqual({
      count: 1,
      dtype: "uint8",
      scaled: false,
      colorTable: true,
      valueBands: [1],
      colorInterp: ["palette"],
      palette: { band: 1, colors: { 1: "#ff0000", 3: "#0000ff" } },
    });
    // One object per info: the popup's color cache keys on it, in the panel as on the map.
    expect(bandFactsOf(info)).toBe(bandFactsOf(info));
    // An older geoapi tells neither.
    expect(bandFactsOf(rasterInfoOf({ ...INFO, dtype: "uint8" }))).toEqual({
      count: 1,
      dtype: "uint8",
      scaled: false,
      colorTable: false,
      valueBands: [1],
    });
  });

  it("From the data sets the domain to the band's 2nd and 98th percentiles", () => {
    const info = rasterInfoOf(INFO);
    const sample = sampleOf(info, 1);
    expect(sample).toEqual({ min: 106.4, max: 393.2, values: [] });
    expect(seedDomain(sample, info)).toEqual([106, 394]);
    expect(sampleOf(info, 2)).toBeNull();
  });

  it("a whole-number band lists its values; a band without values has no sample", () => {
    const codes = rasterInfoOf({ ...INFO, dtype: "uint8", bands: [band(1, { values: [1, 2, 5] })] });
    expect(sampleOf(codes, 1)?.values).toEqual([1, 2, 5]);
    const empty = rasterInfoOf({ ...INFO, bands: [band(1, { min: null, max: null, p2: null, p98: null })] });
    expect(sampleOf(empty, 1)).toBeNull();
  });

  it("rasterInfoOf keeps the band names; a band without a description has none", () => {
    // The service names a band without a description "Band <n>": that is no name of the file's own.
    const info = rasterInfoOf({ ...INFO, count: 3, names: ["Rot", "Band 2", ""], bands: [band(1)] });
    expect(info.names).toEqual(["Rot", "", ""]);
    expect(rasterInfoOf({ ...INFO, names: ["Band 1"] }).names).toEqual([""]);
  });

  it("a band's label is the file's name for it, else the translated Band n", () => {
    const info = rasterInfoOf({ ...INFO, count: 2, names: ["Rot", ""] });
    const de = commonT("de");
    expect(bandLabel(info, 1, de)).toBe("Rot");
    expect(bandLabel(info, 2, de)).toBe(de("style_editor.band_n", { n: 2 }));
    expect(bandLabel(undefined, 3, commonT("en"))).toBe("Band 3");
  });

  it("a no-data value is shown as typed, a long one cut to three digits", () => {
    expect(shortNumber(-9999)).toBe("-9999");
    expect(shortNumber(-3.4028234663852886e38)).toBe("-3.4e+38");
    expect(shortNumber(0.000123456789)).toBe("0.000123");
    expect(shortNumber(1234567.25)).toBe("1234567.25");
    expect(shortNumber(12345678.25)).toBe("1.23e+7");
  });

  it("rasterInfoOf keeps each band's histogram, mean, standard deviation and precomputed breaks", () => {
    const breaks = { quantile: { "3": [150, 250], "4": [] }, std_dev: { "3": [170] } };
    const info = rasterInfoOf({
      ...INFO,
      bands: [band(1, { histogram: { counts: [3, 1], edges: [100, 250, 400] }, breaks })],
    });
    expect(info.stats[0]).toMatchObject({
      mean: 250,
      std: 80,
      histogram: { counts: [3, 1], edges: [100, 250, 400] },
      breaks,
    });
    // An info from before the breaks: none.
    expect(rasterInfoOf(INFO).stats[0].breaks).toEqual({});
  });

  it("a band's histogram as bins, and the breaks precomputed for a method and count", () => {
    const info = rasterInfoOf({
      ...INFO,
      count: 2,
      bands: [
        band(1, {
          histogram: { counts: [3, 1], edges: [100, 250, 400] },
          breaks: { quantile: { "3": [150, 250], "4": [] } },
        }),
        band(2, { histogram: { counts: [], edges: [] } }),
      ],
    });
    expect(bandHistogram(info, 1)).toEqual([
      { range: [100, 250], count: 3 },
      { range: [250, 400], count: 1 },
    ]);
    expect(bandHistogram(info, 2)).toEqual([]);
    expect(bandHistogram(info, 3)).toEqual([]);
    expect(bandBreaks(info, 1, "quantile", 3)).toEqual([150, 250]);
    // A list can be empty (all values alike) or missing (a count or method the service did not compute).
    expect(bandBreaks(info, 1, "quantile", 4)).toEqual([]);
    expect(bandBreaks(info, 1, "quantile", 5)).toBeUndefined();
    expect(bandBreaks(info, 1, "natural_breaks", 3)).toBeUndefined();
    expect(bandBreaks(info, 2, "quantile", 3)).toBeUndefined();
    expect(bandBreaks(undefined, 1, "quantile", 3)).toBeUndefined();
  });

  it("the info is asked for the band or formula a color range or a hillshade reads, and for none otherwise", () => {
    const raster = (render?: object) => ({ version: "1.0.0", kind: "raster", ...(render ? { render } : {}) });
    expect(breaksBandOf(raster({ type: "continuous", palette: "goat:elevation", band: 3 }))).toBe(3);
    expect(breaksBandOf(raster({ type: "continuous", palette: "goat:elevation" }))).toBe(1);
    // Images and categories have no classes to compute.
    for (const type of ["image", "categorical"])
      expect(breaksBandOf(raster({ type, band: 2 })), type).toBeUndefined();
    expect(breaksBandOf(raster())).toBeUndefined();
    expect(breaksBandOf({ version: "1.0.0", kind: "vector" })).toBeUndefined();
    expect(breaksBandOf(undefined)).toBeUndefined();
  });

  it("a hillshade's info is asked for its band or formula: its colors classify it, a formula's values come only so", () => {
    const shaded = (render: object) => ({ version: "1.0.0", kind: "raster", render: { type: "hillshade", ...render } });
    const classify = { method: "quantile", count: 5 };
    expect(breaksBandOf(shaded({ band: 2, palette: "goat:elevation", classify }))).toBe(2);
    expect(breaksBandOf(shaded({ palette: "goat:elevation" }))).toBe(1);
    // Shading alone: its band, so turning its colors on finds the breaks there.
    expect(breaksBandOf(shaded({}))).toBe(1);
    expect(breaksBandOf(shaded({ band: 3 }))).toBe(3);
  });

  it("an info carries breaks for the band it was asked for only: another band has none", () => {
    const info = rasterInfoOf({
      ...INFO,
      count: 2,
      bands: [band(1), band(2, { breaks: { quantile: { "3": [150, 300] } } })],
    });
    expect(bandBreaks(info, 2, "quantile", 3)).toEqual([150, 300]);
    expect(bandBreaks(info, 1, "quantile", 3)).toBeUndefined();
    // Its statistics are there all the same.
    expect(bandRange(info, 1)).toEqual([100, 400]);
    expect(sampleOf(info, 1)).toEqual({ min: 106.4, max: 393.2, values: [] });
  });

  it("a class's share splits each bin by the part of it the class covers", () => {
    const bins = [
      { range: [0, 10], count: 10 },
      { range: [10, 20], count: 30 },
      { range: [20, 30], count: 60 },
    ] as Array<{ range: [number, number]; count: number }>;
    expect(rangeShare(bins, undefined, 10)).toBeCloseTo(0.1);
    // 14 cuts the second bin: 6 tenths of its cells are from 14 on, 4 tenths under it.
    expect(rangeShare(bins, 14, undefined)).toBeCloseTo(0.78);
    expect(rangeShare(bins, undefined, 14)).toBeCloseTo(0.22);
    expect(rangeShare(bins, 12, 25)).toBeCloseTo((30 * 0.8 + 60 * 0.5) / 100);
    // A class from the highest edge on, and one above the bins, hold nothing.
    expect(rangeShare(bins, 30, undefined)).toBe(0);
    expect(rangeShare(bins, 40, 50)).toBe(0);
    expect(rangeShare([], 0, 10)).toBeUndefined();
    expect(rangeShare([{ range: [0, 1], count: 0 }], 0, 10)).toBeUndefined();
    // A band of one value: its bin has no width and counts whole in the class its edge falls in.
    const one = [{ range: [5, 5], count: 8 }] as Array<{ range: [number, number]; count: number }>;
    expect(rangeShare(one, undefined, 5)).toBe(0);
    expect(rangeShare(one, 5, undefined)).toBe(1);
    expect(rangeShare(one, 4, 6)).toBe(1);
  });

  it("quantile classes read about a fifth of the cells each", () => {
    // The Copernicus DEM tile around Berlin as the raster service describes it: 50 bins and the breaks of 5 quantiles,
    // a peaked band where a class covers only two or three bins.
    const counts = [
      7, 3, 11, 7, 19, 10, 11, 5, 1721, 905, 310, 256, 249, 350, 2821, 21019, 68999, 63425, 76201, 78471,
      78114, 64048, 51361, 40205, 34542, 27754, 21098, 16562, 11493, 7774, 6042, 4123, 3220, 2808, 2550, 2404,
      2092, 1790, 1698, 1538, 1226, 761, 510, 437, 301, 93, 41, 4, 2, 1,
    ];
    const edges = [
      -38.9353, -34.3737, -29.8122, -25.2507, -20.6892, -16.1277, -11.5661, -7.0046, -2.4431, 2.1184, 6.6799,
      11.2414, 15.803, 20.3645, 24.926, 29.4875, 34.049, 38.6105, 43.1721, 47.7336, 52.2951, 56.8566, 61.4181,
      65.9797, 70.5412, 75.1027, 79.6642, 84.2257, 88.7872, 93.3488, 97.9103, 102.4718, 107.0333, 111.5948,
      116.1563, 120.7179, 125.2794, 129.8409, 134.4024, 138.9639, 143.5254, 148.087, 152.6485, 157.21,
      161.7715, 166.333, 170.8946, 175.4561, 180.0176, 184.5791, 189.1406,
    ];
    const bins = counts.map((count, i) => ({ range: [edges[i], edges[i + 1]] as [number, number], count }));
    const breaks = [41.7291175842, 50.2070343018, 58.5443336487, 71.912588501];
    const bounds = [undefined, ...breaks, undefined];
    const shares = breaks.concat(0).map((_, k) => rangeShare(bins, bounds[k], bounds[k + 1]) as number);
    for (const share of shares) expect(Math.abs(share - 0.2)).toBeLessThan(0.01);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("a code's share is known where it is the only code in its bin", () => {
    // Codes 0 and 1 share the first bin; 7 and 9 have a bin each; the last bin holds the highest edge.
    const bins = [
      { range: [0, 2.5], count: 50 },
      { range: [2.5, 5], count: 0 },
      { range: [5, 7.5], count: 30 },
      { range: [7.5, 10], count: 20 },
    ] as Array<{ range: [number, number]; count: number }>;
    const codes = [0, 1, 7, 10];
    expect(valueShare(bins, codes, 7)).toBeCloseTo(0.3);
    expect(valueShare(bins, codes, 10)).toBeCloseTo(0.2);
    expect(valueShare(bins, codes, 0)).toBeUndefined();
    expect(valueShare(bins, codes, 1)).toBeUndefined();
    // A code the band does not hold, and a value beyond the bins.
    expect(valueShare(bins, codes, 4)).toBe(0);
    expect(valueShare(bins, codes, 12)).toBe(0);
    expect(valueShare([], codes, 7)).toBeUndefined();
  });

  it("a code's share is its cell count over all the band's counted cells, exact however the bins fall", () => {
    // A paletted band: codes 0, 1 and 2 share the histogram's first bin, the service counts each code.
    const info = rasterInfoOf({
      ...INFO,
      dtype: "uint8",
      bands: [
        band(1, {
          min: 0,
          max: 205,
          values: [0, 1, 2, 205],
          counts: [50, 25, 15, 10],
          histogram: { counts: [90, 10], edges: [0, 102.5, 205] },
        }),
      ],
    });
    expect(info.stats[0].counts).toEqual([50, 25, 15, 10]);
    expect(codeShare(info, 1, 0)).toBeCloseTo(0.5);
    expect(codeShare(info, 1, 1)).toBeCloseTo(0.25);
    expect(codeShare(info, 1, 2)).toBeCloseTo(0.15);
    expect(codeShare(info, 1, 205)).toBeCloseTo(0.1);
    // A code the band does not hold; a band without codes.
    expect(codeShare(info, 1, 7)).toBe(0);
    expect(codeShare(rasterInfoOf(INFO), 1, 0)).toBeUndefined();
    // An info from before the counts reads the histogram where a code has a bin of its own.
    const older = rasterInfoOf({
      ...INFO,
      bands: [band(1, { values: [0, 205], histogram: { counts: [90, 10], edges: [0, 102.5, 205] } })],
    });
    expect(codeShare(older, 1, 205)).toBeCloseTo(0.1);
  });
});
