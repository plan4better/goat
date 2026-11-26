// A layer's blend (spec 4.7) as the browser draws it: MapLibre composites a fill, line or raster layer with a blend
// onto what is drawn below it by the W3C compositing formulas. Most cases draw on a basemap's land with two grey
// streets and a name across it (a picture the test draws); each check reads a pixel of the layer and the
// ground beside it on the same row, where the layer is not, and compares the pixel with the formula over that ground.
import type { GeoJSONSource } from "maplibre-gl";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import { applyCompiled } from "@/lib/style/render/apply";

import { type Rgb, WHITE, distance, readRect } from "./checks";
import tiles from "./fixtures/raster/tiles.json";
import {
  BASEMAP_LAND,
  LAB_FONT,
  LAB_GROUNDS,
  type LabCase,
  type LabGround,
  MAP,
  type Scene,
  closeScenes,
  renderScene,
} from "./scene";

/** How far a drawn channel may be from the formula's, of 255. */
const TOLERANCE = 3;
/** Where the ground is read on a row: left of every shape the cases draw. */
const GROUND_X = 60;
/** The rows of the middles of the two streets across the ground, each 8 px wide, as a basemap draws them; the street
 * name above them. */
const STREET_ROWS = [180, 300];
const STREET_WIDTH = 8;
const NAME = { text: "Lindenallee", y: 140 };
/** A row of the ground with neither street nor name. */
const PLAIN_ROW = 240;

const FILL = "#fcbba1";
const scenes: Scene[] = [];

/** The light and the dark ground with the streets and the name: filled in before the tests. */
let streets: LabGround;
let darkStreets: LabGround;

