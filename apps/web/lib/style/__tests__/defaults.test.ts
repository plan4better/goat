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
      outline: false,
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
});
