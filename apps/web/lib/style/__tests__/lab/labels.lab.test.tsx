// Labels on the map: how the lines of a multi-line point label line up beside their marker. With placement "auto"
// MapLibre picks one of the compiled anchors per label; each test keeps a single anchor of the compiled list, so the
// label sits on the side that anchor gives it, and reads where each drawn line of text starts and ends.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/style/json";

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

/** A short line over a long one, in black without a halo, wide enough that neither wraps. */
const TWO_LINES: JsonObject = {
  version: 1,
  kind: "vector",
  symbol: {
    marker: { shape: "circle", color: "#ffffff", size: 8 },
    label: {
      text: "Ab\nAbcdefghijklm",
      size: 16,
      color: "#000000",
      halo: { width: 0 },
      max_width: 400,
      placement: "auto",
    },
  },
};

const point = (id: string, style: JsonObject): LabCase => ({
  id,
  style,
  geometry: "point",
  zoom: 4,
  fields: {},
});

/** The map's pixels of a rectangle in CSS pixels, row by row: true where the pixel is dark (text). */
function darkPixels(s: Scene, x: number, y: number, w: number, h: number): boolean[][] {
  const canvas = s.map.getCanvas();
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
  const ratio = s.map.getPixelRatio();
  const x0 = Math.max(0, Math.round(x * ratio));
  const y0 = Math.max(0, Math.round(y * ratio));
  const x1 = Math.min(gl.drawingBufferWidth, Math.round((x + w) * ratio));
  const y1 = Math.min(gl.drawingBufferHeight, Math.round((y + h) * ratio));
  const [cols, rows] = [x1 - x0, y1 - y0];
  const data = new Uint8Array(cols * rows * 4);
  // readPixels counts rows from the bottom of the drawing buffer.
  gl.readPixels(x0, gl.drawingBufferHeight - y1, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const out: boolean[][] = [];
  for (let r = rows - 1; r >= 0; r--) {
    const row: boolean[] = [];
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4;
      row.push(data[i] + data[i + 1] + data[i + 2] < 384);
    }
    out.push(row);
  }
  return out;
}

/** The drawn lines of text in a rectangle, top to bottom: the first and last dark column of each band of rows with
 * dark pixels, in device pixels from the rectangle's left. */
function textLines(
  s: Scene,
  x: number,
  y: number,
  w: number,
  h: number
): Array<{ left: number; right: number }> {
  const lines: Array<{ left: number; right: number }> = [];
  let current: { left: number; right: number } | null = null;
  for (const row of darkPixels(s, x, y, w, h)) {
    const left = row.indexOf(true);
    if (left < 0) {
      current = null;
      continue;
    }
    const right = row.lastIndexOf(true);
    if (!current) {
      current = { left, right };
      lines.push(current);
    } else {
      current.left = Math.min(current.left, left);
      current.right = Math.max(current.right, right);
    }
  }
  return lines;
}

/** Keeps one anchor of the label layer's compiled anchors, moves the sample to the map's middle so the label has
 * room on either side, and resolves with the sample's pixel once the map has drawn it. */
async function keepAnchor(s: Scene, anchor: "left" | "right"): Promise<[number, number]> {
  const layer = `${s.input!.id}-label`;
  const anchors = s.map.getLayoutProperty(layer, "text-variable-anchor-offset") as Array<
    string | [number, number]
  >;
  const at = anchors.indexOf(anchor);
  expect(at, `${anchor} among ${JSON.stringify(anchors)}`).toBeGreaterThanOrEqual(0);
  s.map.setLayoutProperty(layer, "text-variable-anchor-offset", [anchor, anchors[at + 1]]);
  const where = s.map.unproject(s.placed[0].pixel);
  s.map.jumpTo({ center: where });
  const idle = s.map.once("idle");
  s.map.triggerRepaint();
  await idle;
  const { x, y } = s.map.project(where);
  return [x, y];
}

/** How far apart two lines may start (or end) and still count as lined up, in device pixels: a glyph's side bearing. */
const ALIGNED = 3;
/** The short line's width is far less than the long one's: centred, its ends sit well inside the long line's. */
const CENTRED = 20;
/** The strip read on each side of the marker: past the marker's half size, up to the label's full width. */
const GAP = 6;
const STRIP = { w: 220, h: 60 };