/** A basemap's ground with the streets (the first at STREET_ROWS[0]) and the name drawn over its land, as a picture. */
function streetGround(ground: LabGround, colors: [string, string], name: string): LabGround {
  const canvas = document.createElement("canvas");
  canvas.width = MAP.width;
  canvas.height = MAP.height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = ground.color;
  context.fillRect(0, 0, MAP.width, MAP.height);
  STREET_ROWS.forEach((y, i) => {
    context.fillStyle = colors[i];
    context.fillRect(0, y - STREET_WIDTH / 2, MAP.width, STREET_WIDTH);
  });
  context.fillStyle = name;
  context.font = `700 28px ${LAB_FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(NAME.text, MAP.width / 2, NAME.y);
  return { ...ground, picture: canvas.toDataURL("image/png") };
}

beforeAll(async () => {
  // The name in the lab's font, loaded before the pictures are drawn.
  await document.fonts.load(`700 28px ${LAB_FONT}`);
  // On the light ground a light grey street (above half of white) and a darker one (below half); on the dark ground
  // streets lighter than its land, the lighter one first.
  streets = streetGround(LAB_GROUNDS.light, ["#b4b4b4", "#7a7a7a"], "#333333");
  darkStreets = streetGround(LAB_GROUNDS.dark, ["#6e6e6e", "#3c3c3c"], "#c8c8c8");
});

beforeEach(() => performance.clearResourceTimings());

// The scenes' errors once more: those the map reported after a test changed it.
afterEach(() => {
  expect(closeScenes(scenes)).toEqual([]);
});

async function scene(c: LabCase, ground?: LabGround): Promise<Scene> {
  const drawn = await renderScene(c, ground ? { ground } : {});
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

const vector = (id: string, style: JsonObject, geometry: "polygon" | "line" = "polygon"): LabCase => ({
  id,
  style: { version: "1.0.0", kind: "vector", ...style },
  geometry,
  zoom: 4,
  fields: {},
});

const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** The pixel at a point of the map, in CSS pixels. */
const pixel = (s: Scene, [x, y]: [number, number]): Rgb => readRect(s, { x, y, w: 1, h: 1 })[0];

/** The ground on a row, read where no shape is. */
const groundAt = (s: Scene, y: number): Rgb => pixel(s, [GROUND_X, y]);

const multiply = (a: Rgb, b: Rgb): Rgb => a.map((c, i) => (c * b[i]) / 255) as Rgb;
const screen = (a: Rgb, b: Rgb): Rgb => a.map((c, i) => 255 - ((255 - c) * (255 - b[i])) / 255) as Rgb;
const halfway = (a: Rgb, b: Rgb): Rgb => a.map((c, i) => (c + b[i]) / 2) as Rgb;
/** Overlay of the color `a` over the ground `b`: multiplied twice where the ground's channel is below half, screened
 * twice where it is at or above half (W3C hard light with the two swapped). */
const overlay = (a: Rgb, b: Rgb): Rgb =>
  a.map((c, i) =>
    2 * b[i] < 255 ? (2 * c * b[i]) / 255 : 255 - (2 * (255 - c) * (255 - b[i])) / 255
  ) as Rgb;
/** Luminosity as the W3C formulas weigh it, on the scale of the channels given. */
const lum = ([r, g, b]: number[]) => 0.3 * r + 0.59 * g + 0.11 * b;
/** Color of `a` over the ground `b` (W3C SetLum): the color moved by the difference of the two luminosities, then
 * pulled toward its luminosity where a channel left 0 to 1, so its hue and saturation stay and its luminosity is the
 * ground's. */
function color(a: Rgb, b: Rgb): Rgb {
  const src = a.map((c) => c / 255);
  const l = lum(b.map((c) => c / 255));
  let out = src.map((c) => c + (l - lum(src)));
  const [n, x] = [Math.min(...out), Math.max(...out)];
  if (n < 0) out = out.map((c) => l + ((c - l) * l) / (l - n));
  if (x > 1) out = out.map((c) => l + ((c - l) * (1 - l)) / (x - l));
  return out.map((c) => c * 255) as Rgb;
}

/** A pixel against the color a formula gives, both in the message where they differ. */
function expectNear(drawn: Rgb, want: Rgb, what: string): void {
  const rounded = want.map(Math.round);
  expect(distance(drawn, want) <= TOLERANCE, `${what}: drawn ${drawn}, want ${rounded}`).toBe(true);
}

/** A ring of a square around a pixel, as map coordinates, counterclockwise on the map. */
function square(s: Scene, [x, y]: [number, number], side: number): number[][] {
  const at = (px: number, py: number) => s.map.unproject([px, py]).toArray();
  const h = side / 2;
  const ring = [at(x - h, y - h), at(x - h, y + h), at(x + h, y + h), at(x + h, y - h)];
  return [...ring, ring[0]];
}

const polygons = (s: Scene, squares: Array<{ at: [number, number]; side: number }>): GeoJSON.Feature[] =>
  squares.map(({ at, side }, i) => ({
    type: "Feature",
    id: i + 1,
    properties: {},
    geometry: { type: "Polygon", coordinates: [square(s, at, side)] },
  }));

/** Draws `features` in place of the scene's samples and waits until the map has drawn them. */
async function draw(s: Scene, features: GeoJSON.Feature[]): Promise<void> {
  const source = Object.keys(s.compiled!.sources)[0];
  const idle = s.map.once("idle");
  (s.map.getSource(source) as GeoJSONSource).setData({ type: "FeatureCollection", features });
  await idle;
}

/** The square most cases draw: across both streets and the name, its edges at x 200 and 440. */
const AREA = { at: [320, 240] as [number, number], side: 240 };
const INSIDE_X = 320;

/** The blend properties of the scene's layers, by layer id. */
const blendsOf = (s: Scene) =>
  Object.fromEntries(
    (s.compiled?.layers ?? []).map((l) => [
      l.id,
      Object.entries((l.paint ?? {}) as Record<string, unknown>).find(([k]) =>
        k.endsWith("-layer-blend")
      )?.[1],
    ])
  );

const linux = navigator.userAgent.includes("Linux");

/** The scene against its screenshot baseline, on Linux only (baselines are made there). */
async function matchesScreenshot(s: Scene, name: string): Promise<void> {
  if (linux) await expect(s.root).toMatchScreenshot(name);
}

describe("blend over the basemap (spec 4.7)", () => {
  const area = (blend?: string, extra: JsonObject = {}): JsonObject => ({
    ...(blend ? { blend } : {}),
    ...extra,
    symbol: { fill: { color: FILL }, outline: false },
  });

  it("an area in normal covers the streets; in multiply each pixel is the product of its color and the ground", async () => {
    const normal = await scene(vector("blend-area-normal", area()), streets);
    await draw(normal, polygons(normal, [AREA]));
    for (const y of STREET_ROWS)
      expectNear(pixel(normal, [INSIDE_X, y]), rgbOf(FILL), `normal over the street at ${y}`);
    await matchesScreenshot(normal, "blend-area-normal");

    const s = await scene(vector("blend-area-multiply", area("multiply")), streets);
    expect(blendsOf(s)).toEqual({ "blend-area-multiply-fill": "multiply" });
    await draw(s, polygons(s, [AREA]));
    for (const y of [PLAIN_ROW, ...STREET_ROWS])
      expectNear(pixel(s, [INSIDE_X, y]), multiply(rgbOf(FILL), groundAt(s, y)), `multiply at row ${y}`);
    // The streets show through: darker than the area over the plain ground, the darker street the darkest.
    const [plain, light, dark] = [PLAIN_ROW, ...STREET_ROWS].map((y) => pixel(s, [INSIDE_X, y]));
    for (let i = 0; i < 3; i++) {
      expect(light[i]).toBeLessThan(plain[i]);
      expect(dark[i]).toBeLessThan(light[i]);
    }
    await matchesScreenshot(s, "blend-area-multiply");
  });

  it("at layer opacity 0.5 a multiplied area lies halfway between the ground and the product", async () => {
    const s = await scene(vector("blend-opacity", area("multiply", { opacity: 0.5 })), streets);
    await draw(s, polygons(s, [AREA]));
    for (const y of [PLAIN_ROW, ...STREET_ROWS]) {
      const ground = groundAt(s, y);
      expectNear(pixel(s, [INSIDE_X, y]), halfway(ground, multiply(rgbOf(FILL), ground)), `row ${y}`);
    }
  });

  it("overlapping areas of one layer do not darken each other", async () => {
    const s = await scene(vector("blend-overlap", area("multiply")), streets);
    // Two squares across the streets, overlapping between x 270 and 370.
    await draw(
      s,
      polygons(s, [
        { at: [270, 240], side: 200 },
        { at: [370, 240], side: 200 },
      ])
    );
    for (const y of [PLAIN_ROW, ...STREET_ROWS]) {
      const want = multiply(rgbOf(FILL), groundAt(s, y));
      expectNear(pixel(s, [200, y]), want, `the first square alone at row ${y}`);
      expectNear(pixel(s, [440, y]), want, `the second square alone at row ${y}`);
      expectNear(pixel(s, [320, y]), want, `the overlap at row ${y}`);
    }
  });

  it("an outline mixes over the mixed fill: its inner half is darker than its outer half", async () => {
    const OUTLINE = "#2166ac";
    const style = {
      blend: "multiply",
      symbol: { fill: { color: FILL }, outline: { color: OUTLINE, width: 4 } },
    };
    const s = await scene(vector("blend-outline", style), streets);
    expect(blendsOf(s)).toEqual({ "blend-outline-fill": "multiply", "blend-outline-outline": "multiply" });
    await draw(s, polygons(s, [AREA]));
    const ground = groundAt(s, PLAIN_ROW);
    // The left edge at x 200: the outline from 198 to 202, its pixels 198 and 199 over the ground, 200 and 201 over
    // the fill. Pixel 199 also holds the fill's antialiased edge: the outer half is read at 198, the inner at 201.
    const outer = pixel(s, [198, PLAIN_ROW]);
    const inner = pixel(s, [201, PLAIN_ROW]);
    expectNear(outer, multiply(rgbOf(OUTLINE), ground), "outer half");
    expectNear(inner, multiply(rgbOf(OUTLINE), multiply(rgbOf(FILL), ground)), "inner half");
    // Darker: no channel lighter, all of them together less (the fill's red is close to white and darkens it little).
    for (let i = 0; i < 3; i++) expect(inner[i]).toBeLessThanOrEqual(outer[i]);
    expect(inner[0] + inner[1] + inner[2]).toBeLessThan(outer[0] + outer[1] + outer[2]);
    await matchesScreenshot(s, "blend-outline");
  });

  it("a white casing disappears in multiply; in normal it covers the streets", async () => {
    const LINE = "#2166ac";
    const line = (blend?: string): JsonObject => ({
      ...(blend ? { blend } : {}),
      symbol: { line: { color: LINE, width: 6 }, casing: { color: "#ffffff", width: 4 } },
    });
    // A vertical line at x 320 across the streets: the line from 317 to 323, the casing 4 px on each side of it.
    const vertical = (s: Scene): GeoJSON.Feature[] => [
      {
        type: "Feature",
        id: 1,
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [s.map.unproject([320, 40]).toArray(), s.map.unproject([320, 440]).toArray()],
        },
      },
    ];
    const CASING_X = 315;
    const normal = await scene(vector("blend-casing-normal", line(), "line"), streets);
    await draw(normal, vertical(normal));
    for (const y of STREET_ROWS) expectNear(pixel(normal, [CASING_X, y]), WHITE, `normal casing at ${y}`);

    const s = await scene(vector("blend-casing-multiply", line("multiply"), "line"), streets);
    expect(blendsOf(s)).toEqual({
      "blend-casing-multiply-casing": "multiply",
      "blend-casing-multiply-line": "multiply",
    });
    await draw(s, vertical(s));
    for (const y of [PLAIN_ROW, ...STREET_ROWS]) {
      const ground = groundAt(s, y);
      expectNear(pixel(s, [CASING_X, y]), ground, `the casing at row ${y} is the ground`);
      expectNear(pixel(s, [INSIDE_X, y]), multiply(rgbOf(LINE), ground), `the line at row ${y}`);
    }
  });

  it("overlay multiplies over the dark street and screens over the light one", async () => {
    const s = await scene(vector("blend-overlay", area("overlay")), streets);
    expect(blendsOf(s)).toEqual({ "blend-overlay-fill": "overlay" });
    await draw(s, polygons(s, [AREA]));
    // The two streets fall into the formula's two branches: the light one above half of white, the dark one below.
    const [light, dark] = STREET_ROWS.map((y) => groundAt(s, y));
    for (let i = 0; i < 3; i++) {
      expect(2 * light[i]).toBeGreaterThanOrEqual(255);
      expect(2 * dark[i]).toBeLessThan(255);
    }
    for (const y of [PLAIN_ROW, ...STREET_ROWS])
      expectNear(pixel(s, [INSIDE_X, y]), overlay(rgbOf(FILL), groundAt(s, y)), `overlay at row ${y}`);
  });

  it("color keeps the area's hue and saturation with the luminosity of the ground below", async () => {
    const s = await scene(vector("blend-color", area("color")), streets);
    expect(blendsOf(s)).toEqual({ "blend-color-fill": "color" });
    await draw(s, polygons(s, [AREA]));
    for (const y of [PLAIN_ROW, ...STREET_ROWS]) {
      const ground = groundAt(s, y);
      const drawn = pixel(s, [INSIDE_X, y]);
      expectNear(drawn, color(rgbOf(FILL), ground), `color at row ${y}`);
      // The luminosity is the ground's, within a step.
      expect(Math.abs(lum(drawn) - lum(ground))).toBeLessThanOrEqual(1.5);
    }
  });

  it("screen on the dark basemap lightens: each channel 255 - (255 - a)(255 - b) / 255", async () => {
    // A dark blue: screen over a near black ground lifts a dark color clearly, a light one hardly at all.
    const BLUE = "#2166ac";
    const style = { blend: "screen", symbol: { fill: { color: BLUE }, outline: false } };
    const s = await scene(vector("blend-screen-dark", style), darkStreets);
    await draw(s, polygons(s, [AREA]));
    expect(distance(groundAt(s, PLAIN_ROW), rgbOf(BASEMAP_LAND.dark))).toBeLessThanOrEqual(TOLERANCE);
    for (const y of [PLAIN_ROW, ...STREET_ROWS])
      expectNear(pixel(s, [INSIDE_X, y]), screen(rgbOf(BLUE), groundAt(s, y)), `screen at row ${y}`);
    // Lighter than the color drawn without a blend, by more than the tolerance, and the streets show through: the
    // lighter street the lightest.
    const [plain, light, dark] = [PLAIN_ROW, ...STREET_ROWS].map((y) => pixel(s, [INSIDE_X, y]));
    expect(distance(plain, rgbOf(BLUE))).toBeGreaterThan(TOLERANCE);
    for (let i = 0; i < 3; i++) {
      expect(dark[i]).toBeGreaterThan(plain[i]);
      expect(light[i]).toBeGreaterThan(dark[i]);
    }
    await matchesScreenshot(s, "blend-screen-dark");
  });

  it("with terrain the multiplied area still holds the product at the scene's center", async () => {
    const s = await scene(vector("blend-terrain", area("multiply")), streets);
    await draw(s, polygons(s, [AREA]));
    // Terrain of the lab's cone tiles, as the raster lab sets it up: the map draws on a mesh of their heights.
    s.map.addSource("terrain", {
      type: "raster-dem",
      tiles: [`${location.origin}/lab-raster/cone/{z}/{x}/{y}.webp`],
      tileSize: tiles.cone.size,
      encoding: "custom",
      ...tiles.cone.encoding,
    });
    const idle = s.map.once("idle");
    s.map.setTerrain({ source: "terrain" });
    s.map.jumpTo({ pitch: 55 });
    await idle;
    expect(s.map.getTerrain()).not.toBeNull();
    expect(s.errors).toEqual([]);
    const center: [number, number] = [MAP.width / 2, MAP.height / 2];
    expectNear(pixel(s, center), multiply(rgbOf(FILL), rgbOf(BASEMAP_LAND.light)), "multiply at the center");
  });
});

describe("a raster image in multiply over a polygon (spec 4.7)", () => {
  // The raster service's picture of the paletted fixture (make_tiles.py): eight blocks of 32 px in its top row, white,
  // white, grey, grey, green, blue, black and orange, transparent no data around them. The lab answers every tile
  // address with it, drawn 256 px wide, so the tile whose top left corner is at the map's center and the one left of
  // it hold the same blocks.
  const BLOCK = 32;
  const TILE = 256;
  const image = (id: string, blend?: string): LabCase => ({
    id,
    style: { version: "1.0.0", kind: "raster", resampling: "nearest", ...(blend ? { blend } : {}) },
    geometry: "polygon",
    zoom: 12,
    fields: {},
    source: {
      type: "raster",
      id: "raster",
      tiles: `${location.origin}/lab-raster/paletted-image/{z}/{x}/{y}.webp`,
      coverage: `${location.origin}/lab-raster/none`,
    } satisfies CompileInput["source"],
    tileSize: TILE,
  });

  it("each pixel is the product of the polygon's color and the image's; white and no data leave the polygon's color", async () => {
    const s = await scene(image("blend-raster", "multiply"));
    expect(blendsOf(s)).toEqual({ "blend-raster-raster": "multiply" });
    const { x, y } = s.map.project([0, 0]);
    // A polygon below the image over the tile at the map's center, clear of the tile left of it.
    const polygon = compileLayer({
      id: "below",
      style: {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: FILL }, outline: false },
      } as LayerStyle,
      geometry: "polygon",
      source: {
        type: "points",
        id: "below",
        data: {
          type: "FeatureCollection",
          features: polygons(s, [{ at: [x + TILE / 2, y + 2 * BLOCK], side: TILE - 8 }]),
        },
      },
    });
    const idle = s.map.once("idle");
    applyCompiled(s.map, null, polygon, { beforeId: "blend-raster-raster" });
    await idle;
    expect(s.errors).toEqual([]);
    const fill = rgbOf(FILL);
    // Each block's middle over the polygon, and the same block of the tile left of it over the white ground, where
    // multiply draws the image as it is.
    for (let k = 0; k < 8; k++) {
      const row = y + BLOCK / 2;
      const over = pixel(s, [x + (k + 0.5) * BLOCK, row]);
      const alone = pixel(s, [x - TILE + (k + 0.5) * BLOCK, row]);
      expectNear(over, multiply(fill, alone), `block ${k}`);
    }
    // The white blocks and the transparent no data below the blocks show the polygon's color.
    for (const at of [
      [x + BLOCK / 2, y + BLOCK / 2],
      [x + 1.5 * BLOCK, y + BLOCK / 2],
      [x + TILE / 2, y + 2.5 * BLOCK],
    ] as Array<[number, number]>)
      expectNear(pixel(s, at), fill, `the polygon's color at ${at}`);
    await matchesScreenshot(s, "blend-raster-over-polygon");
  });
});
