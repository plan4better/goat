import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

/** The style panel's texts: a summary names a value as the row it sums up, one name for one thing, no dashes. */
const LANGUAGES = { en: en.style_editor, de: de.style_editor } as Record<"en" | "de", Record<string, string>>;

describe.each(Object.entries(LANGUAGES))("style panel texts (%s)", (_, texts) => {
  it("the Text style summary names each value as its row", () => {
    for (const [summary, row] of [
      ["ts_letter_spacing", "letter_spacing"],
      ["ts_line_height", "line_height"],
      ["ts_max_width", "max_width"],
    ])
      expect(texts[summary].replace(" {{value}}", "").toLowerCase(), summary).toBe(texts[row].toLowerCase());
    for (const [summary, row] of [
      ["ts_letter_spacing_varies", "letter_spacing"],
      ["ts_line_height_varies", "line_height"],
    ])
      expect(texts[summary].toLowerCase().startsWith(texts[row].toLowerCase()), summary).toBe(true);
  });

  it("the clusters' circles do not say they grow by count: the Value row says what they grow with", () => {
    expect(texts.value_render_look_circle).not.toMatch(/count|Anzahl/);
  });

  it("every label property a classification can set names the label", () => {
    const keys = Object.keys(texts).filter((key) => key.startsWith("prop_label_") && !key.includes("halo"));
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(texts[key], key).toMatch(/^Label |Beschriftung/);
  });

  it("the clusters' merge distance is not the spacing of arrows and patterns", () => {
    expect(texts.merge_distance).not.toBe(texts.spacing);
    expect(texts.merge_distance).not.toBe(texts.pattern_spacing);
  });

  it("has no dashes inside sentences", () => {
    for (const key of [
      "part_off_for_layer",
      "part_off_for_layer_allow",
      "merge_distance",
      "value_render_look_circle",
    ])
      expect(texts[key], key).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("German style panel texts", () => {
  const texts = LANGUAGES.de;

  it("the note of a part off for the layer refers to the part, whatever its gender", () => {
    expect(texts.part_off_for_layer).toBe(
      "Für den Layer ausgeschaltet. Schalten Sie diesen Teil für alle Objekte ein, um ihn für diese Klasse einzustellen."
    );
  });

  it("the merge distance says what the distance is for, in words that fit the label column", () => {
    expect(texts.merge_distance).toBe("Abstand für Cluster");
  });
});
