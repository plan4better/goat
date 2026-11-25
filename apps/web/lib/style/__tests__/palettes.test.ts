import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PALETTES } from "@/lib/style/generated/catalog";
import { paletteSteps } from "@/lib/style/palettes";
import { rasterColorSpec } from "@/lib/style/raster/color";

// The palette samples goatlib's `sample_colors` gives (its test: goatlib tests/unit/style/test_colors.py). The server
// writes class colors with it, so the browser's picks before that agree with what the server then stores.

interface Row {
  palette: string | string[];
  count: number;
  reverse?: boolean;
  kind?: "qualitative";
  colors: string[];
}

const ROWS = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../../packages/python/goatlib/tests/unit/style/fixtures/palette_samples.json"
    ),
    "utf8"
  )
) as Row[];

describe("paletteSteps (with goatlib's sample_colors)", () => {
  it("covers every catalog palette", () => {
    const covered = new Set(ROWS.map((r) => r.palette).filter((p) => typeof p === "string"));
    expect(Object.keys(PALETTES).filter((id) => !covered.has(id))).toEqual([]);
  });

  it.each(ROWS.map((r) => [`${r.palette} ${r.count}${r.reverse ? " reversed" : ""}`, r] as const))(
    "%s",
    (_, row) => {
      expect(paletteSteps(row.palette, row.count, { reverse: row.reverse, kind: row.kind })).toEqual(
        row.colors
      );
    }
  );

  it("gives raster classes without colors the colors the server writes into them", () => {
    const row = ROWS.find((r) => r.palette === "goat:elevation" && r.count === 5 && r.reverse)!;
    const spec = rasterColorSpec({
      type: "continuous",
      palette: "goat:elevation",
      reverse: true,
      domain: [0, 50],
      classify: { method: "manual", classes: [{ to: 10 }, { from: 10, to: 20 }, {}, {}, { from: 40 }] },
    });
    expect(spec?.kind === "classes" && spec.classes.map((c) => c.color)).toEqual(row.colors);
  });
});
