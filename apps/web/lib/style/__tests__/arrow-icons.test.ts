// Any icon as the arrows of a line (spec 3.2 `arrows.icon`, 16): drawn like GOAT's arrow, its top along the line;
// library icons take the arrows' color, uploads and emoji keep their own.
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import type { LayerStyle } from "@/lib/style/generated/types";

import { maplibreErrors } from "./maplibre";

const compile = (arrows: object, line: object = { color: "#2166ac" }) =>
  compileLayer({
    id: "9",
    style: { version: "1.0.0", kind: "vector", symbol: { line, arrows } } as LayerStyle,
    geometry: "line",
    source: { type: "tiles", id: "s9", tiles: ["https://t/{z}/{x}/{y}"] },
  });

const arrows = (out: ReturnType<typeof compile>, suffix = "arrows") =>
  out.layers.find((l) => l.id === `9-${suffix}`) as unknown as {
    layout: Record<string, unknown>;
    paint: Record<string, unknown>;
  };

describe("arrows.icon", () => {
  it("repeats a library icon along the line, tinted with the line color, its top along the line", () => {
    const out = compile({ icon: "goat:rail-light", size: 12, direction: "both" });
    for (const [suffix, rotate] of [
      ["arrows", 90],
      ["arrows-back", 270],
    ] as const) {
      const layer = arrows(out, suffix);
      expect(layer.layout["icon-image"]).toBe("goat:rail-light");
      expect(layer.layout["icon-rotate"]).toBe(rotate);
      expect(layer.layout["icon-size"]).toBe(0.5);
      expect(layer.paint["icon-color"]).toBe("#2166ac");
    }
    expect(out.images.map((i) => [i.name, i.sdf])).toEqual([["goat:rail-light", true]]);
    expect(maplibreErrors(out.layers, out.sources)).toEqual([]);
  });

  it("takes the arrows' own color", () => {
    const out = compile({ icon: "goat:circle-solid", color: "#d7301f" });
    expect(arrows(out).paint["icon-color"]).toBe("#d7301f");
  });

  it.each(["asset:7f3a91c2", "emoji:1f525"])("draws %s in its own colors, at the line's ends too", (icon) => {
    const out = compile({ icon, placement: "both_ends", color: "#d7301f" });
    const layer = arrows(out);
    expect(layer.layout["icon-image"]).toBe(icon);
    expect(layer.layout["icon-rotate"]).toEqual(["get", "bearing"]);
    expect(layer.paint["icon-color"]).toBeUndefined();
    expect(out.images.map((i) => [i.name, i.sdf])).toEqual([[icon, false]]);
    expect(maplibreErrors(out.layers, out.sources)).toEqual([]);
  });

  it("draws GOAT's arrow without an icon, and when the style names it", () => {
    for (const style of [{}, { icon: "goat:arrow" }]) {
      const out = compile(style);
      expect(arrows(out).layout["icon-image"]).toBe("goat:arrow");
      expect(out.images.map((i) => i.name)).toEqual(["goat:arrow"]);
    }
  });
});

// `arrows.turn_with_line` (spec 3.2): the icon turns with the line, or stays upright on the screen.
describe("arrows.turn_with_line", () => {
  it("turns the icon with the line by default, never flipped", () => {
    for (const placement of ["repeat", "center"]) {
      const layer = arrows(compile({ icon: "goat:rail-light", placement }));
      expect(layer.layout["icon-rotation-alignment"]).toBe("map");
      // Keeping icons upright on the line would turn arrows on lines drawn westward round.
      expect(layer.layout["icon-keep-upright"]).toBeUndefined();
    }
  });

  it("keeps an icon upright along the line: one layer, unturned, whatever the direction", () => {
    const out = compile({ icon: "goat:park", turn_with_line: false, direction: "both" });
    const layer = arrows(out);
    expect(layer.layout["symbol-placement"]).toBe("line");
    expect(layer.layout["icon-rotation-alignment"]).toBe("viewport");
    expect(layer.layout["icon-rotate"]).toBe(0);
    expect(arrows(out, "arrows-back")).toBeUndefined();
    expect(maplibreErrors(out.layers, out.sources)).toEqual([]);
  });

  it("keeps an icon upright at the line's ends", () => {
    const out = compile({ icon: "goat:park", turn_with_line: false, placement: "both_ends" });
    const layer = arrows(out);
    expect(layer.layout["icon-rotation-alignment"]).toBe("viewport");
    expect(layer.layout["icon-rotate"]).toBe(0);
    expect(maplibreErrors(out.layers, out.sources)).toEqual([]);
  });
});
