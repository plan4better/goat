import { describe, expect, it } from "vitest";

import { initialsOf } from "@/lib/utils/avatar";

describe("initialsOf", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Marie Klein")).toBe("MK");
    expect(initialsOf("  anna  maria schmidt ")).toBe("AM");
    expect(initialsOf("Ben")).toBe("B");
  });

  it("takes an address as one word", () => {
    expect(initialsOf("anna@example.com")).toBe("A");
  });

  it("skips words without a letter, as a team name's dash", () => {
    expect(initialsOf("Harthof - P4B")).toBe("HP");
    expect(initialsOf("P4B - GIS Squad")).toBe("PG");
    expect(initialsOf("2026 Verkehr & Umwelt")).toBe("VU");
  });

  it("takes a word's first letter, not a bracket or a quote before it", () => {
    expect(initialsOf("(P4B)")).toBe("P");
    expect(initialsOf("Stadtwerke (Nord)")).toBe("SN");
    expect(initialsOf('"Planung" Team')).toBe("PT");
  });

  it("keeps a name without any letter as it is, and gives nothing for an empty one", () => {
    expect(initialsOf("2026")).toBe("2");
    expect(initialsOf("   ")).toBe("");
  });
});
