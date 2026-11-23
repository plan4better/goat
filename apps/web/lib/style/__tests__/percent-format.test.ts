import { createExpression } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

import { type NumberFormatSpec, formatNumber } from "@/lib/style/compile/labels";
import { formatNumberText } from "@/lib/style/editor/labels";
import { fromPopupConfig, toPopupConfig } from "@/lib/style/popup";
import { formatFieldValue } from "@/lib/utils/formatFieldValue";

const percentIn = (locale: string, value: number, digits = 0) =>
  new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

/** A label's number expression as MapLibre evaluates it for one value, in the viewer's locale. */
const labelText = (format: NumberFormatSpec, share: number, locale = "en"): string => {
  const parsed = createExpression(formatNumber(["get", "share"], format), "layers[0].layout.text-field");
  if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
  return String(
    parsed.value.evaluate(
      { zoom: 10, globalState: { locale } } as never,
      { type: 1, properties: { share } } as never
    )
  );
};
/** The label appends a plain percent sign, the twin writes the locale's form: equal but for the space before it. */
const plainSign = (text: string) => text.replace(/\s+%/, "%");

describe("a number format read as a percent (spec 18.3 `percent`)", () => {
  it("the panel and the legend write it in the reader's language", () => {
    expect(formatNumberText(0.734, { percent: true }, "en")).toBe("73%");
    expect(formatNumberText(0.734, { percent: true }, "de")).toBe(percentIn("de", 0.734));
    expect(formatNumberText(0.7346, { percent: true, decimals: 1 }, "en")).toBe("73.5%");
    expect(formatNumberText(0.05, { percent: true, always_show_sign: true, suffix: " cover" }, "en")).toBe(
      "+5% cover"
    );
    // A percent is never abbreviated.
    expect(formatNumberText(12, { percent: true, abbreviate: true }, "en")).toBe("1,200%");
    expect(formatNumberText(12, { percent: true, thousands_separator: false }, "en")).toBe("1200%");
  });

  it("a popup field shows it in the reader's language", () => {
    expect(formatFieldValue(0.734, "number", { percent: true }, "de")).toBe(percentIn("de", 0.734));
    expect(formatFieldValue(0.7346, "number", { percent: true, decimals: 1 }, "en")).toBe("73.5%");
    expect(formatFieldValue(0.5, "number", { percent: true, always_show_sign: true }, "en")).toBe("+50%");
  });

  it("a label formats the value times 100 with a percent sign", () => {
    const x = ["get", "share"];
    const locale = { locale: ["global-state", "locale"] };
    // Automatic decimals show none.
    for (const format of [{ percent: true }, { percent: true, decimals: 0 }])
      expect(formatNumber(x, format)).toEqual([
        "concat",
        ["number-format", ["round", ["*", x, 100]], locale],
        "%",
      ]);
    expect(formatNumber(x, { percent: true, decimals: 1 })).toEqual([
      "concat",
      ["number-format", ["*", x, 100], { ...locale, "min-fraction-digits": 1, "max-fraction-digits": 1 }],
      "%",
    ]);
  });

  it("the map label reads as the panel, the legend and the popup write the number", () => {
    // Automatic decimals show none, as a percent does everywhere else; the product's float noise never shows.
    expect(labelText({ percent: true }, 0.7345)).toBe("73%");
    expect(labelText({ percent: true }, 12.3456)).toBe("1,235%");
    expect(labelText({ percent: true, thousands_separator: false }, 0.57)).toBe("57%");
    expect(labelText({ percent: true, thousands_separator: false }, 0.07)).toBe("7%");
    // A number of decimals shows in full without the thousands separator too.
    expect(labelText({ percent: true, thousands_separator: false, decimals: 2 }, 0.7)).toBe("70.00%");
    expect(labelText({ percent: true, thousands_separator: false, decimals: 2 }, 12.3456)).toBe("1234.56%");
    expect(labelText({ percent: true, thousands_separator: false, decimals: 1 }, -0.25)).toBe("-25.0%");
    // The decimal mark is the viewer's language's.
    expect(labelText({ percent: true, thousands_separator: false, decimals: 2 }, 0.7, "de")).toBe("70,00%");
    expect(labelText({ percent: true, decimals: 1 }, 12.3456, "de")).toBe("1.234,6%");
  });

  it("the map label and its twin agree for every percent format", () => {
    const differing: string[] = [];
    for (const decimals of ["auto", 0, 1, 2] as const)
      for (const thousands_separator of [true, false])
        for (const always_show_sign of [false, true])
          for (const share of [0.7345, 0.57, 0.07, 0.7, 12.3456, -0.25])
            for (const locale of ["en", "de"]) {
              const format = { percent: true, decimals, thousands_separator, always_show_sign };
              const label = labelText(format, share, locale);
              const twin = plainSign(formatNumberText(share, format, locale));
              if (label !== twin)
                differing.push(`${JSON.stringify(format)} ${share} ${locale}: label ${label}, twin ${twin}`);
            }
    expect(differing).toEqual([]);
  });

  it("a popup field's percent survives the panel's editors", () => {
    const popup = {
      blocks: [
        { type: "field_list", attributes: [{ field: "share", format: { percent: true, decimals: 1 } }] },
      ],
    };
    const config = toPopupConfig(popup, { share: "number" })!;
    const block = config.blocks[0] as { attributes: Array<{ format_config?: Record<string, unknown> }> };
    expect(block.attributes[0].format_config).toEqual({ percent: true, decimals: 1 });
    const back = fromPopupConfig(config, popup) as { blocks: Array<{ attributes: unknown[] }> };
    expect(back.blocks[0].attributes[0]).toEqual({ field: "share", format: { percent: true, decimals: 1 } });
  });
});
