// Rasters as the browser draws them: the raster service's value tiles colored by MapLibre's color-relief and shaded by
// its hillshade, and an image tile's opacity and resampling. The lab answers every tile address with one stored
// fixture tile, made from synthetic data by fixtures/raster/make_tiles.py, so every tile on the map is the same: the
// tile whose top left corner is at the map's center [0, 0] is the one read. Most fixtures are 256 px tiles, drawn at
// their own width so a whole tile fits the lab's map; a few are 512 px tiles drawn at the compiler's own tile size.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompileInput } from "@/lib/style/compile/types";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { JsonObject } from "@/lib/style/json";
import { paletteOf } from "@/lib/style/raster/metadata";
import {
  type TileValueDeps,
  browserReaders,
  decodeWith,
  tileUnder,
  tileValueAt,
  valueTileOptions,
} from "@/lib/style/raster/tileValues";
import { type RasterTileset, type RasterValues, valueTilesUrl } from "@/lib/style/raster/values";

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

/** The cone on flat land: the same tiles decoded 32 times lower (a power of two, so exactly), 47 m high on a radius of
 * about 1.8 km. Its description gives the range, as geoapi's does. */
const FLAT = 32;
const FLAT_SOURCE = {
  ...SOURCE,
  values: described({
    encoding: Object.fromEntries(
      Object.entries(tiles.cone.encoding).map(([key, v]) => [key, v / FLAT])
    ) as RasterValues["encoding"],
    range: [0, tiles.cone.height / FLAT],
    integer: false,
  }),
} satisfies CompileInput["source"];

/** The width of the lab's raster fixture tiles (make_tiles.py SIZE). */
const FIXTURE_TILE_SIZE = 256;

