// The analysis tools' default styles on the results the tools produce: each committed snapshot (a tool's result and the
// default style the tool's own code gives it, written by goatlib's tests/unit/tools/tool_style_cases.py) drawn on the
// light basemap's ground with its legend beside the map. The legend says what the style says (title, classes, No data
// where the data has features without a value, the unit), and the cases with a look of their own are compared with
// their baselines in __screenshots__/ (`pnpm --filter @p4b/web lab:update` rewrites them, after the snapshots are
// rewritten with GOAT_WRITE_FIXTURES=1). Baselines are made with the pinned Playwright's Chromium on Linux.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FieldType, Geometry } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";

import { LAB_GROUNDS, type Scene, closeScene, renderScene } from "./scene";

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true; import: "default" }): Record<string, T>;
  }
}

/** A snapshot as the generator writes it. */
interface ToolStyleCase {
  id: string;
  tool: string;
  layer: string;
  title: string;
  shape: string;
  source: string;
  picture: boolean;
  geometry: Geometry;
  fields: Record<string, FieldType>;
  zoom: number;
  rows: { total: number; kept: number };
  style: JsonObject;
  features: GeoJSON.FeatureCollection;
}

const SNAPSHOTS = import.meta.glob<ToolStyleCase>(
  "../../../../../../packages/python/goatlib/tests/unit/tools/fixtures/tool_styles/*.json",
  { eager: true, import: "default" }
);

const CASES = Object.values(SNAPSHOTS).sort((a, b) => a.id.localeCompare(b.id));

const classifications = (style: JsonObject): JsonObject[] =>
  Array.isArray(style.classify) ? style.classify.filter(isObject) : [];

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

it("reads every snapshot", () => {
  expect(CASES.length).toBeGreaterThan(0);
  expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
});

describe.skipIf(!navigator.userAgent.includes("Linux"))("tool styles", () => {
  it.each(CASES.map((c) => [c.id, c] as const))("%s", async (id, c) => {
    const s = await renderScene(
      {
        id,
        style: c.style,
        geometry: c.geometry,
        fields: c.fields,
        zoom: c.zoom,
        source: { type: "points", id, data: c.features },
      },
      { ground: LAB_GROUNDS.light }
    );
    scenes.push(s);
    expect(s.errors).toEqual([]);

    // A section per classification, beside the layer's base look.
    const sections = (s.legend?.sections ?? []).filter((one) => one.kind === "entries" && one.id !== "base");
    const own = classifications(c.style);
    expect(sections).toHaveLength(own.length);
    for (const k of own) {
      const key = typeof k.id === "string" ? k.id : String(k.field);
      const section = sections.find((one) => one.id === key);
      expect(section, `no legend section for ${key}`).toBeDefined();
      if (section?.kind !== "entries") continue;
      const classes = Array.isArray(k.classes) ? k.classes : [];
      const computed = isObject(k.computed) ? k.computed : {};
      expect(section.title).toBe(k.title);
      expect(section.entries.filter((entry) => !entry.extra)).toHaveLength(classes.length);
      expect(section.entries.some((entry) => entry.extra === "no_data")).toBe(computed.no_data === true);
      expect(section.unit).toBe(k.unit);
      if (typeof k.unit === "string") expect(s.root.textContent).toContain(k.unit);
    }

    if (c.picture) await expect(s.root).toMatchScreenshot(`tool-${id}`);
  });
});
