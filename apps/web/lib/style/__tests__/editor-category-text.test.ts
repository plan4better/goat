import { describe, expect, it } from "vitest";

import { categoryText, numberText } from "@/lib/style/editor/categoryText";

// goatlib's `as_text(float(text))` for each text, as printed by Python.
const GOATLIB: Record<string, string> = {
  "1.0": "1",
  "2.50": "2.5",
  "-0.0": "0",
  "0.0": "0",
  "0.0001": "0.0001",
  "0.00001": "1e-05",
  "1e-7": "1e-07",
  "1.5e-7": "1.5e-07",
  "1.23e-5": "1.23e-05",
  "123.456": "123.456",
  "1e15": "1000000000000000",
  "1e16": "10000000000000000",
  "1e21": "1000000000000000000000",
  "1e22": "10000000000000000000000",
  "12345678901234567.0": "12345678901234568",
  "0.1": "0.1",
  "-3.25": "-3.25",
  "1234567.125": "1234567.125",
  "0.30000000000000004": "0.30000000000000004",
  inf: "inf",
  "-inf": "-inf",
  nan: "nan",
};

describe("a number field's value as category classes spell it", () => {
  it.each(Object.entries(GOATLIB))("%s reads %s, as goatlib writes it", (text, spelled) => {
    expect(numberText(text)).toBe(spelled);
  });

  it("a number reads as goatlib writes it too", () => {
    expect(numberText(1)).toBe("1");
    expect(numberText(2.5)).toBe("2.5");
    expect(numberText(0.00001)).toBe("1e-05");
    expect(numberText(1e21)).toBe("1000000000000000000000");
    expect(numberText(Infinity)).toBe("inf");
    expect(numberText(-Infinity)).toBe("-inf");
    expect(numberText(NaN)).toBe("nan");
  });

  it("a text that is not a number stays as it is", () => {
    expect(numberText("")).toBe("");
    expect(numberText("n/a")).toBe("n/a");
    expect(numberText("0x10")).toBe("0x10");
  });

  it("only a number field's values are spelled again: text, whole numbers and yes/no stay as they are", () => {
    expect(categoryText("2.50", "number")).toBe("2.5");
    expect(categoryText("2.50", "string")).toBe("2.50");
    expect(categoryText("1.0", undefined)).toBe("1.0");
    expect(categoryText("12", "integer")).toBe("12");
    expect(categoryText(true, "boolean")).toBe("true");
    expect(categoryText(null, "number")).toBe("null");
  });
});
