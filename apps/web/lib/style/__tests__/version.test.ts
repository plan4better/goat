import { describe, expect, it } from "vitest";

import { deepEqual, sameAsWritten } from "@/lib/style/json";
import { STYLE_VERSION, isDrawableStyle } from "@/lib/style/version";

describe("GOAT Style versions (spec 14)", () => {
  it("the web writes 1.0.0", () => {
    expect(STYLE_VERSION).toBe("1.0.0");
  });

  it("a document of major 1 is drawn, the integer 1 of older documents included", () => {
    expect(isDrawableStyle({ version: "1.0.0", kind: "vector" })).toBe(true);
    expect(isDrawableStyle({ version: "1.4.2", kind: "raster" })).toBe(true);
    expect(isDrawableStyle({ version: "1.10.0", kind: "raster" })).toBe(true);
    expect(isDrawableStyle({ version: 1, kind: "vector" })).toBe(true);
  });

  it("another major, a malformed version or no document is not", () => {
    // Malformed as goatlib reads it: three numbers without leading zeros.
    const malformed = ["1.0", "1", "v1.0.0", "1.0.0-beta", "1.01.0", "1.0.00", "01.0.0"];
    for (const version of ["2.0.0", 2, ...malformed, true, null, undefined]) {
      expect([version, isDrawableStyle({ version, kind: "vector" })]).toEqual([version, false]);
    }
    expect(isDrawableStyle({ kind: "vector" })).toBe(false);
    expect(isDrawableStyle(null)).toBe(false);
    expect(isDrawableStyle([{ version: "1.0.0" }])).toBe(false);
    expect(isDrawableStyle("1.0.0")).toBe(false);
  });

  it("the server stamps the version: two documents that differ only in it are the same as written", () => {
    const old = { version: 1, kind: "vector", symbol: { fill: { color: "#cccccc" } } };
    const stamped = { ...old, version: "1.0.0" };
    expect(sameAsWritten(old, stamped)).toBe(true);
    expect(sameAsWritten(old, { ...stamped, symbol: { fill: { color: "#000000" } } })).toBe(false);
    // Only the document's own version: a label format of a field named "version" still counts.
    const formatted = (digits: number) => ({
      ...stamped,
      symbol: { label: { text: "{version}", formats: { version: { digits } } } },
    });
    expect(sameAsWritten(formatted(0), formatted(2))).toBe(false);
    // The saver's own comparison still sees the new version.
    expect(deepEqual(old, stamped)).toBe(false);
  });
});
