// Polygons with a height (spec 7.5): one fill-extrusion layer in place of the fill, labels on the roofs.
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { extrudes } from "@/lib/style/compile/polygons";
import type { LayerStyle } from "@/lib/style/generated/types";

import { evaluate, maplibreErrors } from "./maplibre";

const tiles = { type: "tiles" as const, id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] };

const poly = (symbol: object, extra: object = {}) =>
  compileLayer({
    id: "7",
    style: { version: 1, kind: "vector", symbol, ...extra } as LayerStyle,
    geometry: "polygon",
    source: tiles,
    highlight: true,
  });

const fillOf = (out: ReturnType<typeof poly>) => out.layers.find((l) => l.id === "7-fill")!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const paintOf = (out: ReturnType<typeof poly>): Record<string, any> =>
  (fillOf(out) as { paint?: Record<string, unknown> }).paint ?? {};

describe("extruded polygons", () => {
  it("an extruded fill is one fill-extrusion with height, base and colour", () => {
    const out = poly({
      fill: { color: "#d9d9d9", opacity: 0.9 },
      extrude: { height: { field: "height" }, base: 2 },
    });
    const fill = fillOf(out);
    expect(fill.type).toBe("fill-extrusion");
    expect(paintOf(out)).toMatchObject({
      "fill-extrusion-height": ["to-number", ["get", "height"], 0],
      "fill-extrusion-base": ["min", 2, ["to-number", ["get", "height"], 0]],
      "fill-extrusion-opacity": 0.9,
    });
    expect(JSON.stringify(paintOf(out)["fill-extrusion-color"])).toContain("feature-state");
    expect(JSON.stringify(fill)).not.toContain("sort-key");
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
  });

  it("a part with no height stands 10 m; a feature without the field stands flat", () => {
    expect(paintOf(poly({ extrude: {} }))["fill-extrusion-height"]).toBe(10);
    const height = paintOf(poly({ extrude: { height: { field: "height" } } }))["fill-extrusion-height"];
    expect(evaluate(height, {})).toBe(0);
    expect(evaluate(height, { height: 25 })).toBe(25);
  });

  it("storeys multiply a raw field by 3", () => {
    const out = poly({ extrude: { height: { field: "levels" }, unit: "storeys" } });
    expect(paintOf(out)["fill-extrusion-height"]).toEqual(["*", ["to-number", ["get", "levels"], 0], 3]);
  });

  it("storeys leave fixed heights and ranges in metres", () => {
    const out = poly({ extrude: { height: 12, unit: "storeys" } });
    expect(paintOf(out)["fill-extrusion-height"]).toBe(12);
  });

  it("no pattern layer and a ground outline", () => {
    const out = poly({ fill: { pattern: "hatch_45" }, outline: { width: 1 }, extrude: { height: 10 } });
    expect(out.layers.map((l) => [l.id, l.type])).toEqual([
      ["7-fill", "fill-extrusion"],
      ["7-outline", "line"],
    ]);
  });

  it("the layer opacity multiplies the fill opacity", () => {
    const out = poly({ fill: { opacity: 0.8 }, extrude: { height: 10 } }, { opacity: 0.5 });
    expect(paintOf(out)["fill-extrusion-opacity"]).toBe(0.4);
  });

  it("labels of an extruded layer sit on the roof", () => {
    const out = poly({ extrude: { height: { field: "height" } }, label: { text: "{name}" } });
    const label = out.layers.find((l) => l.type === "symbol")!;
    expect((label.layout as Record<string, unknown>)["symbol-height-offset"]).toEqual([
      "to-number",
      ["get", "height"],
      0,
    ]);
    expect(out.tileParams.fields).toContain("height");
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
  });

  it("labels of a flat layer have no height", () => {
    const out = poly({ label: { text: "{name}" } });
    expect(JSON.stringify(out.layers)).not.toContain("symbol-height-offset");
  });

  it("flat classes stay valid", () => {
    const out = poly(
      { extrude: { height: 20 } },
      { classify: [{ field: "use", method: "categories", classes: [{ values: ["green"], extrude: false }] }] }
    );
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
    expect(evaluate(paintOf(out)["fill-extrusion-height"], { use: "green" })).toBe(0);
  });

  it("a class can raise features of a flat layer", () => {
    const out = poly(
      {},
      { classify: [{ field: "use", method: "categories", classes: [{ values: ["tower"], extrude: {} }] }] }
    );
    const height = paintOf(out)["fill-extrusion-height"];
    expect(evaluate(height, { use: "tower" })).toBe(10);
    expect(evaluate(height, { use: "house" })).toBe(0);
  });

  it("extrudes says whether any record or the H3 render raises features", () => {
    const style = (extra: object) => ({ version: 1, kind: "vector", ...extra });
    expect(extrudes(style({}))).toBe(false);
    expect(extrudes(style({ symbol: { extrude: false } }))).toBe(false);
    expect(extrudes(style({ symbol: { extrude: { height: 3 } } }))).toBe(true);
    expect(extrudes(style({ rules: [{ extrude: {} }] }))).toBe(true);
    expect(extrudes(style({ render: { type: "h3", extrude: { tallest: 500 } } }))).toBe(true);
    expect(extrudes(style({ render: { type: "h3" } }))).toBe(false);
  });
});
