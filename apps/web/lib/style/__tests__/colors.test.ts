import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { alphaOf, contrastRatio, isNone, onColor, opaque, readableShade, shade } from "@/lib/style/colors";

// The color rules derived colors are made of, as goatlib's `shade`, `contrast_ratio`, `readable_shade` and `on_color`
// give them (its test: goatlib tests/unit/style/test_colors.py): the map, the legend and the panel draw what goatlib
// describes. Malformed inputs are in the fixture too: `null` stands for a missing value, a contrast ratio of `null` for
// NaN.

interface Rules {
  shade: Array<{ color: string | null; expected: string | null }>;
  contrast_ratio: Array<{ a: string | null; b: string | null; expected: number | null }>;
  readable_shade: Array<{ color: string | null; against: string | null; expected: string | null }>;
  on_color: Array<{ color: string | null; expected: string }>;
  alpha: Array<{ color: string | null; expected: number | null }>;
  is_none: Array<{ color: string | null; expected: boolean }>;
  opaque: Array<{ color: string | null; expected: string | null }>;
}

const RULES = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../../packages/python/goatlib/tests/unit/style/fixtures/color_rules.json"),
    "utf8"
  )
) as Rules;

describe("color rules (with goatlib's)", () => {
  it.each(RULES.shade.map((r) => [r.color, r.expected]))("shade %s", (color, expected) => {
    expect(shade(color as string)).toBe(expected);
  });

  it.each(RULES.contrast_ratio.map((r) => [r.a, r.b, r.expected] as const))(
    "contrast ratio %s %s",
    (a, b, expected) => {
      const got = contrastRatio(a as string, b as string);
      if (expected === null) expect(got).toBeNaN();
      else expect(got).toBeCloseTo(expected, 4);
    }
  );

  it.each(RULES.readable_shade.map((r) => [r.color, r.against, r.expected]))(
    "readable shade %s against %s",
    (color, against, expected) => {
      expect(readableShade(color as string, against as string)).toBe(expected);
    }
  );

  it.each(RULES.on_color.map((r) => [r.color, r.expected]))("on-color %s", (color, expected) => {
    expect(onColor(color as string)).toBe(expected);
  });

  it.each(RULES.alpha.map((r) => [r.color, r.expected]))("alpha %s", (color, expected) => {
    expect(alphaOf(color)).toBe(expected ?? undefined);
  });

  it.each(RULES.is_none.map((r) => [r.color, r.expected]))("is none %s", (color, expected) => {
    expect(isNone(color)).toBe(expected);
  });

  it.each(RULES.opaque.map((r) => [r.color, r.expected]))("opaque %s", (color, expected) => {
    expect(opaque(color as string)).toBe(expected);
  });
});
