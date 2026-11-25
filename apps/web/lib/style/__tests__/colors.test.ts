import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  alphaOf,
  contrastRatio,
  haloAgainst,
  isNone,
  labelPair,
  onColor,
  opaque,
  readableShade,
  shade,
  textAgainst,
} from "@/lib/style/colors";
import { PALETTES } from "@/lib/style/generated/catalog";

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
  halo_against: Array<{ text: string | null; expected: string }>;
  label_pair: Array<{ color: string | null; tone: "light" | "dark" | null; text: string; halo: string }>;
  text_against: Array<{
    color: string | null;
    halo: string | null;
    tone: "light" | "dark";
    text?: string;
    expected: string;
  }>;
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

  it.each(RULES.label_pair.map((r) => [r.color, r.tone, r.text, r.halo]))(
    "label pair %s on %s",
    (color, tone, text, halo) => {
      expect(labelPair(color as string, tone ?? undefined)).toEqual({ text, halo });
    }
  );

  it("gives a label pair that meets the floor for every color on both tones", () => {
    const colors = [
      ...PALETTES["carto:Bold"].colors,
      "#f2b701",
      "#ffffff",
      "#000000",
      "#2bb381",
      "#808080",
      "#ffff00",
    ];
    for (const color of colors)
      for (const tone of ["light", "dark"] as const) {
        const { text, halo } = labelPair(color, tone);
        expect(contrastRatio(text, halo), `${color} ${tone}`).toBeGreaterThanOrEqual(4.5);
      }
  });

  it.each(RULES.halo_against.map((r) => [r.text, r.expected]))(
    "halo against the text %s",
    (text, expected) => {
      expect(haloAgainst(text as string)).toBe(expected);
    }
  );

  it("gives a halo against a text that meets the floor for every grey", () => {
    for (let v = 0; v < 256; v++) {
      const text = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
      expect(contrastRatio(text, haloAgainst(text)), text).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(RULES.text_against.map((r) => [r.color, r.halo, r.tone, r.text, r.expected]))(
    "text %s against the halo %s on %s (%s)",
    (color, halo, tone, text, expected) => {
      expect(textAgainst(color as string, halo as string, tone as string, text as string | undefined)).toBe(
        expected
      );
    }
  );

  it("gives a text against a set halo that meets the floor for every color and tone", () => {
    const features = [
      ...PALETTES["carto:Bold"].colors,
      "#ffd400",
      "#2bb381",
      "#2166ac",
      "#ffffff",
      "#000000",
    ];
    features.push("#808080", "#e7298a", "#3a3541");
    const halos = [...features, "#ffffff80", "#777777", "#767676", "#595959", "#a0a0a0"];
    for (const color of [...features, "fill", null as unknown as string])
      for (const halo of halos)
        for (const tone of ["light", "dark"])
          for (const text of [undefined, onColor(color)]) {
            const got = textAgainst(color, halo, tone, text);
            expect(contrastRatio(got, halo), `${color} ${halo} ${tone} ${text}`).toBeGreaterThanOrEqual(4.5);
          }
  });
});
