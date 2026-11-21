// A size by attribute that grows with the zoom (spec 4.4) on the map, at the zoom the legend reads it at (the middle of
// its stops, spec 7.2): each circle the map draws is as large as the legend's sample for its value, as MapLibre
// evaluates it and in the pixels it draws.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { labCases } from "./cases";
import { type Rgb, WHITE, distance, readRect } from "./checks";
import { type Scene, closeScene, renderScene } from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

/** The circles' color. */
const COLOR: Rgb = [0x1a, 0x6b, 0x4d];
/** How far a drawn width may be from the one expected, in CSS pixels. */
const TOLERANCE = 0.5;

/** The width of the circle drawn at a pixel, in CSS pixels: along its row of device pixels through its middle, how
 * much of each pixel the circle covers, from its color's blend with the white ground. */
function drawnWidth(s: Scene, [x, y]: [number, number], reach: number): number {
  const ratio = s.map.getPixelRatio();
  const row = readRect(s, { x: x - reach, y, w: 2 * reach, h: 1 / ratio });
  const full = distance(COLOR, WHITE);
  return row.reduce((sum, rgb) => sum + Math.min(1, distance(rgb, WHITE) / full), 0) / ratio;
}

describe("sizes by attribute in zoom stops", () => {
  it("each circle is as large as the legend's sample for its value", async () => {
    const c = labCases().find((one) => one.id === "zoom-sizes")!;
    const s = await renderScene(c);
    scenes.push(s);
    expect(s.errors).toEqual([]);
    expect(s.map.getZoom()).toBe(13.5);
    const section = s.legend?.sections.find((one) => one.kind === "sizes");
    if (section?.kind !== "sizes") throw new Error("no size samples in the legend");
    // One point at each sample's value.
    expect(section.samples.map((sample) => sample.value)).toEqual(c.groups!.map((g) => g.points[0].pupils));
    expect(section.samples.map((sample) => sample.swatch.marker?.size)).toEqual([4.5, 11.3, 15]);
    section.samples.forEach((sample, i) => {
      const [x, y] = c.groups![i].at;
      const size = sample.swatch.marker!.size as number;
      const drawn = s.map.queryRenderedFeatures(
        [
          [x - 1, y - 1],
          [x + 1, y + 1],
        ],
        { layers: [`${c.id}-marker`] }
      );
      expect(drawn, `a circle at ${sample.value} pupils`).toHaveLength(1);
      // As MapLibre evaluates the circle for the feature at the map's zoom; the legend rounds to 0.1.
      expect(2 * Number(drawn[0].layer.paint?.["circle-radius"])).toBeCloseTo(size, 1);
      // As it draws it: MapLibre fades a circle's edge out over the outermost device pixel on each side, so the row
      // through its middle is covered one device pixel less than its size.
      const expected = size - 1 / s.map.getPixelRatio();
      expect(
        Math.abs(drawnWidth(s, [x, y], 20) - expected),
        `drawn width at ${sample.value} pupils`
      ).toBeLessThanOrEqual(TOLERANCE);
    });
  });
});
