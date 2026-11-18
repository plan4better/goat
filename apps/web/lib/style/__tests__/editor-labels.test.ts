import i18next from "i18next";
import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import {
  fieldToken,
  fillTemplate,
  formatNumberText,
  labelHaloSummary,
  labelPositionSummary,
  labelTextStyleSummary,
  templateField,
  templateFields,
} from "@/lib/style/editor/labels";
import type { LayerStyle } from "@/lib/style/generated/types";

describe("label templates", () => {
  it("a field token escapes braces in the name", () => {
    expect(fieldToken("Einwohner 2020")).toBe("{Einwohner 2020}");
    expect(fieldToken("a{b}")).toBe("{a\\{b\\}}");
    expect(templateField("{a\\{b\\}}")).toBe("a{b}");
    expect(templateField("{name} km")).toBeNull();
    expect(templateFields("{name}\n{area} km²")).toEqual(["name", "area"]);
  });

  it("fills a template from a feature, marking unknown fields", () => {
    const types = { name: "string" as const, population: "integer" as const };
    expect(
      fillTemplate(
        "{name}, {population} inhabitants {x}",
        { name: "Berlin", population: 3850000 },
        types,
        {},
        "en"
      )
    ).toBe("Berlin, 3,850,000 inhabitants {x?}");
  });

  it("formats numbers as the map draws them", () => {
    expect(formatNumberText(12345.678, {}, "en")).toBe("12,345.678");
    expect(formatNumberText(12345.678, { decimals: 1 }, "de")).toBe("12.345,7");
    expect(formatNumberText(12345.678, { decimals: 0, thousands_separator: false }, "en")).toBe("12346");
    expect(formatNumberText(12345.678, { abbreviate: true }, "en")).toBe("12.3 k");
    expect(formatNumberText(5, { always_show_sign: true, prefix: "€", suffix: " km" }, "en")).toBe("€+5 km");
  });
});

const summaryI18n = i18next.createInstance();
void summaryI18n.init({
  lng: "en",
  resources: { en: { common: en }, de: { common: de } },
  defaultNS: "common",
  initImmediate: false,
});
const tEn = summaryI18n.getFixedT("en");
const tDe = summaryI18n.getFixedT("de");

const withLabel = (label: object, extra: object = {}) =>
  ({ version: 1, kind: "vector", symbol: { label: { text: "{name}", ...label } }, ...extra }) as LayerStyle;
const FIELDS = [{ name: "rank", type: "integer" as const, label: "Rank" }];
const at = (geometry: "point" | "line" | "polygon", language = "en") => ({
  fields: FIELDS,
  mapZoom: 12,
  geometry,
  language,
});
const BASE = "symbol.label";
const step = (a: unknown, b: unknown) => ({
  zoom: [
    [10, a],
    [14, b],
  ],
  interpolate: "step",
});

