// Rasters as the browser draws them: the raster service's value tiles colored by MapLibre's color-relief and shaded by
// its hillshade, and an image tile's opacity and resampling. The lab answers every tile address with one stored
// fixture tile, made from synthetic data by fixtures/raster/make_tiles.py, so every tile on the map is the same: the
// tile whose top left corner is at the map's center [0, 0] is the one read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompileInput } from "@/lib/style/compile/types";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { JsonObject } from "@/lib/style/json";
import type { RasterValues } from "@/lib/style/raster/values";

import contract from "../../../../../../packages/python/goatlib/tests/unit/style/fixtures/raster_color_cases.json";
import { type Rgb, WHITE, blank, distance, over, readRect } from "./checks";
import tiles from "./fixtures/raster/tiles.json";
import { type LabCase, type Scene, closeScene, renderScene } from "./scene";

/** How far a drawn channel may be from the expected one, of 255. */
const TOLERANCE = 3;
/** Where a flank of the cone is read: this share of its radius from its top, along the light's direction. */
const FLANK = 0.5;
/** How closely a pixel's tint must point toward a color (the cosine between the two, seen from the white ground). */
const MIN_TINT = 0.95;
/** The least share of a color a hillshade pixel must hold to count as drawn in it. */
const MIN_SHARE = 0.2;
/** How far a share read on the map may be from the one the light gives. */
const SHARE_TOLERANCE = 0.05;

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

/** A value tile's description as the lab knows it: the encoding make_tiles.py wrote to tiles.json. The fixtures never
 * change, and the lab's tiles exist at every zoom. */
const described = (about: Omit<RasterValues, "version" | "maxzoom">): RasterValues => ({
  ...about,
  version: "lab",
  maxzoom: 22,
});

/** The lab's tile routes, at the URL templates the compiler takes for a raster file: image tiles of colored cells, and
 * value tiles of the cone for the hillshade. */
const SOURCE = {
  type: "raster",
  id: "raster",
  tiles: `${location.origin}/lab-raster/cells/{z}/{x}/{y}.webp`,
  coverage: `${location.origin}/lab-raster/cone`,
  values: described({ encoding: tiles.cone.encoding, range: null, integer: false }),
} satisfies CompileInput["source"];

const raster = (id: string, style: JsonObject): LabCase => ({
  id,
  style: { version: 1, kind: "raster", ...style },
  // A raster has no geometry of its own: the scene asks for one.
  geometry: "polygon",
  // Tiles where a cone of the fixture's height has slopes the hillshade shades fully, and a cell is many pixels wide.
  zoom: 12,
  fields: {},
  source: SOURCE,
});

