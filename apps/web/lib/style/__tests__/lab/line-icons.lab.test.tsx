// Icons along a line on the map (spec 3.2 `arrows.icon`): drawn by the app's compiler and renderer on a real MapLibre
// map. A library icon repeats along the line in the arrows' color; an upload repeats in its own colors (the lab's
// fixture icon, a blue square with an orange dot), never tinted; the line's legend swatch carries the icon. An icon
// turns with the line, or stays upright where the style says so.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { labCases } from "./cases";
import { type Rgb, readRect, readRows } from "./checks";
import { SAMPLE_SIZE, type Scene, closeScene, renderScene } from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

async function scene(id: string, arrows: object = {}): Promise<Scene> {
  const c = labCases().find((one) => one.id === id);
  expect(c, `no lab case ${id}`).toBeDefined();
  const symbol = c!.style.symbol as Record<string, Record<string, unknown>>;
  const style = { ...c!.style, symbol: { ...symbol, arrows: { ...symbol.arrows, ...arrows } } };
  const drawn = await renderScene({ ...c!, style });
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

/** The colors the map drew in a box of CSS pixels around a point, one per device pixel. */
const colorsAround = (s: Scene, [x, y]: [number, number], [w, h]: [number, number]): Rgb[] =>
  readRect(s, { x: x - w / 2, y: y - h / 2, w, h });

const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
/** How many of the colors are `hex` but for antialiasing. */
const count = (colors: Rgb[], hex: string) =>
  colors.filter((c) => c.every((v, i) => Math.abs(v - rgb(hex)[i]) <= 8)).length;

/** How many pixels of `hex` (within the blends of its edges) lie in the outer thirds of their own bounding box, in a
 * box of CSS pixels around a point: a triangle has most of them on the side of its base. */
function thirds(s: Scene, [x, y]: [number, number], [w, h]: [number, number], hex: string) {
  const want = rgb(hex);
  const hits: [number, number][] = [];
  readRows(s, { x: x - w / 2, y: y - h / 2, w, h }).forEach((row, r) =>
    row.forEach((c, col) => {
      if (c.every((v, i) => Math.abs(v - want[i]) <= 40)) hits.push([r, col]);
    })
  );
  const rows = hits.map(([r]) => r);
  const cols = hits.map(([, c]) => c);
  const at = (v: number, lo: number, hi: number) => (v - lo) / (hi - lo + 1);
  const [r0, r1, c0, c1] = [Math.min(...rows), Math.max(...rows), Math.min(...cols), Math.max(...cols)];
  return {
    all: hits.length,
    top: hits.filter(([r]) => at(r, r0, r1) < 1 / 3).length,
    bottom: hits.filter(([r]) => at(r, r0, r1) >= 2 / 3).length,
    left: hits.filter(([, c]) => at(c, c0, c1) < 1 / 3).length,
    right: hits.filter(([, c]) => at(c, c0, c1) >= 2 / 3).length,
  };
}

describe("icons along a line", () => {
  it("a library icon repeats along the line in the arrows' color", async () => {
    const s = await scene("line-icons");
    expect(s.requestedImages).toContain("goat:rail-light");
    expect(s.map.hasImage("goat:rail-light")).toBe(true);
    const [sample] = s.placed;
    expect(sample.swatch.arrows).toMatchObject({ icon: "goat:rail-light", color: "#d7301f" });
    const colors = colorsAround(s, sample.pixel, [SAMPLE_SIZE, 24]);
    expect(count(colors, "#d7301f")).toBeGreaterThan(10);
  });

  it("an upload repeats along the line in its own colors", async () => {
    const s = await scene("line-upload-icons");
    expect(s.requestedImages).toContain("asset:lab-icon");
    expect(s.map.hasImage("asset:lab-icon")).toBe(true);
    const [sample] = s.placed;
    expect(sample.swatch.arrows).toMatchObject({ icon: "asset:lab-icon" });
    const colors = colorsAround(s, sample.pixel, [SAMPLE_SIZE, 24]);
    // The fixture's orange dot, which no tint (the line's blue) would leave.
    expect(count(colors, "#f6ad55")).toBeGreaterThan(10);
  });

  // GOAT's arrow points north; along the line (left to right here) it turns to point east, its base on the left.
  it("an icon that stays upright is drawn unturned on the line", async () => {
    const upright = await scene("line-upright-icons");
    const [sample] = upright.placed;
    const box: [number, number] = [SAMPLE_SIZE + 30, 40];
    const up = thirds(upright, sample.pixel, box, "#d7301f");
    expect(up.all).toBeGreaterThan(50);
    expect(up.bottom).toBeGreaterThan(3 * up.top);
    expect(Math.max(up.left, up.right)).toBeLessThan(1.5 * Math.min(up.left, up.right));

    const turned = await scene("line-upright-icons", { turn_with_line: true });
    const along = thirds(turned, turned.placed[0].pixel, box, "#d7301f");
    expect(along.all).toBeGreaterThan(50);
    expect(along.left).toBeGreaterThan(3 * along.right);
  });
});
