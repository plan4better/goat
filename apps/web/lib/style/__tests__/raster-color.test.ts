import { describe, expect, it } from "vitest";

import { rasterColorSpec } from "@/lib/style/raster/color";

describe("rasterColorSpec", () => {
  it("an image is the file as it is unless it names its bands", () => {
    expect(rasterColorSpec({ type: "image" })).toEqual({ kind: "rgb", bands: null, noData: [] });
    expect(rasterColorSpec({ type: "image", bands: [1, 2, 3] })).toEqual({
      kind: "rgb",
      bands: [1, 2, 3],
      noData: [],
    });
    expect(rasterColorSpec({ type: "image", bands: [4, 1, 2] })).toEqual({
      kind: "rgb",
      bands: [4, 1, 2],
      noData: [],
    });
  });

  it("an image carries the style's no-data values", () => {
    expect(rasterColorSpec({ type: "image", no_data: { values: [0] } })).toEqual({
      kind: "rgb",
      bands: null,
      noData: [0],
    });
  });

  it("a formula is its expression, a missing domain is null, shading without a palette has no coloring", () => {
    expect(
      rasterColorSpec({ type: "continuous", band: { name: "NDVI", expression: "(b4 - b1)" }, domain: [0, 1] })
    ).toMatchObject({ kind: "ramp", band: "(b4 - b1)", domain: [0, 1] });
    expect(rasterColorSpec({ type: "continuous" })).toMatchObject({ kind: "ramp", domain: null });
    expect(rasterColorSpec({ type: "hillshade" })).toBeNull();
  });

  it("resolves palettes, reverse, class colors from the palette's variant and the style's no data", () => {
    const spec = rasterColorSpec({
      type: "continuous",
      band: 2,
      palette: ["#000000", "#ffffff"],
      reverse: true,
      domain: [0, 10],
      outside: "hide",
      no_data: { values: [-1] },
    });
    expect(spec).toEqual({
      kind: "ramp",
      band: 2,
      noData: [-1],
      colors: ["#ffffff", "#000000"],
      domain: [0, 10],
      outside: "hide",
    });
    const classes = rasterColorSpec({
      type: "hillshade",
      palette: "colorbrewer:BuGn",
      domain: [0, 30],
      classify: {
        method: "manual",
        classes: [{ to: 10 }, { from: 10, to: 20, visible: false }, { from: 20, color: "#123456" }],
      },
    });
    expect(classes).toEqual({
      kind: "classes",
      band: 1,
      noData: [],
      classes: [
        { to: 10, color: "#e5f5f9" },
        { from: 10, to: 20, color: null },
        { from: 20, color: "#123456" },
      ],
      domain: null,
      outside: "clamp",
    });
    // Values outside left out: the classes carry their own outer ends and the range they end at otherwise; with the end
    // colors, the outer ends are left out (the first and last class are open).
    const ends = {
      type: "continuous",
      palette: ["#000000", "#ffffff"],
      computed: { domain: [-5, 40] },
      classify: {
        method: "manual",
        classes: [
          { from: 2, to: 10 },
          { from: 10, to: 30 },
        ],
      },
    };
    expect(rasterColorSpec({ ...ends, outside: "hide" })).toMatchObject({
      classes: [
        { from: 2, to: 10 },
        { from: 10, to: 30 },
      ],
      domain: [-5, 40],
      outside: "hide",
    });
    expect(rasterColorSpec(ends)).toMatchObject({
      classes: [{ to: 10 }, { from: 10 }],
      domain: null,
      outside: "clamp",
    });
    // One computed class (geometric intervals over values at or below 0): drawn as that class, not as the ramp.
    expect(
      rasterColorSpec({
        type: "continuous",
        palette: ["#000000", "#ffffff"],
        classify: { method: "geometric_interval", count: 5, classes: [{}], computed: { at: "t", data: "x" } },
      })
    ).toMatchObject({ kind: "classes", classes: [{ color: "#777777" }] });
    // Classes listed by position the server stamped without bounds (a band without values): the ramp stands in.
    expect(
      rasterColorSpec({
        type: "continuous",
        palette: ["#000000", "#ffffff"],
        classify: { method: "quantile", count: 3, classes: [{}, {}, {}], computed: { at: "t", data: "x" } },
      })
    ).toMatchObject({ kind: "ramp" });
    expect(rasterColorSpec({ type: "continuous", domain: [0, 1] })).toMatchObject({
      kind: "ramp",
      colors: expect.any(Array),
    });
    expect(
      rasterColorSpec({
        type: "categorical",
        classes: [
          { value: 1, color: "#ff0000" },
          { value: 2 },
          { value: 3, color: "#00ff00", visible: false },
        ],
      })
    ).toEqual({
      kind: "categories",
      band: 1,
      noData: [],
      classes: [
        { value: 1, color: "#ff0000" },
        { value: 2, color: "#9aa3ad" },
        { value: 3, color: null },
      ],
      other: null,
    });
  });
});
