// H3 hexagons as the browser draws them, over tiles geoapi's own H3 code made from synthetic points
// (fixtures/h3/make_tiles.py): every hexagon's count and mean are known, and the styles carry the classes and ranges
// goatlib computed over the same points. The lab answers the tile URLs the compiler builds for an H3 layer. Each
// hexagon must draw the color the legend gives its value at the legend's opacity, and from `points_from_zoom` on the
// points take over.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompileInput } from "@/lib/style/compile/types";
import type { JsonObject } from "@/lib/style/json";
import type { LegendSection } from "@/lib/style/legend";

import { rampColorAt, rampStops } from "@/components/map/legend/rampGradient";

import { type Rgb, WHITE, blank, colorMismatches, distance, notDrawn, over, readRect } from "./checks";
import facts from "./fixtures/h3/facts.json";
import styles from "./fixtures/h3/styles.json";
import { type LabCase, type Scene, closeScene, renderScene } from "./scene";

/** How far a drawn channel may be from the expected one, of 255. */
const TOLERANCE = 3;
/** The side of the square of CSS pixels read at a hexagon's middle: well inside the hexagon, clear of its outline. */
const WINDOW = 5;
/** Hexagons whose middle is closer than this to the map's edge are not read: part of them is off the map. */
const MARGIN = 30;
/** The least number of hexagons a scene must show whole: the view holds many more. */
const MIN_HEXAGONS = 80;

type Cell = (typeof facts.cells)[number];
type Entries = Extract<LegendSection, { kind: "entries" }>;
type Ramp = Extract<LegendSection, { kind: "ramp" }>;

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

/** A case over the lab's H3 tile route, at the URL template the app gives the compiler for a layer's tiles. */
const h3Case = (id: string, style: JsonObject, zoom: number): LabCase => ({
  id,
  style,
  geometry: "point",
  zoom,
  fields: { pop: "number" },
  source: {
    type: "tiles",
    id,
    tiles: [`${location.origin}/lab-h3/{z}/{x}/{y}.pbf`],
  } satisfies CompileInput["source"],
});

