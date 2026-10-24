import { describe, expect, it } from "vitest";

import { writeAccessFrom } from "@/lib/api/layers";

describe("writeAccessFrom", () => {
  it("passes the server's answer through", () => {
    expect(writeAccessFrom({ can_write: true }, undefined)).toBe(true);
    expect(writeAccessFrom({ can_write: false }, undefined)).toBe(false);
  });

  // With login on, a dataset the user may not see is refused by the access
  // check before the question is answered: that is a "no" too, so the same
  // warning shows as for a dataset they may only view.
  it("reads a refusal as no", () => {
    for (const status of [401, 403]) {
      expect(writeAccessFrom(undefined, { status })).toBe(false);
    }
  });

  it("stays unknown while loading or on other errors", () => {
    expect(writeAccessFrom(undefined, undefined)).toBeUndefined();
    expect(writeAccessFrom(undefined, { status: 500 })).toBeUndefined();
    // A core without the route: no false "no edit rights" warning.
    expect(writeAccessFrom(undefined, { status: 404 })).toBeUndefined();
    expect(writeAccessFrom(undefined, new Error("network"))).toBeUndefined();
  });
});
