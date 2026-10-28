import { describe, expect, it } from "vitest";

import { type RasterInfoResponse, rasterInfoOf, sampleOf, seedDomain } from "@/lib/style/raster/metadata";

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
    expect(codes).toMatchObject({ colorTable: true, integer: true, noData: undefined });
    expect(codes.tableColors).toEqual({ 1: "#ff0000", 3: "#0000ff" });
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
});