describe("label summaries", () => {
  it("text style: the font first, then what differs in order of importance, in short words", () => {
    const style = (label: object, language = "en") =>
      labelTextStyleSummary(
        withLabel(label),
        BASE,
        null,
        language === "de" ? tDe : tEn,
        at("point", language)
      );
    expect(style({})).toBe("Regular");
    expect(style({ font: { weight: "regular", style: "normal" }, transform: "none", line_height: 1.2 })).toBe(
      "Regular"
    );
    expect(style({ font: { weight: "bold" }, transform: "uppercase" })).toBe("Bold, uppercase");
    expect(style({ font: { weight: "bold" }, transform: "uppercase" }, "de")).toBe("Fett, Großbuchstaben");
    // The font always leads, Regular too.
    expect(style({ transform: "uppercase", letter_spacing: 0.24 })).toBe(
      "Regular, uppercase, letter spacing 24%"
    );
    expect(style({ transform: "lowercase", letter_spacing: 0.24 }, "de")).toBe(
      "Normal, Kleinbuchstaben, Zeichenabstand 24%"
    );
    // Case, letter spacing, line height, wrap width, whatever order the style lists them in.
    const all = { max_width: 160, line_height: 1.5, letter_spacing: 0.1, font: { style: "italic" } };
    expect(style(all)).toBe("Italic, letter spacing 10%, line height 150%, wrap at 160 px");
    expect(style(all, "de")).toBe("Kursiv, Zeichenabstand 10%, Zeilenhöhe 150%, Umbruch bei 160 px");
    // Values by zoom say that they vary, in the same places.
    expect(style({ font: { weight: step("regular", "bold") }, transform: step("none", "uppercase") })).toBe(
      "Font varies, case varies"
    );
    expect(
      style({ letter_spacing: step(0, 0.2), line_height: step(1.2, 1.5), max_width: step(100, 200) })
    ).toBe("Regular, letter spacing varies, line height varies, wrap varies");
    expect(
      style({ letter_spacing: step(0, 0.2), line_height: step(1.2, 1.5), max_width: step(100, 200) }, "de")
    ).toBe("Normal, Zeichenabstand wechselt, Zeilenhöhe wechselt, Umbruch wechselt");
  });

  it("text style in a class or a rule: the values it draws", () => {
    const doc = withLabel(
      { font: { weight: "bold" } },
      {
        classify: [
          {
            field: "rank",
            method: "categories",
            classes: [
              { values: [1], label: { font: { weight: "regular", style: "italic" } } },
              { values: [2], label: { transform: "lowercase" } },
            ],
          },
        ],
        rules: [{ id: "r", when: { op: "isNull", args: [{ property: "rank" }] }, label: { max_width: 200 } }],
      }
    );
    const ctx = at("point");
    expect(labelTextStyleSummary(doc, BASE, { classify: 0, key: 0 }, tEn, ctx)).toBe("Italic");
    // A class that sets no font draws the layer's.
    expect(labelTextStyleSummary(doc, BASE, { classify: 0, key: 1 }, tEn, ctx)).toBe("Bold, lowercase");
    expect(labelTextStyleSummary(doc, BASE, { rule: "r", index: 0 }, tEn, ctx)).toBe("Bold, wrap at 200 px");
    // For all features: the classes set the font and the case; the rule's wrap width is the rule's.
    expect(labelTextStyleSummary(doc, BASE, null, tEn, ctx)).toBe("Font varies, case varies");
  });

  it("halo: its color and width, none at 0", () => {
    const halo = (label: object, language = "en") =>
      labelHaloSummary(withLabel(label), BASE, null, language === "de" ? tDe : tEn, at("point", language));
    expect(halo({})).toEqual({ text: "1.5 px", swatch: "#ffffff" });
    // Numbers in the panel's language.
    expect(halo({}, "de").text).toBe("1,5 px");
    expect(halo({ halo: { width: step(0.5, 2.5) } }, "de").text).toBe("0,5 → 2,5 px");
    expect(halo({ halo: { color: "#000000", width: 3 } })).toEqual({ text: "3 px", swatch: "#000000" });
    expect(halo({ halo: { width: 0 } }).text).toBe("None");
    expect(halo({ halo: { width: 0 } }, "de").text).toBe("Keiner");
    expect(
      halo({
        halo: {
          width: {
            zoom: [
              [10, 1],
              [14, 3],
            ],
          },
        },
      }).text
    ).toBe("1 → 3 px");
  });

  it("position: the placement of the geometry", () => {
    const position = (label: object, geometry: "point" | "line" | "polygon", extra: object = {}) =>
      labelPositionSummary(withLabel(label, extra), BASE, tEn, at(geometry));
    expect(position({}, "point")).toEqual({ placement: "auto", text: "Automatic" });
    expect(position({ placement: "below_right" }, "point")).toEqual({
      placement: "below_right",
      text: "Below right",
    });
    expect(position({}, "line")).toEqual({ placement: "line", text: "Along the line" });
    // An area's label without a placement sits beside its marker, or in the middle without one.
    expect(position({}, "polygon")).toEqual({ placement: "auto", text: "Automatic" });
    expect(position({ placement: "inside" }, "polygon")).toEqual({
      placement: "inside",
      text: "In the middle",
    });
    expect(position({ placement: "center" }, "line")).toEqual({ placement: "center", text: "In the middle" });
    expect(position({ placement: "above" }, "line")).toEqual({ placement: "above", text: "Above" });
    expect(
      position({}, "polygon", { symbol: { fill: {}, extrude: { height: 20 }, label: { text: "{name}" } } })
        .text
    ).toBe("On the roof");
  });
});
