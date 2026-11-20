// Labels at a fixed side of their point's marker: for each placement the drawn text lies on the side the placement
// names, clear of the marker; beside the marker the lines of a label line up on its side. An area's label and a line's
// label at its middle take the same sides around their marker. The map's pixels tell the text (black) from the marker
// (red) on the white ground, the area's fill and the line being light enough to count as ground.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/style/json";

import { readRows } from "./checks";
import { type LabCase, type Scene, closeScenes, renderScene } from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

// The scenes' errors once more: those the map reported after a test changed it.
afterEach(() => {
  expect(closeScenes(scenes)).toEqual([]);
});

async function scene(c: LabCase): Promise<Scene> {
  const drawn = await renderScene(c);
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

const MARKER_SIZE = 16;

/** A red circle without outline and a black label without halo at the named side of it. */
const placed = (placement: string, text = "Abc"): JsonObject => ({
  version: "1.0.0",
  kind: "vector",
  symbol: {
    marker: { shape: "circle", color: "#ff0000", size: MARKER_SIZE },
    outline: false,
    label: { text, size: 16, color: "#000000", halo: { width: 0 }, max_width: 400, placement },
  },
});

const point = (id: string, style: JsonObject): LabCase => ({
  id,
  style,
  geometry: "point",
  zoom: 4,
  fields: {},
});

/** Moves the sample to the map's middle, so the label has room on every side, and resolves with its pixel once the
 * map has drawn it. */
async function centred(s: Scene): Promise<[number, number]> {
  const where = s.map.unproject(s.placed[0].pixel);
  s.map.jumpTo({ center: where });
  const idle = s.map.once("idle");
  s.map.triggerRepaint();
  await idle;
  const { x, y } = s.map.project(where);
  return [x, y];
}

type Kind = "text" | "marker" | null;

/** What each pixel of a square around (x, y) shows, row by row, in device pixels from the square's top left. */
function pixels(s: Scene, x: number, y: number, half: number): Kind[][] {
  return readRows(s, { x: x - half, y: y - half, w: 2 * half, h: 2 * half }).map((row) =>
    row.map(([red, green, blue]) =>
      red > 150 && green < 120 && blue < 120 ? "marker" : red + green + blue < 300 ? "text" : null
    )
  );
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The bounding box of the pixels of `kind`, in CSS pixels relative to the point (y down). */
function box(grid: Kind[][], kind: Kind, ratio: number, half: number): Box | null {
  let found: Box | null = null;
  grid.forEach((row, r) =>
    row.forEach((k, c) => {
      if (k !== kind) return;
      const [px, py] = [c / ratio - half, r / ratio - half];
      found = found
        ? {
            left: Math.min(found.left, px),
            right: Math.max(found.right, px),
            top: Math.min(found.top, py),
            bottom: Math.max(found.bottom, py),
          }
        : { left: px, right: px, top: py, bottom: py };
    })
  );
  return found;
}

const HALF = 120;

async function boxes(placement: string, c?: LabCase): Promise<{ text: Box; marker: Box }> {
  const s = await scene(c ?? point(`label-at-${placement}`, placed(placement)));
  const [x, y] = await centred(s);
  const grid = pixels(s, x, y, HALF);
  const ratio = s.map.getPixelRatio();
  const text = box(grid, "text", ratio, HALF);
  const marker = box(grid, "marker", ratio, HALF);
  expect(text, `${placement}: text drawn`).not.toBeNull();
  expect(marker, `${placement}: marker drawn`).not.toBeNull();
  return { text: text!, marker: marker! };
}

/** Clear of the marker: at least a pixel of white between the text and the marker. */
const CLEAR = 1;

const SIDES: Array<[string, "left" | "right" | null, "above" | "below" | null]> = [
  ["above", null, "above"],
  ["below", null, "below"],
  ["left", "left", null],
  ["right", "right", null],
  ["above_left", "left", "above"],
  ["above_right", "right", "above"],
  ["below_left", "left", "below"],
  ["below_right", "right", "below"],
];

/** That the text lies on the named side of the marker drawn on the point, clear of it. */
function expectBeside(
  { text, marker }: { text: Box; marker: Box },
  horizontal: "left" | "right" | null,
  vertical: "above" | "below" | null
): void {
  const where = JSON.stringify({ text, marker });
  // The marker is drawn on the point.
  expect(Math.abs((marker.left + marker.right) / 2), where).toBeLessThanOrEqual(1);
  expect(Math.abs((marker.top + marker.bottom) / 2), where).toBeLessThanOrEqual(1);
  if (horizontal === "right") expect(text.left - marker.right, where).toBeGreaterThanOrEqual(CLEAR);
  if (horizontal === "left") expect(marker.left - text.right, where).toBeGreaterThanOrEqual(CLEAR);
  if (vertical === "above") expect(marker.top - text.bottom, where).toBeGreaterThanOrEqual(CLEAR);
  if (vertical === "below") expect(text.top - marker.bottom, where).toBeGreaterThanOrEqual(CLEAR);
  // Straight above or below the text is centred on the point; straight beside it, the point's row runs through it.
  if (!horizontal) expect(Math.abs((text.left + text.right) / 2), where).toBeLessThanOrEqual(3);
  if (!vertical) {
    expect(text.top, where).toBeLessThan(0);
    expect(text.bottom, where).toBeGreaterThan(0);
  }
}

describe("labels at a fixed side of their marker", () => {
  for (const [placement, horizontal, vertical] of SIDES) {
    it(`${placement}: the text is on that side of the marker, clear of it`, async () => {
      expectBeside(await boxes(placement), horizontal, vertical);
    });
  }

  it("right of the marker the lines of a label start at the same x; left of it they end at the same x", async () => {
    for (const placement of ["right", "left"]) {
      const s = await scene(point(`label-lines-${placement}`, placed(placement, "Ab\nAbcdefghijklm")));
      const [x, y] = await centred(s);
      const grid = pixels(s, x, y, HALF);
      // The rows of each line of text: bands of rows with text, top to bottom.
      const lines: Array<{ left: number; right: number }> = [];
      let current: { left: number; right: number } | null = null;
      for (const row of grid) {
        const left = row.indexOf("text");
        if (left < 0) {
          current = null;
          continue;
        }
        const right = row.lastIndexOf("text");
        if (!current) lines.push((current = { left, right }));
        else [current.left, current.right] = [Math.min(current.left, left), Math.max(current.right, right)];
      }
      expect(lines.length, placement).toBe(2);
      const [a, b] = lines;
      // A glyph's side bearing apart at most; centred, the short line would sit far inside the long one.
      if (placement === "right")
        expect(Math.abs(a.left - b.left), JSON.stringify(lines)).toBeLessThanOrEqual(3);
      else expect(Math.abs(a.right - b.right), JSON.stringify(lines)).toBeLessThanOrEqual(3);
    }
  });
});

/** An area or a line with a red marker at its label point or middle and a black label around it. */
const around = (geometry: "polygon" | "line", placement: string): LabCase => ({
  id: `${geometry}-label-at-${placement}`,
  geometry,
  zoom: 4,
  fields: {},
  style: {
    version: "1.0.0",
    kind: "vector",
    symbol: {
      ...(geometry === "polygon"
        ? { fill: { color: "#eeeeee" }, outline: false }
        : { line: { color: "#c6dbef", width: 2 } }),
      marker: { shape: "circle", color: "#ff0000", size: MARKER_SIZE },
      label: { text: "Abc", size: 16, color: "#000000", halo: { width: 0 }, max_width: 400, placement },
    },
  },
});

describe("labels around the marker of an area and of a line's middle", () => {
  for (const [placement, horizontal, vertical] of SIDES.filter(([p]) =>
    ["above", "below_right", "left"].includes(p)
  ))
    it(`an area's label ${placement}: on that side of the marker, clear of it`, async () => {
      expectBeside(await boxes(placement, around("polygon", placement)), horizontal, vertical);
    });

  it("an area's label in the middle sits on its marker", async () => {
    const { text, marker } = await boxes("inside", around("polygon", "inside"));
    const where = JSON.stringify({ text, marker });
    expect(text.left, where).toBeLessThan(0);
    expect(text.right, where).toBeGreaterThan(0);
    expect(text.top, where).toBeLessThan(0);
    expect(text.bottom, where).toBeGreaterThan(0);
  });

  for (const [placement, horizontal, vertical] of SIDES.filter(([p]) => ["above", "right"].includes(p)))
    it(`a line's label ${placement} at its middle: on that side of the marker, upright and clear of it`, async () => {
      expectBeside(await boxes(placement, around("line", placement)), horizontal, vertical);
    });
});
