import { describe, expect, it } from "vitest";

import { catalogSampleLayer } from "@/lib/catalog/style";

/**
 * The catalog preview draws its sample with the dataset's own style through the same compiler as every map, so a
 * preview cannot diverge from the layer it becomes once added. What is pinned here is the boundary: only a GOAT Style
 * document reaches the compiler, and anything else falls back to the plain footprint rendering.
 */

const sample: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [7, 50] }, properties: { measure: 3 } },
    { type: "Feature", geometry: { type: "Point", coordinates: [8, 51] }, properties: { measure: 9 } },
  ],
};

const STYLE = { version: 1, kind: "vector", symbol: { marker: { color: "#66c2a5" } } };

describe("catalogSampleLayer", () => {
  it("draws the sample with the dataset's style, features numbered for the highlight", () => {
    const layer = catalogSampleLayer(STYLE, "point", sample);
    expect(layer?.style).toEqual(STYLE);
    expect(layer?.geometry).toBe("point");
    expect(layer?.source.type).toBe("points");
    const data = (layer?.source as { data: GeoJSON.FeatureCollection }).data;
    expect(data.features.map((f) => f.id)).toEqual([1, 2]);
    expect(catalogSampleLayer(STYLE, "point", sample, 2)?.highlight).toBe(2);
  });

  it("a catalog style without version 1 falls back to the footprint", () => {
    // Today's layer properties, which the catalog served before it upgraded styles on read.
    expect(catalogSampleLayer({ color: [102, 194, 165], filled: true }, "point", sample)).toBeUndefined();
    expect(catalogSampleLayer(undefined, "point", sample)).toBeUndefined();
    expect(catalogSampleLayer(STYLE, undefined, sample)).toBeUndefined();
    expect(catalogSampleLayer(STYLE, "raster", sample)).toBeUndefined();
    expect(catalogSampleLayer(STYLE, "point", null)).toBeUndefined();
  });
});
