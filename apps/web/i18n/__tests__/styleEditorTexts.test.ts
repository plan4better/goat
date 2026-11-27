import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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

describe.each(Object.entries(LANGUAGES))("the color picker's texts (%s)", (_, texts) => {
  it("names its choices, its transparency and the note of a part that is off, without dashes", () => {
    for (const key of [
      "auto",
      "none",
      "same_as_fill",
      "same_as_line",
      "transparency",
      "transparency_percent",
    ]) {
      expect(texts[key], key).toBeTruthy();
      expect(texts[key], key).not.toMatch(/[\u2013\u2014]/);
    }
    expect(texts.part_off_note).toBeTruthy();
    // Height is turned off by its switch, as the other parts: its menu has no None of its own.
    expect(texts.height_none_sub).toBeUndefined();
  });
});

describe("German style panel texts", () => {
  it("the picker's transparency is the color's own, not the part's opacity", () => {
    expect(LANGUAGES.de.transparency).toBe("Transparenz dieser Farbe");
    expect(LANGUAGES.de.transparency).not.toBe(LANGUAGES.de.opacity);
    expect(LANGUAGES.en.transparency).toBe("Transparency of this color");
  });

  const texts = LANGUAGES.de;

  it("the note of a part off for the layer refers to the part, whatever its gender", () => {
    expect(texts.part_off_for_layer).toBe(
      "Für den Layer ausgeschaltet. Schalten Sie diesen Teil für alle Objekte ein, um ihn für diese Klasse einzustellen."
    );
  });

  it("the merge distance says what the distance is for, in words that fit the label column", () => {
    expect(texts.merge_distance).toBe("Abstand für Cluster");
  });

  it("the color choice reads Auto; the automatic values of a dropdown read Automatisch", () => {
    expect(texts.auto).toBe("Auto");
    expect(texts.decimals_auto).toBe("Automatisch");
    expect(texts.h3_size_auto).toBe("Automatisch");
    expect(texts.value_label_placement_auto).toBe("Automatisch");
    expect((de as Record<string, unknown>).placement_auto).toBe("Automatisch");
    expect(LANGUAGES.en.auto).toBe("Auto");
    expect(LANGUAGES.en.decimals_auto).toBe("Auto");
  });
});

/** The raster panel's files, their literal `style_editor.…` keys and those they build from a value. */
const RASTER_FILES = [
  "sections/RasterGeneralSection.tsx",
  "sections/RasterColorSection.tsx",
  "sections/RasterLayerSection.tsx",
  "sections/RasterPopupSection.tsx",
  "sections/ServiceSection.tsx",
  "editors/RasterColorsEditor.tsx",
].map((file) => path.join(__dirname, "../../components/map/panels/styleEditor", file));
/** Raster texts that are the same word in both languages. */
const SAME_IN_GERMAN = [
  "band",
  "band_n",
  "palette",
  "section_layer",
  "section_popup",
  "outside_hide",
  "hillshade_method_standard",
  "hillshade_method_igor",
];
const BUILT_RASTER_KEYS = [
  ...["hillshade", "continuous", "categorical", "image"].flatMap((v) => [
    `raster_type_${v}`,
    `raster_type_${v}_sub`,
  ]),
  ...["linear", "nearest"].flatMap((v) => [`resampling_${v}`, `resampling_${v}_sub`]),
  ...["palette", "stops"].flatMap((v) => [`colors_${v}`, `colors_${v}_sub`]),
  ...["off", "on_click", "on_hover"].map((v) => `raster_popup_${v}_sub`),
  ...["clamp", "hide"].flatMap((v) => [`outside_${v}`, `outside_${v}_sub`]),
  ...["standard", "multidirectional", "combined", "igor", "basic"].flatMap((v) => [
    `hillshade_method_${v}`,
    `hillshade_method_${v}_sub`,
  ]),
  ...["styled", "all"].flatMap((v) => [`popup_values_${v}`, `popup_values_${v}_sub`]),
  ...["off", "on_click", "on_hover"].map((v) => `popup_${v}`),
  ...["red", "green", "blue"].map((v) => `band_${v}`),
  ...["equal_interval", "quantile", "natural_breaks"].map((v) => `method_${v}`),
  "raster_method_continuous",
  "raster_method_continuous_sub",
  "raster_method_manual_sub",
  "method_manual",
];

function rasterKeys(files: string[]): string[] {
  const keys = new Set(BUILT_RASTER_KEYS);
  for (const file of files)
    for (const match of readFileSync(file, "utf8").matchAll(/"style_editor\.([a-z0-9_]+)"/g))
      keys.add(match[1]);
  return [...keys].sort();
}

