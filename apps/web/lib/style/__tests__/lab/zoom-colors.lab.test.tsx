// A color by attribute that changes with the zoom (spec 4.4) on a marker image, drawn between two stops and between
// two whole zooms: each pin the map draws is in its legend ramp's color at its value. The map picks a marker image per
// tile, at the tile's whole zoom, where the image's name holds the color the stops blend to; the legend shows that.
import { Color } from "@maplibre/maplibre-gl-style-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { labCases } from "./cases";
import { type DrawnLayer, type Rgb, distance, markerPlace, missingImages, readRect } from "./checks";
import { type Scene, closeScene, renderScene } from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

/** How far a drawn channel may be from the expected one, of 255. */
const TOLERANCE = 10;
/** How many pixels of the read must have the expected color. */
const MIN_PIXELS = 3;

const rgb = (color: string): Rgb => {
  const c = Color.parse(color)!;
  return [c.r, c.g, c.b].map((x) => Math.round(x * 255)) as Rgb;
};

describe("colors by attribute in zoom stops on marker images", () => {
  it("each pin is drawn in its legend ramp's color at its value", async () => {
    const c = labCases().find((one) => one.id === "zoom-colors")!;
    const s = await renderScene(c);
    scenes.push(s);
    expect(s.errors).toEqual([]);
    expect(missingImages(s)).toEqual([]);
    expect(s.map.getZoom()).toBe(13.5);
    const ramp = s.legend?.sections.find((one) => one.kind === "ramp");
    if (ramp?.kind !== "ramp") throw new Error("no ramp in the legend");
    // Halfway from the stop at 11 to the one at 15, at the whole zoom 13 below the map's.
    expect([ramp.colors[0], ramp.colors[ramp.colors.length - 1]]).toEqual(["#800080", "#80ff00"]);
    const pins = s.map.queryRenderedFeatures({ layers: [`${c.id}-marker`] });
    expect(pins).toHaveLength(2);
    c.groups!.forEach((group, end) => {
      const amount = group.points[0].amount;
      const pin = pins.find((f) => f.properties.amount === amount);
      expect(pin, `a pin at ${amount}`).toBeDefined();
      const { read } = markerPlace(s, { pixel: group.at }, [pin!.layer as unknown as DrawnLayer]);
      const want = rgb(end === 0 ? ramp.colors[0] : ramp.colors[ramp.colors.length - 1]);
      const pixels = readRect(s, read);
      const near = pixels.filter((p) => distance(p, want) <= TOLERANCE);
      expect(
        near.length,
        `pin at ${amount}: want ${want}, read ${JSON.stringify(pixels)}`
      ).toBeGreaterThanOrEqual(MIN_PIXELS);
    });
  });
});
