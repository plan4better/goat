import { describe, expect, it } from "vitest";

import type { CreditBalance } from "@/lib/api/usage";

import { levelOf, quotaNeedsAttention } from "@/components/settings/usage/quotaLevels";

const BALANCE = {
  used_credits: 100,
  total_credits: 1000,
  used_ai_credits: 0,
  total_ai_credits: 100,
  used_storage: 10,
  total_storage: 100,
  used_projects: 1,
  total_projects: 10,
  used_editors: 1,
  total_editors: 10,
} as CreditBalance;

describe("quota levels", () => {
  it("is full at 90 % and over above the limit, never for no limit", () => {
    expect(levelOf(89, 100)).toBe("ok");
    expect(levelOf(90, 100)).toBe("full");
    expect(levelOf(101, 100)).toBe("over");
    expect(levelOf(10_000, null)).toBe("ok");
  });

  it("needs attention when any quota is full or over, and not without a balance", () => {
    expect(quotaNeedsAttention(undefined)).toBe(false);
    expect(quotaNeedsAttention(BALANCE)).toBe(false);
    expect(quotaNeedsAttention({ ...BALANCE, used_storage: 95 })).toBe(true);
  });
});
