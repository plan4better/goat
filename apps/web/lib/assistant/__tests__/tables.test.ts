import { describe, expect, it } from "vitest";

import { isNumericCell, numericColumns } from "@/lib/assistant/tables";

describe("numeric table cells", () => {
  it("read English and German numbers, with thousands separators, decimals, a sign and %", () => {
    for (const cell of [
      "450",
      "4,766",
      "4.766",
      "1 234",
      "1\u00a0234",
      "1\u202f234",
      "1'234",
      "1,234.5",
      "1.234,5",
      "9,8 %",
      "9.8%",
      "12 %",
      "-3.5",
      "−2",
      "\u20133,2 %",
      "+5",
      "0,5",
      " 2026 ",
    ]) {
      expect(isNumericCell(cell), cell).toBe(true);
    }
  });

  it("leave text, units and ranges alone", () => {
    for (const cell of ["Hamburg-Nord", "12 km", "A1", "≥ 84", "1.2.3", "1,23,456", "3-5", "%", "", "-"]) {
      expect(isNumericCell(cell), cell).toBe(false);
    }
  });
});

describe("numeric table columns", () => {
  it("are those whose non-empty body cells are all numbers", () => {
    const rows = [
      ["Hamburg-Nord", "450", "9,8 %", "", "x"],
      ["Altona", "547", "", "", "12"],
      ["Bergedorf", "736", "2,0 %", "", "3"],
    ];
    expect(numericColumns(rows)).toEqual([false, true, true, false, false]);
  });

  it("count a lone dash as an empty cell, and need one number at least", () => {
    expect(
      numericColumns([
        ["A", "–", "-"],
        ["B", "12", "—"],
      ])
    ).toEqual([false, true, false]);
  });

  it("take rows of different lengths", () => {
    expect(numericColumns([["A", "1"], ["B"], []])).toEqual([false, true]);
    expect(numericColumns([])).toEqual([]);
  });
});
