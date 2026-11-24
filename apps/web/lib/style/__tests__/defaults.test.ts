import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { defaultStyle } from "@/lib/style/defaults";

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

  it("a default document carries the version the web writes", () => {
    for (const geometry of ["point", "line", "polygon"] as const)
      expect(defaultStyle(geometry).version).toBe("1.0.0");
  });
});
