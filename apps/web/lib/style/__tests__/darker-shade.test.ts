import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { darkerShade } from "@/lib/style/compile/values";

// The darker shade goatlib's `darker_shade` gives (its test: goatlib tests/unit/style/test_colors.py): the outline's
// and the casing's `"auto"` color draws the same on the map, in the legend and in the panel as goatlib describes it.

const ROWS = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../../packages/python/goatlib/tests/unit/style/fixtures/darker_shades.json"),
    "utf8"
  )
) as Array<{ color: string; shade: string }>;

describe("darkerShade (with goatlib's darker_shade)", () => {
  it.each(ROWS.map((r) => [r.color, r.shade]))("%s", (color, shade) => {
    expect(darkerShade(color)).toBe(shade);
  });
});
