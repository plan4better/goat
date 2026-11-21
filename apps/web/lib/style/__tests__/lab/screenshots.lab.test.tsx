// Chosen scenes compared with screenshots: the map and its legend as one picture, against the baseline in
// __screenshots__/ (`pnpm --filter @p4b/web lab:update` rewrites them). The other lab checks look at single pixels and
// features; a picture also catches a change in how a whole scene looks (an outline, a ramp, a label's place).
// Baselines are made with the pinned Playwright's Chromium on Linux, so the test runs on Linux only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { labCases } from "./cases";
import { type Scene, closeScene, renderScene } from "./scene";

/** The scenes compared, one or two of each kind. A spec example's id is the `line` field its fixture entry
 * (spec_examples.json) carries: a fixed label, which stays when the spec text moves. */
export const SCREENSHOT_CASES: string[] = [
  // The style shapes saved most often, first.
  "polygon-categories",
  "spec-1569", // a plain circle
  "spec-201", // a plain area, with its opacity
  "one-icon",
  "polygon-quantile",
  "plain-line",
  "spec-844", // an icon and a color by category, with Other
  "spec-1509", // circles by category, with Other
  "circle-quantile",
  "spec-1015", // areas in manual classes
  "polygon-label",
  "line-categories",
  // Outline-only areas and markers.
  "spec-218",
  "spec-409",
  // A color ramp over a computed domain.
  "polygon-ramp",
  // Categories with No data.
  "no-data",
  // A layer's opacity, over the base look of a ramp without a domain.
  "spec-1403",
  // Sizes: markers by a field, line widths by class.
  "spec-725",
  "line-widths",
  // Rules.
  "spec-1261",
  // Labels.
  "point-labels",
  // Icons.
  "upload-on-circle",
  "emoji-on-pin",
  // Shapes.
  "squares",
  "pins",
  // Patterns.
  "patterns",
  // Dashes.
  "dashes",
  // Icons along a line, the legend's line with the icon.
  "line-icons",
  "line-upright-icons",
  // Clusters: circles, icons with a count badge, a sum as label.
  "cluster-circle",
  "cluster-icons",
  "cluster-sum",
  // Heatmaps, one weighted by a field.
  "heatmap",
  "spec-1666",
  // Extrusion.
  "extrusion",
];

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

describe.skipIf(!navigator.userAgent.includes("Linux"))("screenshots", () => {
  it.each(SCREENSHOT_CASES)("%s", async (id) => {
    const c = labCases().find((one) => one.id === id);
    expect(c, `no lab case ${id}`).toBeDefined();
    const s = await renderScene(c!);
    scenes.push(s);
    // A scene that did not settle, or whose font or icons did not load, is not worth a picture.
    expect(s.errors).toEqual([]);
    await expect(s.root).toMatchScreenshot(id);
  });
});