async function scene(c: LabCase): Promise<Scene> {
  const drawn = await renderScene(c);
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

/** The pixel at a point of the map, in CSS pixels. */
const pixel = (s: Scene, [x, y]: [number, number]): Rgb =>
  readRect(s, { x: Math.round(x), y: Math.round(y), w: 1, h: 1 })[0];

const near = (a: Rgb, b: Rgb) => distance(a, b) <= TOLERANCE;

/** A color at `opacity` over the white ground. */
const onGround = (color: string, opacity = 1): Rgb => over({ color }, opacity, WHITE)!.map(Math.round) as Rgb;

/** How a pixel is tinted toward a color from the white ground: the cosine between the two tints (1 when the pixel is
 * the color at some opacity over the ground) and the share of the color the pixel holds. */
function tint(drawn: Rgb, color: Rgb): { cosine: number; share: number } {
  const a = drawn.map((c, i) => WHITE[i] - c);
  const b = color.map((c, i) => WHITE[i] - c);
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const length = (v: number[]) => Math.hypot(...v);
  if (!length(a) || !length(b)) return { cosine: 0, share: 0 };
  return { cosine: dot / (length(a) * length(b)), share: dot / length(b) ** 2 };
}

/** A tint that points toward its color and holds at least MIN_SHARE of it. */
const tinted = {
  cosine: expect.toSatisfy((v: number) => v >= MIN_TINT),
  share: expect.toSatisfy((v: number) => v >= MIN_SHARE),
};

/** The top left corner of the tile read, in CSS pixels of the map. */
const origin = (s: Scene): [number, number] => {
  const { x, y } = s.map.project([0, 0]);
  return [x, y];
};

/** A compiled source's tile size: how wide each tile's picture is drawn on the map, in CSS pixels. */
const tileSize = (s: Scene, id: string): number => {
  const source = s.compiled?.sources[id] as { tileSize?: number } | undefined;
  if (typeof source?.tileSize !== "number") throw new Error(`no tile size for the source ${id}`);
  return source.tileSize;
};

describe("hillshade", () => {
  // The fixture's value tile holds one cone on flat ground; the light comes from the style's direction (degrees
  // clockwise from north), so the flank toward it faces the light and the one across the top faces away. The light
  // comes from far from both GOAT's default direction and MapLibre's, so a light that is not the style's shows. The
  // cases set the colors: the default highlight is white, which does not show on the white ground.
  const shaded = (method: string): JsonObject => ({
    render: {
      type: "hillshade",
      method,
      direction: 135,
      altitude: 60,
      shadow_color: "#1d3fbf",
      highlight_color: "#e0560d",
    },
  });

  for (const method of ["standard", "basic"]) {
    it(`${method}: draws the highlight color on the flank toward the light, the shadow color on the other`, async () => {
      const s = await scene(raster(`hillshade-${method}`, shaded(method)));
      expect(blank(s)).toBe(false);

      const render = s.style.render as JsonObject;
      const pick = <T,>(key: string) => (render[key] ?? DEFAULTS[`hillshade.${key}`]) as T;
      const direction = pick<number>("direction") * (Math.PI / 180);
      const highlight = onGround(pick("highlight_color"));
      const shadow = onGround(pick("shadow_color"));

      const [x, y] = origin(s);
      const scale = tileSize(s, SOURCE.id) / tiles.cone.size;
      const top = [x + tiles.cone.center[0] * scale, y + tiles.cone.center[1] * scale];
      const reach = tiles.cone.radius * scale * FLANK;
      // Toward the light on the map: north is up.
      const toward: [number, number] = [Math.sin(direction), -Math.cos(direction)];
      const lit = pixel(s, [top[0] + reach * toward[0], top[1] + reach * toward[1]]);
      const dark = pixel(s, [top[0] - reach * toward[0], top[1] - reach * toward[1]]);

      const litTint = tint(lit, highlight);
      const darkTint = tint(dark, shadow);
      expect({ lit, ...litTint }).toMatchObject(tinted);
      expect({ dark, ...darkTint }).toMatchObject(tinted);
      // Each flank is tinted more toward its own color than toward the other one.
      expect(litTint.cosine).toBeGreaterThan(tint(lit, shadow).cosine);
      expect(darkTint.cosine).toBeGreaterThan(tint(dark, highlight).cosine);

      const flat = pixel(s, [x + 8, y + 8]);
      if (method === "standard") {
        // The standard method leaves flat ground unshaded.
        expect(near(flat, WHITE), `flat ground ${flat}`).toBe(true);
      } else {
        // The basic method lights flat ground by the light's altitude: the highlight at 2 sin(altitude) - 1.
        const share = 2 * Math.sin(pick<number>("altitude") * (Math.PI / 180)) - 1;
        const flatTint = tint(flat, highlight);
        expect({ flat, ...flatTint }).toMatchObject(tinted);
        expect(
          Math.abs(flatTint.share - share),
          `flat ground ${flat}: share ${flatTint.share}, want ${share}`
        ).toBeLessThanOrEqual(SHARE_TOLERANCE);
      }
    });
  }
});

/** A contract case of the raster service's colors (goatlib's raster_color_cases.json): a style and cells of known
 * values with the color each is drawn in, null where none. */
interface ContractCase {
  id: string;
  style: JsonObject;
  samples: Array<{ value: number | null; color: string | null }>;
}

/** What tiles.json holds about each value tile: its encoding and the code at each sample's block (a range is a pair,
 * which JSON types as a list). */
const VALUE_TILES = tiles.values as unknown as Record<
  string,
  Omit<RasterValues, "version" | "maxzoom"> & { codes: number[] }
>;

/** The contract's cases that color values; each has a value tile, fixtures/raster/values-<id>.webp. */
const VALUE_CASES = (contract as unknown as ContractCase[]).filter((c) => c.id in VALUE_TILES);

/** A value tile's width in pixels, and its samples' blocks: each sample's cells fill a square block of BLOCK pixels,
 * BLOCKS_PER_ROW to a row from the top left, with no data around them (make_tiles.py SIZE, BLOCK, case_bands). */
const VALUE_TILE_SIZE = 256;
const BLOCK = 32;
const BLOCKS_PER_ROW = 8;

describe("value tiles colored in the browser", () => {
  it("covers every value case of the contract", () => {
    expect(VALUE_CASES.length).toBe(12);
  });

  it.each(VALUE_CASES)("$id: each sample block is drawn in its color", async (c) => {
    const { codes: _codes, ...about } = VALUE_TILES[c.id];
    const s = await scene({
      ...raster(c.id, c.style),
      source: {
        ...SOURCE,
        // The image tiles' route has no such fixture: a coloring drawn from image tiles fails to load.
        tiles: `${location.origin}/lab-raster/none/{z}/{x}/{y}.webp`,
        coverage: `${location.origin}/lab-raster/values-${c.id}`,
        values: described(about),
      },
    });
    const opacity = typeof c.style.opacity === "number" ? c.style.opacity : 1;
    const [x, y] = origin(s);
    const scale = tileSize(s, SOURCE.id) / VALUE_TILE_SIZE;
    const wrong = c.samples.flatMap((sample, k) => {
      const middle: [number, number] = [
        x + ((k % BLOCKS_PER_ROW) + 0.5) * BLOCK * scale,
        y + (Math.floor(k / BLOCKS_PER_ROW) + 0.5) * BLOCK * scale,
      ];
      const drawn = pixel(s, middle);
      const want = sample.color === null ? WHITE : onGround(sample.color, opacity);
      return near(drawn, want) ? [] : [`value ${sample.value}: drawn ${drawn}, want ${want}`];
    });
    expect(wrong).toEqual([]);
  });

  it("draws color-relief on the globe: each sample block in its color", async () => {
    const c = VALUE_CASES.find((v) => v.id === "categories")!;
    const { codes: _codes, ...about } = VALUE_TILES[c.id];
    // Below zoom 11 the globe is a sphere, not yet the flat map it turns into by zoom 12.
    const zoom = 4;
    const s = await scene({
      ...raster(`${c.id}-globe`, c.style),
      zoom,
      source: {
        ...SOURCE,
        tiles: `${location.origin}/lab-raster/none/{z}/{x}/{y}.webp`,
        coverage: `${location.origin}/lab-raster/values-${c.id}`,
        values: described(about),
      },
    });
    s.map.setProjection({ type: "globe" });
    await new Promise((done) => {
      s.map.once("idle", done);
      s.map.triggerRepaint();
    });
    expect(s.errors).toEqual([]);
    expect(s.map.getProjection()?.type).toBe("globe");
    // A pixel of the tile read (top left corner at [0, 0]) as a place, then where the globe draws it. Tiles of 256 px
    // are one zoom level above the map's.
    const n = 2 ** (zoom + 1);
    const at = ([px, py]: [number, number]): [number, number] => {
      const x = n / 2 + px / VALUE_TILE_SIZE;
      const y = n / 2 + py / VALUE_TILE_SIZE;
      const lng = (x / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
      const { x: sx, y: sy } = s.map.project([lng, lat]);
      return [sx, sy];
    };
    const opacity = typeof c.style.opacity === "number" ? c.style.opacity : 1;
    const wrong = c.samples.flatMap((sample, k) => {
      const middle = at([
        ((k % BLOCKS_PER_ROW) + 0.5) * BLOCK,
        (Math.floor(k / BLOCKS_PER_ROW) + 0.5) * BLOCK,
      ]);
      const drawn = pixel(s, middle);
      const want = sample.color === null ? WHITE : onGround(sample.color, opacity);
      return near(drawn, want) ? [] : [`value ${sample.value}: drawn ${drawn}, want ${want}`];
    });
    expect(wrong).toEqual([]);
  });
});

describe("raster image", () => {
  /** A cell of the RGB fixture on the map, in CSS pixels: the tile's picture is drawn over the whole tile. */
  const cellSize = (s: Scene) => tileSize(s, SOURCE.id) / tiles.cells.length;
  const cell = (column: number, line: number) => onGround(tiles.cells[line][column]);

  /** The middle of the fixture's cell at `column`, `line`. */
  const cellMiddle = (s: Scene, column: number, line: number): [number, number] => {
    const [x, y] = origin(s);
    return [x + cellSize(s) * (column + 0.5), y + cellSize(s) * (line + 0.5)];
  };

  it("draws a cell's color at the style's opacity over the ground", async () => {
    const s = await scene(raster("raster-opacity", { render: { type: "image" }, opacity: 0.6 }));
    const opacity = s.style.opacity as number;
    for (const [column, line] of [
      [0, 0],
      [1, 0],
      [2, 3],
    ] as const) {
      const drawn = pixel(s, cellMiddle(s, column, line));
      const want = onGround(tiles.cells[line][column], opacity);
      expect(near(drawn, want), `cell ${column},${line}: drawn ${drawn}, want ${want}`).toBe(true);
    }
  });

  /** The pixels along the row through the middle of the first cells, from the middle of cell 0 to that of cell 1, and
   * how many of them lie before the edge between the two. */
  const acrossEdge = (s: Scene): { pixels: Rgb[]; edge: number } => {
    const [x, y] = cellMiddle(s, 0, 0);
    const pixels = readRect(s, { x: Math.round(x), y: Math.round(y), w: Math.round(cellSize(s)), h: 1 });
    return { pixels, edge: (pixels.length * (cellSize(s) / 2)) / Math.round(cellSize(s)) };
  };

  it("nearest keeps hard cell edges: the pixels on each side of an edge keep their own cell's color", async () => {
    const s = await scene(raster("raster-nearest", { render: { type: "image" }, resampling: "nearest" }));
    const { pixels, edge } = acrossEdge(s);
    const [a, b] = [cell(0, 0), cell(1, 0)];
    const wrong = pixels
      .map((drawn, i) => ({ i, drawn, want: i < edge ? a : b }))
      .filter(({ drawn, want }) => !near(drawn, want));
    expect(wrong).toEqual([]);
  });

  it("linear resampling (the default) blends the colors across a cell edge", async () => {
    const s = await scene(raster("raster-linear", { render: { type: "image" } }));
    const { pixels } = acrossEdge(s);
    const [a, b] = [cell(0, 0), cell(1, 0)];
    // Between the two cells' middles, most pixels are a blend of the two colors, neither one.
    const blended = pixels.filter((drawn) => !near(drawn, a) && !near(drawn, b));
    expect(blended.length).toBeGreaterThan(pixels.length / 2);
    // The ends keep the cells' own colors.
    expect(near(pixels[0], a)).toBe(true);
    expect(near(pixels[pixels.length - 1], b)).toBe(true);
  });
});

it("a case with its own source and groups of points is an error: the scene places no points", async () => {
  const s = await renderScene({
    ...raster("source-and-groups", { render: { type: "image" } }),
    groups: [{ at: [100, 100], points: [{}] }],
  });
  scenes.push(s);
  expect(s.errors).toEqual(["scene: a case with its own source places no groups of points"]);
});
