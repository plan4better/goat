import { describe, expect, it } from "vitest";

import {
  OutOfCreditsError,
  creditsErrorMessage,
  formatCredits,
  formatRate,
  isOutOfCreditsError,
  parseApiDate,
} from "@/lib/utils/credits";

const t = (key: string) => `t:${key}`;

describe("formatCredits", () => {
  it("shows one decimal below 10 and whole numbers from there", () => {
    expect(formatCredits(0.4, "en")).toBe("0.4");
    expect(formatCredits(2.5, "en")).toBe("2.5");
    expect(formatCredits(2, "en")).toBe("2");
    expect(formatCredits(9.96, "en")).toBe("10");
    expect(formatCredits(10.4, "en")).toBe("10");
    expect(formatCredits(3030.4, "en")).toBe("3,030");
    expect(formatCredits(null, "en")).toBe("0");
  });

  it("follows the locale", () => {
    expect(formatCredits(2.5, "de")).toBe("2,5");
    expect(formatCredits(3030.4, "de")).toBe("3.030");
  });
});

describe("formatRate", () => {
  it("does not round prices", () => {
    expect(formatRate(0.5, "en")).toBe("0.5");
    expect(formatRate(0.25, "en")).toBe("0.25");
    expect(formatRate(20, "en")).toBe("20");
    expect(formatRate(0.5, "de")).toBe("0,5");
  });
});

describe("out of credits", () => {
  it("recognises the typed error and any 402", () => {
    expect(isOutOfCreditsError(new OutOfCreditsError())).toBe(true);
    expect(isOutOfCreditsError(Object.assign(new Error("x"), { status: 402 }))).toBe(true);
    expect(isOutOfCreditsError(Object.assign(new Error("x"), { status: 500 }))).toBe(false);
    expect(isOutOfCreditsError(new Error("x"))).toBe(false);
    expect(isOutOfCreditsError(null)).toBe(false);
  });

  it("maps a 402 to the translated message and leaves other errors alone", () => {
    expect(creditsErrorMessage(new OutOfCreditsError(), t)).toBe("t:out_of_credits_tool");
    expect(creditsErrorMessage(Object.assign(new Error("Failed"), { status: 402 }), t)).toBe(
      "t:out_of_credits_tool"
    );
    expect(creditsErrorMessage(new Error("boom"), t)).toBeNull();
    expect(creditsErrorMessage(new Error("boom"), t, "fallback")).toBe("fallback");
  });
});

describe("parseApiDate", () => {
  it("reads a naive datetime as UTC", () => {
    expect(parseApiDate("2026-07-01T10:00:00").toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(parseApiDate("2026-07-01 10:00:00.250").toISOString()).toBe("2026-07-01T10:00:00.250Z");
  });

  it("keeps an explicit zone or offset", () => {
    expect(parseApiDate("2026-07-01T10:00:00Z").toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(parseApiDate("2026-07-01T12:00:00+02:00").toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(parseApiDate("2026-07-01T05:00:00-05:00").toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });
});
