import { describe, expect, it } from "vitest";

import { formatColor, parseColor } from "@/lib/utils/colorFormats";

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
