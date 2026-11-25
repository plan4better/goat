import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { shade } from "@/lib/style/colors";
import { compileLayer } from "@/lib/style/compile";
import { defaultStyle } from "@/lib/style/defaults";
import { swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import { baseSwatch } from "@/lib/style/legend";
import { paletteColors } from "@/lib/style/palettes";

import { maplibreErrors } from "./maplibre";

describe("defaultStyle", () => {
  it("a result without a style draws its geometry's default document, as goatlib writes it", () => {
    expect((defaultStyle("point") as { symbol?: unknown }).symbol).toEqual({
      marker: { shape: "circle", color: "#2bb381", size: 10 },
    });
    expect((defaultStyle("line") as { symbol?: unknown }).symbol).toEqual({
      line: { color: "#2bb381", width: 2 },
    });
    expect((defaultStyle("polygon") as { symbol?: unknown }).symbol).toEqual({
      fill: { color: "#2bb381", opacity: 0.8 },
      outline: { color: "auto", width: 1 },
    });
    for (const geometry of ["point", "line", "polygon"] as const) {
      const out = compileLayer({
        id: "t",
        style: defaultStyle(geometry),
        geometry,
        source: { type: "tiles", id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] },
      });
      expect(maplibreErrors(out.layers)).toEqual([]);
    }
  });

  it("equals goatlib's default document of each geometry but for the color goatlib picks by layer id", () => {
    // goatlib's documents for one seed (its test: goatlib tests/unit/style/test_defaults.py).
    const rows = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          "../../../../../packages/python/goatlib/tests/unit/style/fixtures/default_styles.json"
        ),
        "utf8"
      )
    ) as Array<{
      geometry: "point" | "line" | "polygon";
      style: { symbol: Record<string, Record<string, unknown>> };
    }>;
    expect(rows.map((r) => r.geometry)).toEqual(["point", "line", "polygon"]);
    for (const { geometry, style } of rows) {
      const main = { point: "marker", line: "line", polygon: "fill" }[geometry];
      const symbol = { ...style.symbol, [main]: { ...style.symbol[main], color: "#2bb381" } };
      expect(defaultStyle(geometry)).toEqual({ ...style, symbol });
    }
  });

  it("a new polygon's outline draws a darker shade of its fill, for GOAT's green and every seeded color", () => {
    // goatlib seeds a new layer's color from carto:Bold (goatlib DEFAULT_PALETTE); the web's default takes the green.
    // The same ten colors as goatlib's test of the seed (tests/unit/style/test_defaults.py, BOLD).
    expect(paletteColors("carto:Bold")).toEqual([
      "#7f3c8d",
      "#11a579",
      "#3969ac",
      "#f2b701",
      "#e73f74",
      "#80ba5a",
      "#e68310",
      "#008695",
      "#cf1c90",
      "#f97b72",
    ]);
    const colors = ["#2bb381", ...paletteColors("carto:Bold")];
    for (const color of colors) {
      const style = defaultStyle("polygon") as unknown as { symbol: { fill: { color: string } } };
      style.symbol.fill.color = color;
      for (const tone of ["light", "dark"] as const) {
        const out = compileLayer({
          id: "t",
          style: style as unknown as LayerStyle,
          geometry: "polygon",
          source: { type: "tiles", id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] },
          tone,
        });
        expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
        const paint = (id: string) =>
          (out.layers.find((l) => l.id === `t-${id}`) as { paint: Record<string, unknown> }).paint;
        expect(paint("outline")["line-color"], color).toBe(shade(color));
        expect(paint("fill")["fill-color"], color).toBe(color);
        expect(paint("fill")["fill-opacity"], color).toBe(0.8);
      }
      // The legend and the panel's swatch show the same outline.
      expect(
        baseSwatch(style as unknown as JsonObject, { geometry: "polygon", zoom: 12 }).outline?.color
      ).toBe(shade(color));
      expect(swatchOf(style as unknown as LayerStyle, "symbol.outline.color", "polygon")).toBe(shade(color));
    }
  });

  it("a default document carries the version the web writes", () => {
    for (const geometry of ["point", "line", "polygon"] as const)
      expect(defaultStyle(geometry).version).toBe("1.0.0");
  });
});
