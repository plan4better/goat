// H3 hexagons as columns (3D spec 5.4, 7.6): the height follows the cell value over the computed range.
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { LayerStyle } from "@/lib/style/generated/types";

import { evaluate, maplibreErrors } from "./maplibre";

const tiles = { type: "tiles" as const, id: "s9", tiles: ["https://t/{z}/{x}/{y}"] };

const h3 = (render: object) =>
  compileLayer({
    id: "9",
    style: { version: 1, kind: "vector", render: { type: "h3", ...render } } as LayerStyle,
    geometry: "point",
    source: tiles,
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fillOf = (out: ReturnType<typeof h3>): any => out.layers.find((l) => l.id === "9-h3-fill");

const computed = { resolutions: { "8": { min: 0, max: 100 } } };

describe("H3 columns", () => {
  it("linear: half the range is half the tallest", () => {
    const fill = fillOf(h3({ computed, extrude: { tallest: 1000, scale: "linear" } }));
    expect(fill.type).toBe("fill-extrusion");
    expect(evaluate(fill.paint["fill-extrusion-height"], { value: 50, resolution: 8 })).toBe(500);
    expect(evaluate(fill.paint["fill-extrusion-height"], { value: 150, resolution: 8 })).toBe(1000);
  });

  it("square root: 25 of 0 to 100 is half the tallest", () => {
    const fill = fillOf(h3({ computed, extrude: { tallest: 1000, scale: "sqrt" } }));
    expect(evaluate(fill.paint["fill-extrusion-height"], { value: 25, resolution: 8 })).toBe(500);
  });

  it("without computed values every column is half the tallest", () => {
    const fill = fillOf(h3({ extrude: { tallest: 1000 } }));
    expect(evaluate(fill.paint["fill-extrusion-height"], { value: 7, resolution: 8 })).toBe(500);
  });

  it("the base lifts every column; tallest by zoom stays the outer curve", () => {
    const fill = fillOf(
      h3({
        computed,
        extrude: {
          tallest: {
            zoom: [
              [8, 2000],
              [14, 200],
            ],
          },
          base: 10,
          scale: "linear",
        },
      })
    );
    const height = fill.paint["fill-extrusion-height"];
    expect(height[0]).toBe("interpolate");
    expect(height[2]).toEqual(["zoom"]);
    expect(evaluate(height, { value: 50, resolution: 8 }, 8)).toBe(1010);
    expect(fill.paint["fill-extrusion-base"]).toBe(10);
  });

  it("no outline layer, the colour and opacity as before, valid in MapLibre", () => {
    const out = h3({ computed, extrude: { tallest: 1000 } });
    expect(out.layers.map((l) => l.id)).toEqual(["9-h3-fill"]);
    const fill = fillOf(out);
    expect(fill.paint["fill-extrusion-color"]).toBeDefined();
    expect(fill.paint["fill-extrusion-opacity"]).toBe(0.85);
    expect(JSON.stringify(fill)).not.toContain("sort-key");
    expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
  });

  it("flat hexagons without extrude", () => {
    expect(fillOf(h3({ computed })).type).toBe("fill");
  });
});