async function scene(c: LabCase): Promise<Scene> {
  const drawn = await renderScene(c);
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

/** The legend's section for the hexagons. */
const h3Section = (s: Scene): LegendSection | undefined => s.legend?.sections.find((x) => x.id === "h3");

/** The hexagons whose middle is on the map, at least MARGIN from its edges, and the pixel of their middle. */
function cellsInView(s: Scene): Array<{ cell: Cell; pixel: [number, number] }> {
  const canvas = s.map.getCanvas();
  return facts.cells.flatMap((cell) => {
    const { x, y } = s.map.project([cell.lng, cell.lat]);
    const inside =
      x >= MARGIN && y >= MARGIN && x <= canvas.clientWidth - MARGIN && y <= canvas.clientHeight - MARGIN;
    return inside ? [{ cell, pixel: [x, y] as [number, number] }] : [];
  });
}

const hex = (rgb: Rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/** The color and opacity the legend shows for a value. */
type Look = { color: string; opacity: number };

/** The hexagons in view whose middle is not drawn in the look the legend gives their value (`lookOf`), its color at its
 * opacity over the ground: "cell (value): want #rrggbb, drawn #rrggbb". Passes a hexagon when most pixels of its read
 * are within TOLERANCE. */
function hexagonMismatches(
  s: Scene,
  valueOf: (cell: Cell) => number,
  lookOf: (value: number) => Look
): { read: number; mismatches: string[] } {
  const cells = cellsInView(s);
  const mismatches: string[] = [];
  for (const { cell, pixel } of cells) {
    const value = valueOf(cell);
    const { color, opacity } = lookOf(value);
    const want = over({ color }, opacity, WHITE)!;
    const half = WINDOW / 2;
    const pixels = readRect(s, { x: pixel[0] - half, y: pixel[1] - half, w: WINDOW, h: WINDOW });
    const near = pixels.filter((rgb) => distance(rgb, want) <= TOLERANCE).length;
    if (near * 2 <= pixels.length)
      mismatches.push(
        `${cell.cell} (${value}): want ${hex(want)}, drawn ${hex(pixels[Math.floor(pixels.length / 2)])}`
      );
  }
  return { read: cells.length, mismatches };
}

/** The swatch of the legend's class entry a value falls in (from its `from` up to below its `to`): its color at its
 * opacity, full strength without one. */
function classLook(section: Entries, value: number): Look {
  const entry = section.entries.find(
    ({ range }) =>
      (range?.from === undefined || value >= range.from) && (range?.to === undefined || value < range.to)
  );
  const fill = entry?.swatch.fill;
  if (!fill?.color) throw new Error(`no legend class holds ${value}`);
  return { color: fill.color as string, opacity: typeof fill.opacity === "number" ? fill.opacity : 1 };
}

/** The legend ramp's look at a value: the color its bar shows there (`rampColorAt`), at the opacity the bar is drawn
 * with. */
function rampLook(section: Ramp, value: number): Look {
  return { color: rampColorAt(section, value), opacity: section.opacity ?? 1 };
}

describe("hexagons", () => {
  it("classes: each hexagon draws the color of the legend class its count falls in", async () => {
    const s = await scene(h3Case("h3-classes", styles.classes as JsonObject, facts.zoom));
    expect(blank(s)).toBe(false);
    const section = h3Section(s);
    expect(section?.kind).toBe("entries");
    const classes = section as Entries;
    // Four classes of the counts 1 to 9, as goatlib computed them.
    expect(classes.entries.map((e) => e.range)).toEqual([
      { to: 3 },
      { from: 3, to: 5 },
      { from: 5, to: 7 },
      { from: 7 },
    ]);

    const { read, mismatches } = hexagonMismatches(
      s,
      (cell) => cell.count,
      (value) => classLook(classes, value)
    );
    expect(read).toBeGreaterThanOrEqual(MIN_HEXAGONS);
    expect(mismatches).toEqual([]);
    // Every class is on the map, and counts on a break (the class it opens holds it).
    const counts = new Set(cellsInView(s).map(({ cell }) => cell.count));
    for (const count of [1, 3, 5, 7, 9]) expect(counts.has(count), `a hexagon of count ${count}`).toBe(true);
  });

  it("ramp: each hexagon draws the legend ramp's color at its mean", async () => {
    const s = await scene(h3Case("h3-ramp", styles.ramp as JsonObject, facts.zoom));
    expect(blank(s)).toBe(false);
    const section = h3Section(s);
    expect(section?.kind).toBe("ramp");
    const ramp = section as Ramp;
    expect(ramp.domain).toEqual([0, 160]);

    const { read, mismatches } = hexagonMismatches(
      s,
      (cell) => cell.pop,
      (value) => rampLook(ramp, value)
    );
    expect(read).toBeGreaterThanOrEqual(MIN_HEXAGONS);
    expect(mismatches).toEqual([]);
    // Means on the ramp's stops and between two of them.
    const stops = rampStops(ramp).map((stop) => ramp.domain[0] + stop.at * (ramp.domain[1] - ramp.domain[0]));
    const means = cellsInView(s).map(({ cell }) => cell.pop);
    expect(means.some((m) => stops.includes(m))).toBe(true);
    expect(means.some((m) => !stops.includes(m))).toBe(true);
  });
});

it("from points_from_zoom on, the points are drawn in their legend look and the hexagons are not", async () => {
  const style = styles.classes as JsonObject;
  expect((style.render as JsonObject).points_from_zoom).toBe(facts.points_zoom);
  const s = await scene(h3Case("h3-points", style, facts.points_zoom));
  expect(blank(s)).toBe(false);
  expect(h3Section(s)).toBeUndefined();
  const base = s.legend?.sections.find((x) => x.id === "base");
  expect(base?.kind).toBe("entries");
  const entry = (base as Entries).entries[0];

  expect(s.map.getLayer(`${s.input!.id}-h3-fill`), "hexagon layer").toBeDefined();
  const hexagons = s.map.queryRenderedFeatures({ layers: [`${s.input!.id}-h3-fill`] });
  expect(hexagons.length, "hexagons drawn").toBe(0);

  // One sample per hexagon middle in view: the point drawn there, compared with the legend's base swatch by the
  // lab's checks.
  const missing: string[] = [];
  for (const { cell, pixel } of cellsInView(s)) {
    const point = s.map
      .queryRenderedFeatures(pixel)
      .find((f) => f.source === s.input!.id && f.sourceLayer === "default");
    if (typeof point?.id !== "number") {
      missing.push(cell.cell);
      continue;
    }
    s.placed.push({ section: "base", entry, swatch: entry.swatch, pixel, featureId: point.id });
  }
  expect(missing).toEqual([]);
  expect(s.placed.length).toBeGreaterThanOrEqual(MIN_HEXAGONS / 4);
  expect(notDrawn(s)).toEqual([]);
  expect(colorMismatches(s)).toEqual([]);
});

it("a tile request the fixtures do not hold is a map error, not an empty map", async () => {
  const style = structuredClone(styles.ramp) as JsonObject;
  (style.render as JsonObject).value = { op: "mean", field: "missing" };
  const drawn = await renderScene({
    ...h3Case("h3-missing", style, facts.zoom),
    fields: { missing: "number" },
  });
  scenes.push(drawn);
  expect(drawn.errors.join("\n")).toMatch(/400/);
});
