import { describe, expect, it } from "vitest";

import {
  fieldToken,
  fillTemplate,
  formatNumberText,
  templateField,
  templateFields,
} from "@/lib/style/editor/labels";

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