describe("raster panel texts", () => {
  it("every raster panel text exists in both languages and is German in German", () => {
    // A file renamed or moved fails here, not with a crash: update the list.
    for (const file of RASTER_FILES) expect(existsSync(file), file).toBe(true);
    const keys = rasterKeys(RASTER_FILES.filter((file) => existsSync(file)));
    expect(keys.length).toBeGreaterThan(30);
    const text = (texts: Record<string, string>, key: string) => texts[key] ?? texts[`${key}_other`];
    for (const key of keys) {
      // A counted text exists as its plural forms.
      for (const texts of Object.values(LANGUAGES)) expect(text(texts, key), key).toBeTypeOf("string");
      if (!SAME_IN_GERMAN.includes(key))
        expect(text(LANGUAGES.de, key), key).not.toBe(text(LANGUAGES.en, key));
    }
  });

  it("stops and manual classes have distinct names, and neither is the palette of your own colors", () => {
    for (const texts of Object.values(LANGUAGES)) {
      expect(texts.colors_stops).not.toBe(texts.method_manual);
      expect(texts.colors_stops).not.toBe(texts.palette_custom);
      expect(texts.raster_manual_n).not.toContain(texts.palette_custom);
    }
    expect(LANGUAGES.de.colors_stops).toBe("Farben an Werten");
    expect(LANGUAGES.de.method_manual).toBe("Manuelle Grenzen");
    expect(LANGUAGES.en.colors_stops).toBe("Colors at values");
    expect(LANGUAGES.en.method_manual).toBe("Manual breaks");
  });

  it("the raster type is a colour scale and resampling is smoothing, in German", () => {
    expect(LANGUAGES.de.raster_type_continuous).toBe("Farbskala");
    expect(LANGUAGES.de.resampling).toBe("Glättung");
    expect(LANGUAGES.de.resampling_linear).toBe("Weich");
    expect(LANGUAGES.de.resampling_nearest).toBe("Scharf");
  });

  it("a click popup does not speak of the pointer; the no-data placeholder names the file's value", () => {
    for (const texts of Object.values(LANGUAGES)) {
      expect(texts.raster_popup_on_click_sub).not.toMatch(/pointer|Mauszeiger/);
      expect(texts.no_data_from_file).toContain("{{value}}");
      expect(texts.range_from_data_note).toMatch(/98/);
    }
    expect(LANGUAGES.de.no_data_from_file).toBe("aus der Datei: {{value}}");
    expect(LANGUAGES.de.no_data_none).toBe("keiner");
  });
});

describe("the Blend row's texts", () => {
  const BLEND: Record<"en" | "de", Record<string, string>> = {
    en: {
      blend: "Blend",
      value_blend_normal: "Normal",
      value_blend_normal_sub: "Covers what is below",
      value_blend_multiply: "Multiply",
      value_blend_multiply_sub: "Darkens: streets and names below stay visible",
      value_blend_screen: "Screen",
      value_blend_screen_sub: "Lightens: for dark basemaps",
      value_blend_overlay: "Overlay",
      value_blend_overlay_sub: "Strengthens the contrast of what is below",
      value_blend_color: "Color",
      value_blend_color_sub: "Takes the layer's hue, keeps the brightness below",
      value_blend_luminosity: "Luminosity",
      value_blend_luminosity_sub: "Takes the layer's brightness, keeps the colors below",
      "value_blend_plus-lighter": "Plus lighter",
      "value_blend_plus-lighter_sub": "Adds light: glows on dark basemaps and images",
      blend_columns: "Columns draw without blending.",
      blend_heights: "Heights draw without blending; the outline blends.",
      blend_hillshade: "Shading draws without blending.",
      blend_values: "Colors from values draw without blending.",
      blend_dark_basemap: "On a dark basemap, Multiply draws the colors very dark. Screen lightens instead.",
      blend_light_basemap: "On a light basemap this turns light colors white.",
    },
    de: {
      blend: "Mischmodus",
      value_blend_normal: "Normal",
      value_blend_normal_sub: "Verdeckt, was darunter liegt",
      value_blend_multiply: "Multiply",
      value_blend_multiply_sub: "Dunkelt ab: Straßen und Namen darunter bleiben sichtbar",
      value_blend_screen: "Screen",
      value_blend_screen_sub: "Hellt auf: für dunkle Grundkarten",
      value_blend_overlay: "Overlay",
      value_blend_overlay_sub: "Verstärkt den Kontrast darunter",
      value_blend_color: "Color",
      value_blend_color_sub: "Übernimmt den Farbton, behält die Helligkeit darunter",
      value_blend_luminosity: "Luminosity",
      value_blend_luminosity_sub: "Übernimmt die Helligkeit, behält die Farben darunter",
      "value_blend_plus-lighter": "Plus lighter",
      "value_blend_plus-lighter_sub": "Addiert Licht: Leuchten auf dunklen Grundkarten und Bildern",
      blend_columns: "Säulen werden ohne Mischmodus gezeichnet.",
      blend_heights: "Höhen werden ohne Mischmodus gezeichnet; der Umriss wird gemischt.",
      blend_hillshade: "Die Schummerung wird ohne Mischmodus gezeichnet.",
      blend_values: "Farben aus Werten werden ohne Mischmodus gezeichnet.",
      blend_dark_basemap:
        "Auf einer dunklen Grundkarte werden die Farben mit Multiply sehr dunkel. Screen hellt stattdessen auf.",
      blend_light_basemap: "Auf einer hellen Grundkarte werden helle Farben weiß.",
    },
  };

  it("names the seven modes, their sub-lines and the notes in both languages, with the same keys", () => {
    // The locale files hold exactly these blend texts, the same keys in both languages.
    const blendKeys = (texts: Record<string, string>) =>
      Object.keys(texts)
        .filter((key) => /^(value_)?blend(_|$)/.test(key))
        .sort();
    expect(blendKeys(LANGUAGES.en)).toEqual(Object.keys(BLEND.en).sort());
    expect(blendKeys(LANGUAGES.de)).toEqual(Object.keys(BLEND.de).sort());
    for (const language of ["en", "de"] as const)
      for (const [key, text] of Object.entries(BLEND[language])) {
        expect([language, key, LANGUAGES[language][key]]).toEqual([language, key, text]);
        expect(text, key).not.toMatch(/[–—]/);
      }
  });
});
