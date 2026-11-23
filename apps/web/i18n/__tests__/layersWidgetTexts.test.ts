import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { layersOutOfZoomBehaviorTypes } from "@/lib/validations/widget";

/** The builder's Layers widget names each "Out of zoom range" option with `out_of_zoom_<value>`. */
describe("layers widget texts", () => {
  it.each([
    ["en", en],
    ["de", de],
  ] as const)("%s has a text for every out of zoom option", (_language, messages) => {
    const texts = messages as unknown as Record<string, string>;
    for (const value of layersOutOfZoomBehaviorTypes.options) {
      const key = `out_of_zoom_${value}`;
      expect(texts[key], key).toBeTruthy();
      expect(texts[key], key).not.toMatch(/[–—]/);
    }
  });
});
