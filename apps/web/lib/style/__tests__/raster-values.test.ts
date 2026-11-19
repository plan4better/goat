// Value tiles colored in the browser: the color-relief stops of a coloring, placed on the codes of a value tile
// (goatlib.raster.values), checked against the shared raster color contract
// (packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json) and the codes goatlib's encoder gave
// each of its samples (lab/fixtures/raster/tiles.json, written by make_tiles.py).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { type JsonObject, isObject } from "@/lib/style/json";
import { type RasterColorSpec, rasterColorSpec } from "@/lib/style/raster/color";
import {
  MAX_Q,
  MAX_RELIEF_STOPS,
  type RasterValues,
  type ReliefStop,
  linear,
  rasterValuesOf,
  reliefColor,
  reliefStops,
  resamplingOf,
  valueQuery,
  valueTilesUrl,
  valuesUrl,
} from "@/lib/style/raster/values";

interface Sample {
  value: number | null;
  color: string | null;
}

interface Case {
  id: string;
  style: JsonObject;
  samples: Sample[];
}

interface ValueTile {
  encoding: RasterValues["encoding"];
  range: [number, number] | null;
  integer: boolean;
  codes: number[];
}

const CASES = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../../packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json"
    ),
    "utf8"
  )
) as Case[];
const TILES = JSON.parse(readFileSync(resolve(__dirname, "lab/fixtures/raster/tiles.json"), "utf8")) as {
  values: Record<string, ValueTile>;
};

/** The largest difference per channel (0 to 255) a sample's color may have, as in the contract test. */
const TOLERANCE = 2;

/** The value cases of the contract with their tiles' encodings. */
const VALUE_CASES = CASES.filter((c) => c.id in TILES.values).map((c) => {
  const { codes, ...tile } = TILES.values[c.id];
  return { ...c, codes, values: { ...tile, version: "1-e1" } as RasterValues };
});

/** An encoding of `base + q * step`, as goatlib writes its factors. */
const encoded = (
  base: number,
  step: number,
  range: [number, number] | null,
  integer = false
): RasterValues => ({
  encoding: { redFactor: 65536 * step, greenFactor: 256 * step, blueFactor: step, baseShift: -base },
  range,
  integer,
  version: "1-e1",
});

