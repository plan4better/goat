import { describe, expect, it } from "vitest";

import { alphaOfPercent, formatColor, parseColor, percentOf, withAlpha } from "@/lib/utils/colorFormats";

describe("color formats", () => {
  it("writes a color as Hex, RGB or HSL", () => {
    expect(formatColor("#833b21", "hex")).toBe("#833B21");
    expect(formatColor("#833b21", "rgb")).toBe("131, 59, 33");
    expect(formatColor("#833b21", "hsl")).toBe("16, 60%, 32%");
    expect(formatColor("#ffffff", "hsl")).toBe("0, 0%, 100%");
  });

  it("reads what is typed in the chosen format, and a hex code in any", () => {
    expect(parseColor("131, 59, 33", "rgb")).toBe("#833b21");
    expect(parseColor("rgb(131 59 33)", "rgb")).toBe("#833b21");
    expect(parseColor("16, 60%, 32%", "hsl")).toBe("#833b21");
    expect(parseColor("#833B21", "rgb")).toBe("#833b21");
    expect(parseColor("833b21", "hex")).toBe("#833b21");
    expect(parseColor("300, 0, 0", "rgb")).toBeNull();
    expect(parseColor("12, 40", "hsl")).toBeNull();
    expect(parseColor("#83", "hex")).toBeNull();
  });
});

describe("a color with its own transparency", () => {
  it("shows six digits, its RGB and HSL from the color alone", () => {
    expect(formatColor("#833b2180", "hex")).toBe("#833B21");
    expect(formatColor("#833b2180", "rgb")).toBe("131, 59, 33");
    expect(formatColor("#833b2100", "hsl")).toBe("16, 60%, 32%");
  });

  it("reads a typed or pasted eight-digit hex whole, in any format", () => {
    expect(parseColor("#833B2180", "hex")).toBe("#833b2180");
    expect(parseColor("833b2101", "rgb")).toBe("#833b2101");
    expect(parseColor(" #833b21fe ", "hsl")).toBe("#833b21fe");
    expect(parseColor("#833b218", "hex")).toBeNull();
  });

  it("says its percent, 100 for an opaque color, and keeps it through a round trip", () => {
    expect(percentOf("#833b21")).toBe(100);
    expect(percentOf("#833b2100")).toBe(0);
    expect(percentOf("#833b2180")).toBe(50);
    expect(percentOf("#833b2101")).toBe(1);
    expect(percentOf("#833b21fe")).toBe(99);
    expect(percentOf("not a color")).toBe(100);
    for (let p = 0; p <= 100; p++) expect(percentOf(withAlpha("#833b21", alphaOfPercent(p)))).toBe(p);
  });

  it("writes a color at an alpha: eight digits below 255, six at 255, the old alpha replaced", () => {
    expect(withAlpha("#833b21", 128)).toBe("#833b2180");
    expect(withAlpha("#833b2180", 1)).toBe("#833b2101");
    expect(withAlpha("#833b2180", 255)).toBe("#833b21");
    expect(withAlpha("#833B21", 0)).toBe("#833b2100");
  });
});
