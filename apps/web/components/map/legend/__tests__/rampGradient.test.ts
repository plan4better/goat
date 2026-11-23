import { describe, expect, it } from "vitest";

import type { LegendSection } from "@/lib/style/legend";

import { rampColorAt, rampGradient, rampStops } from "../rampGradient";

type Ramp = Extract<LegendSection, { kind: "ramp" }>;

const ramp = (extra: Partial<Ramp>): Ramp => ({
  kind: "ramp",
  id: "r",
  colors: ["#000000", "#808080", "#ffffff"],
  domain: [0, 10],
  ...extra,
});

describe("rampGradient", () => {
  it("spreads colors without positions evenly", () => {
    expect(rampStops(ramp({}))).toEqual([
      { color: "#000000", at: 0 },
      { color: "#808080", at: 0.5 },
      { color: "#ffffff", at: 1 },
    ]);
    expect(rampGradient(ramp({}))).toBe("linear-gradient(90deg, #000000 0%, #808080 50%, #ffffff 100%)");
  });

  it("puts each color at its position", () => {
    const section = ramp({ positions: [0, 0.2, 1] });
    expect(rampStops(section).map((s) => s.at)).toEqual([0, 0.2, 1]);
    expect(rampGradient(section)).toBe("linear-gradient(90deg, #000000 0%, #808080 20%, #ffffff 100%)");
  });

  it("draws two colors at one position as a hard step", () => {
    const section = ramp({
      colors: ["#000000", "#000000", "#ffffff", "#ffffff"],
      positions: [0, 0.25, 0.25, 1],
    });
    expect(rampGradient(section)).toBe(
      "linear-gradient(90deg, #000000 0%, #000000 25%, #ffffff 25%, #ffffff 100%)"
    );
  });
});

describe("rampColorAt", () => {
  it("blends between the two stops around a value, in RGB as the gradient does", () => {
    expect(rampColorAt(ramp({}), 0)).toBe("#000000");
    expect(rampColorAt(ramp({}), 2.5)).toBe("#404040");
    expect(rampColorAt(ramp({}), 5)).toBe("#808080");
    expect(rampColorAt(ramp({}), 10)).toBe("#ffffff");
  });

  it("holds the end colors beyond the domain and before the first and after the last position", () => {
    expect(rampColorAt(ramp({}), -5)).toBe("#000000");
    expect(rampColorAt(ramp({}), 15)).toBe("#ffffff");
    const inset = ramp({ positions: [0.2, 0.5, 0.8] });
    expect(rampColorAt(inset, 1)).toBe("#000000");
    expect(rampColorAt(inset, 9)).toBe("#ffffff");
  });

  it("holds the lower color on a hard step itself, the upper one past it", () => {
    const section = ramp({
      colors: ["#000000", "#000000", "#ffffff", "#ffffff"],
      positions: [0, 0.25, 0.25, 1],
    });
    expect(rampColorAt(section, 2.5)).toBe("#000000");
    expect(rampColorAt(section, 2.6)).toBe("#ffffff");
  });

  it("a domain of one value shows the first color", () => {
    expect(rampColorAt(ramp({ domain: [3, 3] }), 3)).toBe("#000000");
  });
});