/** The code goatlib's encoder stores a value at (numpy's rint, halves to even). */
const codeOf = (values: RasterValues, v: number): number => {
  const x = (v + values.encoding.baseShift) / values.encoding.blueFactor;
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

const coloring = (render: JsonObject) => rasterColorSpec(render) as Exclude<RasterColorSpec, { kind: "rgb" }>;

const rgba = (color: string): number[] => {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
  if (!m) throw new Error(`Not an rgba color: ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
};

const hexRgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The color the shader gives a cell of code `q`: the stops around it found by binary search and blended linearly;
 * below the first and above the last stop their colors hold. */
function colorAt(stops: ReliefStop[], q: number): number[] {
  if (q <= stops[0][0]) return rgba(stops[0][1]);
  const last = stops[stops.length - 1];
  if (q >= last[0]) return rgba(last[1]);
  let l = 0;
  let r = stops.length - 1;
  while (r - l > 1) {
    const m = (l + r) >> 1;
    if (q < stops[m][0]) r = m;
    else l = m;
  }
  const t = (q - stops[l][0]) / (stops[r][0] - stops[l][0]);
  const a = rgba(stops[l][1]);
  const b = rgba(stops[r][1]);
  return a.map((v, i) => v + (b[i] - v) * t);
}

/** What is wrong with the color at code `q` for a sample of `color` (null: transparent), or null. */
function problem(stops: ReliefStop[], q: number, color: string | null): string | null {
  const got = colorAt(stops, q);
  const shown = `rgba(${got.map((v) => Number(v.toFixed(2))).join(", ")})`;
  if (color === null) return got[3] === 0 ? null : `code ${q} is ${shown}, expected transparent`;
  const want = hexRgb(color);
  const near = got[3] === 1 && want.every((v, i) => Math.abs(v - got[i]) <= TOLERANCE);
  return near ? null : `code ${q} is ${shown}, expected ${color}`;
}

/** A code's value as the shader decodes it: `R * redFactor + G * greenFactor + B * blueFactor - baseShift`, a dot
 * product of float32 numbers. */
function shaderValue(values: RasterValues, q: number): number {
  const f = Math.fround;
  const { redFactor, greenFactor, blueFactor, baseShift } = values.encoding;
  const products = [
    f((q >> 16) * f(redFactor)),
    f(((q >> 8) & 255) * f(greenFactor)),
    f((q & 255) * f(blueFactor)),
    f(-1 * f(baseShift)),
  ];
  return products.reduce((sum, p) => f(sum + p), 0);
}

describe("value tiles", () => {
  it("asks for values of the band or formula, sharp for color scales, none for images", () => {
    const query = (style: JsonObject) => valueQuery({ version: 1, kind: "raster", ...style });
    expect(query({})).toBeNull();
    expect(query({ render: { type: "image", bands: [3, 2, 1] } })).toBeNull();
    // Categories without classes draw the file's own colors.
    expect(query({ render: { type: "categorical" } })).toBeNull();
    expect(query({ render: { type: "features" } })).toBeNull();
    expect(query({ render: { type: "continuous", palette: "goat:elevation" } })).toEqual({
      band: 1,
      resampling: "nearest",
    });
    expect(query({ render: { type: "continuous", band: 3 } })).toEqual({ band: 3, resampling: "nearest" });
    expect(
      query({ render: { type: "continuous", band: { name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" } } })
    ).toEqual({ formula: "(b4 - b1) / (b4 + b1)", resampling: "nearest" });
    const categories = { type: "categorical", classes: [{ value: 1, color: "#4a90c2" }] };
    expect(query({ render: categories })).toEqual({ band: 1, resampling: "nearest" });
    expect(query({ resampling: "linear", render: categories })).toEqual({ band: 1, resampling: "bilinear" });
    expect(query({ resampling: "linear", render: { type: "continuous" } })).toEqual({
      band: 1,
      resampling: "bilinear",
    });
    // Hillshade reads smooth values, with or without colors, unless the style says nearest.
    expect(query({ render: { type: "hillshade" } })).toEqual({ band: 1, resampling: "bilinear" });
    expect(query({ render: { type: "hillshade", palette: "goat:elevation" } })).toEqual({
      band: 1,
      resampling: "bilinear",
    });
    expect(query({ resampling: "nearest", render: { type: "hillshade" } })).toEqual({
      band: 1,
      resampling: "nearest",
    });
  });

  it("draws color scales crisp and images and shading alone smooth, unless the style says otherwise", () => {
    const of = (style: JsonObject) => resamplingOf({ version: 1, kind: "raster", ...style });
    expect(of({ render: { type: "continuous" } })).toBe("nearest");
    expect(of({ render: { type: "categorical" } })).toBe("nearest");
    expect(of({ render: { type: "hillshade", palette: "goat:elevation" } })).toBe("nearest");
    expect(of({ render: { type: "hillshade" } })).toBe("linear");
    expect(of({ render: { type: "image" } })).toBe("linear");
    expect(of({})).toBe("linear");
    expect(of({ resampling: "linear", render: { type: "continuous" } })).toBe("linear");
    expect(of({ resampling: "nearest", render: { type: "image" } })).toBe("nearest");
  });

  it("names the tileset description and the tiles of a band or formula", () => {
    const coverage = "https://geo/collections/d1/coverage/tiles/WebMercatorQuad";
    expect(valuesUrl(coverage, { band: 2, resampling: "nearest" }, "7")).toBe(
      `${coverage}?band=2&resampling=nearest&v=7`
    );
    expect(valuesUrl(coverage, { formula: "b1 + b2", resampling: "bilinear" })).toBe(
      `${coverage}?formula=b1%20%2B%20b2&resampling=bilinear`
    );
    const values = encoded(99.5, 2 ** -12, [100, 400]);
    expect(valueTilesUrl(coverage, { band: 1, resampling: "bilinear" }, values)).toBe(
      `${coverage}/{z}/{y}/{x}?f=webp&band=1&resampling=bilinear&base=99.5&step=0.000244140625&v=1-e1`
    );
  });

  it("the tile URL carries base and step from the encoding: the URL alone names its tile", () => {
    const coverage = "https://geo/collections/d1/coverage/tiles/WebMercatorQuad";
    const values = encoded(-6.000003814697266, 3.814697265625e-6, [-5, 5]);
    const url = new URL(
      valueTilesUrl(coverage, { formula: "b2 - b1", resampling: "nearest" }, values).replace(
        "{z}/{y}/{x}",
        "0/0/0"
      )
    );
    expect([...url.searchParams.keys()]).toEqual(["f", "formula", "resampling", "base", "step", "v"]);
    expect(Number(url.searchParams.get("base"))).toBe(-values.encoding.baseShift);
    expect(Number(url.searchParams.get("step"))).toBe(values.encoding.blueFactor);
    expect(url.searchParams.get("formula")).toBe("b2 - b1");
  });

  it("reads the tileset description; a malformed one is none", () => {
    const description = {
      title: "d1 values",
      dataType: "coverage",
      maxzoom: 14,
      links: [{ rel: "item", type: "image/webp", templated: true, href: "https://geo/x" }],
      "goat:values": {
        encoding: { redFactor: 16, greenFactor: 0.0625, blueFactor: 0.000244140625, baseShift: -95.5 },
        range: [100, 400],
        integer: false,
        version: "abc-e1",
      },
    };
    expect(rasterValuesOf(description)).toEqual({
      encoding: { redFactor: 16, greenFactor: 0.0625, blueFactor: 0.000244140625, baseShift: -95.5 },
      range: [100, 400],
      integer: false,
      version: "abc-e1",
      maxzoom: 14,
    });
    // An unknown native zoom: the source has none.
    for (const maxzoom of [null, undefined]) {
      const values = rasterValuesOf({ ...description, maxzoom });
      expect(values).not.toBeNull();
      expect(values).not.toHaveProperty("maxzoom");
    }
    const goat = description["goat:values"];
    expect(rasterValuesOf({ ...description, "goat:values": { ...goat, range: null } })?.range).toBeNull();
    for (const broken of [
      null,
      "text",
      { ...description, "goat:values": undefined },
      { ...description, "goat:values": { ...goat, encoding: { ...goat.encoding, blueFactor: 0 } } },
      { ...description, "goat:values": { ...goat, encoding: { ...goat.encoding, redFactor: "16" } } },
      { ...description, "goat:values": { ...goat, range: [100] } },
      { ...description, "goat:values": { ...goat, integer: "no" } },
      { ...description, "goat:values": { ...goat, version: undefined } },
    ])
      expect(rasterValuesOf(broken)).toBeNull();
  });

  it("covers every value case of the contract", () => {
    expect(VALUE_CASES.length).toBe(12);
  });

  it("places every contract case's colors on its codes", () => {
    const wrong: string[] = [];
    for (const c of VALUE_CASES) {
      const render = isObject(c.style.render) ? c.style.render : {};
      const stops = reliefStops(coloring(render), c.values);
      if (!stops) {
        wrong.push(`${c.id}: no stops`);
        continue;
      }
      c.samples.forEach((sample, i) => {
        const found = problem(stops, c.codes[i], sample.color);
        if (found) wrong.push(`${c.id}, value ${sample.value}: ${found}`);
      });
    }
    expect(wrong).toEqual([]);
  });

  it("starts with transparent no data at code 0 and never puts two stops on one code", () => {
    for (const c of VALUE_CASES) {
      const stops = reliefStops(coloring(c.style.render as JsonObject), c.values) as ReliefStop[];
      expect([c.id, stops[0]]).toEqual([c.id, [0, "rgba(0, 0, 0, 0)"]]);
      for (let i = 1; i < stops.length; i++) {
        expect(Number.isInteger(stops[i][0])).toBe(true);
        expect([c.id, stops[i][0] > stops[i - 1][0]]).toEqual([c.id, true]);
      }
      expect(stops[stops.length - 1][0]).toBeLessThanOrEqual(MAX_Q);
    }
  });

  it("a constant band's ramp draws its first color", () => {
    const render = { type: "continuous", palette: ["#ff0000", "#0000ff"] };
    for (const values of [encoded(6.9, 2 ** -20, [7, 7]), encoded(-1, 1, [7, 7], true)]) {
      const stops = reliefStops(coloring(render), values) as ReliefStop[];
      expect(problem(stops, codeOf(values, 7), "#ff0000")).toBeNull();
    }
  });

  it("colors each code of a ramp or stops narrower than a few codes as the service does", () => {
    // Whole numbers stored exactly: breakpoints between two codes. The colors are goatlib's colorize for the values 0
    // to 3 (its ramp is a 256-color lookup: 0, 85, 170 and 255 hit the palette's colors 0, 2, 4 and 6).
    const values = encoded(-1, 1, [0, 10], true);
    const palette = ["#000000", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ffffff"];
    const ramp = reliefStops(
      coloring({ type: "continuous", palette, domain: [0, 3] }),
      values
    ) as ReliefStop[];
    const stops = reliefStops(
      coloring({
        type: "continuous",
        stops: [
          { value: 0, color: "#ff0000" },
          { value: 2.5, color: "#00ff00" },
          { value: 3, color: "#0000ff" },
        ],
      }),
      values
    ) as ReliefStop[];
    const colors = (relief: ReliefStop[]) =>
      [0, 1, 2, 3].map((v) => colorAt(relief, codeOf(values, v)).map((x) => Number(x.toFixed(2))));
    expect(colors(ramp)).toEqual([
      [0, 0, 0, 1],
      [0, 255, 0, 1],
      [255, 255, 0, 1],
      [255, 255, 255, 1],
    ]);
    expect(colors(stops)).toEqual([
      [255, 0, 0, 1],
      [153, 102, 0, 1],
      [51, 204, 0, 1],
      [0, 0, 255, 1],
    ]);
    // Breakpoints on whole codes keep one stop each.
    const whole = reliefStops(
      coloring({ type: "continuous", palette: ["#000000", "#ffffff"], domain: [0, 3] }),
      values
    );
    expect(whole).toEqual([
      [0, "rgba(0, 0, 0, 0)"],
      [1, "rgba(0, 0, 0, 1)"],
      [4, "rgba(255, 255, 255, 1)"],
      [MAX_Q, "rgba(255, 255, 255, 1)"],
    ]);
  });

  it("keeps the knots of positions closer than a code in order", () => {
    const positions = [1, 4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3];
    const knots = linear(positions.map((p, i) => [p, [i * 40, 0, 0, 1]]));
    expect(knots.map(([q]) => q)).toEqual([1, 2, 3, MAX_Q]);
  });

  it("two colors on one value jump there, the later from that value on, as the service does", () => {
    // Whole numbers stored exactly. The colors are goatlib's colorize for the values listed (numpy's interp takes the
    // last of two stops on one value).
    const values = encoded(-1, 1, [0, 30], true);
    const colorsAt = (stops: Array<[number, string]>, at: number[]) => {
      const relief = reliefStops(
        coloring({ type: "continuous", stops: stops.map(([value, color]) => ({ value, color })) }),
        values
      ) as ReliefStop[];
      return at.map((v) => colorAt(relief, codeOf(values, v)).map((x) => Math.round(x)));
    };
    const RED = [255, 0, 0, 1];
    const BLUE = [0, 0, 255, 1];
    const at = [0, 5, 9, 10, 11, 15, 19, 20, 21];
    expect(
      colorsAt(
        [
          [0, "#ff0000"],
          [10, "#ff0000"],
          [10, "#0000ff"],
          [20, "#0000ff"],
        ],
        at
      )
    ).toEqual([RED, RED, RED, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]);
    const ramps = colorsAt(
      [
        [0, "#000000"],
        [10, "#ff0000"],
        [10, "#00ff00"],
        [20, "#0000ff"],
      ],
      at.slice(0, 8)
    );
    const service = [
      [0, 0, 0],
      [128, 0, 0],
      [230, 0, 0],
      [0, 255, 0],
      [0, 230, 26],
      [0, 128, 128],
      [0, 26, 230],
      [0, 0, 255],
    ];
    ramps.forEach((got, i) =>
      expect([at[i], got.slice(0, 3).every((x, k) => Math.abs(x - service[i][k]) <= 1), got[3]]).toEqual([
        at[i],
        true,
        1,
      ])
    );
  });

  it("clips a domain wider than the data to the end codes", () => {
    // The codes hold 0 to 1024; the domain reaches far beyond on both sides.
    const values = encoded(-(2 ** -14), 2 ** -14, [0, 1000]);
    for (const outside of ["clamp", "hide"]) {
      const render = { type: "continuous", palette: ["#000000", "#ffffff"], domain: [-1000, 3000], outside };
      const stops = reliefStops(coloring(render), values) as ReliefStop[];
      expect(stops.every(([q]) => q >= 0 && q <= MAX_Q)).toBe(true);
      for (const v of [0, 250, 500, 1000]) {
        const grey = (255 * (v + 1000)) / 4000;
        const got = colorAt(stops, codeOf(values, v));
        expect([outside, v, got.slice(0, 3).every((x) => Math.abs(x - grey) <= 1), got[3]]).toEqual([
          outside,
          v,
          true,
          1,
        ]);
      }
    }
  });

  it("hides what lies outside a domain inside the data", () => {
    const values = encoded(-(2 ** -14), 2 ** -14, [0, 1000]);
    const render = {
      type: "continuous",
      palette: ["#000000", "#ffffff"],
      domain: [200, 600],
      outside: "hide",
    };
    const stops = reliefStops(coloring(render), values) as ReliefStop[];
    expect(problem(stops, codeOf(values, 199.99), null)).toBeNull();
    expect(problem(stops, codeOf(values, 200), "#000000")).toBeNull();
    expect(problem(stops, codeOf(values, 600), "#ffffff")).toBeNull();
    expect(problem(stops, codeOf(values, 600.01), null)).toBeNull();
  });

  it("gives up past 4096 stops", () => {
    // Categories apart from each other take four stops each on a float encoding.
    const values = encoded(-1, 2 ** -10, [0, 2400]);
    const categories = (n: number) =>
      coloring({
        type: "categorical",
        classes: Array.from({ length: n }, (_, i) => ({
          value: 2 * i,
          color: i % 2 ? "#ff0000" : "#0000ff",
        })),
      });
    const fitting = reliefStops(categories(1000), values);
    expect(fitting).not.toBeNull();
    expect((fitting as ReliefStop[]).length).toBeLessThanOrEqual(MAX_RELIEF_STOPS);
    expect(reliefStops(categories(1100), values)).toBeNull();
  });

  it("decodes stop positions back to their codes", () => {
    for (const c of VALUE_CASES) {
      const stops = reliefStops(coloring(c.style.render as JsonObject), c.values) as ReliefStop[];
      const expression = reliefColor(stops, c.values);
      expect(expression.slice(0, 3)).toEqual(["interpolate", ["linear"], ["elevation"]]);
      const { baseShift, blueFactor } = c.values.encoding;
      // MapLibre packs each stop's elevation with the source's encoding (packDEMData).
      const packed = stops.map((_, i) =>
        Math.round(((expression[3 + 2 * i] as number) + baseShift) / blueFactor)
      );
      expect([c.id, packed]).toEqual([c.id, stops.map(([q]) => q)]);
      expect([c.id, stops.map((_, i) => expression[4 + 2 * i])]).toEqual([
        c.id,
        stops.map(([, color]) => color),
      ]);
    }
  });

  it("keeps stops apart where float32 no longer tells neighboring codes apart", () => {
    // Elevations of 500 to 600: the codes reach about 8,700, and above 8,192 float32 holds two codes as one value.
    const values = encoded(490 - 2 ** -11, 2 ** -11, [500, 600]);
    let edge = 8600;
    while (shaderValue(values, codeOf(values, edge) - 1) !== shaderValue(values, codeOf(values, edge)))
      edge += 2 ** -11;
    const render = {
      type: "continuous",
      palette: ["#ff0000", "#0000ff"],
      classify: {
        method: "manual",
        classes: [
          { to: edge, color: "#ff0000" },
          { from: edge, color: "#0000ff" },
        ],
      },
    };
    const stops = reliefStops(coloring(render), values) as ReliefStop[];
    for (let i = 1; i < stops.length; i++)
      expect(shaderValue(values, stops[i][0])).toBeGreaterThan(shaderValue(values, stops[i - 1][0]));
    // The later stop keeps its place: the class from the edge on starts there, and the cells below stay red.
    expect(stops.some(([q, color]) => q === codeOf(values, edge) && color === "rgba(0, 0, 255, 1)")).toBe(
      true
    );
    for (const v of [500, 550, 600, 8000]) expect(problem(stops, codeOf(values, v), "#ff0000")).toBeNull();
    expect(problem(stops, codeOf(values, edge), "#0000ff")).toBeNull();
    // Every contract case too.
    for (const c of VALUE_CASES) {
      const own = reliefStops(coloring(c.style.render as JsonObject), c.values) as ReliefStop[];
      for (let i = 1; i < own.length; i++)
        expect([c.id, shaderValue(c.values, own[i][0]) > shaderValue(c.values, own[i - 1][0])]).toEqual([
          c.id,
          true,
        ]);
    }
  });
});
