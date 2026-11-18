// Every lab case drawn and checked: no error, every image the map asked for present, every sample drawn where it is
// placed (and none its class or rule hides at the map's zoom) and in its legend swatch's color; a case of points in
// groups (clusters, a heatmap, a legend without entries) draws something. A known difference (legend/known.ts, check
// "lab") shows in its one finding and in no other.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isObject } from "@/lib/style/json";
import { buildLegend } from "@/lib/style/legend";

import { pointsDrawn } from "../legend/caseList";
import { known } from "../legend/known";
import { labCases } from "./cases";
import { blank, colorMismatches, drawnHidden, missingImages, notDrawn } from "./checks";
import { type Scene, closeScene, renderScene } from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

describe("legend cases without samples", () => {
  // A heatmap below its points zoom and a legend of ramps or sizes alone list no entry to sample: their scenes draw
  // points in groups instead, so a map that draws nothing fails (the blank check below).
  it("draw points in groups", () => {
    const without = labCases().filter((c) => {
      if (!c.legendCase) return false;
      const legend = buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom });
      return !pointsDrawn(c.legendCase) || !legend?.sections.some((section) => section.kind === "entries");
    });
    // Pinned: a legend change that moves a case here, where only the blank check reads it, shows in this list.
    expect(without.map((c) => c.id)).toEqual([
      "v002",
      "v015",
      "v018",
      "v021",
      "v028",
      "v031",
      "v034",
      "v038",
      "v041",
      "v044",
      "v045",
      "v046",
      "v060",
      "v093",
      "v098",
      "v099",
      "v102",
      "v109",
      "v110",
      "v116",
      "spec-725",
      "spec-1473",
      "spec-1666",
      "spec-463",
    ]);
    expect(without.filter((c) => !c.groups?.length).map((c) => c.id)).toEqual([]);
  });
});

describe("every lab case", () => {
  it.each(labCases().map((c) => [c.id, c] as const))("%s", async (_, c) => {
    const s = await renderScene(c);
    scenes.push(s);
    const found = {
      errors: s.errors,
      missingImages: missingImages(s),
      notDrawn: notDrawn(s).map((p) => `${p.section}/${p.entry.id}`),
      drawnHidden: drawnHidden(s).map((p) => `${p.section}/${p.entry.id}`),
      colorMismatches: colorMismatches(s),
    };
    const difference = known("lab", c.legendCase ?? c);
    const expected = { errors: [], missingImages: [], notDrawn: [], drawnHidden: [], colorMismatches: [] };
    if (difference?.finding) {
      expect(found[difference.finding].length, difference.reason).toBeGreaterThan(0);
      expect({ ...found, [difference.finding]: [] }).toEqual(expected);
    } else expect(found).toEqual(expected);
    if (c.groups) expect(blank(s), "the points in groups draw nothing").toBe(false);
  });
});

describe("labels", () => {
  // The label layers' text for each feature, as MapLibre evaluated and drew it: a label whose glyphs do not load
  // draws no text, and its request lands in `errors`.
  it.each(["point-labels", "line-labels"])("%s draws each sample's text", async (id) => {
    const s = await renderScene(labCases().find((c) => c.id === id)!);
    scenes.push(s);
    expect(s.errors).toEqual([]);
    const layers = (s.compiled?.layers ?? [])
      .filter((l) => l.type === "symbol" && isObject(l.layout) && l.layout["text-field"] !== undefined)
      .map((l) => l.id);
    expect(layers.length).toBeGreaterThan(0);
    const drawn = new Map<unknown, string>();
    for (const f of s.map.queryRenderedFeatures({ layers })) {
      const field = f.layer.layout?.["text-field"] as unknown;
      const sections = isObject(field) && Array.isArray(field.sections) ? field.sections : [];
      drawn.set(f.id, sections.map((part) => (isObject(part) ? String(part.text) : "")).join(""));
    }
    expect(s.placed.length).toBeGreaterThan(0);
    for (const p of s.placed) {
      const values = p.entry.values ?? [];
      expect(drawn.get(p.featureId), `${p.section}/${p.entry.id}`).toBe(String(values[0]));
    }
  });

  // A label font by the categories the color sets: the map draws each category's labels in its font, and the legend
  // keeps the color's block and the size's, headed by what they set, with nothing of the font.
  it("a label font by classes changes the labels, and no block of the legend", async () => {
    const s = await renderScene(labCases().find((c) => c.id === "label-font-classes")!);
    scenes.push(s);
    expect(s.errors).toEqual([]);
    const headings = [...s.root.querySelectorAll("[data-lab-legend] .MuiTypography-caption")]
      .map((node) => node.textContent ?? "")
      .filter((text) => text.includes("·"));
    expect(headings).toEqual(["Color · category", "Size · amount"]);
    const layers = (s.compiled?.layers ?? [])
      .filter((l) => l.type === "symbol" && isObject(l.layout) && l.layout["text-field"] !== undefined)
      .map((l) => l.id);
    const fonts = new Map<unknown, unknown>();
    for (const f of s.map.queryRenderedFeatures({ layers }))
      fonts.set(f.properties.category, f.layer.layout?.["text-font"]);
    expect(Object.fromEntries(fonts)).toEqual({ a: ["Noto Sans Bold"], b: ["Noto Sans Italic"] });
  });
});
