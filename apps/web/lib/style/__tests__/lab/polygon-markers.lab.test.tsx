// Markers on polygons and lines on the map (spec 3.3): drawn by the app's compiler and renderer on a real MapLibre
// map from the lab's GeoJSON source, where MapLibre places the marker inside each polygon itself and at the middle of
// each line (vector tiles draw it at geoapi's anchors instead, which the compiler tests check). The marker shows in
// the middle of its feature in the color its legend swatch gives it, and only on the features that have one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/style/json";

import { readRows } from "./checks";
import { type LabCase, SAMPLE_SIZE, type Scene, closeScene, renderScene } from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

async function scene(c: LabCase): Promise<Scene> {
  const drawn = await renderScene(c);
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

/** The color the map drew at a pixel of the map, as `#rrggbb`. */
function colorAt(s: Scene, [x, y]: [number, number]): string {
  const [pixel] = readRows(s, { x, y, w: 1, h: 1 })[0];
  return `#${pixel.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether two colors are the same but for antialiasing. */
function near(a: string, b: string): boolean {
  const rgb = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return x.every((v, i) => Math.abs(v - y[i]) <= 6);
}

/** That a drawn color is the wanted one but for antialiasing. */
function expectNear(drawn: string, want: string): void {
  expect(near(drawn, want), `drawn ${drawn}, want ${want}`).toBe(true);
}

const FILL = "#dddddd";
const MARKER = "#d7301f";

const style = (symbol: JsonObject, extra: JsonObject = {}): JsonObject => ({
  version: "1.0.0",
  kind: "vector",
  symbol,
  ...extra,
});

describe("markers on polygons and lines", () => {
  it("a polygon draws its marker in its middle, in the legend's color", async () => {
    const s = await scene({
      id: "polygon-marker",
      geometry: "polygon",
      zoom: 4,
      fields: {},
      style: style({ fill: { color: FILL }, marker: { color: MARKER, size: 24 } }),
    });
    const [sample] = s.placed;
    expect(sample.swatch.marker?.color).toBe(MARKER);
    expect(sample.swatch.fill?.color).toBe(FILL);
    const [x, y] = sample.pixel;
    expectNear(colorAt(s, [x, y]), MARKER);
    // Inside the polygon, away from the 24 px marker: the fill.
    expectNear(colorAt(s, [x + SAMPLE_SIZE / 2 - 4, y + SAMPLE_SIZE / 2 - 4]), FILL);
    // The marker is drawn as an image (no circle at each corner of the polygon).
    expect(s.requestedImages.some((name) => name.startsWith("goat-marker:"))).toBe(true);
    expect(near(colorAt(s, [x - SAMPLE_SIZE / 2, y - SAMPLE_SIZE / 2]), MARKER)).toBe(false);
  });

  it("a class switches the marker on for its polygons alone", async () => {
    const s = await scene({
      id: "polygon-marker-class",
      geometry: "polygon",
      zoom: 4,
      fields: { land_use: "string" },
      style: style(
        { fill: { color: FILL } },
        {
          classify: [
            {
              id: "use",
              field: "land_use",
              method: "categories",
              classes: [
                { id: "green", values: ["green"], name: "Green", marker: { color: MARKER, size: 24 } },
                { id: "mixed", values: ["mixed"], name: "Mixed" },
              ],
            },
          ],
        }
      ),
    });
    const green = s.placed.find((p) => p.entry.id === "green")!;
    const mixed = s.placed.find((p) => p.entry.id === "mixed")!;
    expect(green.swatch.marker?.color).toBe(MARKER);
    expect(mixed.swatch.marker).toBeUndefined();
    expectNear(colorAt(s, green.pixel), green.swatch.marker?.color as string);
    expectNear(colorAt(s, mixed.pixel), FILL);
  });

  it("a line draws its marker at its middle, in the legend's color", async () => {
    const s = await scene({
      id: "line-marker",
      geometry: "line",
      zoom: 4,
      fields: {},
      style: style({
        line: { color: "#2166ac", width: 2 },
        marker: { shape: "square", color: MARKER, size: 16 },
      }),
    });
    const [sample] = s.placed;
    const [x, y] = sample.pixel;
    // Just off the line, which runs through the middle of the square marker.
    expect(near(colorAt(s, [x + 4, y - 5]), sample.swatch.marker?.color as string)).toBe(true);
    // Near the line's ends, no marker.
    expectNear(colorAt(s, [x + SAMPLE_SIZE / 2 - 3, y - 5]), "#ffffff");
  });
});
