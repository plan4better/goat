// The legend cases are usable: each compiles to MapLibre layers without validation errors.
import { describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";

import { maplibreErrors } from "../maplibre";
import { compileInput, legendCases } from "./cases";
import { known } from "./known";

const cases = legendCases();

describe("legend cases", () => {
  it("hold the generated cases and the spec's examples, each id once", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith("v")).length).toBeGreaterThan(50);
    expect(ids.filter((id) => id.startsWith("spec-")).length).toBeGreaterThan(50);
  });

  it("the generated cases use the made-up fields only", () => {
    const made = cases.filter((c) => c.values);
    expect(made.length).toBeGreaterThan(0);
    for (const c of made)
      expect(Object.keys(c.fields).sort()).toEqual(
        [
          "amount",
          "category",
          "constant",
          "empty_number",
          "empty_text",
          "flag",
          "long_text",
          "partial",
          "partial_text",
          "rate",
          "year",
        ].sort()
      );
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s compiles", (_id, c) => {
    const out = compileLayer(compileInput(c));
    expect(out.layers.length).toBeGreaterThan(0);
    const errors = maplibreErrors(out.layers, out.sources, out.state);
    if (known("compiles", c)) expect(errors, known("compiles", c)!.reason).not.toEqual([]);
    else expect(errors).toEqual([]);
  });
});