const raster = (id: string, style: JsonObject, source: CompileInput["source"] = SOURCE): LabCase => ({
  id,
  style: { version: "1.0.0", kind: "raster", ...style },
  // A raster has no geometry of its own: the scene asks for one.
  geometry: "polygon",
  // Tiles where a cone of the fixture's height has slopes the hillshade shades fully, and a cell is many pixels wide.
  zoom: 12,
  fields: {},
  source,
  tileSize: FIXTURE_TILE_SIZE,
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

// The fixture's value tile holds one cone on flat ground; the light comes from the style's direction (degrees clockwise
// from north), so the flank toward it faces the light and the one across the top faces away. The light comes from far
// from both GOAT's default direction and MapLibre's, so a light that is not the style's shows. The cases set the colors:
// the default highlight is white, which does not show on the white ground.
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

describe("hillshade", () => {
  const cases = [
    ["standard", SOURCE],
    ["basic", SOURCE],
    // Flat land is raised before MapLibre shades it, at the style's default strength.
    ["standard", FLAT_SOURCE],
  ] as const;
  for (const [method, source] of cases) {
    const flatLand = source === FLAT_SOURCE ? " on flat land" : "";
    it(`${method}${flatLand}: draws the highlight color on the flank toward the light, the shadow color on the other`, async () => {
      const s = await scene(raster(`hillshade-${method}${flatLand ? "-flat" : ""}`, shaded(method), source));
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
    expect(VALUE_CASES.length).toBe(17);
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

describe("values read from value tiles", () => {
  const c = VALUE_CASES.find((v) => v.id === "categories")!;
  const { codes, ...about } = VALUE_TILES[c.id];
  const values = described(about);
  // The middle of each sample's block on the tile whose top left corner is at [0, 0], as a place at zoom 12.
  const zoom = 12;
  const n = 2 ** zoom;
  const tile = { z: zoom, x: n / 2, y: n / 2 };
  const places = c.samples.map((_, k) => {
    const x = n / 2 + ((k % BLOCKS_PER_ROW) + 0.5) * (BLOCK / VALUE_TILE_SIZE);
    const y = n / 2 + (Math.floor(k / BLOCKS_PER_ROW) + 0.5) * (BLOCK / VALUE_TILE_SIZE);
    return {
      lng: (x / n) * 360 - 180,
      lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    };
  });
  // A sample of the file's no data has code 0 in the tile: no value.
  const want = c.samples.map((sample, k) => (codes[k] === 0 ? null : sample.value));

  /** Each sample's value read on the 256 px tile and on the 512 px one, which covers the same area at twice the
   * resolution; `reader` names the read, so its tiles are not the ones another read kept. */
  async function readSamples(reader: string, deps?: Partial<TileValueDeps>) {
    expect(want).toContain(null);
    for (const fixture of [`values-${c.id}`, `values-${tiles.large.size}-${c.id}`]) {
      const template = `${valueTilesUrl(
        `${location.origin}/lab-raster/${fixture}`,
        { band: 1, resampling: "nearest" },
        values
      )}&reader=${reader}`;
      const read = await Promise.all(places.map((at) => tileValueAt(values, template, at, tile, deps)));
      expect(read, `${fixture}, ${reader}`).toEqual(want);
    }
  }

  it("decodes a value tile in the browser", async () => {
    // The lab's browser reads a canvas back exactly: the default reads through one.
    expect(browserReaders.canvasExact()).toBe(true);
    await readSamples("default");
  });

  it("decodes a value tile through a video frame as through the canvas", async () => {
    // As where the canvas adds noise.
    await readSamples("video-frame", { decode: decodeWith({ ...browserReaders, canvasExact: () => false }) });
  });

  /** A scene of the 512 px value tiles, as the compiler asks for them and as the options of the tiles read are. */
  const valueScene = (id: string) =>
    scene({
      ...raster(`${c.id}-${id}`, c.style),
      tileSize: undefined,
      source: {
        ...SOURCE,
        tiles: `${location.origin}/lab-raster/none/{z}/{x}/{y}.webp`,
        coverage: `${location.origin}/lab-raster/values-${tiles.large.size}-${c.id}`,
        values,
      },
    });

  const settled = (s: Scene) =>
    new Promise((done) => {
      s.map.once("idle", done);
      s.map.triggerRepaint();
    });

  /** The tile under points from the bottom of the map, near the camera, to its top, far away: each one a tile the map
   * drew for the value source, read at its own zoom. Gives the drawn tiles and the tiles found, as `z/x/y`. */
  async function readsDrawnTiles(s: Scene): Promise<{ drawn: Set<string>; found: string[] }> {
    const template = (s.compiled?.sources[SOURCE.id] as { tiles: string[] }).tiles[0];
    const drawn = new Set(
      s.map.style.tileManagers[SOURCE.id]
        .getVisibleCoordinates()
        .map(({ canonical: { z, x, y } }) => `${z}/${x}/${y}`)
    );
    const { clientWidth: width, clientHeight: height } = s.map.getContainer();
    const points = Array.from({ length: 24 }, (_, k) =>
      s.map.unproject([width / 2, height - 4 - (k * (height - 8)) / 23])
    );
    const tilesUnder = points.map((at) => tileUnder(s.map, valueTileOptions(values), at));
    // The lower half of the map is all ground.
    expect(tilesUnder.slice(0, 12)).not.toContain(null);
    const found = tilesUnder.flatMap((t) => (t ? [`${t.z}/${t.x}/${t.y}`] : []));
    expect(found.filter((key) => !drawn.has(key))).toEqual([]);
    // Read at its own zoom: a sample's value or no data.
    const read = await Promise.all(points.map((at, k) => tileValueAt(values, template, at, tilesUnder[k])));
    const known = new Set([...c.samples.map((sample) => sample.value), null]);
    expect(read.filter((value) => !known.has(value))).toEqual([]);
    return { drawn, found };
  }

  it("reads the tile MapLibre drew under each point of a tilted map", async () => {
    const s = await valueScene("tilted");
    // Tilted past 60 degrees MapLibre loads lower zooms away from the camera.
    s.map.setMaxPitch(85);
    s.map.jumpTo({ pitch: 75 });
    await settled(s);
    expect(s.errors).toEqual([]);
    const { found } = await readsDrawnTiles(s);
    expect(new Set(found.map((key) => key.split("/")[0])).size).toBeGreaterThan(1);
  });

  it("computes the covering tiles anew when the map is resized", async () => {
    const s = await valueScene("resized");
    const covering = vi.spyOn(s.map, "coveringTiles");
    const options = valueTileOptions(values);
    const center = s.map.getCenter();
    tileUnder(s.map, options, center);
    tileUnder(s.map, options, center);
    expect(covering).toHaveBeenCalledTimes(1);
    // A side panel opening: the map is narrower, its camera stays.
    const container = s.map.getContainer();
    const before = s.map.getCanvas().width;
    container.style.width = `${Math.round(container.clientWidth / 2)}px`;
    s.map.resize();
    expect(s.map.getCanvas().width).toBeLessThan(before);
    tileUnder(s.map, options, center);
    tileUnder(s.map, options, center);
    expect(covering).toHaveBeenCalledTimes(2);
  });

  it("reads the tile MapLibre drew under each point of a map with terrain", async () => {
    const s = await valueScene("terrain");
    // Terrain of the cone's tiles; with terrain MapLibre picks a zoom per tile, and culls tiles by their heights.
    s.map.addSource("terrain", {
      type: "raster-dem",
      tiles: [`${location.origin}/lab-raster/cone/{z}/{x}/{y}.webp`],
      tileSize: tiles.cone.size,
      encoding: "custom",
      ...tiles.cone.encoding,
    });
    s.map.setTerrain({ source: "terrain" });
    s.map.jumpTo({ pitch: 55 });
    await settled(s);
    expect(s.errors).toEqual([]);
    const { drawn } = await readsDrawnTiles(s);
    // The tiles covering the view without the terrain are others: a MapLibre that no longer hands the terrain on
    // through `coveringTiles` shows here.
    const flat = s.map
      .coveringTiles(valueTileOptions(values))
      .map(({ canonical: { z, x, y } }) => `${z}/${x}/${y}`);
    expect(new Set(flat)).not.toEqual(drawn);
  });
});

describe("an image drawn with its file's color table", () => {
  // The paletted fixture (make_tiles.py): one 8 bit band whose codes fill blocks as the value cases' samples, its
  // color table's colors shared by some codes, its no data around the blocks.
  const { codes, palette, ...about } = tiles.paletted as unknown as Omit<
    RasterValues,
    "version" | "maxzoom"
  > & {
    codes: number[];
    palette: unknown;
  };
  /** The colored tiles' description geoapi gives for the file: its band facts with the table. */
  const IMAGE: RasterTileset = {
    version: "lab",
    maxzoom: 22,
    bands: {
      count: 1,
      dtype: "uint8",
      scaled: false,
      colorTable: true,
      colorInterp: ["palette"],
      palette: paletteOf(palette),
    },
  };
  /** The raster service's picture of the file, drawn as an image (crisp, so a block's middle is its own color). */
  const served = (id: string, style: JsonObject) =>
    raster(
      id,
      { ...style, resampling: "nearest", render: { type: "image" } },
      { ...SOURCE, tiles: `${location.origin}/lab-raster/paletted-image/{z}/{x}/{y}.webp` }
    );
  /** The same file as the map draws it: its value tiles in the table's colors. */
  const fromValues = (id: string, style: JsonObject) =>
    raster(
      id,
      { ...style, render: { type: "image" } },
      {
        ...SOURCE,
        // The image tiles' route has no such fixture: a picture drawn from image tiles fails to load.
        tiles: `${location.origin}/lab-raster/none/{z}/{x}/{y}.webp`,
        coverage: `${location.origin}/lab-raster/paletted-values`,
        image: IMAGE,
        values: described(about),
      }
    );
  /** The pixel in the middle of each code's block, and of the no data beside the last one. */
  const blocks = (s: Scene): Rgb[] => {
    const [x, y] = origin(s);
    const scale = tileSize(s, SOURCE.id) / VALUE_TILE_SIZE;
    return [...codes, 0].map((_, k) =>
      pixel(s, [
        x + ((k % BLOCKS_PER_ROW) + 0.5) * BLOCK * scale,
        y + (Math.floor(k / BLOCKS_PER_ROW) + 0.5) * BLOCK * scale,
      ])
    );
  };

  it.each([
    ["as stored", {}],
    [
      "with adjustments and opacity",
      { brightness: 0.1, contrast: 0.25, saturation: -0.4, hue: 40, opacity: 0.7 },
    ],
  ] as Array<[string, JsonObject]>)("%s: draws the pixels of the service's picture", async (name, style) => {
    const id = name.replace(/\W+/g, "-");
    const picture = blocks(await scene(served(`paletted-served-${id}`, style)));
    const s = await scene(fromValues(`paletted-values-${id}`, style));
    expect(s.compiled?.layers.map((l) => l.type)).toEqual(["color-relief"]);
    expect(blank(s)).toBe(false);
    const drawn = blocks(s);
    const wrong = drawn.flatMap((d, k) =>
      near(d, picture[k])
        ? []
        : [
            `block ${k} (value ${k < codes.length ? codes[k] - about.encoding.baseShift : "none"}): drawn ${d}, service ${picture[k]}`,
          ]
    );
    expect(wrong).toEqual([]);
    // The blocks tell their colors apart: grey, green and black are not the ground.
    expect(drawn.filter((d) => !near(d, WHITE)).length).toBeGreaterThanOrEqual(4);
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

describe("512 px tiles, as the compiler asks for them", () => {
  // make_tiles.py reads the same files at 512 px for a few cases (tiles.json `large`): the same area at twice the
  // resolution. A 512 px tile does not fit the map's quarter right of and below its center, but every tile is the same
  // fixture, so a point of the tile read is also drawn on the tile left of it or above it.
  const LARGE = tiles.large;

  /** A point of the tile read, in pixels of its picture, where the map draws it: on that tile, or on the tile left of it
   * or above it where it falls past the map's right or bottom edge. */
  const onMap = (s: Scene, [px, py]: [number, number]): [number, number] => {
    const [x, y] = origin(s);
    const size = tileSize(s, SOURCE.id);
    const scale = size / LARGE.size;
    const { clientWidth, clientHeight } = s.map.getContainer();
    const place = (start: number, p: number, extent: number) => {
      const at = start + p * scale;
      const shown = at < extent ? at : at - size;
      if (shown < 0 || shown >= extent) throw new Error(`${p} px of the tile is not on the map`);
      return shown;
    };
    return [place(x, px, clientWidth), place(y, py, clientHeight)];
  };

  it.each(VALUE_CASES.filter((c) => LARGE.values.includes(c.id)))(
    "$id: each sample block of a 512 px value tile is drawn in its color",
    async (c) => {
      const { codes: _codes, ...about } = VALUE_TILES[c.id];
      const s = await scene({
        ...raster(`${c.id}-512`, c.style),
        // Drawn at the compiler's own tile size.
        tileSize: undefined,
        source: {
          ...SOURCE,
          tiles: `${location.origin}/lab-raster/none/{z}/{x}/{y}.webp`,
          coverage: `${location.origin}/lab-raster/values-${LARGE.size}-${c.id}`,
          values: described(about),
        },
      });
      expect(tileSize(s, SOURCE.id)).toBe(LARGE.size);
      const block = (BLOCK * LARGE.size) / VALUE_TILE_SIZE;
      const opacity = typeof c.style.opacity === "number" ? c.style.opacity : 1;
      const wrong = c.samples.flatMap((sample, k) => {
        const middle = onMap(s, [
          ((k % BLOCKS_PER_ROW) + 0.5) * block,
          (Math.floor(k / BLOCKS_PER_ROW) + 0.5) * block,
        ]);
        const drawn = pixel(s, middle);
        const want = sample.color === null ? WHITE : onGround(sample.color, opacity);
        return near(drawn, want) ? [] : [`value ${sample.value}: drawn ${drawn}, want ${want}`];
      });
      expect(wrong).toEqual([]);
    }
  );

  it("hillshade of a 512 px cone: the highlight color on the flank toward the light, the shadow color on the other", async () => {
    const s = await scene({
      ...raster("hillshade-512", shaded("standard")),
      tileSize: undefined,
      source: { ...SOURCE, coverage: `${location.origin}/lab-raster/cone-${LARGE.size}` },
    });
    expect(tileSize(s, SOURCE.id)).toBe(LARGE.size);
    expect(blank(s)).toBe(false);
    const render = s.style.render as JsonObject;
    const direction = (render.direction as number) * (Math.PI / 180);
    // The cone at 512 px: its top and radius twice those of the 256 px picture.
    const grow = LARGE.size / tiles.cone.size;
    const [cx, cy] = tiles.cone.center.map((v) => v * grow);
    const reach = tiles.cone.radius * grow * FLANK;
    const toward: [number, number] = [Math.sin(direction), -Math.cos(direction)];
    const lit = pixel(s, onMap(s, [cx + reach * toward[0], cy + reach * toward[1]]));
    const dark = pixel(s, onMap(s, [cx - reach * toward[0], cy - reach * toward[1]]));
    const highlight = onGround(render.highlight_color as string);
    const shadow = onGround(render.shadow_color as string);
    expect({ lit, ...tint(lit, highlight) }).toMatchObject(tinted);
    expect({ dark, ...tint(dark, shadow) }).toMatchObject(tinted);
    expect(tint(lit, highlight).cosine).toBeGreaterThan(tint(lit, shadow).cosine);
    expect(tint(dark, shadow).cosine).toBeGreaterThan(tint(dark, highlight).cosine);
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
