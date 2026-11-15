import { describe, expect, it } from "vitest";

import { levelOf } from "@/components/settings/usage/quotaLevels";

describe("quota levels", () => {
  it("is full at 90 % and over above the limit, never for no limit", () => {
    expect(levelOf(89, 100)).toBe("ok");
    expect(levelOf(90, 100)).toBe("full");
    expect(levelOf(101, 100)).toBe("over");
    expect(levelOf(10_000, null)).toBe("ok");
  });
});
