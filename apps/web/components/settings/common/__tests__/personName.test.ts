import { describe, expect, it } from "vitest";

import { personName } from "@/components/settings/common/personName";

describe("personName", () => {
  it("joins first and last name", () => {
    expect(personName({ firstname: "Anna", lastname: "Weber", email: "a@x.de" })).toBe("Anna Weber");
    expect(personName({ firstname: " Anna ", lastname: "", email: "a@x.de" })).toBe("Anna");
  });

  it("falls back to the address for an invitation or an account without a name", () => {
    expect(personName({ firstname: "", lastname: "", email: "ben@x.de" })).toBe("ben@x.de");
    expect(personName({ firstname: null, lastname: undefined, email: "ben@x.de" })).toBe("ben@x.de");
  });
});
