// Polygon outlines on the map: where an outline at each position (spec 3.1) is drawn against its polygon's edge, on a
// square and on a square with a hole, with the rings wound either way round. The outline's pixels are read along one
// row of the map across the edges.
import type { GeoJSONSource } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/style/json";

import { type LabCase, SAMPLE_SIZE, type Scene, closeScenes, renderScene } from "./scene";

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

/** The outline's width in px: wide enough to read where it lies against the edge. */
const WIDTH = 8;
/** How far a drawn edge may be from where it is expected, in CSS pixels: antialiasing. */
const SLACK = 1.5;

const outlined = (position: string): JsonObject => ({
  version: 1,
  kind: "vector",
  symbol: {
    fill: { color: "#dddddd" },
    outline: { color: "#ff0000", width: WIDTH, position },
  },
});

const polygon = (id: string, style: JsonObject): LabCase => ({
  id,
  style,
  geometry: "polygon",
  zoom: 4,
  fields: {},
});

/** The runs of outline-red pixels along the map's row `y` between `from` and `to`, in CSS pixels of the map. */
function redRuns(s: Scene, y: number, from: number, to: number): Array<[number, number]> {
  const canvas = s.map.getCanvas();
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
  const ratio = s.map.getPixelRatio();
  const x0 = Math.max(0, Math.round(from * ratio));
  const x1 = Math.min(gl.drawingBufferWidth, Math.round(to * ratio));
  const row = Math.round(y * ratio);
  const data = new Uint8Array((x1 - x0) * 4);
  // readPixels counts rows from the bottom of the drawing buffer.
  gl.readPixels(x0, gl.drawingBufferHeight - row - 1, x1 - x0, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= x1 - x0; i++) {
    const red = i < x1 - x0 && data[i * 4] > 200 && data[i * 4 + 1] < 90 && data[i * 4 + 2] < 90;
    if (red && start < 0) start = i;
    if (!red && start >= 0) {
      runs.push([(x0 + start) / ratio, (x0 + i) / ratio]);
      start = -1;
    }
  }
  return runs;
}

/** Where the outline lies against an edge at `edge` whose polygon side is `side` (+1: right of it, -1: left of it):
 * "inside" all on the polygon's side, "outside" all on the other, "center" across it. */
function placeOf([a, b]: [number, number], edge: number, side: 1 | -1): string {
  const [near, far] = side === 1 ? [a - edge, b - edge] : [edge - b, edge - a];
  if (near >= -SLACK && far <= WIDTH + SLACK) return "inside";
  if (far <= SLACK && near >= -WIDTH - SLACK) return "outside";
  if (near < -SLACK && far > SLACK) return "center";
  return `elsewhere (${a} to ${b}, edge ${edge})`;
}

/** A ring of a square around a pixel, as map coordinates, counterclockwise on the map unless `clockwise`. */
function square(s: Scene, [x, y]: [number, number], side: number, clockwise: boolean): number[][] {
  const at = (px: number, py: number) => s.map.unproject([px, py]).toArray();
  const h = side / 2;
  const ring = [at(x - h, y - h), at(x - h, y + h), at(x + h, y + h), at(x + h, y - h)];
  if (clockwise) ring.reverse();
  return [...ring, ring[0]];
}

/** Draws one polygon with a hole in place of the scene's samples, the rings wound as GeoJSON wants them (outer ring
 * counterclockwise, hole clockwise) or the other way round, and waits until the map has drawn it. */
async function drawWithHole(
  s: Scene,
  center: [number, number],
  outer: number,
  hole: number,
  wound: "rfc7946" | "reversed"
): Promise<void> {
  const reversed = wound === "reversed";
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 1,
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [square(s, center, outer, reversed), square(s, center, hole, !reversed)],
        },
      },
    ],
  };
  const source = Object.keys(s.compiled!.sources)[0];
  const idle = s.map.once("idle");
  (s.map.getSource(source) as GeoJSONSource).setData(data);
  await idle;
}

describe("polygon outline positions", () => {
  for (const position of ["center", "inside", "outside"]) {
    it(`a square's outline at "${position}"`, async () => {
      const s = await scene(polygon(`outline-${position}`, outlined(position)));
      const [x, y] = s.placed[0].pixel;
      const left = x - SAMPLE_SIZE / 2;
      const right = x + SAMPLE_SIZE / 2;

      const runs = redRuns(s, y, left - 20, right + 20);
      expect(runs.length, JSON.stringify(runs)).toBe(2);
      expect(placeOf(runs[0], left, 1)).toBe(position);
      expect(placeOf(runs[1], right, -1)).toBe(position);
    });
  }

  for (const wound of ["rfc7946", "reversed"] as const) {
    for (const position of ["inside", "outside"]) {
      it(`a polygon with a hole, rings wound ${wound}: the outline at "${position}" of both rings`, async () => {
        const s = await scene(polygon(`hole-${position}-${wound}`, outlined(position)));
        const center: [number, number] = [320, 240];
        const [outer, hole] = [160, 60];
        await drawWithHole(s, center, outer, hole, wound);
        const [x, y] = center;

        // Along the middle row: the outer ring's left edge, the hole's left and right edges, the outer right edge.
        const runs = redRuns(s, y, x - outer / 2 - 20, x + outer / 2 + 20);
        expect(runs.length, JSON.stringify(runs)).toBe(4);
        expect(placeOf(runs[0], x - outer / 2, 1)).toBe(position);
        // The polygon lies left of the hole's left edge and right of its right edge.
        expect(placeOf(runs[1], x - hole / 2, -1)).toBe(position);
        expect(placeOf(runs[2], x + hole / 2, 1)).toBe(position);
        expect(placeOf(runs[3], x + outer / 2, -1)).toBe(position);
      });
    }
  }
});