describe("multi-line labels beside their marker", () => {
  it("to the right of the marker the lines start at the same x, next to it", async () => {
    const s = await scene(point("label-right", TWO_LINES));
    const [x, y] = await keepAnchor(s, "left");

    const lines = textLines(s, x + GAP, y - STRIP.h / 2, STRIP.w, STRIP.h);
    expect(lines.length).toBe(2);
    expect(Math.abs(lines[0].left - lines[1].left), JSON.stringify(lines)).toBeLessThanOrEqual(ALIGNED);
  });

  it("to the left of the marker the lines end at the same x, next to it", async () => {
    const s = await scene(point("label-left", TWO_LINES));
    const [x, y] = await keepAnchor(s, "right");

    const lines = textLines(s, x - GAP - STRIP.w, y - STRIP.h / 2, STRIP.w, STRIP.h);
    expect(lines.length).toBe(2);
    expect(Math.abs(lines[0].right - lines[1].right), JSON.stringify(lines)).toBeLessThanOrEqual(ALIGNED);
  });

  it("MapLibre centres the lines when the layer leaves the justification unset", async () => {
    const s = await scene(point("label-centred", TWO_LINES));
    const layer = `${s.input!.id}-label`;
    s.map.setLayoutProperty(layer, "text-justify", undefined);
    const [x, y] = await keepAnchor(s, "left");

    const lines = textLines(s, x + GAP, y - STRIP.h / 2, STRIP.w, STRIP.h);
    expect(lines.length).toBe(2);
    expect(lines[0].left - lines[1].left, JSON.stringify(lines)).toBeGreaterThan(CENTRED);
    expect(lines[1].right - lines[0].right, JSON.stringify(lines)).toBeGreaterThan(CENTRED);
  });
});

/** Upright strokes in black on a white marker, centred on the point: the slant of the drawn text shows the font. */
const STEMS = (font?: JsonObject): JsonObject => ({
  version: 1,
  kind: "vector",
  symbol: {
    marker: { shape: "circle", color: "#ffffff", size: 8 },
    outline: false,
    label: {
      text: "IIIIII",
      size: 24,
      color: "#000000",
      halo: { width: 0 },
      placement: "center",
      ...(font ? { font } : {}),
    },
  },
});

/** Moves the sample to the map's middle and resolves with its pixel once the map has drawn it. */
async function centred(s: Scene): Promise<[number, number]> {
  const where = s.map.unproject(s.placed[0].pixel);
  s.map.jumpTo({ center: where });
  const idle = s.map.once("idle");
  s.map.triggerRepaint();
  await idle;
  const { x, y } = s.map.project(where);
  return [x, y];
}

/** How far right the ink of the text's top rows starts of the ink of its bottom rows, in device pixels. */
async function slantOf(s: Scene): Promise<number> {
  const [x, y] = await centred(s);
  const rows = darkPixels(s, x - 80, y - 30, 160, 60).filter((row) => row.includes(true));
  expect(rows.length).toBeGreaterThan(8);
  const start = (band: boolean[][]) => Math.min(...band.map((row) => row.indexOf(true)));
  return start(rows.slice(0, 3)) - start(rows.slice(-3));
}

describe("italic labels", () => {
  it("draw slanted, from the Noto Sans Italic glyphs", async () => {
    const upright = await slantOf(await scene(point("stems-regular", STEMS())));
    expect(Math.abs(upright)).toBeLessThanOrEqual(1);
    const italic = await slantOf(await scene(point("stems-italic", STEMS({ style: "italic" }))));
    expect(italic).toBeGreaterThanOrEqual(3);
  });

  it("draw bold italic slanted and heavier than italic, from GOAT's own Bold Italic glyphs", async () => {
    // Each measure centres its own scene once.
    const BOLD_ITALIC = STEMS({ weight: "bold", style: "italic" });
    const italicInk = await inkOf(await scene(point("stems-italic", STEMS({ style: "italic" }))));
    expect(await inkOf(await scene(point("stems-bold-italic", BOLD_ITALIC)))).toBeGreaterThan(
      italicInk * 1.2
    );
    expect(await slantOf(await scene(point("stems-bold-italic-slant", BOLD_ITALIC)))).toBeGreaterThanOrEqual(
      3
    );
    const glyphs = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .map((entry) => decodeURIComponent(new URL(entry.name).pathname))
      .filter((path) => path.endsWith(".pbf"));
    expect(glyphs).toContain("/glyphs/noto-sans-bold-italic/0-255.pbf");
  });

  it("draw light and medium between their neighbours' weights", async () => {
    const ink = async (id: string, weight?: string) =>
      inkOf(await scene(point(id, STEMS(weight ? { weight } : undefined))));
    const [light, regular, medium, bold] = [
      await ink("stems-light", "light"),
      await ink("stems-regular"),
      await ink("stems-medium", "medium"),
      await ink("stems-bold", "bold"),
    ];
    expect(light).toBeLessThan(regular);
    expect(regular).toBeLessThan(medium);
    expect(medium).toBeLessThan(bold);
  });
});

/** The dark pixels of the sample's text, once it sits in the map's middle. */
async function inkOf(s: Scene): Promise<number> {
  const [x, y] = await centred(s);
  return darkPixels(s, x - 80, y - 30, 160, 60)
    .flat()
    .filter(Boolean).length;
}
